"""Danbooru canonical tags + aliases 全量同步层。

- GET /tags.json          分页拉取 canonical tag（含 post_count / category / is_deprecated）
- GET /tag_aliases.json   拉取 alias（antecedent -> consequent）
- upsert 进 SQLite；随后重新解析 taxonomy Seed 的 canonical / alias / overlay 状态

设计约束（规格 26 节）：
- 手动触发，不随启动强制联网；
- 断网 / 网络失败优雅降级，返回错误信息而不抛崩；
- 用 min_post_count 控制体量，避免把数百万长尾 tag 一次性拉满。
"""
from __future__ import annotations

import base64
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import db  # noqa: E402
from prompt import composer  # noqa: E402

SETTINGS_PATH = db.BASE_DIR / "config" / "app_settings.json"


def _settings() -> dict:
    return db.load_json(SETTINGS_PATH)


def _user_settings() -> dict:
    path = Path.home() / ".workbuddy" / "tags-market-settings.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return {}


def _opener() -> urllib.request.OpenerDirector:
    cfg = _settings().get("proxy") or {}
    user = _user_settings()
    url = user.get("proxy_url") if user.get("proxy_enabled", True) else None
    if not url:
        url = cfg.get("url") if cfg.get("enabled", False) else None
    if url:
        handler = urllib.request.ProxyHandler({"http": url, "https": url})
        return urllib.request.build_opener(handler)
    return urllib.request.build_opener()


def _auth_headers() -> dict:
    """构造 Danbooru Basic Auth，凭据优先从环境变量读取。"""
    cfg = _settings().get("danbooru") or {}
    user = _user_settings()
    login = os.environ.get("DANBOORU_LOGIN", "") or user.get("danbooru_login") or cfg.get("login") or ""
    api_key = os.environ.get("DANBOORU_API_KEY", "") or user.get("danbooru_api_key") or cfg.get("api_key") or ""
    if login and api_key:
        token = base64.b64encode(f"{login}:{api_key}".encode("utf-8")).decode("ascii")
        return {"Authorization": f"Basic {token}"}
    return {}


