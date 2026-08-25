"""汉语拼音生成工具：标签中文名 -> 全拼 / 首字母。

全拼按词（空格/标点）拆分后用空格连接，如 '蓝 眼睛' -> 'lan yan jing'；
首字母取每个拼音音节的首字母连写，如 '蓝眼' -> 'ly'。

依赖 pypinyin（见 requirements.txt）。用惰性导入：缺库时返回空串，不阻断
不含拼音功能的其它流程（import / 测试等）。
"""
from __future__ import annotations

import re


def _pypinyin():
    try:
        from pypinyin import Style, pinyin as _pinyin  # noqa: PLC0415
        return _pinyin, Style
    except Exception:  # noqa: BLE001
        return None, None


# 按空格 / 常见中文标点 / 括号 / 斜杠拆分中文名（用于分词）
_SPLIT_RE = re.compile(r"[\s，。、；：！？（）()\[\]【】\-—/\\]+")


def to_pinyin_full(text: str) -> str:
    """中文文本 -> 全拼（音节间空格），如 '蓝 眼睛' -> 'lan yan jing'。"""
    text = (text or "").strip()
    if not text:
        return ""
    pinyin_fn, style = _pypinyin()
    if pinyin_fn is None:
        return ""
    out: list[str] = []
    for word in _SPLIT_RE.split(text):
        if not word:
            continue
        syllables = pinyin_fn(word, style=style.NORMAL, heteronym=False)
        for syl in syllables:
            if syl:
                out.append(syl[0])
    return " ".join(out).lower()


def to_pinyin_initials(text: str) -> str:
    """中文文本 -> 各拼音音节首字母连写，如 '蓝眼' -> 'ly'。"""
    full = to_pinyin_full(text)
    return "".join(syl[0] for syl in full.split() if syl)


def compute_pinyin(text: str) -> tuple[str, str]:
    """返回 (全拼, 首字母)。文本为空或无可用拼音库时返回 ("", "")。"""
    full = to_pinyin_full(text)
    if not full:
        return "", ""
    initials = "".join(syl[0] for syl in full.split() if syl)
    return full, initials
