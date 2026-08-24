"""批量导入 NAI 图包 zip 到图库（本地直调，不走 HTTP 上传）。

用法: python import_nai.py <zip1> <zip2> ...
每个 zip 成为一个图库目录（用 zip 文件名作为目录名）。
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import db  # noqa: E402
import imageutil  # noqa: E402

BASE_DIR = db.BASE_DIR
GALLERY_DIR = BASE_DIR / "data" / "gallery"
ALLOWED_IMG_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".bmp"}

import re  # noqa: E402
import zipfile  # noqa: E402
from io import BytesIO  # noqa: E402


def sanitize_dir_name(name: str) -> str:
    base = Path(name).stem
    keep = re.sub(r'[\\/:*?"<>|\s]+', "_", base).strip("_")
    return keep or "gallery"


def prompt_from_filename(fname: str) -> str:
    stem = Path(fname).stem
    stem = re.sub(r"[\s,_-]+s?[-_]?\d{6,}$", "", stem)
    stem = re.sub(r"[\s,_-]+\d{6,}$", "", stem)
    return stem.strip()


def import_zip(zip_path: Path) -> dict:
    dir_name = sanitize_dir_name(zip_path.name)
    target = GALLERY_DIR / dir_name
    target.mkdir(parents=True, exist_ok=True)
    imported = skipped = failed = 0
    conn = db.get_conn()
    try:
        with zipfile.ZipFile(zip_path) as zf:
            for info in zf.infolist():
                if info.is_dir():
                    continue
                ext = Path(info.filename).suffix.lower()
                if ext not in ALLOWED_IMG_EXT:
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
                prompt = prompt_from_filename(fname)
                short = re.sub(r'[\\/:*?"<>|,{}\[\]()\s]+', "_", prompt).strip("._ ") or "img"
                short = short[:40].strip("_") or "img"
                out_name = f"{imported + 1:04d}_{short}.jpg"
                out_path = target / out_name
                try:
                    out_path.write_bytes(compressed)
                except OSError:  # noqa: BLE001
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
    return {"dir": dir_name, "imported": imported, "skipped": skipped, "failed": failed}


if __name__ == "__main__":
    db.init_db()
    GALLERY_DIR.mkdir(parents=True, exist_ok=True)
    for p in sys.argv[1:]:
        zp = Path(p)
        if not zp.exists():
            print(f"跳过（不存在）: {zp}")
            continue
        r = import_zip(zp)
        print(f"{zp.name}: 导入 {r['imported']} 张，跳过 {r['skipped']}，失败 {r['failed']} → 目录 {r['dir']}")