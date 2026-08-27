#!/usr/bin/env python3
"""PHASE 8 交付契约：离线先验引导助手（可选、极小）。

data/offline_prompt_prior.sqlite 缺失时打印获取指引；设置环境变量
PRIOR_DOWNLOAD_URL 可直接下载预构建制品放入 data/。绝不做自动更新 /
自动重建框架。成功退出 0；缺失且未下载成功退出 2。
"""
from __future__ import annotations

import os
import sys
import urllib.request
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
PRIOR_PATH = DATA_DIR / "offline_prompt_prior.sqlite"
DOWNLOAD_TIMEOUT_S = 600

INSTRUCTIONS = f"""\
Offline Prior DB not found at {PRIOR_PATH}

Options:
  1) Download the prebuilt offline_prompt_prior.sqlite from GitHub Releases and
     place it into {DATA_DIR}/
     (or set env PRIOR_DOWNLOAD_URL and re-run this script to download it here)
  2) Build it locally:
       python -m prompt.prior_build             # public prior (NPMI / slots / context / transitions)
       python -m scripts.build_embedding_prior  # embedding semantic prior (REQUIRES SILICONFLOW_API_KEY)

     The embedding builder needs SILICONFLOW_API_KEY; the public builder does not.
     SILICONFLOW_API_KEY is NOT required for normal runtime.

When the prior is missing the app logs a warning and runs in degraded fallback mode:
recommendation still works via NPMI/seed, but semantic-alternative quality is reduced.
See README "Offline Prior (数据先验)".
"""


def _download(url: str) -> int:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = PRIOR_PATH.with_suffix(".sqlite.part")
    print(f"[bootstrap_prior] downloading {url} -> {PRIOR_PATH}")
    with urllib.request.urlopen(url, timeout=DOWNLOAD_TIMEOUT_S) as resp, tmp.open("wb") as fh:
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            fh.write(chunk)
    os.replace(tmp, PRIOR_PATH)
    print(f"[bootstrap_prior] saved: {PRIOR_PATH}")
    return 0


def main() -> int:
    if PRIOR_PATH.is_file():
        print(f"Offline Prior already present: {PRIOR_PATH}")
        return 0
    url = os.environ.get("PRIOR_DOWNLOAD_URL", "").strip()
    if url:
        try:
            return _download(url)
        except Exception as exc:  # noqa: BLE001 —— 下载失败降级为指引
            print(f"[bootstrap_prior] download failed: {exc}", file=sys.stderr)
            PRIOR_PATH.with_suffix(".sqlite.part").unlink(missing_ok=True)
    print(INSTRUCTIONS)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())