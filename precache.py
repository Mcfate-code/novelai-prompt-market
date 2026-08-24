"""预缓存例图到本地（主动预热，约 200MB 额度）。

优先级：收藏 → 最近使用（高频优先）→ 热门 tag（post_count 降序）。
每 tag 缓存 缩略图 + 大图 到 static/thumbs/，并把 URL 写入 tag_thumbs 表。
达到 TARGET_MB 或取尽候选即停止。支持断点续传（已存在文件/已入库 tag 跳过）。
"""
from __future__ import annotations

import hashlib
import sys
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import db  # noqa: E402
import imageutil  # noqa: E402
from importer import sync_danbooru  # noqa: E402

BASE_DIR = db.BASE_DIR
THUMB_DIR = BASE_DIR / "static" / "thumbs"
TARGET_MB = 700
MAX_WORKERS = 8
SLEEP_PER_TAG = 0.10  # 防 Danbooru 限流；下载由工作线程并发执行
LOG_PATH = BASE_DIR / "data" / "precache.log"


def log(msg: str) -> None:
    line = f"[{db.now_iso()}] {msg}"
    print(line, flush=True)
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def guess_ext(url: str) -> str:
    path = url.split("?")[0].lower().rstrip("/")
    for ext in (".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif"):
        if path.endswith(ext):
            return ext if ext != ".jpeg" else ".jpg"
    return ".jpg"


def collect_candidates() -> list[str]:
    """按优先级收集待缓存 tag（去重、跳过已缓存完整对的）。"""
    conn = db.get_conn()
    try:
        # 已缓存 tag（thumb 或 large 非空）→ 跳过；净空占位视为已尝试，不重复请求远端。
        done = {
            r["tag_name"]
            for r in conn.execute(
                "SELECT tag_name FROM tag_thumbs WHERE thumb_url != '' OR thumb_large_url != ''"
            ).fetchall()
        }
        # 1. 收藏
        fav = [r["tag_name"] for r in conn.execute("SELECT tag_name FROM favorites").fetchall()]
        # 2. 最近使用（按 use_count 降序）
        recent = [
            r["tag_name"]
            for r in conn.execute("SELECT tag_name FROM recent_tags ORDER BY use_count DESC, last_used_at DESC").fetchall()
        ]
        # 3. 热门（post_count 降序，扩大候选池，避免高失败率时过早耗尽）
        conn.row_factory = None
        hot = [
            r[0]
            for r in conn.execute(
                "SELECT prompt_tag FROM tags WHERE post_count > 0 ORDER BY post_count DESC LIMIT 20000"
            ).fetchall()
        ]
    finally:
        conn.close()
    seen, out = set(), []
    for tag in fav + recent + hot:
        if tag in seen or tag in done:
            continue
        seen.add(tag)
        out.append(tag)
    return out


def fetch_post_images(tag: str):
    """直接按热度查 posts.json 取一张代表图（单请求），返回 (thumb_url, large_url)。

    相比逐 tag 查 wiki（2-3 次请求），更适合大批量预缓存。
    """
    cfg = sync_danbooru._settings()["danbooru"]
    base = cfg["base_url"].rstrip("/")
    q = urllib.parse.urlencode({"tags": db.underscore(tag), "limit": 1, "search[order]": "score"})
    try:
        data = sync_danbooru._http_json(f"{base}/posts.json?{q}", timeout=20)
        if not isinstance(data, list) or not data:
            return None, None
        p = data[0]
        thumb = p.get("preview_file_url") or p.get("large_file_url") or p.get("file_url")
        large = p.get("sample_file_url") or thumb
        return thumb, large
    except Exception:  # noqa: BLE001
        return None, None


