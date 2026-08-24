"""例图压缩工具：下载的远端大图 → 压缩为本地 jpg（hover 查看够用、体积小）。

压缩策略：
- 最长边 ≤ 512px（hover 浮层最大显示 280px 高/420px 宽，512 完全够）
- JPEG quality 78（视觉清晰，文件小）
- 输出统一 .jpg，透明 PNG 自动补白底
"""

from __future__ import annotations

from io import BytesIO
from pathlib import Path

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    Image = None  # type: ignore[assignment]

MAX_EDGE = 512
JPEG_QUALITY = 78


def compress_image_bytes(data: bytes) -> bytes | None:
    """把远端图片字节压缩为 JPEG 字节。失败/缺 Pillow 返回 None。"""
    if Image is None:
        return None
    try:
        im = Image.open(BytesIO(data))
        im.load()
        # RGBA/P 透明图补白底，避免 jpg 黑底
        if im.mode in ("RGBA", "LA", "P"):
            im = im.convert("RGBA")
            bg = Image.new("RGB", im.size, (255, 255, 255))
            bg.paste(im, mask=im.split()[-1])
            im = bg
        else:
            im = im.convert("RGB")
        # 等比缩小
        w, h = im.size
        if max(w, h) > MAX_EDGE:
            ratio = MAX_EDGE / max(w, h)
            im = im.resize((max(1, round(w * ratio)), max(1, round(h * ratio))), Image.LANCZOS)
        out = BytesIO()
        im.save(out, format="JPEG", quality=JPEG_QUALITY, optimize=True, progressive=True)
        return out.getvalue()
    except Exception:  # noqa: BLE001
        return None


def compress_image_file(src: Path, dst: Path) -> bool:
    """把 src 图片文件压缩保存到 dst（.jpg）。成功返回 True。"""
    try:
        data = src.read_bytes()
    except OSError:
        return False
    out = compress_image_bytes(data)
    if out is None:
        return False
    try:
        dst.write_bytes(out)
        return True
    except OSError:
        return False