"""NovelAI V5 本地提示词标签超市 —— FastAPI 后端。

只监听 127.0.0.1，单机工具，无需认证/TLS。
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import sys
import tempfile
import uuid
import zipfile
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import db  # noqa: E402
import imageutil  # noqa: E402
import search  # noqa: E402
from importer import build_catalog, import_aliases, import_danbooru_zh, import_restricted, import_taxonomy, sync_danbooru  # noqa: E402
from prompt import composer, import_parser, novelai_export  # noqa: E402

from fastapi import FastAPI, File, HTTPException, Query, UploadFile  # noqa: E402
from fastapi.responses import FileResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from pydantic import BaseModel  # noqa: E402

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
THUMB_DIR = STATIC_DIR / "thumbs"
GALLERY_DIR = BASE_DIR / "data" / "gallery"
SETTINGS = db.load_json(BASE_DIR / "config" / "app_settings.json")
USER_SETTINGS_PATH = Path.home() / ".workbuddy" / "tags-market-settings.json"
DEFAULT_USER_SETTINGS = {
    "adolescent_mode": True,
    "cache_limit_mb": 1024,
    "proxy_enabled": True,
    "proxy_url": "http://127.0.0.1:7890",
    "danbooru_login": "",
    "danbooru_api_key": "",
}


def _load_user_settings() -> dict:
    data = dict(DEFAULT_USER_SETTINGS)
    try:
        raw = json.loads(USER_SETTINGS_PATH.read_text(encoding="utf-8"))
        if isinstance(raw, dict):
            data.update(raw)
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        pass
    data["adolescent_mode"] = bool(data.get("adolescent_mode", True))
    try:
        data["cache_limit_mb"] = max(0, min(102400, int(data.get("cache_limit_mb", 1024))))
    except (TypeError, ValueError):
        data["cache_limit_mb"] = 1024
    data["proxy_enabled"] = bool(data.get("proxy_enabled", True))
    data["proxy_url"] = str(data.get("proxy_url") or DEFAULT_USER_SETTINGS["proxy_url"]).strip()
    data["danbooru_login"] = str(data.get("danbooru_login") or "").strip()
    data["danbooru_api_key"] = str(data.get("danbooru_api_key") or "").strip()
    return data


def _save_user_settings(data: dict) -> None:
    USER_SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = USER_SETTINGS_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.chmod(tmp, 0o600)
    os.replace(tmp, USER_SETTINGS_PATH)


def _hidden_tag_names(conn) -> set[str]:
    """青少年模式下隐藏的受限/成人分类标签。"""
    if not _load_user_settings()["adolescent_mode"]:
        return set()
    names = {
        r["tag"] for r in conn.execute(
            "SELECT COALESCE(t.prompt_tag, m.seed) AS tag "
            "FROM restricted_taxonomy_map m LEFT JOIN tags t ON t.danbooru_name=m.canonical_name "
            "WHERE m.status != 'anomalous'"
        ).fetchall()
    }
    names.update(
        r["tag"] for r in conn.execute(
            "SELECT DISTINCT m.tag_name AS tag FROM taxonomy_map m "
            "WHERE lower(COALESCE(m.category_l1, '')) LIKE '%成人%' "
            "OR lower(COALESCE(m.category_l1, '')) LIKE '%nsfw%' "
            "OR lower(COALESCE(m.category_l2, '')) LIKE '%成人%' "
            "OR lower(COALESCE(m.category_l2, '')) LIKE '%nsfw%'"
        ).fetchall()
    )
    return {n for n in names if n}


def _filter_hidden_items(items: list[dict], hidden: set[str]) -> list[dict]:
    return [item for item in items if item.get("tag") not in hidden]


def _user_zh_overlay(conn) -> dict[str, str]:
    """用户备注中文覆盖层：prompt_tag -> 备注中文（存在 user_zh 表，覆盖默认中文）。"""
    return {r["tag_name"]: r["zh"] for r in conn.execute("SELECT tag_name, zh FROM user_zh")}


def _apply_user_zh(conn, items):
    """把用户备注中文覆盖应用到 tag DTO（list 或单个 dict，就地修改 zh / zh_name 字段）。

    备注保存在 user_zh 表（数据库内），但搜索 / 目录 / 收藏 / 最近等接口的 zh 直接来自
    tags.zh_name，未应用覆盖——统一在这里补齐，保证所有界面看到一致的中文名。
    """
    if not items:
        return items
    overlay = _user_zh_overlay(conn)
    if not overlay:
        return items
    lst = items if isinstance(items, list) else [items]
    for it in lst:
        if not isinstance(it, dict):
            continue
        tag = it.get("tag")
        if tag and tag in overlay:
            if "zh" in it:
                it["zh"] = overlay[tag]
            if "zh_name" in it:
                it["zh_name"] = overlay[tag]
    return items


def _prepare_hidden_table(conn, hidden: set[str]) -> str:
    """把本次请求的隐藏标签放入临时表，供计数和分页查询共用。"""
    table = "catalog_hidden_tags"
    conn.execute(f"CREATE TEMP TABLE IF NOT EXISTS {table} (tag TEXT PRIMARY KEY)")
    conn.execute(f"DELETE FROM {table}")
    if hidden:
        conn.executemany(
            f"INSERT OR IGNORE INTO {table} (tag) VALUES (?)",
            ((tag,) for tag in hidden),
        )
    return table


def _cache_limit_bytes() -> int:
    return _load_user_settings()["cache_limit_mb"] * 1024 * 1024


def _enforce_cache_limit(protected: set[str] | None = None) -> None:
    """按修改时间淘汰最旧例图缓存，保留本次刚写入的文件。"""
    protected = protected or set()
    limit = _cache_limit_bytes()
    files = [p for p in THUMB_DIR.iterdir() if p.is_file()] if THUMB_DIR.exists() else []
    total = sum(p.stat().st_size for p in files)
    if total <= limit:
        return
    for path in sorted(files, key=lambda p: p.stat().st_mtime):
        if path.name in protected:
            continue
        try:
            total -= path.stat().st_size
            path.unlink()
        except OSError:
            continue
        if total <= limit:
            break


def _guess_img_ext(url: str) -> str:
    """从远端 URL 推断图片扩展名（默认 .jpg）。"""
    path = url.split("?")[0].lower().rstrip("/")
    for ext in (".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif"):
        if path.endswith(ext):
            return ext if ext != ".jpeg" else ".jpg"
    return ".jpg"


def ensure_seeded() -> None:
    db.init_db()
    conn = db.get_conn()
    try:
        n_tax = conn.execute("SELECT COUNT(*) c FROM taxonomy_map").fetchone()["c"]
        n_zh = conn.execute("SELECT COUNT(*) c FROM tag_aliases WHERE lang='zh'").fetchone()["c"]
        n_restricted = conn.execute("SELECT COUNT(*) c FROM restricted_taxonomy_map").fetchone()["c"]
        n_cat = conn.execute("SELECT COUNT(*) c FROM tag_catalog").fetchone()["c"]
        if n_tax == 0:
            import_taxonomy.import_taxonomy(conn)
        if n_zh == 0:
            import_aliases.import_zh(conn)
        if n_restricted == 0:
            try:
                import_restricted.import_restricted(conn)
            except FileNotFoundError:
                pass  # 未放置受限 taxonomy 文件时跳过，不阻塞启动
        if n_cat == 0:
            build_catalog.build_catalog(conn)
    finally:
        conn.close()


@asynccontextmanager
async def lifespan(app: FastAPI):
    ensure_seeded()
    app.state.thumb_executor = ThreadPoolExecutor(max_workers=8, thread_name_prefix="thumb-fetch")
    app.state.image_executor = ThreadPoolExecutor(max_workers=8, thread_name_prefix="image-fetch")
    try:
        yield
    finally:
        app.state.thumb_executor.shutdown(wait=True, cancel_futures=True)
        app.state.image_executor.shutdown(wait=True, cancel_futures=True)


app = FastAPI(title="NovelAI Prompt Builder", lifespan=lifespan)

_cache_exts = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".svg", ".ico", ".css", ".js", ".woff2", ".woff"}


@app.middleware("http")
async def add_cache_headers(request, call_next):
    """静态资源（含本地例图）加长缓存头，浏览器只下载一次。"""
    response = await call_next(request)
    path = request.url.path
    if path.startswith(("/static/", "/gallery/")):
        ext = Path(path).suffix.lower()
        if ext in _cache_exts:
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return response


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
GALLERY_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/gallery", StaticFiles(directory=str(GALLERY_DIR)), name="gallery")


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


def _conn():
    conn = db.get_conn()
    return conn


# ---------- 图库（NovelAI 图包） ----------

ALLOWED_IMG_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".bmp"}
MAX_ZIP_BYTES = 1.5 * 1024 * 1024 * 1024
MAX_ZIP_FILES = 10000
MAX_IMAGE_BYTES = 50 * 1024 * 1024
MAX_UNCOMPRESSED_BYTES = 8 * 1024 * 1024 * 1024
GALLERY_ROOT = GALLERY_DIR.resolve()


def _sanitize_dir_name(name: str) -> str:
    """zip 文件名 → 目录名（去扩展名、非法字符）。"""
    base = Path(name).stem
    if not base or base.startswith("."):
        return "gallery"
    keep = re.sub(r'[\\/:*?"<>|\s]+', "_", base).strip("_")
    return keep or "gallery"


def _safe_gallery_path(dir_name: str) -> Path:
    """只允许访问图库根目录下一层目录，拒绝路径穿越。"""
    if not dir_name or Path(dir_name).name != dir_name or dir_name in {".", ".."}:
        raise HTTPException(400, "非法图库目录")
    target = (GALLERY_DIR / dir_name).resolve()
    if target.parent != GALLERY_ROOT:
        raise HTTPException(400, "非法图库目录")
    return target


def _prompt_from_filename(fname: str) -> str:
    """NovelAI 图包文件名 → 提示词。

    格式: "masterpiece, best quality, ultra detailed, ... s-1635401377.png"
    去掉后缀扩展名和尾部的 "-数字id" / " s-数字id" / "_数字id" 标识。
    """
    stem = Path(fname).stem
    # 常见三种尾缀：', 123456' / '-123456' / '_123456' / ' s-123456' / ' - 123456'
    stem = re.sub(r"[\s,_-]+s?[-_]?\d{6,}$", "", stem)
    stem = re.sub(r"[\s,_-]+\d{6,}$", "", stem)
    return stem.strip()


@app.post("/api/gallery/import")
async def gallery_import(upload: UploadFile = File(...)):
    """上传 NovelAI 图包 zip，压缩后存项目副本并建索引。"""
    if not upload.filename or not upload.filename.lower().endswith(".zip"):
        raise HTTPException(400, "请上传 .zip 文件")

    temp_path: Path | None = None
    try:
        # 分块落盘，避免把整个 ZIP 一次性读入内存。
        with tempfile.NamedTemporaryFile(prefix="gallery-", suffix=".zip", delete=False) as tmp:
            temp_path = Path(tmp.name)
            total = 0
            while chunk := await upload.read(1024 * 1024):
                total += len(chunk)
                if total > MAX_ZIP_BYTES:
                    raise HTTPException(400, "zip 过大（>1.5GB）")
                tmp.write(chunk)

        dir_name = _sanitize_dir_name(upload.filename)
        target = _safe_gallery_path(dir_name)
        target.mkdir(parents=True, exist_ok=True)
        imported = skipped = failed = 0
        conn = _conn()
        try:
            with zipfile.ZipFile(temp_path) as zf:
                infos = zf.infolist()
                if len(infos) > MAX_ZIP_FILES:
                    raise HTTPException(400, "zip 文件数量过多")
                if sum(max(0, info.file_size) for info in infos) > MAX_UNCOMPRESSED_BYTES:
                    raise HTTPException(400, "zip 解压后体积过大")
                for info in infos:
                    if info.is_dir():
                        continue
                    ext = Path(info.filename).suffix.lower()
                    if ext not in ALLOWED_IMG_EXT:
                        continue
                    if info.flag_bits & 0x1 or info.file_size > MAX_IMAGE_BYTES:
                        failed += 1
                        continue
                    fname = Path(info.filename).name
                    done = conn.execute(
                        "SELECT 1 FROM gallery WHERE dir_name=? AND file_name=?", (dir_name, fname)
                    ).fetchone()
                    if done:
                        skipped += 1
                        continue
                    try:
                        data = zf.read(info)
                    except Exception:  # noqa: BLE001
                        failed += 1
                        continue
                    compressed = imageutil.compress_image_bytes(data)
                    if compressed is None:
                        failed += 1
                        continue
                    prompt = _prompt_from_filename(fname)
                    short = re.sub(r'[\\/:*?"<>|,{}\[\]()\s]+', "_", prompt).strip("._ ") or "img"
                    short = short[:40].strip("_") or "img"
                    # UUID 避免重复导入、跳过条目或同名提示词造成覆盖。
                    out_name = f"{uuid.uuid4().hex}_{short}.jpg"
                    out_path = target / out_name
                    temp_out = target / f".{out_name}.tmp"
                    try:
                        temp_out.write_bytes(compressed)
                        os.replace(temp_out, out_path)
                    except OSError:  # noqa: BLE001
                        temp_out.unlink(missing_ok=True)
                        failed += 1
                        continue
                    conn.execute(
                        "INSERT INTO gallery (dir_name, file_name, prompt, file_path, created_at) "
                        "VALUES (?,?,?,?,?)",
                        (dir_name, fname, prompt, str(out_path.relative_to(BASE_DIR)), db.now_iso()),
                    )
                    imported += 1
            conn.commit()
        finally:
            conn.close()
        return {"ok": True, "dir": dir_name, "imported": imported, "skipped": skipped, "failed": failed}
    except zipfile.BadZipFile as exc:
        raise HTTPException(400, "无效的 zip 文件") from exc
    finally:
        await upload.close()
        if temp_path:
            temp_path.unlink(missing_ok=True)


class GalleryItemBody(BaseModel):
    """单张图片入库请求体（由 NovelAI 联动层生图完成后调用）。"""

    image_base64: str
    mime: str = "image/png"
    prompt: str = ""
    negative_prompt: str = ""
    parameters: dict | None = None
    dir_name: str = "nai_generated"


@app.post("/api/gallery/item")
async def gallery_item(body: GalleryItemBody):
    """单张图片入库：base64 → 压缩 → 存 data/gallery/<dir>/ → 建索引。

    图库表只保留 prompt 正文字段；负面提示词与参数完整元数据由
    NovelAI 联动层（Node library.db）持有，这里不冗余存储。
    """
    dir_name = _sanitize_dir_name(body.dir_name)
    target = _safe_gallery_path(dir_name)
    target.mkdir(parents=True, exist_ok=True)
    try:
        data = base64.b64decode(body.image_base64, validate=False)
    except (ValueError, TypeError) as exc:
        raise HTTPException(400, "图片 base64 无效") from exc
    if not data or len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(400, "图片数据无效或过大（>50MB）")
    if body.mime.split("/")[0] != "image":
        raise HTTPException(400, "非法图片类型")
    compressed = imageutil.compress_image_bytes(data)
    if compressed is None:
        raise HTTPException(400, "图片压缩失败")
    short = re.sub(r'[\\/:*?"<>|,{}\[\]()\s]+', "_", body.prompt).strip("._ ") or "img"
    short = short[:40].strip("_") or "img"
    fname = f"{uuid.uuid4().hex}_{short}.jpg"
    out_path = target / fname
    temp_out = target / f".{fname}.tmp"
    try:
        temp_out.write_bytes(compressed)
        os.replace(temp_out, out_path)
    except OSError:  # noqa: BLE001
        temp_out.unlink(missing_ok=True)
        raise HTTPException(500, "图片写入失败")
    prompt = body.prompt.strip()
    conn = _conn()
    try:
        conn.execute(
            "INSERT INTO gallery (dir_name, file_name, prompt, file_path, created_at, negative_prompt, parameters_json) "
            "VALUES (?,?,?,?,?,?,?)",
            (dir_name, fname, prompt, str(out_path.relative_to(BASE_DIR)), db.now_iso(),
             (body.negative_prompt or "").strip(),
             json.dumps(body.parameters, ensure_ascii=False) if body.parameters else None),
        )
        conn.commit()
    finally:
        conn.close()
    return {
        "ok": True,
        "dir_name": dir_name,
        "file_name": fname,
        "file_path": str(out_path.relative_to(BASE_DIR)),
        "prompt": prompt,
        "negative_prompt": (body.negative_prompt or "").strip(),
        "parameters": body.parameters,
    }


@app.get("/api/gallery")
def gallery_list():
    """图库目录列表（每个 zip 一个目录），含图片数与收藏数。"""
    conn = _conn()
    try:
        rows = conn.execute(
            "SELECT g.dir_name, COUNT(*) n, SUM(CASE WHEN f.dir_name IS NOT NULL THEN 1 ELSE 0 END) favs "
            "FROM gallery g LEFT JOIN gallery_favorites f USING (dir_name, file_name) "
            "GROUP BY g.dir_name ORDER BY MAX(g.created_at) DESC"
        ).fetchall()
        return {"dirs": [dict(r) for r in rows]}
    finally:
        conn.close()


@app.get("/api/gallery/{dir_name}")
def gallery_dir(dir_name: str):
    """某目录的图片列表（含提示词与收藏状态）。"""
    _safe_gallery_path(dir_name)
    conn = _conn()
    try:
        rows = conn.execute(
            "SELECT g.id, g.file_name, g.prompt, g.negative_prompt, g.parameters_json, g.file_path, "
            "(f.dir_name IS NOT NULL) favorite "
            "FROM gallery g LEFT JOIN gallery_favorites f USING (dir_name, file_name) "
            "WHERE g.dir_name=? ORDER BY g.id DESC",
            (dir_name,),
        ).fetchall()
        return {
            "dir": dir_name,
            "items": [
                {**dict(r), "parameters": json.loads(r["parameters_json"]) if r["parameters_json"] else None}
                for r in rows
            ],
        }
    finally:
        conn.close()


class GalleryFavRequest(BaseModel):
    dir_name: str
    file_name: str
    favorite: bool


@app.post("/api/gallery/favorite")
def gallery_favorite(req: GalleryFavRequest):
    """收藏/取消收藏图库图片（收藏的图片已留副本在项目 data/gallery 中）。"""
    _safe_gallery_path(req.dir_name)
    conn = _conn()
    try:
        exists = conn.execute(
            "SELECT 1 FROM gallery WHERE dir_name=? AND file_name=?", (req.dir_name, req.file_name)
        ).fetchone()
        if req.favorite and not exists:
            raise HTTPException(404, "图库图片不存在")
        if req.favorite:
            conn.execute(
                "INSERT OR IGNORE INTO gallery_favorites (dir_name, file_name, created_at) VALUES (?,?,?)",
                (req.dir_name, req.file_name, db.now_iso()),
            )
        else:
            conn.execute(
                "DELETE FROM gallery_favorites WHERE dir_name=? AND file_name=?",
                (req.dir_name, req.file_name),
            )
        conn.commit()
        return {"ok": True, "favorite": req.favorite}
    finally:
        conn.close()


@app.delete("/api/gallery/{dir_name}")
def gallery_delete(dir_name: str):
    """删除整个图库目录（项目副本与索引）。"""
    target = _safe_gallery_path(dir_name)
    conn = _conn()
    try:
        exists = conn.execute("SELECT 1 FROM gallery WHERE dir_name=? LIMIT 1", (dir_name,)).fetchone()
        if not exists:
            raise HTTPException(404, "图库目录不存在")
        conn.execute("DELETE FROM gallery WHERE dir_name=?", (dir_name,))
        conn.execute("DELETE FROM gallery_favorites WHERE dir_name=?", (dir_name,))
        conn.commit()
    finally:
        conn.close()
    if target.exists():
        import shutil
        shutil.rmtree(target, ignore_errors=False)
    return {"ok": True}


# ---------- 模型 / overlay ----------

@app.get("/api/models")
def models():
    return {"default": composer.load_overlay()["_model_id"], "models": composer.list_models()}


@app.get("/api/overlay/{model_id}")
def overlay(model_id: str):
    ov = composer.load_overlay(model_id)
    data = composer.load_overlay()["_all"]
    return {
        "id": ov["_model_id"],
        "label": ov["label"],
        "id_full": ov.get("id"),
        "supports": ov.get("supports", {}),
        "character_note": ov.get("character_note"),
        "special_tags": ov.get("special_tags", []),
        "quality_presets": ov.get("quality_presets", {}),
        "uc_presets": ov.get("uc_presets", {}),
        "renamed_tags": data.get("renamed_tags", {}),
        "special_tag_groups": data.get("special_tags", {}),
        "conflict_hints": data.get("conflict_hints", []),
    }


# ---------- 分类浏览 / 搜索 ----------

@app.get("/api/taxonomy")
def taxonomy():
    conn = _conn()
    try:
        cats = search.taxonomy_tree(conn)
        for c in cats:
            _apply_user_zh(conn, c["tags"])
        return {"categories": cats}
    finally:
        conn.close()


@app.get("/api/search")
def do_search(
    q: str = "",
    category: int | None = Query(default=None),
    limit: int = Query(default=50, le=200),
    deprecated: bool = False,
):
    conn = _conn()
    try:
        hidden = _hidden_tag_names(conn)
        results = search.search(conn, q, limit=limit, category=category, deprecated=deprecated)
        _apply_user_zh(conn, results)
        return {"results": _filter_hidden_items(results, hidden)}
    finally:
        conn.close()


@app.get("/api/resolve")
def resolve(q: str):
    conn = _conn()
    try:
        r = search.resolve_tag(conn, q)
        if r is None:
            return {"resolved": False, "query": q}
        if r.get("tag") in _hidden_tag_names(conn):
            return {"resolved": False, "query": q}
        _apply_user_zh(conn, r)
        r["resolved"] = True
        r["category_name"] = db.CATEGORY_NAMES.get(r.get("category"), "General")
        return r
    finally:
        conn.close()


@app.get("/api/zh")
def zh_map():
    """返回全部 prompt_tag -> 中文名 映射（DB 中文 + 用户备注，用户备注覆盖）。"""
    conn = _conn()
    try:
        zh = {
            r["prompt_tag"]: r["zh_name"]
            for r in conn.execute("SELECT prompt_tag, zh_name FROM tags WHERE zh_name IS NOT NULL").fetchall()
        }
        for r in conn.execute("SELECT tag_name, zh FROM user_zh").fetchall():
            zh[r["tag_name"]] = r["zh"]
        return {"zh": zh}
    finally:
        conn.close()


class ZhNoteBody(BaseModel):
    tag: str
    zh: str = ""


@app.post("/api/zh-notes")
def save_zh_note(body: ZhNoteBody):
    """给任意 tag（含自定义/未解析 tag）备注中文。zh 为空则清除备注。"""
    tag = body.tag.strip()
    zh = body.zh.strip()
    if not tag:
        raise HTTPException(400, "empty tag")
    conn = _conn()
    try:
        if zh:
            conn.execute(
                "INSERT INTO user_zh (tag_name, zh, updated_at) VALUES (?,?,?) "
                "ON CONFLICT(tag_name) DO UPDATE SET zh=excluded.zh, updated_at=excluded.updated_at",
                (tag, zh, db.now_iso()),
            )
        else:
            conn.execute("DELETE FROM user_zh WHERE tag_name=?", (tag,))
        conn.commit()
        return {"ok": True, "tag": tag, "zh": zh}
    finally:
        conn.close()


@app.delete("/api/zh-notes/{tag}")
def del_zh_note(tag: str):
    conn = _conn()
    try:
        conn.execute("DELETE FROM user_zh WHERE tag_name=?", (tag,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


def _fetch_and_cache(tag: str) -> tuple[str, str]:
    """取权威例图 (thumb, large) URL → 下载两图 → 返回本地 URL 对（失败返回空串）。"""
    remote_thumb, remote_large = sync_danbooru.fetch_authoritative_images(tag)
    if not remote_thumb:
        return "", ""
    digest = hashlib.md5(tag.encode("utf-8")).hexdigest()
    ext = _guess_img_ext(remote_thumb)
    fname = digest + ext
    fpath = THUMB_DIR / fname
    # 缩略图和大图互不依赖，使用应用级图片线程池并发下载。
    lname = digest + "_l.jpg"
    lpath = THUMB_DIR / lname
    image_ex = getattr(app.state, "image_executor", None)
    thumb_future = None if fpath.exists() else (
        image_ex.submit(sync_danbooru.fetch_image_bytes, remote_thumb)
        if image_ex else None
    )
    large_future = None
    if remote_large and remote_large != remote_thumb and not lpath.exists():
        large_future = (
            image_ex.submit(sync_danbooru.fetch_image_bytes, remote_large)
            if image_ex else None
        )
    thumb_data = thumb_future.result() if thumb_future else (
        sync_danbooru.fetch_image_bytes(remote_thumb) if not fpath.exists() else None
    )
    large_data = large_future.result() if large_future else (
        sync_danbooru.fetch_image_bytes(remote_large)
        if remote_large and remote_large != remote_thumb and not lpath.exists() else None
    )

    thumb_local = ""
    if fpath.exists():
        thumb_local = f"/static/thumbs/{fname}"
    elif thumb_data:
        try:
            fpath.write_bytes(thumb_data)
            thumb_local = f"/static/thumbs/{fname}"
        except OSError:  # noqa: BLE001
            thumb_local = ""

    # 大图：统一压缩为本地 jpg（不存原始大图）
    if lpath.exists():
        large_local = f"/static/thumbs/{lname}"
    elif large_data:
        compressed = imageutil.compress_image_bytes(large_data)
        if compressed:
            try:
                lpath.write_bytes(compressed)
                large_local = f"/static/thumbs/{lname}"
            except OSError:  # noqa: BLE001
                large_local = ""
        else:
            large_local = ""
    else:
        large_local = thumb_local  # 无大图时兜底用同一张
    return thumb_local, large_local


# 全局懒加载后台任务去重锁，线程池由应用 lifespan 管理
import threading  # noqa: E402

_pending_lock = threading.Lock()
_pending = set()


@app.get("/api/thumbs")
def thumbs(tags: str = ""):
    """批量返回 tag 的例图 URL：{tag: {thumb, large}}。异步补抓 + 本地缓存。

    已缓存的立即返回；未缓存的提交后台线程池下载后立即返回结果。
    """
    names = [t.strip() for t in tags.split(",") if t.strip()][:40]
    if not names:
        return {"thumbs": {}, "large": {}}
    conn = _conn()
    hidden = _hidden_tag_names(conn)
    names = [n for n in names if n not in hidden]
    if not names:
        conn.close()
        return {"thumbs": {}, "large": {}}
    try:
        ph = ",".join(["?"] * len(names))
        rows = conn.execute(
            f"SELECT tag_name, thumb_url, thumb_large_url FROM tag_thumbs "
            f"WHERE tag_name IN ({ph})",
            names,
        ).fetchall()
    finally:
        conn.close()
    cached = {r["tag_name"]: (r["thumb_url"], r["thumb_large_url"]) for r in rows}
    missing = [n for n in names if n not in cached or not (cached.get(n) or ("", ""))[0] or not (cached.get(n) or ("", ""))[1]]
    if missing:
        THUMB_DIR.mkdir(parents=True, exist_ok=True)
        ex = getattr(app.state, "thumb_executor", None)
        if ex is None:
            return {
                "thumbs": {n: (cached.get(n) or ("", ""))[0] for n in names},
                "large": {n: (cached.get(n) or ("", ""))[1] for n in names},
            }

        def _bg(tag: str) -> None:
            try:
                pair = _fetch_and_cache(tag)
                if not pair[0]:
                    return
                conn2 = _conn()
                try:
                    conn2.execute(
                        "INSERT INTO tag_thumbs (tag_name, thumb_url, thumb_large_url, fetched_at) "
                        "VALUES (?,?,?,?) "
                        "ON CONFLICT(tag_name) DO UPDATE SET thumb_url=excluded.thumb_url, "
                        "thumb_large_url=excluded.thumb_large_url, fetched_at=excluded.fetched_at",
                        (tag, pair[0], pair[1], db.now_iso()),
                    )
                    conn2.commit()
                finally:
                    conn2.close()
                _enforce_cache_limit(protected={Path(pair[0]).name, Path(pair[1]).name})
            finally:
                with _pending_lock:
                    _pending.discard(tag)

        for n in missing:
            with _pending_lock:
                if n in _pending:
                    continue
                _pending.add(n)
            ex.submit(_bg, n)
    return {
        "thumbs": {n: (cached.get(n) or ("", ""))[0] for n in names},
        "large": {n: (cached.get(n) or ("", ""))[1] for n in names},
    }


class UserSettingsBody(BaseModel):
    adolescent_mode: bool = True
    cache_limit_mb: int = 1024
    proxy_enabled: bool = True
    proxy_url: str = "http://127.0.0.1:7890"
    danbooru_login: str = ""
    danbooru_api_key: str = ""


def _cache_usage_mb() -> float:
    files = [p for p in THUMB_DIR.iterdir() if p.is_file()] if THUMB_DIR.exists() else []
    return round(sum(p.stat().st_size for p in files) / 1024 / 1024, 1)


@app.get("/api/settings")
def get_settings():
    settings = _load_user_settings()
    return {
        "adolescent_mode": settings["adolescent_mode"],
        "cache_limit_mb": settings["cache_limit_mb"],
        "cache_usage_mb": _cache_usage_mb(),
        "proxy_enabled": settings["proxy_enabled"],
        "proxy_url": settings["proxy_url"],
        "danbooru_login": settings["danbooru_login"],
        "has_danbooru_api_key": bool(settings["danbooru_api_key"] or os.environ.get("DANBOORU_API_KEY")),
    }


@app.post("/api/cache/clear")
def clear_thumb_cache():
    removed = 0
    if THUMB_DIR.exists():
        for path in THUMB_DIR.iterdir():
            if not path.is_file():
                continue
            try:
                path.unlink()
                removed += 1
            except OSError:
                continue
    conn = _conn()
    try:
        conn.execute("DELETE FROM tag_thumbs")
        conn.commit()
    finally:
        conn.close()
    return {"ok": True, "removed": removed}


@app.post("/api/settings")
def save_settings(body: UserSettingsBody):
    current = _load_user_settings()
    incoming = body.model_dump()
    # 空 API Key 表示保持原值，避免用户只改青少年模式时意外清空凭据。
    if not incoming["danbooru_api_key"].strip():
        incoming["danbooru_api_key"] = current["danbooru_api_key"]
    incoming["danbooru_login"] = incoming["danbooru_login"].strip()
    incoming["proxy_url"] = incoming["proxy_url"].strip()
    normalized = _load_user_settings()
    normalized.update(incoming)
    _save_user_settings(normalized)
    _enforce_cache_limit()
    return get_settings()


@app.get("/api/catalog")
def catalog_tree():
    """返回目录树：分组 + 子目录（含数量估算）。"""
    conn = _conn()
    try:
        groups_rows = conn.execute(
            "SELECT * FROM tag_catalog WHERE kind='group' ORDER BY sort_order"
        ).fetchall()
        children_rows = conn.execute(
            "SELECT * FROM tag_catalog WHERE kind!='group' ORDER BY sort_order"
        ).fetchall()
        groups = []
        for g in groups_rows:
            kids = [c for c in children_rows if c["group_id"] == g["id"]]
            gcfg = json.loads(g["config_json"]) if g["config_json"] else {}
            groups.append(
                {
                    "id": g["id"],
                    "label": g["label"],
                    "icon": gcfg.get("icon", ""),
                    "collapsed": bool(gcfg.get("collapsed")),
                    "nsfw": bool(g["nsfw"]),
                    "children": [
                        {
                            "id": c["id"],
                            "kind": c["kind"],
                            "label": c["label"],
                            "nsfw": bool(c["nsfw"]),
                            "config": json.loads(c["config_json"]) if c["config_json"] else {},
                        }
                        for c in kids
                    ],
                }
            )
        if _load_user_settings()["adolescent_mode"]:
            groups = [
                {
                    **g,
                    "children": [c for c in g["children"] if not c["nsfw"]],
                }
                for g in groups
                if not g["nsfw"]
            ]
        return {"groups": groups}
    finally:
        conn.close()


@app.get("/api/catalog/{cid}/tags")
def catalog_tags(cid: str, page: int = Query(default=1, ge=1), page_size: int = Query(default=40, le=40), sort: str = "hot"):
    """浏览某个目录的 tag，分页（每页默认 40），排序：hot(热度) / preference(我的偏好)。"""
    conn = _conn()
    try:
        row = conn.execute("SELECT * FROM tag_catalog WHERE id=?", (cid,)).fetchone()
        if row is None:
            raise HTTPException(404, "catalog not found")
        kind = row["kind"]
        cfg = json.loads(row["config_json"]) if row["config_json"] else {}
        hidden_table = _prepare_hidden_table(conn, _hidden_tag_names(conn))

        if _load_user_settings()["adolescent_mode"] and row["nsfw"]:
            raise HTTPException(404, "catalog not found")

        if kind == "danbooru_category":
            cat_id = cfg.get("category")
            visible = f"category=? AND post_count>0 AND NOT EXISTS (SELECT 1 FROM {hidden_table} h WHERE h.tag=t.prompt_tag)"
            total = conn.execute(
                f"SELECT COUNT(*) c FROM tags t WHERE {visible}", (cat_id,),
            ).fetchone()["c"]
            rows = _query_tags(
                conn,
                where=visible,
                params=(cat_id,),
                sort=sort,
                page=page, page_size=page_size,
            )
        elif kind == "taxonomy_category":
            label = cfg.get("taxonomy_label")
            visible = f"m.category_l1=? AND NOT EXISTS (SELECT 1 FROM {hidden_table} h WHERE h.tag=m.tag_name)"
            total = conn.execute(
                f"SELECT COUNT(*) c FROM taxonomy_map m WHERE {visible}", (label,)
            ).fetchone()["c"]
            rows = _query_taxonomy_tags(
                conn, label=label, sort=sort, page=page, page_size=page_size,
                hidden_table=hidden_table,
            )
        elif kind == "restricted_taxonomy":
            sid = cfg.get("section_id")
            visible = f"m.section_id=? AND m.status!='anomalous' AND NOT EXISTS (SELECT 1 FROM {hidden_table} h WHERE h.tag=COALESCE(t.prompt_tag, m.seed))"
            total = conn.execute(
                f"SELECT COUNT(*) c FROM restricted_taxonomy_map m LEFT JOIN tags t ON t.danbooru_name=m.canonical_name WHERE {visible}",
                (sid,),
            ).fetchone()["c"]
            rows = _query_restricted_tags(
                conn, sid, sort=sort, page=page, page_size=page_size,
                hidden_table=hidden_table,
            )
        elif kind == "favorites":
            visible = f"NOT EXISTS (SELECT 1 FROM {hidden_table} h WHERE h.tag=f.tag_name)"
            total = conn.execute(
                f"SELECT COUNT(*) c FROM favorites f WHERE {visible}"
            ).fetchone()["c"]
            rows = conn.execute(
                "SELECT f.tag_name, t.zh_name, t.post_count, t.category, t.danbooru_name FROM favorites f "
                "LEFT JOIN tags t ON t.prompt_tag=f.tag_name "
                f"WHERE {visible} ORDER BY f.created_at DESC LIMIT ? OFFSET ?",
                (page_size, (page - 1) * page_size),
            ).fetchall()
        elif kind == "recent":
            visible = f"NOT EXISTS (SELECT 1 FROM {hidden_table} h WHERE h.tag=r.tag_name)"
            total = conn.execute(
                f"SELECT COUNT(*) c FROM recent_tags r WHERE {visible}"
            ).fetchone()["c"]
            rows = conn.execute(
                "SELECT r.tag_name, t.zh_name, t.post_count, t.category, t.danbooru_name FROM recent_tags r "
                "LEFT JOIN tags t ON t.prompt_tag=r.tag_name "
                f"WHERE {visible} ORDER BY r.last_used_at DESC LIMIT ? OFFSET ?",
                (page_size, (page - 1) * page_size),
            ).fetchall()
        else:
            raise HTTPException(400, f"unknown kind {kind}")

        tags = _serialize_catalog_rows(conn, rows)
        return {
            "id": cid,
            "label": row["label"],
            "kind": kind,
            "total": total,
            "page": page,
            "page_size": page_size,
            "pages": max(1, (total + page_size - 1) // page_size),
            "tags": tags,
        }
    finally:
        conn.close()


def _query_tags(conn, where: str, params: tuple, sort: str, page: int, page_size: int):
    if sort == "preference":
        rows = conn.execute(
            f"""
            SELECT t.prompt_tag, t.zh_name, t.post_count, t.category, t.danbooru_name,
                   COALESCE(f.fav, 0) AS fav, COALESCE(r.rec, 0) AS rec
            FROM tags t
            LEFT JOIN (SELECT tag_name, 1 fav FROM favorites) f ON f.tag_name = t.prompt_tag
            LEFT JOIN (SELECT tag_name, 1 rec FROM recent_tags) r ON r.tag_name = t.prompt_tag
            WHERE {where}
            ORDER BY fav DESC, rec DESC, t.post_count DESC
            LIMIT ? OFFSET ?
            """,
            (*params, page_size, (page - 1) * page_size),
        )
    else:
        rows = conn.execute(
            f"SELECT t.prompt_tag, t.zh_name, t.post_count, t.category, t.danbooru_name FROM tags t "
            f"WHERE {where} ORDER BY t.post_count DESC LIMIT ? OFFSET ?",
            (*params, page_size, (page - 1) * page_size),
        )
    return rows


def _query_taxonomy_tags(
    conn, label: str, sort: str, page: int, page_size: int, hidden_table: str
):
    hidden = f"NOT EXISTS (SELECT 1 FROM {hidden_table} h WHERE h.tag=m.tag_name)"
    if sort == "preference":
        rows = conn.execute(
            f"""
            SELECT t.prompt_tag, t.zh_name, t.post_count, t.category, t.danbooru_name,
                   COALESCE(f.fav, 0) AS fav, COALESCE(r.rec, 0) AS rec
            FROM taxonomy_map m
            JOIN tags t ON t.prompt_tag = m.tag_name
            LEFT JOIN (SELECT tag_name, 1 fav FROM favorites) f ON f.tag_name = t.prompt_tag
            LEFT JOIN (SELECT tag_name, 1 rec FROM recent_tags) r ON r.tag_name = t.prompt_tag
            WHERE m.category_l1 = ? AND {hidden}
            ORDER BY fav DESC, rec DESC, t.post_count DESC
            LIMIT ? OFFSET ?
            """,
            (label, page_size, (page - 1) * page_size),
        )
    else:
        rows = conn.execute(
            f"""
            SELECT t.prompt_tag, t.zh_name, t.post_count, t.category, t.danbooru_name
            FROM taxonomy_map m JOIN tags t ON t.prompt_tag = m.tag_name
            WHERE m.category_l1 = ? AND {hidden}
            ORDER BY t.post_count DESC LIMIT ? OFFSET ?
            """,
            (label, page_size, (page - 1) * page_size),
        )
    return rows


def _query_restricted_tags(
    conn, section_id: str, sort: str, page: int, page_size: int, hidden_table: str
):
    """受限 taxonomy 分区：resolved 显示 canonical，unresolved 保留原始 seed（不丢弃）。"""
    if sort == "preference":
        rows = conn.execute(
            f"""
            SELECT COALESCE(t.prompt_tag, m.seed) AS prompt_tag,
                   COALESCE(t.zh_name, '') AS zh_name,
                   COALESCE(t.post_count, 0) AS post_count,
                   COALESCE(t.category, 0) AS category,
                   t.danbooru_name AS danbooru_name,
                   COALESCE(f.fav, 0) AS fav, COALESCE(r.rec, 0) AS rec
            FROM restricted_taxonomy_map m
            LEFT JOIN tags t ON t.danbooru_name = m.canonical_name
            LEFT JOIN (SELECT tag_name, 1 fav FROM favorites) f
                ON f.tag_name = COALESCE(t.prompt_tag, m.seed)
            LEFT JOIN (SELECT tag_name, 1 rec FROM recent_tags) r
                ON r.tag_name = COALESCE(t.prompt_tag, m.seed)
            WHERE m.section_id = ? AND m.status != 'anomalous'
              AND NOT EXISTS (SELECT 1 FROM {hidden_table} h WHERE h.tag=COALESCE(t.prompt_tag, m.seed))
            ORDER BY fav DESC, rec DESC, post_count DESC
            LIMIT ? OFFSET ?
            """,
            (section_id, page_size, (page - 1) * page_size),
        )
    else:
        rows = conn.execute(
            """
            SELECT COALESCE(t.prompt_tag, m.seed) AS prompt_tag,
                   COALESCE(t.zh_name, '') AS zh_name,
                   COALESCE(t.post_count, 0) AS post_count,
                   COALESCE(t.category, 0) AS category,
                   t.danbooru_name AS danbooru_name
            FROM restricted_taxonomy_map m
            LEFT JOIN tags t ON t.danbooru_name = m.canonical_name
            WHERE m.section_id = ? AND m.status != 'anomalous'
            ORDER BY post_count DESC LIMIT ? OFFSET ?
            """,
            (section_id, page_size, (page - 1) * page_size),
        )
    return rows


def _serialize_catalog_rows(conn, rows):
    """把目录查询行统一序列化为公开 DTO，并填充 favorite 标记与用户备注覆盖。"""
    favs = {r["tag_name"] for r in conn.execute("SELECT tag_name FROM favorites")}
    out = []
    for r in rows:
        item = db.serialize_tag(r)
        if item is None:
            continue
        item["favorite"] = item["tag"] in favs
        out.append(item)
    _apply_user_zh(conn, out)
    return out

@app.get("/api/tag/{name}")
def tag_detail(name: str):
    conn = _conn()
    try:
        row = conn.execute(
            "SELECT * FROM tags WHERE lower(prompt_tag)=? OR lower(danbooru_name)=? LIMIT 1",
            (name.lower(), name.lower()),
        ).fetchone()
        if row is None:
            raise HTTPException(404, "tag not found")
        d = db.tag_dict(row)
        _apply_user_zh(conn, d)
        d["category_name"] = db.CATEGORY_NAMES.get(d.get("category"), "General")
        return d
    finally:
        conn.close()


@app.get("/api/status/{name}")
def status(name: str):
    conn = _conn()
    try:
        return {"tag": name, "status": search.seed_status(conn, name)}
    finally:
        conn.close()


@app.get("/api/category/{cat_id}")
def category_browse(cat_id: int, offset: int = Query(default=0), limit: int = Query(default=100, le=500)):
    """浏览某个 Danbooru category（0 General / 1 Artist / 3 Copyright / 4 Character / 5 Meta）的热门 tag。"""
    conn = _conn()
    try:
        total = conn.execute(
            "SELECT COUNT(*) c FROM tags WHERE category=? AND post_count>0", (cat_id,)
        ).fetchone()["c"]
        rows = conn.execute(
            "SELECT prompt_tag, zh_name, post_count, is_deprecated, category FROM tags "
            "WHERE category=? AND post_count>0 ORDER BY post_count DESC LIMIT ? OFFSET ?",
            (cat_id, limit, offset),
        ).fetchall()
        tags = [db.tag_dict(r) for r in rows]
        _apply_user_zh(conn, tags)
        return {
            "category": cat_id,
            "category_name": db.CATEGORY_NAMES.get(cat_id, "General"),
            "total": total,
            "tags": tags,
        }
    finally:
        conn.close()


# ---------- Prompt 导入（对话 / 粘贴） ----------

import threading  # noqa: E402

_INBOX_LOCK = threading.Lock()
_INBOX = {"seq": 0, "state": None}


class ImportRequest(BaseModel):
    text: str
    mode: str = "replace"  # replace | append


@app.post("/api/import")
def import_prompt(req: ImportRequest):
    """解析一段 NovelAI 提示词，写入导入收件箱，前端轮询后自动填充右侧购物车。"""
    parsed = import_parser.parse(req.text)
    with _INBOX_LOCK:
        _INBOX["seq"] += 1
        _INBOX["state"] = {"mode": req.mode, "parsed": parsed}
        return {"seq": _INBOX["seq"], "mode": req.mode, "parsed": parsed}


class ImportPreviewRequest(BaseModel):
    text: str


def _fuzzy_candidates(conn, raw_tag: str, limit: int = 5) -> list[dict]:
    """对库内无法精确匹配的 tag 给出相似候选。

    候选池 = 完整 q 的 LIKE 命中 ∪ 任一 token 的 LIKE 命中（覆盖词序颠倒场景）；
    排序用 token 证据多键（token_key 全等 → 完整 token 交集 → 覆盖率 → 序列比），
    字符巧合（如 'orange hat' 含子串 range）不会盖过真实 token 命中。
    """
    q = search._norm(raw_tag)
    if not q:
        return []
    tokens = search._tokens_in_layer(q)
    like_q = search._like_escape(q)
    pool: list[str] = []
    rows = conn.execute(
        "SELECT prompt_tag FROM tags WHERE lower(prompt_tag) LIKE ? ESCAPE '\\' ORDER BY post_count DESC LIMIT 200",
        (f"%{like_q}%",),
    ).fetchall()
    pool.extend(r["prompt_tag"] for r in rows)
    if tokens:
        like = [search._like_escape(t) for t in tokens]
        cond = " OR ".join(["lower(prompt_tag) LIKE ? ESCAPE '\\'"] * len(tokens))
        rows = conn.execute(
            f"SELECT prompt_tag FROM tags WHERE {cond} ORDER BY post_count DESC LIMIT 3000",
            tuple(f"%{t}%" for t in like),
        ).fetchall()
        pool.extend(r["prompt_tag"] for r in rows)
    if not pool:
        rows = conn.execute(
            "SELECT prompt_tag FROM tags ORDER BY post_count DESC LIMIT 20000"
        ).fetchall()
        pool = [r["prompt_tag"] for r in rows]
    seen: set[str] = set()
    scored = sorted(
        (s for s in pool if not (s in seen or seen.add(s))),
        key=lambda s: search.token_similarity_keys(q, s),
        reverse=True,
    )[:limit]
    return [{"tag": s} for s in scored]


@app.post("/api/import/preview")
def import_preview(req: ImportPreviewRequest):
    """解析导入文本，并逐 tag 校验：是否已在库中、未命中给出相似候选。

    返回结构：
    {
      "segments": [
        {"label": "Base", "kind": "base", "entries": [
          {"raw": "blue eyes", "match": {"tag": "blue eyes"} | None,
           "candidates": [{"tag": "..."}]}
        ]}
      ],
      "characters": [...], "global_uc": [...], "free_text": "..."
    }
    """
    parsed = import_parser.parse(req.text)
    conn = _conn()
    try:
        def check(entries: list[dict]) -> list[dict]:
            out = []
            for e in entries:
                tag = e.get("tag", "")
                hit = search.resolve_tag(conn, tag)
                candidates = []
                if not hit:
                    # 用户自定义库优先匹配
                    custom = conn.execute(
                        "SELECT tag_name FROM user_tags WHERE lower(tag_name)=?",
                        (tag.strip().lower(),),
                    ).fetchone()
                    if custom:
                        hit = {"tag": custom["tag_name"], "via": "user_tags"}
                    else:
                        candidates = _fuzzy_candidates(conn, tag)
                out.append({
                    "raw": tag,
                    "match": {"tag": hit["tag"], "via": hit.get("via", "canonical")} if hit else None,
                    "candidates": candidates,
                    "entry": e,
                })
            return out

        segments = []
        if parsed.get("base"):
            segments.append({"label": "Base Prompt", "kind": "base", "entries": check(parsed["base"])})
        for i, c in enumerate(parsed.get("characters") or []):
            seg = {"label": c.get("name") or f"Character {i+1}", "kind": "char", "index": i, "entries": []}
            if c.get("prompt"):
                seg["entries"].extend(check(c["prompt"]))
            if c.get("uc"):
                seg["entries"].extend([{**x, "uc": True} for x in check(c["uc"])])
            if seg["entries"]:
                segments.append(seg)
        if parsed.get("global_uc"):
            segments.append({"label": "Global UC", "kind": "global_uc", "entries": check(parsed["global_uc"])})
        return {
            "segments": segments,
            "free_text": parsed.get("free_text", ""),
            "stats": {"total": sum(len(s["entries"]) for s in segments),
                      "unmatched": sum(1 for s in segments for e in s["entries"] if not e["match"])},
        }
    finally:
        conn.close()


class UserTagRequest(BaseModel):
    tag: str
    note: str = ""


@app.post("/api/user-tags")
def add_user_tag(req: UserTagRequest):
    """把自定义 tag 备注入本地库（无法在 Danbooru 词库匹配时使用）。"""
    tag = req.tag.strip()
    if not tag:
        raise HTTPException(400, "empty tag")
    conn = _conn()
    try:
        conn.execute(
            "INSERT INTO user_tags (tag_name, note, created_at) VALUES (?,?,?) "
            "ON CONFLICT(tag_name) DO UPDATE SET note=excluded.note, created_at=excluded.created_at",
            (tag, req.note.strip(), db.now_iso()),
        )
        conn.commit()
        return {"ok": True, "tag": tag}
    finally:
        conn.close()


@app.delete("/api/user-tags/{tag}")
def del_user_tag(tag: str):
    conn = _conn()
    try:
        conn.execute("DELETE FROM user_tags WHERE tag_name=?", (tag,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@app.get("/api/inbox")
def inbox(since: int = 0):
    with _INBOX_LOCK:
        if _INBOX["seq"] > since:
            return {"seq": _INBOX["seq"], "state": _INBOX["state"]}
        return {"seq": _INBOX["seq"], "state": None}


# ---------- 导出 ----------

class ExportRequest(BaseModel):
    model: str = "v5"
    base_prompt: list = []
    characters: list = []
    global_uc: list = []
    free_text: str = ""


@app.post("/api/export")
def export(req: ExportRequest):
    state = req.model_dump()
    return novelai_export.export(state)


# ---------- 收藏 / 最近 / 预设 ----------

@app.get("/api/favorites")
def list_favorites():
    conn = _conn()
    try:
        rows = conn.execute(
            "SELECT f.tag_name, f.created_at, t.post_count, t.zh_name FROM favorites f "
            "LEFT JOIN tags t ON t.prompt_tag=f.tag_name ORDER BY f.created_at DESC"
        ).fetchall()
        hidden = _hidden_tag_names(conn)
        items = [item for item in (db.tag_dict(r) for r in rows) if item and item.get("tag") not in hidden]
        _apply_user_zh(conn, items)
        return {"favorites": items}
    finally:
        conn.close()


class TagBody(BaseModel):
    tag: str


@app.post("/api/favorites")
def add_favorite(body: TagBody):
    tag = body.tag.strip()
    if not tag:
        raise HTTPException(400, "empty tag")
    conn = _conn()
    try:
        conn.execute(
            "INSERT INTO favorites (tag_name, created_at) VALUES (?, ?) "
            "ON CONFLICT(tag_name) DO NOTHING",
            (tag, db.now_iso()),
        )
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@app.delete("/api/favorites/{tag}")
def del_favorite(tag: str):
    conn = _conn()
    try:
        conn.execute("DELETE FROM favorites WHERE tag_name=?", (tag,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@app.get("/api/recent")
def list_recent():
    conn = _conn()
    try:
        rows = conn.execute(
            "SELECT * FROM recent_tags ORDER BY last_used_at DESC LIMIT 50"
        ).fetchall()
        items = [db.tag_dict(r) for r in rows]
        _apply_user_zh(conn, items)
        return {"recent": items}
    finally:
        conn.close()


@app.post("/api/recent")
def add_recent(body: TagBody):
    tag = body.tag.strip()
    if not tag:
        raise HTTPException(400, "empty tag")
    conn = _conn()
    try:
        conn.execute(
            "INSERT INTO recent_tags (tag_name, last_used_at, use_count) VALUES (?, ?, 1) "
            "ON CONFLICT(tag_name) DO UPDATE SET last_used_at=excluded.last_used_at, "
            "use_count=recent_tags.use_count+1",
            (tag, db.now_iso()),
        )
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@app.get("/api/presets")
def list_presets():
    conn = _conn()
    try:
        rows = conn.execute("SELECT id, name, kind, updated_at FROM presets ORDER BY updated_at DESC").fetchall()
        return {"presets": [dict(r) for r in rows]}
    finally:
        conn.close()


class PresetBody(BaseModel):
    name: str
    kind: str = "prompt"
    payload: dict


@app.post("/api/presets")
def save_preset(body: PresetBody):
    conn = _conn()
    try:
        import json

        cur = conn.execute(
            "INSERT INTO presets (name, kind, payload_json, updated_at) VALUES (?, ?, ?, ?)",
            (body.name.strip(), body.kind, json.dumps(body.payload, ensure_ascii=False), db.now_iso()),
        )
        conn.commit()
        return {"ok": True, "id": cur.lastrowid}
    finally:
        conn.close()


@app.get("/api/presets/{pid}")
def get_preset(pid: int):
    conn = _conn()
    try:
        import json

        row = conn.execute("SELECT * FROM presets WHERE id=?", (pid,)).fetchone()
        if row is None:
            raise HTTPException(404, "preset not found")
        d = dict(row)
        d["payload"] = json.loads(d.pop("payload_json"))
        return d
    finally:
        conn.close()


@app.delete("/api/presets/{pid}")
def del_preset(pid: int):
    conn = _conn()
    try:
        conn.execute("DELETE FROM presets WHERE id=?", (pid,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


# ---------- 数据更新 ----------

@app.post("/api/sync")
def sync(min_post_count: int = Query(default=10), max_pages: int = Query(default=50)):
    """手动更新标签库（规格 26 节）。断网会返回错误信息而不抛崩。"""
    summary = sync_danbooru.run(min_post_count=min_post_count, max_pages=max_pages)
    return summary


@app.post("/api/sync-hot")
def sync_hot():
    """按热度同步热门 general/character/artist/copyright/meta tag（需代理可达 Danbooru）。"""
    return sync_danbooru.run_hot_sync()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app:app",
        host=SETTINGS.get("host", "127.0.0.1"),
        port=SETTINGS.get("port", 8123),
    )