def cache_one(tag: str) -> tuple[str, int]:
    """缓存单个 tag 的缩略图+大图，返回 (状态, 新增字节)。"""
    thumb_remote, large_remote = fetch_post_images(tag)
    if not thumb_remote:
        _mark_failed(tag)
        return "no_thumb", 0
    digest = hashlib.md5(tag.encode("utf-8")).hexdigest()
    ext = guess_ext(thumb_remote)
    fname = digest + ext
    fpath = THUMB_DIR / fname
    added = 0
    thumb_local = ""
    # 缩略图和大图下载并不互相依赖，先并发请求，减少单 tag 等待时间。
    with ThreadPoolExecutor(max_workers=2) as image_ex:
        thumb_future = None if fpath.exists() else image_ex.submit(
            sync_danbooru.fetch_image_bytes, thumb_remote
        )
        lname = digest + "_l.jpg"
        lpath = THUMB_DIR / lname
        large_future = None
        if large_remote and large_remote != thumb_remote and not lpath.exists():
            large_future = image_ex.submit(sync_danbooru.fetch_image_bytes, large_remote)
        thumb_data = thumb_future.result() if thumb_future else None
        large_data = large_future.result() if large_future else None

    if fpath.exists():
        thumb_local = f"/static/thumbs/{fname}"
    elif thumb_data:
        try:
            fpath.write_bytes(thumb_data)
            added += len(thumb_data)
            thumb_local = f"/static/thumbs/{fname}"
        except OSError:
            _mark_failed(tag)
            return "write_fail", 0
    else:
        _mark_failed(tag)
        return "dl_fail", 0

    large_local = thumb_local
    if large_remote and large_remote != thumb_remote:
        # 大图统一压缩为本地 jpg（不存原始大图）
        if lpath.exists():
            large_local = f"/static/thumbs/{lname}"
        elif large_data:
            compressed = imageutil.compress_image_bytes(large_data)
            if compressed:
                try:
                    lpath.write_bytes(compressed)
                    added += len(compressed)
                    large_local = f"/static/thumbs/{lname}"
                except OSError:
                    large_local = thumb_local
    _mark_done(tag, thumb_local, large_local)
    return "ok", added


def _mark_done(tag: str, thumb_local: str, large_local: str) -> None:
    conn = db.get_conn()
    try:
        conn.execute(
            "INSERT INTO tag_thumbs (tag_name, thumb_url, thumb_large_url, fetched_at) "
            "VALUES (?,?,?,?) "
            "ON CONFLICT(tag_name) DO UPDATE SET thumb_url=excluded.thumb_url, "
            "thumb_large_url=excluded.thumb_large_url, fetched_at=excluded.fetched_at",
            (tag, thumb_local, large_local, db.now_iso()),
        )
        conn.commit()
    finally:
        conn.close()


def _mark_failed(tag: str) -> None:
    """写入净空占位：下次候选收集时视为已尝试，不再重复请求远端。"""
    _mark_done(tag, "", "")


def main() -> None:
    THUMB_DIR.mkdir(parents=True, exist_ok=True)
    start_total = sum(f.stat().st_size for f in THUMB_DIR.glob("*") if f.is_file())
    log(f"预缓存开始：已有缓存 {start_total/1024/1024:.1f}MB，目标 ≤ {TARGET_MB}MB")
    candidates = collect_candidates()
    log(f"候选 tag 数：{len(candidates)}（收藏+最近+热门 top20000 去重后）")

    total = start_total
    ok_count = fail_count = 0
    t0 = time.time()
    batch = candidates[:4000]
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        futs = {ex.submit(cache_one, tag): tag for tag in batch}
        for i, fut in enumerate(as_completed(futs), 1):
            tag = futs[fut]
            try:
                status, added = fut.result()
            except Exception as e:  # noqa: BLE001
                status, added = f"exc:{type(e).__name__}", 0
            total += added
            if status == "ok":
                ok_count += 1
            else:
                fail_count += 1
            if i % 20 == 0 or added:
                elapsed = time.time() - t0
                log(
                    f"[{i}/{len(batch)}] ok={ok_count} fail={fail_count} "
                    f"累计 {total/1024/1024:.1f}MB 用时 {elapsed:.0f}s"
                )
            if total >= TARGET_MB * 1024 * 1024:
                log(f"达到目标 {TARGET_MB}MB，停止。")
                ex.shutdown(cancel_futures=True)
                break
            time.sleep(SLEEP_PER_TAG)
    log(f"预缓存完成：新增 {ok_count} 个成功，{fail_count} 个失败，目录总大小 {total/1024/1024:.1f}MB")


if __name__ == "__main__":
    main()