def _http_json(url: str, timeout: int = 30) -> list | dict:
    cfg = _settings()["danbooru"]
    headers = {"User-Agent": cfg.get("user_agent", "novelai-prompt-builder/1.0")}
    headers.update(_auth_headers())
    req = urllib.request.Request(url, headers=headers)
    with _opener().open(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_tags_page(page: int, limit: int = 1000, min_post_count: int = 10) -> list[dict]:
    cfg = _settings()["danbooru"]
    base = cfg["base_url"].rstrip("/")
    q = urllib.parse.urlencode(
        {"limit": limit, "page": page, "search[post_count]": f">={min_post_count}"}
    )
    return _http_json(f"{base}/tags.json?{q}")


def fetch_aliases_page(page: int, limit: int = 1000) -> list[dict]:
    cfg = _settings()["danbooru"]
    base = cfg["base_url"].rstrip("/")
    q = urllib.parse.urlencode({"limit": limit, "page": page})
    return _http_json(f"{base}/tag_aliases.json?{q}")


def sync_tags(conn, min_post_count: int = 10, max_pages: int = 50) -> dict:
    added = updated = 0
    for page in range(1, max_pages + 1):
        rows = fetch_tags_page(page, min_post_count=min_post_count)
        if not rows:
            break
        mapped = [
            {
                "danbooru_name": r["name"],
                "prompt_tag": db.prompt_form(r["name"]),
                "category": r.get("category", 0),
                "post_count": r.get("post_count", 0),
                "is_deprecated": int(bool(r.get("is_deprecated", False))),
                "source": "danbooru",
                "created_at": r.get("created_at"),
                "updated_at": r.get("updated_at"),
                "synced_at": db.now_iso(),
            }
            for r in rows
        ]
        db.upsert_tags(conn, mapped)
        added += len(mapped)
        if len(rows) < 1000:
            break
        time.sleep(0.4)
    return {"tags_seen": added, "pages": page}


def sync_aliases(conn, max_pages: int = 50) -> dict:
    added = 0
    for page in range(1, max_pages + 1):
        rows = fetch_aliases_page(page)
        if not rows:
            break
        mapped = [
            {
                "alias": r.get("antecedent_name"),
                "canonical_name": r.get("consequent_name"),
                "lang": "en",
                "source": "danbooru",
            }
            for r in rows
            if r.get("antecedent_name") and r.get("consequent_name")
        ]
        db.upsert_aliases(conn, mapped)
        added += len(mapped)
        if len(rows) < 1000:
            break
        time.sleep(0.4)
    return {"aliases_seen": added, "pages": page}


def resolve_seed(conn) -> dict:
    """按规格 11 节做 Seed 存在性校验，返回统计（不写回 taxonomy_map）。"""
    overlay = composer.overlay_tags()
    cur = conn.execute("SELECT DISTINCT tag_name FROM taxonomy_map")
    seeds = [r["tag_name"] for r in cur.fetchall()]

    canonical = set(
        r["danbooru_name"] for r in conn.execute("SELECT danbooru_name FROM tags").fetchall()
    )
    alias_map = {}
    for r in conn.execute("SELECT alias, canonical_name FROM tag_aliases").fetchall():
        alias_map[r["alias"]] = r["canonical_name"]

    resolved = unresolved = overlay_only = 0
    for s in seeds:
        if s in overlay:
            overlay_only += 1
        elif db.underscore(s) in canonical:
            resolved += 1
        elif s in alias_map or db.underscore(s) in alias_map:
            resolved += 1
        else:
            unresolved += 1
    return {
        "seed_total": len(seeds),
        "resolved": resolved,
        "overlay_only": overlay_only,
        "unresolved": unresolved,
    }


def fetch_hot_tags_page(category: int, page: int, limit: int = 1000) -> list[dict]:
    """按 post_count 降序拉取指定 category 的热门 tag。"""
    cfg = _settings()["danbooru"]
    base = cfg["base_url"].rstrip("/")
    q = urllib.parse.urlencode(
        {"limit": limit, "page": page, "search[order]": "count", "search[category]": category}
    )
    return _http_json(f"{base}/tags.json?{q}")


def _fetch_wiki_page(tag: str, timeout: int = 15) -> dict | None:
    """获取 tag 的 Danbooru wiki 页（权威例图来源）。

    优先返回 wiki body 中 Examples 区块挑选的代表性 post id，
    其次返回 wiki 页自身的 image 字段。
    """
    cfg = _settings()["danbooru"]
    base = cfg["base_url"].rstrip("/")
    q = urllib.parse.urlencode({"search[title]": db.underscore(tag)})
    try:
        data = _http_json(f"{base}/wiki_pages.json?{q}", timeout=timeout)
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(data, list) or not data:
        return None
    return data[0]


def _extract_wiki_example_post_id(wiki: dict) -> int | None:
    """从 wiki body 的 Examples 区块解析第一个 !post #id。"""
    body = wiki.get("body") or ""
    # Danbooru wiki 的示例写法：!post #123456
    import re

    m = re.search(r"!post\s+#?(\d+)", body)
    if m:
        return int(m.group(1))
    return None


def _post_image_urls(post_id: int, timeout: int = 15) -> tuple[str | None, str | None]:
    """根据 post id 取 (preview 图 URL, 大图 URL)。

    大图优先取 sample_file_url（Danbooru 标准中等尺寸，通常 ~850px，足够 hover 查看），
    无 sample 时回退 file_url（原图）。
    """
    cfg = _settings()["danbooru"]
    base = cfg["base_url"].rstrip("/")
    q = urllib.parse.urlencode({"tags": f"id:{post_id}", "limit": 1})
    try:
        data = _http_json(f"{base}/posts.json?{q}", timeout=timeout)
        if isinstance(data, list) and data:
            p = data[0]
            thumb = p.get("preview_file_url") or p.get("large_file_url") or p.get("file_url")
            large = p.get("sample_file_url") or p.get("large_file_url") or p.get("file_url")
            return thumb, large
    except Exception:  # noqa: BLE001
        return None, None
    return None, None


def _post_thumb_url(post_id: int, timeout: int = 15) -> str | None:
    """根据 post id 取 preview 图 URL（兼容旧调用）。"""
    return _post_image_urls(post_id, timeout)[0]


def fetch_fast_images(tag: str, timeout: int = 15) -> tuple[str | None, str | None]:
    """快速取一张高分例图，单请求直连 posts.json。

    网页首屏和批量预缓存优先使用此路径，避免先查 wiki 再查 post 的多次往返。
    需要更强「权威 Examples」语义时，再调用 fetch_authoritative_images。
    """
    cfg = _settings()["danbooru"]
    base = cfg["base_url"].rstrip("/")
    q = urllib.parse.urlencode(
        {"tags": db.underscore(tag), "limit": 1, "search[order]": "score"}
    )
    try:
        data = _http_json(f"{base}/posts.json?{q}", timeout=timeout)
        if isinstance(data, list) and data:
            post = data[0]
            thumb = post.get("preview_file_url") or post.get("large_file_url") or post.get("file_url")
            large = post.get("sample_file_url") or post.get("large_file_url") or post.get("file_url")
            if thumb:
                return thumb, large or thumb
    except Exception:  # noqa: BLE001
        return None, None
    return None, None


def fetch_authoritative_images(tag: str, timeout: int = 15) -> tuple[str | None, str | None]:
    """取某个 tag 的权威例图 (缩略图 URL, 大图 URL)。

    三层回退，依次取第一份成功的：
    1. Danbooru Wiki「Examples」区块首个示例 post（最权威、最有代表性）
    2. Wiki 页面自身的 image 字段
    3. /posts.json 按 score 排序取最高分 post（比默认「第一条」更有代表性）

    全部失败返回 (None, None)（不抛异常）。
    """
    wiki = _fetch_wiki_page(tag, timeout)
    if wiki:
        ex_id = _extract_wiki_example_post_id(wiki)
        if ex_id:
            thumb, large = _post_image_urls(ex_id, timeout)
            if thumb:
                return thumb, large or thumb
        # 回退 2：wiki 页自身配图（单图，thumb 与 large 相同）
        img = wiki.get("image") or wiki.get("thumbnail")
        if img:
            return img, img
    # 回退 3：score 最高的 post
    cfg = _settings()["danbooru"]
    base = cfg["base_url"].rstrip("/")
    q = urllib.parse.urlencode({"tags": db.underscore(tag), "limit": 1, "search[order]": "score"})
    try:
        data = _http_json(f"{base}/posts.json?{q}", timeout=timeout)
        if isinstance(data, list) and data:
            p = data[0]
            thumb = p.get("preview_file_url") or p.get("large_file_url") or p.get("file_url")
            large = p.get("sample_file_url") or p.get("large_file_url") or p.get("file_url")
            if thumb:
                return thumb, large or thumb
    except Exception:  # noqa: BLE001
        return None, None
    return None, None


def fetch_authoritative_thumb(tag: str, timeout: int = 15) -> str | None:
    """兼容旧接口：取某个 tag 的权威例图缩略图 URL。"""
    return fetch_authoritative_images(tag, timeout)[0]


def fetch_post_thumb(tag: str, timeout: int = 15) -> str | None:
    """兼容旧接口：取某个 tag 的例图缩略图 URL（改为权威来源）。"""
    return fetch_authoritative_thumb(tag, timeout)


def fetch_image_bytes(url: str, timeout: int = 30) -> bytes | None:
    """下载远端图片二进制（走项目配置的代理 + 可选账号认证）。失败返回 None。"""
    try:
        cfg = _settings()["danbooru"]
        headers = {"User-Agent": cfg.get("user_agent", "novelai-prompt-builder/1.0")}
        headers.update(_auth_headers())
        req = urllib.request.Request(url, headers=headers)
        with _opener().open(req, timeout=timeout) as resp:
            return resp.read()
    except Exception:  # noqa: BLE001
        return None


def sync_category(conn, category: int, top_n: int) -> dict:
    """同步某 category 热门前 top_n 个 tag。"""
    added = 0
    pages = (top_n + 999) // 1000
    for page in range(1, pages + 1):
        try:
            rows = fetch_hot_tags_page(category, page)
        except Exception as e:  # noqa: BLE001
            return {"category": category, "added": added, "error": f"{type(e).__name__}: {e}"}
        if not rows:
            break
        mapped = [
            {
                "danbooru_name": r["name"],
                "prompt_tag": db.prompt_form(r["name"]),
                "category": r.get("category", category),
                "post_count": r.get("post_count", 0),
                "is_deprecated": int(bool(r.get("is_deprecated", False))),
                "source": "danbooru",
                "created_at": r.get("created_at"),
                "updated_at": r.get("updated_at"),
                "synced_at": db.now_iso(),
            }
            for r in rows
        ]
        db.upsert_tags(conn, mapped)
        added += len(mapped)
        if len(rows) < 1000:
            break
        time.sleep(0.3)
    return {"category": category, "added": added}


def run_hot_sync() -> dict:
    """按配置同步热门 general / character / artist / copyright / meta tag。"""
    db.init_db()
    conn = db.get_conn()
    cfg = _settings().get("hot_sync", {})
    summary = {}
    try:
        for key, cat in [("general", 0), ("character", 4), ("artist", 1), ("copyright", 3), ("meta", 5)]:
            n = cfg.get(key, 0)
            if n > 0:
                summary[key] = sync_category(conn, cat, n)
        summary["seed_resolution"] = resolve_seed(conn)
    finally:
        conn.close()
    return summary


def run(min_post_count: int = 10, max_pages: int = 50, do_aliases: bool = True) -> dict:
    db.init_db()
    conn = db.get_conn()
    summary = {}
    try:
        summary["tags"] = sync_tags(conn, min_post_count=min_post_count, max_pages=max_pages)
    except Exception as e:  # noqa: BLE001
        summary["tags"] = {"error": f"{type(e).__name__}: {e}"}
    if do_aliases:
        try:
            summary["aliases"] = sync_aliases(conn, max_pages=max_pages)
        except Exception as e:  # noqa: BLE001
            summary["aliases"] = {"error": f"{type(e).__name__}: {e}"}
    summary["seed_resolution"] = resolve_seed(conn)
    conn.close()
    return summary


def main() -> None:
    import argparse

    p = argparse.ArgumentParser(description="同步 Danbooru 标签库")
    p.add_argument("--min-post-count", type=int, default=10)
    p.add_argument("--max-pages", type=int, default=50)
    p.add_argument("--skip-aliases", action="store_true")
    args = p.parse_args()
    print(json.dumps(run(args.min_post_count, args.max_pages, not args.skip_aliases),
                     ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
