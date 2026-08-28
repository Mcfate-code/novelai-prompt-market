"""零依赖 PNG tEXt/zTXt/iTXt 读取。"""
from __future__ import annotations

import struct
import zlib

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def _split_nul(payload: bytes, count: int = 2) -> list[bytes]:
    parts = payload.split(b"\0", count - 1)
    if len(parts) != count:
        raise ValueError("PNG 文本块缺少字段分隔符")
    return parts


def read_png_text_chunks(data: bytes, *, max_bytes: int = 64 * 1024 * 1024) -> dict[str, list[str]]:
    if not data.startswith(PNG_SIGNATURE):
        raise ValueError("不是 PNG 文件")
    if len(data) > max_bytes:
        raise ValueError("PNG 文件过大")
    offset = len(PNG_SIGNATURE)
    result: dict[str, list[str]] = {}
    while offset + 12 <= len(data):
        length = struct.unpack(">I", data[offset:offset + 4])[0]
        kind = data[offset + 4:offset + 8]
        start = offset + 8
        end = start + length
        if end + 4 > len(data):
            raise ValueError("PNG chunk 长度无效")
        payload = data[start:end]
        offset = end + 4  # 跳过 CRC；这里不需要重新校验图像完整性。
        try:
            if kind == b"tEXt":
                keyword, value = _split_nul(payload)
                text = value.decode("latin-1", errors="replace")
            elif kind == b"zTXt":
                keyword, rest = _split_nul(payload)
                if not rest or rest[0] != 0:
                    continue
                text = zlib.decompress(rest[1:]).decode("utf-8", errors="replace")
            elif kind == b"iTXt":
                parts = payload.split(b"\0", 5)
                if len(parts) != 6:
                    continue
                keyword, flag, method, _language, _translated, value = parts
                if flag == b"\x01":
                    if method != b"\x00":
                        continue
                    value = zlib.decompress(value)
                text = value.decode("utf-8", errors="replace")
            else:
                if kind == b"IEND":
                    break
                continue
        except (UnicodeError, ValueError, zlib.error):
            continue
        key = keyword.decode("latin-1", errors="replace").strip() or "text"
        result.setdefault(key, []).append(text)
    return result


__all__ = ["read_png_text_chunks"]
