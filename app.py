"""NovelAI V5 本地提示词标签超市 —— FastAPI 后端。

只监听 127.0.0.1，单机工具，无需认证/TLS。
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import json
import math
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import threading
import zipfile
from typing import Any
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import db  # noqa: E402
import gallery_memory  # noqa: E402
import imageutil  # noqa: E402
import search  # noqa: E402
from importer import build_catalog, import_aliases, import_danbooru_zh, import_restricted, import_taxonomy, sync_danbooru  # noqa: E402
from prompt import auto_split, composer, import_parser, novelai_export, recommendation, related_client, sections as prompt_sections  # noqa: E402

from fastapi import FastAPI, File, HTTPException, Query, UploadFile  # noqa: E402
from fastapi.responses import FileResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
THUMB_DIR = STATIC_DIR / "thumbs"
NOVELAI_EXAMPLE_DIR = STATIC_DIR / "novelai-examples"
NOVELAI_EXAMPLE_MODEL = "nai-diffusion-4-5-full"
NOVELAI_EXAMPLE_WIDTH = 832
NOVELAI_EXAMPLE_HEIGHT = 832
NOVELAI_EXAMPLE_STEPS = 28
NOVELAI_EXAMPLE_COOLDOWN_SECONDS = 8
# 生成 NovelAI 标签例图时使用的默认提示词模板。
# {tag} 会被替换为目标标签（自动加双花括号强调），{rating} 替换为 safe / nsfw。
NOVELAI_EXAMPLE_PROMPT_TEMPLATE = "{tag}, {rating}, masterpiece, best quality, very aesthetic, absurdres"
GALLERY_DIR = BASE_DIR / "data" / "gallery"
GALLERY_TRASH_DIR = BASE_DIR / "待清理" / "图库"
APP_SETTINGS_PATH = BASE_DIR / "config" / "app_settings.json"
SETTINGS = db.load_json(APP_SETTINGS_PATH) if APP_SETTINGS_PATH.is_file() else {}
# 语义导航：创作概念骨架（Base/Character），供导航树与推荐上下文使用（不含 embedding/LLM/向量库）。
PROMPT_NAVIGATION_PATH = BASE_DIR / "config" / "prompt_navigation.json"
# WorkBuddy 本机目录：默认 ~/.workbuddy，可用环境变量 WORKBUDDY_HOME 覆盖（与 server/start-nai.sh 一致）。
WORKBUDDY_HOME = Path(os.path.expanduser(os.getenv("WORKBUDDY_HOME") or "~/.workbuddy"))
USER_SETTINGS_PATH = WORKBUDDY_HOME / "tags-market-settings.json"
DEFAULT_USER_SETTINGS = {
    "adolescent_mode": True,
    "cache_limit_mb": 1024,
    "proxy_enabled": True,
    "proxy_url": "",
    "danbooru_login": "",
    "danbooru_api_key": "",
    "novelai_api_token": "",
    "novelai_batch_max_count": 6,
    "novelai_example_credit_warning": True,
    "novelai_example_prompt_template": NOVELAI_EXAMPLE_PROMPT_TEMPLATE,
    "baidu_translate_appid": "",
    "baidu_translate_secret": "",
}
BAIDU_TRANSLATE_URL = "https://fanyi-api.baidu.com/api/trans/vip/translate"
BAIDU_TRANSLATE_TIMEOUT = 12
_translate_lock = threading.Lock()
_translate_last_request = 0.0
NOVELAI_SERVICE_URL = "http://127.0.0.1:8787"
NOVELAI_SERVICE_START_TIMEOUT = 12.0
MANAGED_NODE_BIN = WORKBUDDY_HOME / "binaries" / "node" / "versions" / "22.12.0" / "bin" / "node"
MANAGED_NODE_MODULES = WORKBUDDY_HOME / "binaries" / "node" / "workspace" / "node_modules"


def _live_reload_enabled() -> bool:
    """本地工作台默认热重载；部署或排障时可显式关闭。"""
    return os.environ.get("TAGS_MARKET_RELOAD", "1").strip().lower() not in {"0", "false", "no"}


def _novelai_service_ready(timeout: float = 0.5) -> bool:
    try:
        with urllib.request.urlopen(f"{NOVELAI_SERVICE_URL}/api/novelai/status?probe=0", timeout=timeout) as response:
            return response.status == 200
    except (OSError, urllib.error.URLError, urllib.error.HTTPError):
        return False


def _node_executable() -> str:
    configured = os.environ.get("NODE_BIN", "").strip()
    if configured and Path(configured).is_file():
        return configured
    if MANAGED_NODE_BIN.is_file():
        return str(MANAGED_NODE_BIN)
    discovered = shutil.which("node")
    if discovered:
        return discovered
    raise RuntimeError("未找到 Node.js 22.5+，无法自动启动 NovelAI 本地服务")


def _novelai_pidfile_path() -> Path:
    """node 服务 owner 记录文件（与 novelai-service.log 同目录）。"""
    return BASE_DIR / ".workbuddy" / "runtime" / "novelai-service.pid"


def _read_novelai_pidfile() -> dict | None:
    """读取 node 服务的 owner 记录 {parent_pid, node_pid}；缺失/损坏返回 None。"""
    try:
        data = json.loads(_novelai_pidfile_path().read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _write_novelai_pidfile(node_pid: int | None) -> None:
    """把本进程声明为 8787 node 服务的 owner（原子写入，失败不抛出）。"""
    try:
        path = _novelai_pidfile_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps({"parent_pid": os.getpid(), "node_pid": node_pid}, ensure_ascii=False)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(payload, encoding="utf-8")
        os.replace(tmp, path)
    except OSError:
        pass


def _remove_novelai_pidfile() -> None:
    """删除 pidfile，但仅当它仍指向本进程（避免误删别的实例的 owner 记录）。"""
    owner = _read_novelai_pidfile()
    if owner is not None and owner.get("parent_pid") == os.getpid():
        try:
            _novelai_pidfile_path().unlink(missing_ok=True)
        except OSError:
            pass


def _app_port_available(host: str, port: int) -> bool:
    """返回 True 当 (host, port) 当前可被本进程绑定（即没有其它 app.py 占用）。

    用于 lifespan 启动阶段预判：若 8123 已被别的实例占用，则本实例稍后绑定必然失败、
    属于「冗余实例」，退出时不得杀掉仍在健康服务的 node。
    """
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind((host, port))
        return True
    except OSError:
        return False


def _start_novelai_service() -> tuple[subprocess.Popen | None, object | None]:
    if os.environ.get("TAGS_MARKET_AUTOSTART_NAI", "1").strip().lower() in {"0", "false", "no"}:
        return None, None
    if _novelai_service_ready():
        return None, None

    node = _node_executable()
    server_dir = BASE_DIR / "server"
    server_entry = server_dir / "server.mjs"
    if not server_entry.is_file():
        raise RuntimeError(f"NovelAI 本地服务入口不存在：{server_entry}")

    runtime_dir = BASE_DIR / ".workbuddy" / "runtime"
    runtime_dir.mkdir(parents=True, exist_ok=True)
    log_handle = (runtime_dir / "novelai-service.log").open("a", encoding="utf-8")
    env = os.environ.copy()
    env["NODE_OPTIONS"] = ""
    env["PYTHON_APP_URL"] = f"http://{SETTINGS.get('host', '127.0.0.1')}:{SETTINGS.get('port', 8123)}"
    if MANAGED_NODE_MODULES.is_dir():
        env["NODE_PATH"] = str(MANAGED_NODE_MODULES)
    node_args = [node]
    if _live_reload_enabled():
        node_args.append("--watch")
    node_args.extend(["--experimental-sqlite", str(server_entry), "--port", "8787", "--no-boot"])
    process = subprocess.Popen(
        node_args,
        cwd=server_dir,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=log_handle,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )

    deadline = time.monotonic() + NOVELAI_SERVICE_START_TIMEOUT
    while time.monotonic() < deadline:
        if process.poll() is not None:
            log_handle.close()
            raise RuntimeError(
                f"NovelAI 本地服务启动失败（退出码 {process.returncode}），"
                "请查看 .workbuddy/runtime/novelai-service.log"
            )
        if _novelai_service_ready():
            _write_novelai_pidfile(getattr(process, "pid", None))
            print(f"NovelAI 本地服务已自动启动：{NOVELAI_SERVICE_URL}")
            return process, log_handle
        time.sleep(0.1)

    process.terminate()
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=3)
    log_handle.close()
    raise RuntimeError("NovelAI 本地服务启动超时，请查看 .workbuddy/runtime/novelai-service.log")


def _stop_novelai_service(
    process: subprocess.Popen | None,
    log_handle: object | None,
    graceful: bool = True,
) -> None:
    """停止本实例托管的 node 子进程，但绝不动别的 app.py 实例的 node。

    防互杀守卫：只有「pidfile 声明的 owner 就是本进程」且「本实例确实接管了 8123
    （graceful 关闭）」时，才 terminate 自己 spawn 的 node。其余情况（别的实例的 node、
    或本实例因 8123 被占用而启动失败、即将退出）一律只清理自己的句柄，不杀 node。
    """
    try:
        if process is None or process.poll() is not None:
            return
        owner = _read_novelai_pidfile()
        owns_node = owner is not None and owner.get("parent_pid") == os.getpid()
        if not owns_node:
            # 该 node 是别的 app.py 实例启动的（或 pidfile 已易主），绝不碰。
            return
        if not graceful and _novelai_service_ready():
            # 本实例并未真正接管 8123（如端口被占、启动失败即将退出），
            # 而 node 仍健康对外服务——不要拖垮它，仅清理本进程残留的 pidfile 声明。
            _remove_novelai_pidfile()
            return
        # 正常关闭（或 node 已不健康）：terminate 自己 spawn 的 node 并清理 pidfile。
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=3)
        _remove_novelai_pidfile()
    finally:
        if log_handle is not None:
            log_handle.close()


def _parse_bool(value, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and value in (0, 1):
        return bool(value)
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "1", "yes", "on"}:
            return True
        if normalized in {"false", "0", "no", "off"}:
            return False
    return default


def _load_user_settings() -> dict:
    data = dict(DEFAULT_USER_SETTINGS)
    try:
        raw = json.loads(USER_SETTINGS_PATH.read_text(encoding="utf-8"))
        if isinstance(raw, dict):
            data.update(raw)
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        pass
    data["adolescent_mode"] = _parse_bool(data.get("adolescent_mode"), True)
    try:
        data["cache_limit_mb"] = max(0, min(102400, int(data.get("cache_limit_mb", 1024))))
    except (TypeError, ValueError):
        data["cache_limit_mb"] = 1024
    data["proxy_enabled"] = _parse_bool(data.get("proxy_enabled"), True)
    data["proxy_url"] = str(os.environ.get("NAI_PROXY_URL") or data.get("proxy_url") or DEFAULT_USER_SETTINGS["proxy_url"]).strip()
    data["danbooru_login"] = str(data.get("danbooru_login") or "").strip()
    data["danbooru_api_key"] = str(data.get("danbooru_api_key") or "").strip()
    data["novelai_api_token"] = str(os.environ.get("NOVELAI_API_KEY") or data.get("novelai_api_token") or "").strip()
    data["baidu_translate_appid"] = str(os.environ.get("BAIDU_TRANSLATE_APPID") or data.get("baidu_translate_appid") or "").strip()
    data["baidu_translate_secret"] = str(os.environ.get("BAIDU_TRANSLATE_SECRET") or data.get("baidu_translate_secret") or "").strip()
    try:
        data["novelai_batch_max_count"] = max(1, min(6, int(data.get("novelai_batch_max_count", 6))))
    except (TypeError, ValueError):
        data["novelai_batch_max_count"] = 6
    data["novelai_example_credit_warning"] = _parse_bool(data.get("novelai_example_credit_warning"), True)
    tpl = data.get("novelai_example_prompt_template")
    if not isinstance(tpl, str) or "{tag}" not in tpl:
        tpl = NOVELAI_EXAMPLE_PROMPT_TEMPLATE
    data["novelai_example_prompt_template"] = tpl.strip()
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


def _valid_cached_thumb_url(url: str) -> bool:
    """Only expose non-empty local cache files; stale DB rows must be refetched."""
    if not url or not url.startswith("/static/thumbs/"):
        return False
    name = url.rsplit("/", 1)[-1]
    if not name or Path(name).name != name:
        return False
    path = THUMB_DIR / name
    try:
        return path.is_file() and path.stat().st_size > 0
    except OSError:
        return False


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
        if n_tax == 0 and import_taxonomy.SEED_PATH.is_file():
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
    app.state.novelai_service_process = None
    app.state.novelai_service_log = None
    app.state.novelai_service_error = None
    app.state.novelai_service_owns_port = True
    try:
        process, log_handle = _start_novelai_service()
        app.state.novelai_service_process = process
        app.state.novelai_service_log = log_handle
        # 预判本实例能否真正接管 8123：若端口已被别的 app.py 占用，则稍后绑定必然失败，
        # 退出时不得杀掉仍在健康服务的 node（防互杀）。
        app.state.novelai_service_owns_port = _app_port_available(
            SETTINGS.get("host", "127.0.0.1"),
            SETTINGS.get("port", 8123),
        )
    except RuntimeError as exc:
        app.state.novelai_service_error = str(exc)
        print(f"NovelAI 本地服务自动启动失败：{exc}", file=sys.stderr)
    try:
        yield
    finally:
        _stop_novelai_service(
            app.state.novelai_service_process,
            app.state.novelai_service_log,
            graceful=app.state.novelai_service_owns_port,
        )
        app.state.thumb_executor.shutdown(wait=True, cancel_futures=True)
        app.state.image_executor.shutdown(wait=True, cancel_futures=True)


app = FastAPI(title="NovelAI Prompt Builder", lifespan=lifespan)

_cache_exts = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".svg", ".ico", ".css", ".js", ".woff2", ".woff"}


@app.middleware("http")
async def add_cache_headers(request, call_next):
    """图库图片长缓存；应用 JS/CSS/HTML 始终重新验证，避免升级后卡在旧前端。"""
    response = await call_next(request)
    path = request.url.path
    ext = Path(path).suffix.lower()
    if path.startswith("/gallery/") and ext in _cache_exts and response.status_code < 400:
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    elif path.startswith("/static/") or path == "/":
        response.headers["Cache-Control"] = "no-cache"
    return response


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
NOVELAI_EXAMPLE_DIR.mkdir(parents=True, exist_ok=True)
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
ALLOWED_IMAGE_MIME = {"image/png", "image/jpeg", "image/webp", "image/gif", "image/avif", "image/bmp"}
GALLERY_MIME_EXT = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/avif": ".avif",
    "image/bmp": ".bmp",
}
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


def _move_gallery_to_cleanup(path: Path, category: str) -> Path | None:
    """把图库文件移入项目内待清理区，避免直接永久删除。"""
    if not path.exists():
        return None
    cleanup_dir = GALLERY_TRASH_DIR / category
    cleanup_dir.mkdir(parents=True, exist_ok=True)
    destination = cleanup_dir / f"{path.name}-{uuid.uuid4().hex[:8]}"
    os.replace(path, destination)
    return destination


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
        created_paths: list[Path] = []
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
                    if not imageutil.is_valid_image_bytes(data):
                        failed += 1
                        continue
                    prompt = _prompt_from_filename(fname)
                    short = re.sub(r'[\\/:*?"<>|,{}\[\]()\s]+', "_", prompt).strip("._ ") or "img"
                    short = short[:40].strip("_") or "img"
                    # 保留 ZIP 中的原始图片字节与扩展名；列表/预览由 CSS 缩放，不再落盘低清 JPEG。
                    out_name = f"{uuid.uuid4().hex}_{short}{ext}"
                    out_path = target / out_name
                    temp_out = target / f".{out_name}.tmp"
                    try:
                        temp_out.write_bytes(data)
                        os.replace(temp_out, out_path)
                    except OSError:  # noqa: BLE001
                        temp_out.unlink(missing_ok=True)
                        failed += 1
                        continue
                    created_paths.append(out_path)
                    conn.execute(
                        "INSERT INTO gallery (dir_name, file_name, prompt, file_path, created_at) "
                        "VALUES (?,?,?,?,?)",
                        (dir_name, fname, prompt, str(out_path.relative_to(BASE_DIR)), db.now_iso()),
                    )
                    imported += 1
            conn.commit()
        except Exception:
            conn.rollback()
            for created_path in created_paths:
                try:
                    _move_gallery_to_cleanup(created_path, "ZIP导入失败")
                except OSError:
                    pass
            raise
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
    snapshot_id: str | None = None
    source_asset_id: str | None = None
    parent: dict | None = None


@app.post("/api/gallery/item")
async def gallery_item(body: GalleryItemBody):
    """单张图片入库：base64 → 压缩 → 存 data/gallery/<dir>/ → 建索引。

    Python 图库保存正负提示词、完整参数与 Node 资产 ID，后者用于幂等同步。
    """
    dir_name = _sanitize_dir_name(body.dir_name)
    conn = _conn()
    try:
        if body.source_asset_id:
            existing = conn.execute(
                "SELECT * FROM gallery WHERE source_asset_id=?", (body.source_asset_id,)
            ).fetchone()
            if existing:
                return _gallery_item_dict(conn, existing)
        if body.snapshot_id and not conn.execute(
            "SELECT 1 FROM prompt_snapshot WHERE id=?", (body.snapshot_id,)
        ).fetchone():
            raise HTTPException(404, "snapshot not found")
    finally:
        conn.close()
    target = _safe_gallery_path(dir_name)
    target.mkdir(parents=True, exist_ok=True)
    encoded = (body.image_base64 or "").strip()
    if "," in encoded and encoded.lower().startswith("data:"):
        header, encoded = encoded.split(",", 1)
        if ";base64" not in header.lower():
            raise HTTPException(400, "图片 base64 无效")
    try:
        data = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError, TypeError) as exc:
        raise HTTPException(400, "图片 base64 无效") from exc
    if not data or len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(400, "图片数据无效或过大（>50MB）")
    mime = (body.mime or "").strip().lower()
    if mime not in ALLOWED_IMAGE_MIME:
        raise HTTPException(400, "非法图片类型")
    short = re.sub(r'[\\/:*?"<>|,{}\[\]()\s]+', "_", body.prompt).strip("._ ") or "img"
    short = short[:40].strip("_") or "img"
    ext = GALLERY_MIME_EXT[mime]
    fname = f"{uuid.uuid4().hex}_{short}{ext}"
    out_path = target / fname
    temp_out = target / f".{fname}.tmp"
    try:
        # 保留 Node/NovelAI 返回的原始图片字节；前端只缩放显示，不降低源文件清晰度。
        temp_out.write_bytes(data)
        os.replace(temp_out, out_path)
    except OSError:  # noqa: BLE001
        temp_out.unlink(missing_ok=True)
        raise HTTPException(500, "图片写入失败")
    prompt = body.prompt.strip()
    parent_payload = gallery_memory.parent_payload(body.parent, body.parameters)
    conn = _conn()
    try:
        cur = conn.execute(
            "INSERT INTO gallery (dir_name, file_name, prompt, file_path, created_at, negative_prompt, "
            "parameters_json, snapshot_id, source_asset_id, parent_json) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (dir_name, fname, prompt, str(out_path.relative_to(BASE_DIR)), db.now_iso(),
             (body.negative_prompt or "").strip(),
             json.dumps(body.parameters, ensure_ascii=False) if body.parameters else None,
             body.snapshot_id, body.source_asset_id,
             json.dumps(parent_payload, ensure_ascii=False) if parent_payload else None),
        )
        conn.execute(
            "INSERT INTO generation (snapshot_id, gallery_id, source_asset_id, parameters_json, created_at) "
            "VALUES (?,?,?,?,?)",
            (body.snapshot_id, cur.lastrowid, body.source_asset_id,
             json.dumps(body.parameters, ensure_ascii=False) if body.parameters else None, db.now_iso()),
        )
        # 成功生成 → 事件驱动的正向学习（作用域共现），仅此路径触发学习。
        if body.snapshot_id:
            snapshot_row = conn.execute(
                "SELECT structured_state_json FROM prompt_snapshot WHERE id=?", (body.snapshot_id,)
            ).fetchone()
            if snapshot_row:
                snapshot_state = _json_object(snapshot_row["structured_state_json"])
                scoped = _collect_scoped_positive_tags(snapshot_state, conn)
                _record_scoped_cooccurrence(conn, scoped, event_weight=LEARNING_EVENT_WEIGHTS["successful_generate"])
        conn.execute(
            "INSERT INTO gallery_events (dir_name, file_name, source_asset_id, event_type, created_at, context_json) "
            "VALUES (?,?,?,?,?,?)",
            (dir_name, fname, body.source_asset_id, "successful_generate", db.now_iso(), None),
        )
        conn.commit()
        created = conn.execute("SELECT * FROM gallery WHERE id=?", (cur.lastrowid,)).fetchone()
        return _gallery_item_dict(conn, created)
    except Exception:
        conn.rollback()
        try:
            _move_gallery_to_cleanup(out_path, "入库失败")
        except OSError:
            pass
        raise
    finally:
        conn.close()


def _json_object(raw):
    try:
        value = json.loads(raw) if raw else None
        return value if isinstance(value, dict) else None
    except (TypeError, json.JSONDecodeError):
        return None


def _gallery_item_dict(conn, row) -> dict:
    item = dict(row)
    item["parameters"] = _json_object(item.pop("parameters_json", None))
    parent = _json_object(item.pop("parent_json", None))
    if isinstance(parent, dict) and parent.get("dir_name") and parent.get("file_name"):
        available = conn.execute(
            "SELECT 1 FROM gallery WHERE dir_name=? AND file_name=?",
            (parent["dir_name"], parent["file_name"]),
        ).fetchone() is not None
        parent["available"] = available
        item["parent"] = parent
    else:
        item["parent"] = None
    snapshot_id = item.get("snapshot_id")
    snapshot = None
    if snapshot_id:
        snap = conn.execute(
            "SELECT id, positive_prompt, negative_prompt, structured_state_json, created_at "
            "FROM prompt_snapshot WHERE id=?", (snapshot_id,)
        ).fetchone()
        if snap:
            snapshot = dict(snap)
            snapshot["structured_state"] = _json_object(snapshot.pop("structured_state_json")) or {}
    item["snapshot"] = snapshot
    item["ok"] = True
    return item


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


@app.get("/api/gallery/preferences")
def gallery_preferences():
    """从图库元数据 + 事件重建全局/角色偏好（可随时重算，无缓存依赖）。"""
    conn = _conn()
    try:
        return gallery_memory.build_preferences(conn)
    finally:
        conn.close()


@app.get("/api/gallery/collections")
def gallery_collections():
    """Smart Collections 侧栏元信息（收藏/继续/恢复计数 + 角色/标签聚合）。"""
    conn = _conn()
    try:
        return gallery_memory.collection_meta(conn)
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
            "g.snapshot_id, g.source_asset_id, g.parent_json, g.created_at, (f.dir_name IS NOT NULL) favorite "
            "FROM gallery g LEFT JOIN gallery_favorites f USING (dir_name, file_name) "
            "WHERE g.dir_name=? ORDER BY g.id DESC",
            (dir_name,),
        ).fetchall()
        return {
            "dir": dir_name,
            "items": [_gallery_item_dict(conn, r) for r in rows],
        }
    finally:
        conn.close()


class GalleryFavRequest(BaseModel):
    dir_name: str
    file_name: str
    favorite: bool


class GalleryItemRef(BaseModel):
    dir_name: str
    file_name: str


class GalleryEventBody(BaseModel):
    dir_name: str
    file_name: str
    source_asset_id: str | None = None
    event_type: str = "continue_generate"
    context: dict | None = None


class GalleryCleanupBody(BaseModel):
    items: list[GalleryItemRef]


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
        already = conn.execute(
            "SELECT 1 FROM gallery_favorites WHERE dir_name=? AND file_name=?",
            (req.dir_name, req.file_name),
        ).fetchone() is not None
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
        # 只在真实状态变化时写事件（收藏→1 条 favorite，取消→1 条 unfavorite）。
        if req.favorite and not already:
            gallery_memory.record_event(
                conn, req.dir_name, req.file_name, None, "favorite"
            )
        elif not req.favorite and already:
            gallery_memory.record_event(
                conn, req.dir_name, req.file_name, None, "unfavorite"
            )
        conn.commit()
        return {"ok": True, "favorite": req.favorite}
    finally:
        conn.close()


@app.post("/api/gallery/events")
def gallery_events(body: GalleryEventBody):
    """写入一条图库事件（favorite/unfavorite/continue_generate/restore/delete）。"""
    _safe_gallery_path(body.dir_name)
    conn = _conn()
    try:
        try:
            gallery_memory.record_event(
                conn, body.dir_name, body.file_name,
                body.source_asset_id, body.event_type, body.context,
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@app.post("/api/gallery/cleanup/open")
def gallery_cleanup_open():
    """创建并打开项目内待清理文件夹，交由用户手动审查和删除。"""
    GALLERY_TRASH_DIR.mkdir(parents=True, exist_ok=True)
    try:
        if sys.platform == "darwin":
            subprocess.Popen(["open", str(GALLERY_TRASH_DIR)])
        elif os.name == "nt":
            os.startfile(str(GALLERY_TRASH_DIR))  # type: ignore[attr-defined]
        else:
            subprocess.Popen(["xdg-open", str(GALLERY_TRASH_DIR)])
    except OSError as exc:
        raise HTTPException(500, "无法打开待清理文件夹") from exc
    return {"ok": True, "created": True, "path": str(GALLERY_TRASH_DIR.relative_to(BASE_DIR))}


@app.post("/api/gallery/cleanup")
def gallery_cleanup(body: GalleryCleanupBody):
    """把选中的图库图片移入项目待清理文件夹，并移除活动索引。"""
    items = body.items[:100]
    if not items:
        raise HTTPException(400, "请选择至少一张图片")
    moved: list[dict] = []
    conn = _conn()
    try:
        candidates = []
        for item in items:
            target = _safe_gallery_path(item.dir_name)
            row = conn.execute(
                "SELECT id, file_path FROM gallery WHERE dir_name=? AND file_name=?",
                (item.dir_name, item.file_name),
            ).fetchone()
            if not row:
                continue
            file_path = Path(row["file_path"])
            if not file_path.is_absolute():
                file_path = BASE_DIR / file_path
            file_path = file_path.resolve()
            if file_path.parent != target.resolve() or not file_path.is_file():
                continue
            candidates.append((item, row, file_path))

        # 先完整校验，再执行移动；中途失败时把已经移动的文件还原。
        cleanup_paths: list[tuple[Path, Path]] = []
        try:
            for item, row, file_path in candidates:
                cleanup_path = _move_gallery_to_cleanup(file_path, "用户待清理")
                if not cleanup_path:
                    raise OSError(f"文件不存在：{item.file_name}")
                cleanup_paths.append((file_path, cleanup_path))
                moved.append({"dir_name": item.dir_name, "file_name": item.file_name, "cleanup_path": str(cleanup_path.relative_to(BASE_DIR))})
                conn.execute("DELETE FROM gallery WHERE id=?", (row["id"],))
                conn.execute("DELETE FROM gallery_favorites WHERE dir_name=? AND file_name=?", (item.dir_name, item.file_name))
            conn.commit()
        except Exception:
            conn.rollback()
            for original, cleanup_path in reversed(cleanup_paths):
                try:
                    original.parent.mkdir(parents=True, exist_ok=True)
                    os.replace(cleanup_path, original)
                except OSError:
                    pass
            raise
    except OSError as exc:
        raise HTTPException(500, "图片移动到待清理区失败，索引未修改") from exc
    finally:
        conn.close()
    return {"ok": True, "moved": moved, "count": len(moved), "cleanup_dir": str(GALLERY_TRASH_DIR.relative_to(BASE_DIR))}


@app.delete("/api/gallery/{dir_name}")
def gallery_delete(dir_name: str):
    """移走整个图库目录到待清理区，并删除活动索引。"""
    target = _safe_gallery_path(dir_name)
    conn = _conn()
    cleanup_path = None
    try:
        exists = conn.execute("SELECT 1 FROM gallery WHERE dir_name=? LIMIT 1", (dir_name,)).fetchone()
        if not exists:
            raise HTTPException(404, "图库目录不存在")
        try:
            cleanup_path = _move_gallery_to_cleanup(target, "已移除目录")
        except OSError as exc:
            raise HTTPException(500, "图库目录移动到待清理区失败，索引未修改") from exc
        conn.execute("DELETE FROM gallery WHERE dir_name=?", (dir_name,))
        conn.execute("DELETE FROM gallery_favorites WHERE dir_name=?", (dir_name,))
        conn.commit()
    except Exception:
        conn.rollback()
        if cleanup_path and cleanup_path.exists() and not target.exists():
            try:
                target.parent.mkdir(parents=True, exist_ok=True)
                os.replace(cleanup_path, target)
            except OSError:
                pass
        raise
    finally:
        conn.close()
    return {"ok": True, "cleanup_path": str(cleanup_path.relative_to(BASE_DIR)) if cleanup_path else None}


def _gallery_companion_files(file_path: Path) -> list[Path]:
    """返回与主图片同目录、同名的伴随文件（JSON 元数据 / 缩略图等）。

    只扫描 file_path 所在目录内的普通文件：stem 与主文件相同（如 xxx.json / xxx.txt）
    或以主文件 stem 为前缀的派生文件（如 xxx.thumb.jpg / xxx-preview.webp）。
    绝不触碰目录之外的文件。
    """
    if not file_path.is_file():
        return []
    directory = file_path.parent
    stem = file_path.stem
    companions: list[Path] = []
    for candidate in directory.iterdir():
        if not candidate.is_file() or candidate.name == file_path.name:
            continue
        if candidate.stem == stem or candidate.name.startswith(f"{stem}."):
            companions.append(candidate)
    return companions


@app.post("/api/gallery/item/delete")
def gallery_item_delete(body: GalleryItemRef):
    """删除图库目录中的单张图片：文件与同名伴随文件移入待清理区，并移除活动索引。"""
    target = _safe_gallery_path(body.dir_name)
    conn = _conn()
    try:
        row = conn.execute(
            "SELECT * FROM gallery WHERE dir_name=? AND file_name=?",
            (body.dir_name, body.file_name),
        ).fetchone()
        if not row:
            raise HTTPException(404, "图库图片不存在")
        file_path = Path(row["file_path"])
        if not file_path.is_absolute():
            file_path = BASE_DIR / file_path
        file_path = file_path.resolve()
        if file_path.parent != target.resolve() or not file_path.is_file():
            raise HTTPException(404, "图库图片文件不存在")

        # 删除前记录紧凑上下文事件（供偏好重建时排除已删资产）。
        snap = gallery_memory.load_snapshot_state(conn, row["snapshot_id"])
        gallery_memory.record_event(
            conn, body.dir_name, body.file_name, row["source_asset_id"], "delete",
            gallery_memory.compact_delete_context(conn, row, snap),
        )

        moved: list[str] = []
        for candidate in [file_path, *_gallery_companion_files(file_path)]:
            cleanup_path = _move_gallery_to_cleanup(candidate, "已删除图片")
            if cleanup_path:
                moved.append(str(cleanup_path.relative_to(BASE_DIR)))
        conn.execute("DELETE FROM gallery WHERE id=?", (row["id"],))
        conn.execute(
            "DELETE FROM gallery_favorites WHERE dir_name=? AND file_name=?",
            (body.dir_name, body.file_name),
        )
        conn.commit()
        return {"ok": True, "deleted": body.file_name, "moved": moved}
    finally:
        conn.close()


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
    limit: int = Query(default=50, ge=1, le=200),
    deprecated: bool = False,
):
    limit = max(1, min(200, int(limit)))
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


DANBOORU_SEMANTIC_URL = "https://sakizuki-danboorusearch.hf.space/api/search"
DANBOORU_SEMANTIC_TIMEOUT = 90
DANBOORU_SEMANTIC_DEFAULTS = {
    "top_k": 5,
    "limit": 80,
    "popularity_weight": 0.15,
    "use_segmentation": True,
    "target_layers": ["英文", "中文扩展词", "释义", "中文核心词"],
    "target_categories": ["General", "Character", "Copyright"],
    "group_mode": "off",
    "max_per_group": 2,
}


class SemanticSearchBody(BaseModel):
    query: str
    category: int | None = None
    top_k: int = 5
    limit: int = 80


def _semantic_proxy_handler(settings: dict):
    if not settings.get("proxy_enabled"):
        return urllib.request.ProxyHandler({})
    proxy = str(settings.get("proxy_url") or "").strip()
    return urllib.request.ProxyHandler({"http": proxy, "https": proxy}) if proxy else urllib.request.ProxyHandler({})


def _semantic_request_payload(body: SemanticSearchBody, adolescent_mode: bool) -> dict:
    query = body.query.strip()
    if not query:
        raise HTTPException(400, "语义搜索词不能为空")
    payload = dict(DANBOORU_SEMANTIC_DEFAULTS)
    payload.update({
        "query": query,
        "top_k": max(1, min(20, int(body.top_k))),
        "limit": max(1, min(200, int(body.limit))),
        "show_nsfw": not adolescent_mode,
    })
    if body.category is not None and body.category in db.CATEGORY_NAMES:
        payload["target_categories"] = [db.CATEGORY_NAMES[body.category]]
    return payload


def _semantic_category_id(value) -> int | None:
    if isinstance(value, int):
        return value if value in db.CATEGORY_NAMES else None
    if isinstance(value, str):
        return db.CATEGORY_IDS.get(value.strip())
    return None


def _normalize_semantic_response(raw, conn, hidden: set[str], category: int | None = None) -> list[dict]:
    if not isinstance(raw, dict) or not isinstance(raw.get("results"), list):
        raise ValueError("第三方响应缺少 results 列表")
    output = []
    seen = set()
    for item in raw["results"]:
        if not isinstance(item, dict) or not isinstance(item.get("tag"), str):
            continue
        tag = item["tag"].strip().replace("_", " ")
        if not tag or tag in seen or tag in hidden:
            continue
        category_name = str(item.get("category") or "General").strip() or "General"
        category_id = _semantic_category_id(category_name)
        if category is not None and category_id != category:
            continue
        resolved = search.resolve_tag(conn, tag)
        if resolved is not None and resolved.get("tag") in hidden:
            continue
        if resolved is not None:
            local_status = "alias" if resolved.get("via", "").startswith("alias") or resolved.get("via") == "token_alias" else "canonical"
            canonical_tag = resolved.get("tag", tag)
            local_zh = resolved.get("zh") or resolved.get("zh_name") or ""
            section = resolved.get("section")
        else:
            local_status = "candidate"
            canonical_tag = tag
            local_zh = ""
            section = None
        score = item.get("final_score", item.get("score", item.get("semantic_score", 0)))
        try:
            score = float(score)
        except (TypeError, ValueError):
            score = 0.0
        output.append({
            "tag": canonical_tag,
            "source_tag": tag,
            "cn_name": str(item.get("cn_name") or local_zh or ""),
            "zh": str(item.get("cn_name") or local_zh or ""),
            "category": category_id if category_id is not None else category_name,
            "category_name": category_name,
            "score": score,
            "final_score": score,
            "semantic_score": item.get("semantic_score", score),
            "post_count": item.get("count", 0),
            "wiki": str(item.get("wiki") or ""),
            "alias_from": item.get("alias_from"),
            "layer": str(item.get("layer") or ""),
            "local_status": local_status,
            "resolved": resolved is not None,
            "section": section,
        })
        seen.add(tag)
    return output


def _semantic_search(body: SemanticSearchBody) -> dict:
    settings = _load_user_settings()
    payload = _semantic_request_payload(body, settings["adolescent_mode"])
    request = urllib.request.Request(
        DANBOORU_SEMANTIC_URL,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    try:
        opener = urllib.request.build_opener(_semantic_proxy_handler(settings))
        with opener.open(request, timeout=DANBOORU_SEMANTIC_TIMEOUT) as response:
            if response.status < 200 or response.status >= 300:
                raise HTTPException(502, f"语义搜索服务返回 HTTP {response.status}")
            raw = json.loads(response.read().decode("utf-8"))
    except HTTPException:
        raise
    except urllib.error.HTTPError as exc:
        raise HTTPException(502, f"语义搜索服务返回 HTTP {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise HTTPException(502, "语义搜索服务连接失败，请检查代理或稍后重试") from exc
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(502, "语义搜索服务返回的不是有效 JSON") from exc
    conn = _conn()
    try:
        hidden = _hidden_tag_names(conn)
        try:
            results = _normalize_semantic_response(raw, conn, hidden, category=body.category)
        except ValueError as exc:
            raise HTTPException(502, str(exc)) from exc
        return {"query": payload["query"], "results": results, "show_nsfw": payload["show_nsfw"]}
    finally:
        conn.close()


@app.post("/api/semantic-search")
def semantic_search(body: SemanticSearchBody):
    return _semantic_search(body)


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
    """快速取图并先落缩略图；大图在同一后台任务中随后补齐。"""
    remote_thumb, remote_large = sync_danbooru.fetch_fast_images(tag)
    if not remote_thumb:
        return "", ""
    digest = hashlib.md5(tag.encode("utf-8")).hexdigest()
    ext = _guess_img_ext(remote_thumb)
    fname = digest + ext
    fpath = THUMB_DIR / fname
    lname = digest + "_l.jpg"
    lpath = THUMB_DIR / lname
    image_ex = getattr(app.state, "image_executor", None)

    thumb_data = None
    if not fpath.exists():
        future = image_ex.submit(sync_danbooru.fetch_image_bytes, remote_thumb) if image_ex else None
        thumb_data = future.result() if future else sync_danbooru.fetch_image_bytes(remote_thumb)
    thumb_local = f"/static/thumbs/{fname}" if fpath.exists() else ""
    if not thumb_local and thumb_data:
        try:
            tmp = fpath.with_suffix(fpath.suffix + ".tmp")
            tmp.write_bytes(thumb_data)
            os.replace(tmp, fpath)
            thumb_local = f"/static/thumbs/{fname}"
        except OSError:  # noqa: BLE001
            thumb_local = ""
    if not thumb_local:
        return "", ""

    # 缩略图先可用；大图由 _fetch_large_and_cache 在另一个后台任务中补齐。
    return thumb_local, thumb_local


def _fetch_large_and_cache(tag: str, thumb_local: str) -> str:
    """后台补抓并压缩大图，失败时保留缩略图作为 hover 回退。"""
    remote_thumb, remote_large = sync_danbooru.fetch_fast_images(tag)
    if not remote_large or remote_large == remote_thumb:
        return thumb_local
    digest = hashlib.md5(tag.encode("utf-8")).hexdigest()
    lpath = THUMB_DIR / f"{digest}_l.jpg"
    if lpath.exists():
        return f"/static/thumbs/{lpath.name}"
    # 此函数本身已经运行在图片后台线程中，不能再次向同一线程池提交并等待，
    # 否则并发补图达到线程数上限时会相互等待。直接下载即可。
    data = sync_danbooru.fetch_image_bytes(remote_large)
    compressed = imageutil.compress_image_bytes(data) if data else None
    if not compressed:
        return thumb_local
    try:
        tmp = lpath.with_suffix(lpath.suffix + ".tmp")
        tmp.write_bytes(compressed)
        os.replace(tmp, lpath)
        return f"/static/thumbs/{lpath.name}"
    except OSError:  # noqa: BLE001
        return thumb_local


# 全局懒加载后台任务去重锁，线程池由应用 lifespan 管理
_pending_lock = threading.Lock()
_pending = set()
_novelai_example_lock = threading.Lock()
_novelai_example_pending: set[str] = set()
_novelai_example_last_started: dict[str, float] = {}


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
    stale = [n for n in names if n in cached and (
        not _valid_cached_thumb_url(cached[n][0]) or
        (cached[n][1] and not _valid_cached_thumb_url(cached[n][1]))
    )]
    if stale:
        conn = _conn()
        try:
            conn.executemany("DELETE FROM tag_thumbs WHERE tag_name=?", ((n,) for n in stale))
            conn.commit()
        finally:
            conn.close()
        for n in stale:
            cached.pop(n, None)
    missing = [n for n in names if n not in cached]
    if missing:
        THUMB_DIR.mkdir(parents=True, exist_ok=True)
        ex = getattr(app.state, "thumb_executor", None)
        if ex is None:
            return {
                "thumbs": {n: (cached.get(n) or ("", ""))[0] for n in names},
                "large": {n: (cached.get(n) or ("", ""))[1] for n in names},
            }

        def _write_thumb_row(tag: str, thumb_local: str, large_local: str) -> None:
            conn2 = _conn()
            try:
                conn2.execute(
                    "INSERT INTO tag_thumbs (tag_name, thumb_url, thumb_large_url, fetched_at) "
                    "VALUES (?,?,?,?) "
                    "ON CONFLICT(tag_name) DO UPDATE SET thumb_url=excluded.thumb_url, "
                    "thumb_large_url=excluded.thumb_large_url, fetched_at=excluded.fetched_at",
                    (tag, thumb_local, large_local, db.now_iso()),
                )
                conn2.commit()
            finally:
                conn2.close()

        def _finish_large(tag: str, thumb_local: str) -> None:
            try:
                large_local = _fetch_large_and_cache(tag, thumb_local)
                _write_thumb_row(tag, thumb_local, large_local)
                _enforce_cache_limit(protected={Path(thumb_local).name, Path(large_local).name})
            except Exception:  # noqa: BLE001
                # 缩略图已经可用，大图失败不影响首屏。
                pass

        def _bg(tag: str) -> None:
            try:
                pair = _fetch_and_cache(tag)
                if not pair[0]:
                    return
                # 先写缩略图，前端下一轮轮询即可显示。
                _write_thumb_row(tag, pair[0], pair[1])
                _enforce_cache_limit(protected={Path(pair[0]).name})
                image_ex = getattr(app.state, "image_executor", None)
                if image_ex:
                    image_ex.submit(_finish_large, tag, pair[0])
                else:
                    _finish_large(tag, pair[0])
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
    proxy_url: str = ""
    danbooru_login: str = ""
    danbooru_api_key: str = ""
    novelai_api_token: str = ""
    novelai_batch_max_count: int | None = None
    novelai_example_credit_warning: bool | None = None
    novelai_example_prompt_template: str | None = None
    baidu_translate_appid: str = ""
    baidu_translate_secret: str = ""


def _dir_usage_mb(directory: Path) -> float:
    files = [p for p in directory.rglob("*") if p.is_file()] if directory.exists() else []
    return round(sum(p.stat().st_size for p in files) / 1024 / 1024, 1)


def _cache_usage_mb() -> float:
    return _dir_usage_mb(THUMB_DIR)


def _novelai_example_usage_mb() -> float:
    return _dir_usage_mb(NOVELAI_EXAMPLE_DIR)


def _gallery_usage_mb() -> float:
    return _dir_usage_mb(GALLERY_DIR)


@app.get("/api/settings")
def get_settings():
    settings = _load_user_settings()
    return {
        "adolescent_mode": settings["adolescent_mode"],
        "cache_limit_mb": settings["cache_limit_mb"],
        "cache_usage_mb": _cache_usage_mb(),
        "novelai_example_usage_mb": _novelai_example_usage_mb(),
        "gallery_usage_mb": _gallery_usage_mb(),
        "proxy_enabled": settings["proxy_enabled"],
        "proxy_url": settings["proxy_url"],
        "danbooru_login": settings["danbooru_login"],
        "has_danbooru_api_key": bool(settings["danbooru_api_key"] or os.environ.get("DANBOORU_API_KEY")),
        "novelai_configured": bool(settings["novelai_api_token"]),
        "baidu_translate_configured": bool(settings["baidu_translate_appid"] and settings["baidu_translate_secret"]),
        "novelai_batch_max_count": settings["novelai_batch_max_count"],
        "novelai_example_credit_warning": settings["novelai_example_credit_warning"],
        "novelai_example_prompt_template": settings["novelai_example_prompt_template"],
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


@app.post("/api/novelai-examples/clear")
def clear_novelai_example_cache():
    removed = 0
    if NOVELAI_EXAMPLE_DIR.exists():
        for path in NOVELAI_EXAMPLE_DIR.rglob("*"):
            if not path.is_file():
                continue
            try:
                path.unlink()
                removed += 1
            except OSError:
                continue
    conn = _conn()
    try:
        conn.execute("DELETE FROM tag_novelai_examples")
        conn.commit()
    finally:
        conn.close()
    return {"ok": True, "removed": removed}


@app.get("/api/novelai-examples")
def list_novelai_examples(tags: str = ""):
    names = [t.strip() for t in tags.split(",") if t.strip()][:80]
    if not names:
        return {"examples": {}}
    conn = _conn()
    try:
        placeholders = ",".join("?" for _ in names)
        rows = conn.execute(
            "SELECT tag_name, prompt, file_url, model, width, height, steps, seed, status, error_message "
            f"FROM tag_novelai_examples WHERE tag_name IN ({placeholders})",
            names,
        ).fetchall()
        return {"examples": {r["tag_name"]: dict(r) for r in rows if r["status"] == "ready" and r["file_url"]}}
    finally:
        conn.close()


class NovelAIExampleBody(BaseModel):
    # 兼容未重启的旧前端；服务端不会信任该值，而是按 taxonomy 重建提示词。
    prompt: str = ""
    confirm_anlas: bool = False
    force: bool = False


def _novelai_example_path(tag: str) -> Path:
    digest = hashlib.sha256(tag.encode("utf-8")).hexdigest()
    return NOVELAI_EXAMPLE_DIR / f"{digest}.jpg"


def _is_nsfw_example_tag(conn, tag: str) -> bool:
    """使用目录的受限 taxonomy 与 NSFW 分类判定例图的内容分级。"""
    restricted = conn.execute(
        "SELECT 1 FROM restricted_taxonomy_map m LEFT JOIN tags t ON t.danbooru_name=m.canonical_name "
        "WHERE m.status != 'anomalous' AND (m.seed=? OR t.prompt_tag=?) LIMIT 1",
        (tag, tag),
    ).fetchone()
    if restricted:
        return True
    classified = conn.execute(
        "SELECT 1 FROM taxonomy_map WHERE tag_name=? AND ("
        "lower(COALESCE(category_l1, '')) LIKE '%nsfw%' OR lower(COALESCE(category_l1, '')) LIKE '%成人%' "
        "OR lower(COALESCE(category_l2, '')) LIKE '%nsfw%' OR lower(COALESCE(category_l2, '')) LIKE '%成人%' "
        "OR lower(COALESCE(category_l3, '')) LIKE '%nsfw%' OR lower(COALESCE(category_l3, '')) LIKE '%成人%') LIMIT 1",
        (tag,),
    ).fetchone()
    return bool(classified)


def _novelai_example_prompt(tag: str, is_nsfw: bool, template: str | None = None) -> str:
    if not template or "{tag}" not in template:
        template = NOVELAI_EXAMPLE_PROMPT_TEMPLATE
    template = template.strip()
    rating = "nsfw" if is_nsfw else "safe"
    emphasized = f"{{{{{tag}}}}}"  # 双花括号保留 NovelAI 强调语法
    return template.replace("{tag}", emphasized).replace("{rating}", rating)


@app.post("/api/novelai-examples/{tag:path}")
def generate_novelai_example(tag: str, body: NovelAIExampleBody):
    tag = tag.strip()
    if not tag or len(tag) > 200:
        raise HTTPException(400, "标签无效")

    target = _novelai_example_path(tag)
    conn = _conn()
    try:
        prompt = _novelai_example_prompt(
            tag,
            _is_nsfw_example_tag(conn, tag),
            _load_user_settings().get("novelai_example_prompt_template"),
        )
        row = conn.execute(
            "SELECT tag_name, prompt, file_url, model, width, height, steps, seed, status, error_message "
            "FROM tag_novelai_examples WHERE tag_name=?", (tag,),
        ).fetchone()
        if not body.force and row and row["status"] == "ready" and row["file_url"] and target.exists():
            return {"ok": True, "cached": True, "example": dict(row)}
    finally:
        conn.close()

    if not body.confirm_anlas:
        raise HTTPException(428, "生成 NovelAI 标签例图会消耗 Anlas，请明确确认后再请求")

    now = time.monotonic()
    with _novelai_example_lock:
        if tag in _novelai_example_pending:
            raise HTTPException(409, "该标签正在生成，请稍候")
        if now - _novelai_example_last_started.get(tag, 0.0) < NOVELAI_EXAMPLE_COOLDOWN_SECONDS:
            raise HTTPException(429, "该标签刚刚生成过，请稍后再试")
        _novelai_example_pending.add(tag)
        _novelai_example_last_started[tag] = now

    try:
        timestamp = db.now_iso()
        conn = _conn()
        try:
            conn.execute(
                "INSERT INTO tag_novelai_examples (tag_name,prompt,file_url,model,width,height,steps,status,error_message,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tag_name) DO UPDATE SET prompt=excluded.prompt,status='pending',error_message='',updated_at=excluded.updated_at",
                (tag, prompt, "", NOVELAI_EXAMPLE_MODEL, NOVELAI_EXAMPLE_WIDTH, NOVELAI_EXAMPLE_HEIGHT, NOVELAI_EXAMPLE_STEPS, "pending", "", timestamp, timestamp),
            )
            conn.commit()
        finally:
            conn.close()

        request = urllib.request.Request(
            f"{NOVELAI_SERVICE_URL}/api/novelai/tag-example",
            data=json.dumps({"prompt": prompt, "confirm_anlas": True}).encode("utf-8"),
            headers={"Content-Type": "application/json", "Accept": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=150) as response:
            result = json.loads(response.read().decode("utf-8"))
        raw = base64.b64decode(result.get("image_base64", ""), validate=True)
        compressed = imageutil.compress_image_bytes(
            raw,
            max_edge=imageutil.NOVELAI_EXAMPLE_MAX_EDGE,
            quality=imageutil.NOVELAI_EXAMPLE_JPEG_QUALITY,
        )
        if not compressed:
            raise HTTPException(502, "NovelAI 图片压缩失败")
        NOVELAI_EXAMPLE_DIR.mkdir(parents=True, exist_ok=True)
        tmp = target.with_suffix(".jpg.tmp")
        tmp.write_bytes(compressed)
        os.replace(tmp, target)
        example = {
            "tag_name": tag,
            "prompt": prompt,
            "file_url": f"/static/novelai-examples/{target.name}",
            "model": NOVELAI_EXAMPLE_MODEL,
            "width": NOVELAI_EXAMPLE_WIDTH,
            "height": NOVELAI_EXAMPLE_HEIGHT,
            "steps": NOVELAI_EXAMPLE_STEPS,
            "seed": result.get("seed"),
            "status": "ready",
            "error_message": "",
        }
        conn = _conn()
        try:
            conn.execute(
                "UPDATE tag_novelai_examples SET file_url=?, seed=?, status='ready', error_message='', updated_at=? WHERE tag_name=?",
                (example["file_url"], example["seed"], db.now_iso(), tag),
            )
            conn.commit()
        finally:
            conn.close()
        return {"ok": True, "cached": False, "example": example}
    except Exception as exc:
        detail = exc.detail if isinstance(exc, HTTPException) else str(exc)[:300]
        conn = _conn()
        try:
            conn.execute(
                "UPDATE tag_novelai_examples SET status='error', error_message=?, updated_at=? WHERE tag_name=?",
                (str(detail), db.now_iso(), tag),
            )
            conn.commit()
        finally:
            conn.close()
        if isinstance(exc, HTTPException):
            raise
        raise HTTPException(502, f"NovelAI 标签例图生成失败：{str(exc)[:200]}") from exc
    finally:
        with _novelai_example_lock:
            _novelai_example_pending.discard(tag)


@app.post("/api/settings")
def save_settings(body: UserSettingsBody):
    current = _load_user_settings()
    incoming = body.model_dump(exclude_none=True)
    # 空 API Key 表示保持原值，避免用户只改青少年模式时意外清空凭据。
    if not incoming["danbooru_api_key"].strip():
        incoming["danbooru_api_key"] = current["danbooru_api_key"]
    if not incoming["novelai_api_token"].strip():
        incoming["novelai_api_token"] = current["novelai_api_token"]
    if not incoming["baidu_translate_appid"].strip():
        incoming["baidu_translate_appid"] = current["baidu_translate_appid"]
    if not incoming["baidu_translate_secret"].strip():
        incoming["baidu_translate_secret"] = current["baidu_translate_secret"]
    incoming["danbooru_login"] = incoming["danbooru_login"].strip()
    incoming["novelai_api_token"] = incoming["novelai_api_token"].strip()
    incoming["baidu_translate_appid"] = incoming["baidu_translate_appid"].strip()
    incoming["baidu_translate_secret"] = incoming["baidu_translate_secret"].strip()
    incoming["proxy_url"] = incoming["proxy_url"].strip()
    if "novelai_batch_max_count" in incoming:
        incoming["novelai_batch_max_count"] = max(1, min(6, int(incoming["novelai_batch_max_count"])))
    if "novelai_example_prompt_template" in incoming:
        tpl = incoming["novelai_example_prompt_template"]
        if not isinstance(tpl, str) or "{tag}" not in tpl:
            raise HTTPException(400, "例图提示词模板必须包含 {tag} 占位符，否则生成的例图将不含目标标签")
        incoming["novelai_example_prompt_template"] = tpl.strip()
    normalized = _load_user_settings()
    normalized.update(incoming)
    _save_user_settings(normalized)
    _enforce_cache_limit()
    return get_settings()


class TranslateBody(BaseModel):
    text: str
    from_: str = Field("auto", alias="from")
    to: str = "en"

    @property
    def source_language(self) -> str:
        return self.from_


def baidu_translate_sign(appid: str, text: str, salt: str, secret: str) -> str:
    """Baidu 官方签名：appid + 原始 q + salt + secret，再 UTF-8 MD5。"""
    return hashlib.md5(f"{appid}{text}{salt}{secret}".encode("utf-8")).hexdigest()


def _translate_error_message(payload: dict) -> str:
    code = str(payload.get("error_code") or "")
    messages = {
        "52001": "百度翻译请求超时",
        "54003": "百度翻译请求过于频繁，请稍后再试",
        "54004": "百度翻译账户余额不足",
        "54005": "百度翻译短时间内请求过于频繁",
        "58001": "百度翻译语言参数不支持",
        "54001": "百度翻译鉴权失败，请检查配置",
    }
    return messages.get(code, "百度翻译服务暂时不可用")


@app.post("/api/translate")
def translate(body: TranslateBody):
    text = body.text.strip()
    source = body.source_language.strip().lower()
    target = body.to.strip().lower()
    if source not in {"auto", "zh", "en"} or target not in {"zh", "en"}:
        raise HTTPException(400, "翻译语言仅支持 from=auto/zh/en、to=zh/en")
    if not text:
        raise HTTPException(400, "翻译文本不能为空")
    if len(text) > 1000 or len(text.encode("utf-8")) > 6000:
        raise HTTPException(413, "翻译文本不能超过 1000 字符或 6000 字节")
    settings = _load_user_settings()
    appid = settings["baidu_translate_appid"]
    secret = settings["baidu_translate_secret"]
    if not appid or not secret:
        raise HTTPException(428, "尚未配置百度翻译，请先在设置中填写 APP ID 和密钥")

    global _translate_last_request
    with _translate_lock:
        wait = 1.0 - (time.monotonic() - _translate_last_request)
        if wait > 0:
            time.sleep(wait)
        _translate_last_request = time.monotonic()
    salt = secrets.token_hex(8)
    form = {
        "q": text,
        "from": source,
        "to": target,
        "appid": appid,
        "salt": salt,
        "sign": baidu_translate_sign(appid, text, salt, secret),
    }
    request = urllib.request.Request(
        BAIDU_TRANSLATE_URL,
        data=urllib.parse.urlencode(form).encode("utf-8"),
        headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"},
        method="POST",
    )
    try:
        opener = urllib.request.build_opener(_semantic_proxy_handler(settings))
        with opener.open(request, timeout=BAIDU_TRANSLATE_TIMEOUT) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise HTTPException(502, "百度翻译服务返回错误") from exc
    except (urllib.error.URLError, TimeoutError, OSError):
        raise HTTPException(502, "百度翻译服务连接失败，请检查代理或稍后重试")
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(502, "百度翻译服务返回无效结果") from exc
    if payload.get("error_code"):
        raise HTTPException(502, _translate_error_message(payload))
    result = payload.get("trans_result")
    if not isinstance(result, list) or not result or not isinstance(result[0], dict) or not isinstance(result[0].get("dst"), str):
        raise HTTPException(502, "百度翻译服务返回无效结果")
    return {"text": text, "translated": "\n".join(str(item.get("dst") or "") for item in result)}


def _load_prompt_navigation() -> dict:
    """加载 config/prompt_navigation.json 语义导航骨架；缺失/损坏返回 {}。"""
    try:
        data = json.loads(PROMPT_NAVIGATION_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _find_nav_node(tree: dict, node_id: str) -> tuple[dict, list[dict]] | None:
    """按 id 在语义导航树中查找节点，返回 (node, ancestors)；找不到返回 None。"""
    def walk(node, ancestors):
        if not isinstance(node, dict) or not node.get("id"):
            return None
        if node["id"] == node_id:
            return node, ancestors
        for child in node.get("children") or []:
            found = walk(child, ancestors + [node])
            if found is not None:
                return found
        return None
    for root in (tree.get("base"), tree.get("character")):
        found = walk(root, [])
        if found is not None:
            return found
    return None


def _filter_nav_node_nsfw(node, adolescent: bool) -> dict | None:
    """青少年模式下递归剪掉 nsfw 节点；返回 None 表示该节点被隐藏。"""
    if not adolescent:
        return node
    if node.get("nsfw"):
        return None
    node = dict(node)
    node["children"] = [
        child for child in (_filter_nav_node_nsfw(c, adolescent) for c in node.get("children") or [])
        if child is not None
    ]
    return node


def _semantic_tree_response(node_id: str = "") -> dict:
    """语义导航树响应（Base/Character 创作概念骨架）。"""
    tree = _load_prompt_navigation()
    if not tree.get("base") and not tree.get("character"):
        raise HTTPException(404, "semantic navigation not configured")
    adolescent = _load_user_settings()["adolescent_mode"]
    if node_id:
        found = _find_nav_node(tree, node_id)
        if found is None:
            raise HTTPException(404, "node not found")
        node = found[0]
        if adolescent and node.get("nsfw"):
            raise HTTPException(404, "node not found")
        return {"node": _filter_nav_node_nsfw(node, adolescent)}
    filtered = {}
    for key in ("base", "character"):
        root = tree.get(key)
        if isinstance(root, dict):
            pruned = _filter_nav_node_nsfw(root, adolescent)
            if pruned is not None:
                filtered[key] = pruned
    return {"tree": filtered}


@app.get("/api/catalog/semantic")
def catalog_semantic_tree(node_id: str = ""):
    """语义导航树专用路由（复用 catalog 扩展，不影响原目录树 /api/catalog）。"""
    return _semantic_tree_response(node_id)


@app.get("/api/catalog")
def catalog_tree(semantic: bool = False, node_id: str = ""):
    """返回目录树：分组 + 子目录（含数量估算）。

    semantic=true 时复用同一入口返回语义导航树（config/prompt_navigation.json 的
    Base/Character 创作概念骨架），并支持 node_id 下钻；旧请求（不带 semantic 参数）
    返回原目录树，行为完全不变。
    """
    if semantic:
        return _semantic_tree_response(node_id)
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


# ---------- Prompt V2：分区 / Bundle / 推荐 / 快照 ----------


class ClassifyRequest(BaseModel):
    tags: list[str]


class SectionOverrideRequest(BaseModel):
    tag: str
    section: str


@app.get("/api/prompt/sections")
def prompt_section_list():
    return {"sections": prompt_sections.section_definitions()}


@app.post("/api/prompt/classify")
def prompt_classify(body: ClassifyRequest):
    conn = _conn()
    try:
        items = prompt_sections.classify_tags(conn, body.tags)
        return {"items": items, "results": items}
    finally:
        conn.close()


@app.post("/api/prompt/section-override")
def prompt_section_override(body: SectionOverrideRequest):
    tag = body.tag.strip()
    if not tag:
        raise HTTPException(400, "tag is required")
    try:
        section = prompt_sections.validate_section(body.section)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    conn = _conn()
    try:
        conn.execute(
            "INSERT INTO tag_section_override (tag_name, section, updated_at) VALUES (?,?,?) "
            "ON CONFLICT(tag_name) DO UPDATE SET section=excluded.section, updated_at=excluded.updated_at",
            (tag, section, db.now_iso()),
        )
        conn.commit()
        return {"ok": True, "tag": tag, "section": section}
    finally:
        conn.close()


@app.get("/api/prompt/section-overrides")
def prompt_section_overrides():
    """返回全部用户分区覆盖（tag -> section），供前端加载购物车时回填条目分区。"""
    conn = _conn()
    try:
        rows = conn.execute("SELECT tag_name, section FROM tag_section_override").fetchall()
        return {"overrides": {row["tag_name"]: row["section"] for row in rows}}
    finally:
        conn.close()


class BundleItemBody(BaseModel):
    tag: str
    weight: float = 1.0
    section: str = "other"
    sort_order: int = 0


class BundleBody(BaseModel):
    name: str
    items: list[BundleItemBody] = []


def _validated_bundle(body: BundleBody) -> tuple[str, list[dict]]:
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "bundle name is required")
    items = []
    for item in body.items:
        tag = item.tag.strip()
        if not tag:
            raise HTTPException(400, "bundle item tag is required")
        if not math.isfinite(item.weight) or not -10 <= item.weight <= 10:
            raise HTTPException(400, "weight must be finite and between -10 and 10")
        try:
            section = prompt_sections.validate_section(item.section)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        items.append({"tag": tag, "weight": item.weight, "section": section, "sort_order": item.sort_order})
    return name, items


def _bundle_dict(conn, bundle_id: int) -> dict | None:
    row = conn.execute("SELECT * FROM tag_bundle WHERE id=?", (bundle_id,)).fetchone()
    if not row:
        return None
    out = dict(row)
    out["items"] = [
        {"tag": r["tag_name"], "weight": r["weight"], "section": r["section"], "sort_order": r["sort_order"]}
        for r in conn.execute(
            "SELECT tag_name, weight, section, sort_order FROM tag_bundle_item "
            "WHERE bundle_id=? ORDER BY sort_order, id", (bundle_id,)
        )
    ]
    return out


@app.get("/api/bundles")
def bundle_list():
    conn = _conn()
    try:
        ids = [r["id"] for r in conn.execute("SELECT id FROM tag_bundle ORDER BY updated_at DESC, id DESC")]
        return {"bundles": [_bundle_dict(conn, bundle_id) for bundle_id in ids]}
    finally:
        conn.close()


@app.post("/api/bundles")
def bundle_create(body: BundleBody):
    name, items = _validated_bundle(body)
    conn = _conn()
    try:
        now = db.now_iso()
        cur = conn.execute("INSERT INTO tag_bundle (name, created_at, updated_at) VALUES (?,?,?)", (name, now, now))
        conn.executemany(
            "INSERT INTO tag_bundle_item (bundle_id, tag_name, weight, section, sort_order) VALUES (?,?,?,?,?)",
            ((cur.lastrowid, i["tag"], i["weight"], i["section"], i["sort_order"]) for i in items),
        )
        conn.commit()
        return _bundle_dict(conn, cur.lastrowid)
    finally:
        conn.close()


@app.get("/api/bundles/{bundle_id}")
def bundle_get(bundle_id: int):
    conn = _conn()
    try:
        result = _bundle_dict(conn, bundle_id)
        if result is None:
            raise HTTPException(404, "bundle not found")
        return result
    finally:
        conn.close()


@app.put("/api/bundles/{bundle_id}")
def bundle_update(bundle_id: int, body: BundleBody):
    name, items = _validated_bundle(body)
    conn = _conn()
    try:
        if not conn.execute("SELECT 1 FROM tag_bundle WHERE id=?", (bundle_id,)).fetchone():
            raise HTTPException(404, "bundle not found")
        conn.execute("UPDATE tag_bundle SET name=?, updated_at=? WHERE id=?", (name, db.now_iso(), bundle_id))
        conn.execute("DELETE FROM tag_bundle_item WHERE bundle_id=?", (bundle_id,))
        conn.executemany(
            "INSERT INTO tag_bundle_item (bundle_id, tag_name, weight, section, sort_order) VALUES (?,?,?,?,?)",
            ((bundle_id, i["tag"], i["weight"], i["section"], i["sort_order"]) for i in items),
        )
        conn.commit()
        return _bundle_dict(conn, bundle_id)
    finally:
        conn.close()


@app.delete("/api/bundles/{bundle_id}")
def bundle_delete(bundle_id: int):
    conn = _conn()
    try:
        cur = conn.execute("DELETE FROM tag_bundle WHERE id=?", (bundle_id,))
        conn.commit()
        if not cur.rowcount:
            raise HTTPException(404, "bundle not found")
        return {"ok": True}
    finally:
        conn.close()


class TagsRequest(BaseModel):
    tags: list[str]
    limit: int = 20


class RecommendRequest(TagsRequest):
    """推荐请求：旧字段 tags/limit 兼容；新增 Recommendation V2 上下文。

    target 兼容旧 base|character；也接受 char:N / global_uc 等精确目标（归到 active_target）。
    """
    target: str = ""
    node_id: str = ""
    mode: str = "general"
    participant_count: int | str | None = None
    primary_scene_type: str = ""
    stage: str = ""
    position: str = ""
    body_focus: str = ""
    additional_activities: list[str] = []
    clothing_state: dict = {}
    active_target: str = ""
    active_section: str = ""
    last_added_tag: str = ""


def _target_category(target: str) -> str:
    """把精确目标归到 base / character / global_uc 三个分区类别（用于候选分区过滤）。

    未指定目标返回空串 —— 旧请求（仅 tags/limit）不做分区过滤，保持兼容。
    """
    t = (target or "").strip().lower()
    if not t:
        return ""
    if t in ("base", "character", "global_uc"):
        return t
    if t.startswith("char:"):
        return "global_uc" if t.endswith(":uc") else "character"
    return "base"


def _recommendation_mode(raw: str) -> str:
    """Recommendation V2 的 mode 归一：nsfw/adult 统一为 adult（成人上下文 gating 与重排）。"""
    m = (raw or "").strip().lower()
    return "adult" if m in ("nsfw", "adult", "18+") else "general"


def _related_source() -> related_client.RelatedClient | None:
    """远程 global related 源（默认关闭；TAGS_MARKET_RELATED_URL 配置后启用，失败自动回退本地源）。"""
    url = os.environ.get("TAGS_MARKET_RELATED_URL", "").strip()
    if not url:
        return None
    return related_client.RelatedClient(url, timeout=2.0)


def _normalized_unique_tags(tags: list[str]) -> list[str]:
    return list(dict.fromkeys(search._norm(tag) for tag in tags if search._norm(tag)))


# 学习事件权重（Phase A 只接线 successful_generate 正向学习；其余权重供后续阶段事件接入使用）。
LEARNING_EVENT_WEIGHTS = {
    "successful_generate": 1.0,
    "continue_generate": 2.0,
    "favorite": 4.0,
    "unfavorite": -1.0,
    "delete": -2.0,
    "restore": 0.0,
    "manual_snapshot": 0.0,
}

_IDENTITY_CATEGORIES = (4, 3)  # Danbooru Character / Copyright
_RELATION_KINDS = ("source", "target", "mutual")


def _resolve_identity(conn, tags: list[str]) -> str | None:
    """从角色标签里挑稳定 canonical 身份：Character(4) 优先，其次 Copyright(3)。"""
    if conn is None:
        return None
    for tag in tags:
        row = conn.execute(
            "SELECT category FROM tags WHERE lower(prompt_tag)=lower(?) OR lower(danbooru_name)=lower(?) LIMIT 1",
            (tag, tag),
        ).fetchone()
        if row and row["category"] in _IDENTITY_CATEGORIES:
            return tag.strip()
    return None


def _iter_entry_dicts(value):
    """递归产出结构化状态里的 entry dict（含 tag 字段，保留 relation 等元数据）。"""
    if isinstance(value, dict):
        if isinstance(value.get("tag"), str) and value["tag"].strip():
            yield value
        for child in value.values():
            if isinstance(child, (dict, list)):
                yield from _iter_entry_dicts(child)
    elif isinstance(value, list):
        for child in value:
            if isinstance(child, (dict, list)):
                yield from _iter_entry_dicts(child)


def _collect_scoped_positive_tags(state, conn=None) -> dict:
    """把结构化状态拆成按作用域隔离的正向标签集合。

    返回：
      {
        "base": [base 正向标签],
        "characters": [{"identity": 角色身份标签 or None, "tags": [该角色正向标签]}],
        "relations": [(source_tag, target_tag, relation_type), ...]  # 来自 source#/target#/mutual#
      }
    仅收集 Base positive 与 Character positive 的 tag 条目；UC / 自由文本 / assistant_context 一律不采集。
    """
    result: dict = {"base": [], "characters": [], "relations": []}
    if not isinstance(state, dict):
        return result

    sections = state.get("sections")
    if isinstance(sections, dict):
        result["base"] = _collect_structured_tags(sections)

    source_by_action: dict[str, list[str]] = {}
    target_by_action: dict[str, list[str]] = {}
    mutual_by_action: dict[str, list[str]] = {}
    characters: list[dict] = []

    for character in state.get("characters") or []:
        if not isinstance(character, dict):
            continue
        prompt_map = character.get("prompt_sections")
        tags: list[str] = []
        relations_here: list[tuple[str, str]] = []
        if isinstance(prompt_map, dict):
            entries = list(_iter_entry_dicts(prompt_map))
            tags = [e["tag"].strip() for e in entries]
            relations_here = [
                (e["relation"], e["tag"].strip())
                for e in entries
                if e.get("relation") in _RELATION_KINDS
            ]
        identity = _resolve_identity(conn, tags)
        characters.append({"identity": identity, "tags": tags})
        for rel_kind, action in relations_here:
            anchor = identity or action
            bucket = {
                "source": source_by_action,
                "target": target_by_action,
                "mutual": mutual_by_action,
            }[rel_kind]
            bucket.setdefault(action, []).append(anchor)

    relations: list[tuple[str, str, str]] = []
    for action in sorted(source_by_action):
        for source in source_by_action[action]:
            for target in target_by_action.get(action, []):
                relations.append((source, target, action))
    for action in sorted(mutual_by_action):
        mutuals = mutual_by_action[action]
        for i in range(len(mutuals)):
            for j in range(i + 1, len(mutuals)):
                relations.append((mutuals[i], mutuals[j], action))

    result["characters"] = characters
    result["relations"] = relations
    return result


def _record_scoped_cooccurrence(conn, scoped_tags: dict, event_weight: float = 1.0) -> list[str]:
    """按作用域写入 tag_cooccurrence_scoped（修复跨角色污染）。

    作用域语义：
      - base：仅 Base 标签两两配对
      - character：仅单角色内部标签两两配对（含身份标签，绝不跨角色）
      - base_character_context：Base 标签 × 每个角色的「身份标签」only（绝不含外观标签）
      - interaction：显式关系条目（source#/target#/mutual#）配出的身份对
    硬规则：绝不记录跨角色外观对、绝不把 Base×角色外观写进 base/character。
    positive_weight 按 event_weight 累加；负事件（unfavorite/delete）累加 negative_weight。
    """
    if event_weight == 0:
        return []
    base = _normalized_unique_tags(scoped_tags.get("base") or [])
    characters = scoped_tags.get("characters") or []
    relations = scoped_tags.get("relations") or []
    now = db.now_iso()
    positive = max(0.0, float(event_weight))
    negative = max(0.0, -float(event_weight))

    learned: list[str] = []

    def add_pair(scope: str, a: str, b: str) -> None:
        if not a or not b or a == b:
            return
        a, b = sorted((a, b))
        conn.execute(
            "INSERT INTO tag_cooccurrence_scoped (scope, tag_a, tag_b, positive_weight, negative_weight, updated_at) "
            "VALUES (?,?,?,?,?,?) "
            "ON CONFLICT(scope, tag_a, tag_b) DO UPDATE SET "
            "positive_weight = tag_cooccurrence_scoped.positive_weight + excluded.positive_weight, "
            "negative_weight = tag_cooccurrence_scoped.negative_weight + excluded.negative_weight, "
            "updated_at = excluded.updated_at",
            (scope, a, b, positive, negative, now),
        )

    # base scope
    for i, a in enumerate(base):
        for b in base[i + 1:]:
            add_pair("base", a, b)

    # character scope + base_character_context scope
    for ch in characters:
        raw_tags = ch.get("tags") or []
        tags = _normalized_unique_tags(raw_tags)
        identity = search._norm(ch.get("identity")) if ch.get("identity") else None
        char_tags = _normalized_unique_tags(([identity] if identity else []) + tags)
        for i, a in enumerate(char_tags):
            for b in char_tags[i + 1:]:
                add_pair("character", a, b)
        if identity:
            for b in base:
                add_pair("base_character_context", b, identity)

    # interaction scope
    for source_tag, target_tag, _relation_type in relations:
        add_pair("interaction", search._norm(source_tag), search._norm(target_tag))

    # recent_tags：只反映真正被「正向学习」的标签；负事件不更新 recent_tags。
    if event_weight > 0:
        learned = _normalized_unique_tags(
            base + [t for ch in characters for t in (ch.get("tags") or [])]
        )
        for tag in learned:
            conn.execute(
                "INSERT INTO recent_tags (tag_name, last_used_at, use_count) VALUES (?,?,1) "
                "ON CONFLICT(tag_name) DO UPDATE SET last_used_at=excluded.last_used_at, use_count=recent_tags.use_count+1",
                (tag, now),
            )
    return learned


def _record_cooccurrence(conn, tags: list[str]) -> list[str]:
    """（已弃用）旧扁平共现记录：写入旧 tag_cooccurrence 表，仅供向后兼容。

    新学习路径请使用 _record_scoped_cooccurrence；此函数不再被 snapshot/cooccurrence 路由调用。
    """
    tags = _normalized_unique_tags(tags)
    now = db.now_iso()
    for tag in tags:
        conn.execute(
            "INSERT INTO recent_tags (tag_name, last_used_at, use_count) VALUES (?,?,1) "
            "ON CONFLICT(tag_name) DO UPDATE SET last_used_at=excluded.last_used_at, use_count=recent_tags.use_count+1",
            (tag, now),
        )
    for index, tag_a in enumerate(tags):
        for tag_b in tags[index + 1:]:
            a, b = sorted((tag_a, tag_b))
            conn.execute(
                "INSERT INTO tag_cooccurrence (tag_a, tag_b, count, updated_at) VALUES (?,?,1,?) "
                "ON CONFLICT(tag_a, tag_b) DO UPDATE SET count=tag_cooccurrence.count+1, updated_at=excluded.updated_at",
                (a, b, now),
            )
    return tags


@app.post("/api/cooccurrence/record")
def cooccurrence_record(body: TagsRequest):
    """记录一组扁平标签的共现（路由到作用域记录，作为 base 作用域处理）。"""
    conn = _conn()
    try:
        tags = _record_scoped_cooccurrence(
            conn, {"base": body.tags, "characters": [], "relations": []}, event_weight=1.0
        )
        conn.commit()
        return {"ok": True, "tags": tags, "pairs": len(tags) * (len(tags) - 1) // 2}
    finally:
        conn.close()


@app.post("/api/recommendations")
def recommendations(body: RecommendRequest):
    """Recommendation V2（确定性多源 RRF 融合，无 embedding/LLM/向量库）。

    候选源：global related（远程可注入，失败回退本地）/ 本地共现 / 个人最近使用 /
    语义节点 seed / 成人场景上下文（mode=adult）。各源独立排序后 RRF_K=60 融合，
    再做上下文重排与分组多样性。硬过滤（已选 / 青少年隐藏 / 成人未成年与幼态 /
    人数 / target / section / node 不兼容）发生在融合前。
    返回 {groups, recommendations}，每项含 tag / canonical / zh / group / reason / sources，
    另附 section（兼容旧前端分区展示）与 count（旧字段兼容，仅展示用）。
    """
    tags = _normalized_unique_tags(getattr(body, "tags", []) or [])
    limit = max(0, min(int(getattr(body, "limit", 20) or 20), 100))
    if not tags:
        return {"groups": [], "recommendations": []}
    conn = _conn()
    try:
        hidden = _hidden_tag_names(conn)
        settings = _load_user_settings()
        adolescent = settings["adolescent_mode"]
        nav = _load_prompt_navigation()

        node_id = (getattr(body, "node_id", "") or "").strip()
        semantic_node = None
        if node_id:
            found = _find_nav_node(nav, node_id)
            if found is None:
                raise HTTPException(400, "node not found")
            node, ancestors = found
            if adolescent and node.get("nsfw"):
                raise HTTPException(400, "node unavailable in adolescent mode")
            seeds: list[str] = []
            for n in ancestors + [node]:
                seeds.extend(n.get("seed_tags") or [])
            semantic_node = {"seed_tags": seeds}

        raw_target = (getattr(body, "target", "") or "").strip().lower()
        active_target = (getattr(body, "active_target", "") or "").strip().lower() or raw_target
        target = _target_category(raw_target)

        service = recommendation.RecommendationService(
            conn,
            sources={},
            related_source=_related_source(),
            hidden_tags=hidden,
            adolescent_mode=adolescent,
            navigation=nav,
        )
        result = service.recommend(
            tags=tags,
            target=target,
            node_id=node_id,
            limit=limit,
            mode=_recommendation_mode(getattr(body, "mode", "general")),
            participant_count=getattr(body, "participant_count", None),
            primary_scene_type=getattr(body, "primary_scene_type", "") or "",
            stage=getattr(body, "stage", "") or "",
            position=getattr(body, "position", "") or "",
            body_focus=getattr(body, "body_focus", "") or "",
            additional_activities=getattr(body, "additional_activities", []) or [],
            clothing_state=getattr(body, "clothing_state", {}) or {},
            active_target=active_target,
            active_section=getattr(body, "active_section", "") or "",
            semantic_node=semantic_node,
            last_added_tag=getattr(body, "last_added_tag", "") or "",
        )
        # 旧前端兼容：分区字段 + 确定性 count 代理分（仅展示用，不影响 V2 内部排序）。
        for item in result["recommendations"]:
            item["section"] = prompt_sections.classify_tag(conn, item["tag"])
            item["count"] = int(round(float(item.get("_score", 0.0)) * 100))
        return result
    finally:
        conn.close()


class SemanticStateRequest(BaseModel):
    structured_state: dict
    active_target: str = ""
    mode: str = "general"
    generation_config: dict | None = None
    last_added_tag: str = ""


@app.post("/api/semantic-state")
def semantic_state_api(body: SemanticStateRequest):
    from prompt.semantic_state import build_semantic_state
    conn = _conn()
    try:
        state = build_semantic_state(
            body.structured_state, conn=conn,
            generation_config=body.generation_config,
            active_target=body.active_target, mode=body.mode,
            last_added_tag=body.last_added_tag)
        return {
            "base_slots": [vars(s) for s in state.base_slots],
            "character_slots": [[vars(s) for s in chars] for chars in state.character_slots],
            "scene_slots": [vars(s) for s in state.scene_slots],
            "intent": state.intent,
            "summary": state.summary,
        }
    finally:
        conn.close()


class AutoSplitRequest(BaseModel):
    prompt: Any = None
    text: str = ""
    manual_assignments: dict = {}


class _DbTagMetadataResolver:
    """把 tags / tag_aliases / taxonomy 映射为 auto_split 需要的确定性元数据。

    resolve_tag_metadata 只读 category / section / canonical / aliases；
    is_character_identity 依赖 category==4（Danbooru character 分类）作为身份锚。
    """

    def __init__(self, conn):
        self.conn = conn
        self._cache: dict[str, dict] = {}

    def __call__(self, tag: str) -> dict:
        key = search._norm(tag)
        if not key:
            return {}
        if key in self._cache:
            return self._cache[key]
        conn = self.conn
        row = conn.execute(
            "SELECT t.danbooru_name, t.prompt_tag, t.category FROM tags t "
            "WHERE lower(t.prompt_tag)=lower(?) OR lower(t.danbooru_name)=lower(?) LIMIT 1",
            (tag, tag),
        ).fetchone()
        result: dict = {}
        if row:
            canonical = row["danbooru_name"]
            aliases = [r["alias"] for r in conn.execute(
                "SELECT alias FROM tag_aliases WHERE canonical_name=?", (canonical,))]
            result = {
                "category": row["category"],
                "canonical": canonical,
                "aliases": [row["prompt_tag"], canonical, *aliases],
                "section": prompt_sections.classify_tag(conn, row["prompt_tag"]),
            }
        else:
            result = {"section": prompt_sections.classify_tag(conn, tag)}
        self._cache[key] = result
        return result


def _auto_split_summary(proposal: dict) -> dict:
    """从 proposal 提取前端易用摘要字段（不依赖 DB 的纯函数）。"""
    return {
        "base_count": sum(1 for e in proposal.get("base", []) if "tag" in e),
        "characters": [
            {"name": c.get("name", ""),
             "prompt_count": len(c.get("prompt", [])),
             "uc_count": len(c.get("uc", []))}
            for c in proposal.get("characters", [])
        ],
        "unassigned_count": len(proposal.get("unassigned", [])),
    }


@app.post("/api/prompt/auto-split")
def prompt_auto_split(body: AutoSplitRequest):
    """Auto-Split proposal：只返回归属建议，不修改 PromptDocument（APPLY_AUTO_SPLIT 由前端执行）。"""
    prompt = body.prompt
    if prompt is None and (getattr(body, "text", "") or "").strip():
        prompt = body.text.strip()
    if prompt is None:
        raise HTTPException(400, "prompt or text is required")
    conn = _conn()
    try:
        resolver = _DbTagMetadataResolver(conn)
        proposal = auto_split.auto_split(
            prompt, resolver, getattr(body, "manual_assignments", None) or None)
        _enrich_proposal_sections(proposal, conn)
        return {
            "proposal": proposal,
            "summary": proposal.get("summary", ""),
            "unassigned": proposal.get("unassigned", []),
            "structured": bool(proposal.get("structured")),
            "resplit": bool(proposal.get("resplit")),
            "assistant_context": proposal.get("assistant_context", {}),
            **_auto_split_summary(proposal),
        }
    finally:
        conn.close()


def _enrich_proposal_sections(proposal: dict, conn) -> dict:
    """给 proposal 的每个 tag 条目补 prompt 分区（classify_tag），供前端按分区落位。"""
    def walk(items):
        for item in items or []:
            if isinstance(item, dict) and item.get("tag"):
                item.setdefault("section", prompt_sections.classify_tag(conn, item["tag"]))
    walk(proposal.get("base"))
    walk(proposal.get("global_uc"))
    for character in proposal.get("characters") or []:
        walk(character.get("prompt"))
        walk(character.get("uc"))
    return proposal


# Scene Composer 语义候选配置（高层主场景 / 服装状态 / 附加活动 / 身体聚焦 / 体位来源）。
# 所有 canonical tag 必须真实存在于 data/tags.sqlite（或 curated data/nsfw_taxonomy.json），
# 运行时逐条校验，未命中即 drop（绝不发明 / 绝不输出未校验 tag）。
SCENE_COMPOSER_CONFIG_PATH = BASE_DIR / "config" / "scene_composer.json"
NSFW_TAXONOMY_PATH = BASE_DIR / "data" / "nsfw_taxonomy.json"

# 青少年模式下返回的空候选组 key（保持 /api/nsfw-builder/options 响应形状稳定）。
NSFW_BUILDER_GROUPS = ("participants", "scenes", "stages", "positions", "clothingStates", "activities", "bodyFocus")

_scene_composer_config_cache: dict | None = None
_nsfw_taxonomy_cache: dict | None = None


def _scene_composer_config() -> dict:
    """加载 config/scene_composer.json（模块级缓存；损坏 / 缺失返回空 dict）。"""
    global _scene_composer_config_cache
    if _scene_composer_config_cache is None:
        try:
            _scene_composer_config_cache = db.load_json(SCENE_COMPOSER_CONFIG_PATH) if SCENE_COMPOSER_CONFIG_PATH.is_file() else {}
        except (OSError, json.JSONDecodeError):
            _scene_composer_config_cache = {}
    if not isinstance(_scene_composer_config_cache, dict):
        _scene_composer_config_cache = {}
    return _scene_composer_config_cache


def _nsfw_taxonomy() -> dict:
    """加载 data/nsfw_taxonomy.json（curated 成人词库，模块级缓存）。"""
    global _nsfw_taxonomy_cache
    if _nsfw_taxonomy_cache is None:
        try:
            _nsfw_taxonomy_cache = db.load_json(NSFW_TAXONOMY_PATH) if NSFW_TAXONOMY_PATH.is_file() else {}
        except (OSError, json.JSONDecodeError):
            _nsfw_taxonomy_cache = {}
    if not isinstance(_nsfw_taxonomy_cache, dict):
        _nsfw_taxonomy_cache = {}
    return _nsfw_taxonomy_cache


def _nsfw_taxonomy_categories() -> list:
    cats = _nsfw_taxonomy().get("categories")
    return cats if isinstance(cats, list) else []


def _nsfw_taxonomy_tags() -> set[str]:
    tags: set[str] = set()
    for category in _nsfw_taxonomy_categories():
        for tag in category.get("tags") or []:
            tags.add(str(tag).strip().lower())
    return tags


def _nsfw_taxonomy_category_tags(category_id: str) -> list[str]:
    for category in _nsfw_taxonomy_categories():
        if category.get("id") == category_id:
            return [str(t).strip() for t in (category.get("tags") or [])]
    return []


def _scene_tag_in_sqlite(conn, tag: str) -> bool:
    """tag 是否命中本地 sqlite（tags 表 prompt_tag/danbooru_name、taxonomy_map、restricted_taxonomy_map）。"""
    tag = (tag or "").strip()
    if not tag or conn is None:
        return False
    try:
        if conn.execute(
            "SELECT 1 FROM tags WHERE lower(prompt_tag)=lower(?) OR lower(danbooru_name)=lower(?) LIMIT 1",
            (tag, tag),
        ).fetchone():
            return True
        if conn.execute("SELECT 1 FROM taxonomy_map WHERE lower(tag_name)=lower(?) LIMIT 1", (tag,)).fetchone():
            return True
        if conn.execute(
            "SELECT 1 FROM restricted_taxonomy_map "
            "WHERE lower(seed)=lower(?) OR lower(canonical_name)=lower(?) LIMIT 1",
            (tag, tag),
        ).fetchone():
            return True
    except Exception:
        return False
    return False


def _scene_tag_exists(conn, tag: str) -> bool:
    """候选 tag 是否存在于任一权威源（sqlite 三表 + curated nsfw_taxonomy.json）。"""
    tag = (tag or "").strip()
    if not tag:
        return False
    if _scene_tag_in_sqlite(conn, tag):
        return True
    return tag.lower() in _nsfw_taxonomy_tags()


@app.get("/api/nsfw-builder/options")
def nsfw_builder_options():
    """Scene Composer 候选（participants/scenes/stages/positions/clothingStates/activities/bodyFocus）。

    青少年模式下全部返回空候选（组件整体禁用）。成人模式下从 config/scene_composer.json
    取高层主场景 / 服装状态 / 附加活动 / 身体聚焦，体位取自 curated nsfw_positions；
    每个 canonical tag 运行时逐条校验 sqlite，未命中即 drop（绝不发明 / 绝不输出未校验 tag）。
    """
    conn = _conn()
    try:
        if _load_user_settings()["adolescent_mode"]:
            return {group: [] for group in NSFW_BUILDER_GROUPS}

        config = _scene_composer_config()

        def _verified(items, *, require_tag=True):
            """按 {key,label,tag,...} 归一；tag 未命中 sqlite 即 drop（绝不输出未校验 tag）。

            require_tag=False 时（body_focus），tag 缺失直接省略字段而非置空串。
            """
            out: list[dict] = []
            seen: set[str] = set()
            for raw in items or []:
                if not isinstance(raw, dict):
                    continue
                key = str(raw.get("key") or "").strip()
                label = str(raw.get("label") or raw.get("key") or "").strip()
                if not key or key in seen:
                    continue
                seen.add(key)
                tag = str(raw.get("tag") or "").strip()
                if tag and not _scene_tag_in_sqlite(conn, tag):
                    print(f"[nsfw-builder] drop unverified tag {tag!r} (key={key!r})", flush=True)
                    tag = ""
                entry = {"key": key, "label": label}
                if tag:
                    entry["tag"] = tag
                elif require_tag:
                    entry["tag"] = ""
                if raw.get("section"):
                    entry["section"] = str(raw["section"]).strip()
                if raw.get("minParticipants") is not None:
                    entry["minParticipants"] = int(raw["minParticipants"])
                out.append(entry)
            return out

        # 主场景：config primary_scenes -> {key,label,tag,minParticipants}（tag 未命中 sqlite 则 drop 为 ""）。
        scenes = []
        for raw in config.get("primary_scenes") or []:
            if not isinstance(raw, dict):
                continue
            key = str(raw.get("key") or "").strip()
            label = str(raw.get("label") or raw.get("key") or "").strip()
            if not key:
                continue
            tag = str(raw.get("tag") or "").strip()
            if tag and not _scene_tag_in_sqlite(conn, tag):
                print(f"[nsfw-builder] drop unverified scene tag {tag!r} (key={key!r})", flush=True)
                tag = ""
            entry = {"key": key, "label": label, "tag": tag}
            if raw.get("minParticipants") is not None:
                entry["minParticipants"] = int(raw["minParticipants"])
            if raw.get("description"):
                entry["description"] = str(raw["description"]).strip()
            scenes.append(entry)

        positions = []
        seen_positions: set[str] = set()
        for tag in _nsfw_taxonomy_category_tags(config.get("positions_source") or "nsfw_positions"):
            if not tag or tag in seen_positions:
                continue
            if not _scene_tag_in_sqlite(conn, tag):
                print(f"[nsfw-builder] drop unverified position tag {tag!r}", flush=True)
                continue
            seen_positions.add(tag)
            positions.append({"key": tag, "label": tag, "tag": tag, "minParticipants": 2})

        return {
            "participants": [
                {"key": "1", "label": "1"},
                {"key": "2", "label": "2"},
                {"key": "3", "label": "3"},
                {"key": "4+", "label": "4+"},
            ],
            "scenes": scenes,
            "stages": [
                {"key": "PREPARATION", "label": "准备"},
                {"key": "FOREPLAY", "label": "前戏"},
                {"key": "MAIN_ACT", "label": "主戏"},
                {"key": "CLIMAX", "label": "高潮"},
                {"key": "AFTERMATH", "label": "余韵"},
            ],
            "positions": positions,
            "clothingStates": _verified(config.get("clothing_states")),
            "activities": _verified(config.get("activities")),
            "bodyFocus": _verified(config.get("body_focus"), require_tag=False),
        }
    finally:
        conn.close()


@app.get("/api/conflicts")
def conflicts(tags: str = ""):
    names = _normalized_unique_tags(tags.split(","))
    if len(names) < 2:
        return {"conflicts": []}
    placeholders = ",".join("?" for _ in names)
    conn = _conn()
    try:
        rows = conn.execute(
            f"SELECT tag_a, tag_b, reason FROM tag_conflict WHERE tag_a IN ({placeholders}) AND tag_b IN ({placeholders})",
            (*names, *names),
        ).fetchall()
        return {"conflicts": [dict(row) for row in rows]}
    finally:
        conn.close()


def _collect_structured_tags(value) -> list[str]:
    """只收集 Prompt entry 的 tag 字段，不把 section 元数据或普通字符串当作标签。"""
    found = []
    if isinstance(value, dict):
        tag = value.get("tag")
        if isinstance(tag, str) and tag.strip():
            found.append(tag.strip())
        for child in value.values():
            if isinstance(child, (dict, list)):
                found.extend(_collect_structured_tags(child))
    elif isinstance(value, list):
        for child in value:
            if isinstance(child, (dict, list)):
                found.extend(_collect_structured_tags(child))
    return found


def _collect_positive_tags(state) -> list[str]:
    """（已弃用）扁平化收集 Base + Character 正向标签。

    仅作向后兼容包装：调用 _collect_scoped_positive_tags 后把 base 与各角色标签拍平。
    学习路径请使用 _collect_scoped_positive_tags + _record_scoped_cooccurrence。
    """
    scoped = _collect_scoped_positive_tags(state)
    tags: list[str] = list(scoped["base"])
    for character in scoped["characters"]:
        tags.extend(character.get("tags") or [])
    return tags


class SnapshotBody(BaseModel):
    positive_prompt: str = ""
    negative_prompt: str = ""
    structured_state: dict
    generation: dict = {}


def _snapshot_dict(row) -> dict:
    data = dict(row)
    data["structured_state"] = _json_object(data.pop("structured_state_json", None)) or {}
    data["generation"] = _json_object(data.pop("generation_json", None)) or {}
    return data


@app.post("/api/snapshots")
def snapshot_create(body: SnapshotBody):
    snapshot_id = str(uuid.uuid4())
    conn = _conn()
    try:
        conn.execute(
            "INSERT INTO prompt_snapshot (id, positive_prompt, negative_prompt, structured_state_json, generation_json, created_at) "
            "VALUES (?,?,?,?,?,?)",
            (snapshot_id, body.positive_prompt, body.negative_prompt,
             json.dumps(body.structured_state, ensure_ascii=False), json.dumps(body.generation, ensure_ascii=False), db.now_iso()),
        )
        # 快照（含手动保存）不再触发学习：学习只在成功生成回写（gallery_item）时发生。
        conn.commit()
        return _snapshot_dict(conn.execute("SELECT * FROM prompt_snapshot WHERE id=?", (snapshot_id,)).fetchone())
    finally:
        conn.close()


@app.get("/api/snapshots")
def snapshot_list(limit: int = Query(default=50, ge=1, le=200)):
    conn = _conn()
    try:
        rows = conn.execute("SELECT * FROM prompt_snapshot ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
        return {"snapshots": [_snapshot_dict(row) for row in rows]}
    finally:
        conn.close()


@app.get("/api/snapshots/{snapshot_id}")
def snapshot_get(snapshot_id: str):
    conn = _conn()
    try:
        row = conn.execute("SELECT * FROM prompt_snapshot WHERE id=?", (snapshot_id,)).fetchone()
        if not row:
            raise HTTPException(404, "snapshot not found")
        return _snapshot_dict(row)
    finally:
        conn.close()


def _filter_snapshot_sections(state: dict, wanted: set[str]) -> dict:
    result = dict(state)
    if isinstance(state.get("sections"), dict):
        result["sections"] = {key: value for key, value in state["sections"].items() if key in wanted}
    else:
        for section in prompt_sections.SECTIONS:
            if section not in wanted:
                result.pop(section, None)
    if isinstance(state.get("characters"), list):
        result["characters"] = []
        for character in state["characters"]:
            copy = dict(character)
            if isinstance(copy.get("prompt_sections"), dict):
                copy["prompt_sections"] = {key: value for key, value in copy["prompt_sections"].items() if key in wanted}
            result["characters"].append(copy)
    return result


@app.post("/api/snapshots/{snapshot_id}/restore")
def snapshot_restore(snapshot_id: str, sections: str = ""):
    snapshot = snapshot_get(snapshot_id)
    wanted = {item.strip() for item in sections.split(",") if item.strip()}
    if wanted - set(prompt_sections.SECTIONS):
        raise HTTPException(400, "invalid sections")
    if wanted:
        snapshot["structured_state"] = _filter_snapshot_sections(snapshot["structured_state"], wanted)
    return snapshot


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
    out = []
    for candidate in scored:
        evidence = search.match_evidence(raw_tag, candidate) or ("fuzzy", 0.0)
        out.append({
            "tag": candidate,
            "match_type": evidence[0],
            "reason": search.MATCH_REASON[evidence[0]],
            "similarity": round(evidence[1], 6),
        })
    return out


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
                custom = conn.execute(
                    "SELECT tag_name, zh FROM user_tags WHERE lower(tag_name)=lower(?)", (tag.strip(),)
                ).fetchone()
                exact = conn.execute(
                    "SELECT * FROM tags WHERE lower(prompt_tag)=lower(?) OR lower(danbooru_name)=lower(?) LIMIT 1",
                    (tag.strip(), tag.strip()),
                ).fetchone()
                hit = db.tag_dict(exact) if exact else None
                status = "exact" if hit else None
                if not hit:
                    resolved = search.resolve_tag(conn, tag)
                    if resolved and resolved.get("via") not in {"canonical_prefix", "alias_prefix", "user_tags"}:
                        hit, status = resolved, "normalized"
                candidates = []
                if custom and not hit:
                    hit = {"tag": custom["tag_name"], "canonical": custom["tag_name"], "zh": custom["zh"] or "", "via": "user_tags"}
                    status = "custom"
                elif not hit:
                    status = "candidate"
                    candidates = _fuzzy_candidates(conn, tag)
                section = prompt_sections.classify_tag(conn, hit["tag"] if hit else tag)
                out.append({
                    "raw": tag,
                    "status": status,
                    "section": section,
                    "match": ({"tag": hit["tag"], "canonical": hit.get("canonical", hit["tag"]),
                               "via": hit.get("via", "canonical")} if hit else None),
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
    zh: str = ""


@app.post("/api/user-tags")
def add_user_tag(req: UserTagRequest):
    """把自定义 tag 备注入本地库（无法在 Danbooru 词库匹配时使用）。"""
    tag = req.tag.strip()
    if not tag:
        raise HTTPException(400, "empty tag")
    conn = _conn()
    try:
        conn.execute(
            "INSERT INTO user_tags (tag_name, note, zh, created_at) VALUES (?,?,?,?) "
            "ON CONFLICT(tag_name) DO UPDATE SET note=excluded.note, zh=excluded.zh, created_at=excluded.created_at",
            (tag, req.note.strip(), req.zh.strip(), db.now_iso()),
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


@app.get("/api/user-tags")
def list_user_tags():
    conn = _conn()
    try:
        rows = conn.execute(
            "SELECT tag_name, note, zh, created_at FROM user_tags ORDER BY created_at DESC"
        ).fetchall()
        return {
            "tags": [
                {"tag": r["tag_name"], "note": r["note"], "zh": r["zh"], "created_at": r["created_at"]}
                for r in rows
            ]
        }
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
    structured_state: dict | None = None


def _flatten_section_state(structured_state: dict) -> list:
    source = structured_state.get("sections") if isinstance(structured_state.get("sections"), dict) else structured_state
    return [entry for section in prompt_sections.SECTIONS for entry in (source.get(section, []) or [])]


@app.post("/api/export")
def export(req: ExportRequest):
    state = req.model_dump(exclude={"structured_state"})
    if req.structured_state:
        state["base_prompt"] = _flatten_section_state(req.structured_state)
        if isinstance(req.structured_state.get("global_uc_sections"), dict):
            state["global_uc"] = _flatten_section_state({"sections": req.structured_state["global_uc_sections"]})
        if isinstance(req.structured_state.get("free_text"), str):
            state["free_text"] = req.structured_state["free_text"]
        if isinstance(req.structured_state.get("free_text_en"), str):
            state["free_text_en"] = req.structured_state["free_text_en"]
        state["use_free_text_en"] = bool(req.structured_state.get("use_free_text_en"))
        structured_characters = req.structured_state.get("characters")
        if isinstance(structured_characters, list):
            state["characters"] = []
            for character in structured_characters:
                item = dict(character)
                if isinstance(item.get("prompt_sections"), dict):
                    item["prompt"] = _flatten_section_state({"sections": item["prompt_sections"]})
                if isinstance(item.get("uc_sections"), dict):
                    item["uc"] = _flatten_section_state({"sections": item["uc_sections"]})
                state["characters"].append(item)
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
        rows = conn.execute("SELECT id, name, kind, payload_json, updated_at FROM presets ORDER BY updated_at DESC").fetchall()
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
        name = (body.name or "").strip()
        if not name:
            raise HTTPException(400, "preset name is required")
        kind = (body.kind or "prompt").strip().lower()
        if kind not in {"prompt", "nai"}:
            raise HTTPException(400, "unsupported preset kind")
        if not isinstance(body.payload, dict):
            raise HTTPException(400, "payload must be an object")
        cur = conn.execute(
            "INSERT INTO presets (name, kind, payload_json, updated_at) VALUES (?, ?, ?, ?)",
            (name, kind, json.dumps(body.payload, ensure_ascii=False), db.now_iso()),
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
        payload_raw = d.pop("payload_json")
        try:
            d["payload"] = json.loads(payload_raw)
        except Exception:
            d["payload"] = {}
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

    reload_enabled = _live_reload_enabled()
    uvicorn.run(
        "app:app",
        host=SETTINGS.get("host", "127.0.0.1"),
        port=SETTINGS.get("port", 8123),
        reload=reload_enabled,
        reload_dirs=[str(BASE_DIR)] if reload_enabled else None,
    )
