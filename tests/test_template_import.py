"""本地元数据 / Civitai 姿势模板导入回归。"""
from __future__ import annotations

import json
import struct
import tempfile
import unittest
import zlib
from pathlib import Path
from unittest.mock import patch

import db
from prompt.metadata_readers import read_bytes
from prompt.metadata_readers.comfyui import parse_comfyui
from prompt.template_distill import distill_prompt
from prompt.template_import import fetch_civitai_image, import_text


def png_text(keyword: str, value: str) -> bytes:
    payload = keyword.encode("latin-1") + b"\0" + value.encode("utf-8")
    return struct.pack(">I", len(payload)) + b"tEXt" + payload + struct.pack(">I", zlib.crc32(b"tEXt" + payload) & 0xFFFFFFFF)


class _Response:
    def __init__(self, value):
        self.value = value

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, _limit=None):
        return json.dumps(self.value).encode("utf-8")


class TemplateImportTest(unittest.TestCase):
    def test_a1111_png_metadata(self):
        data = b"\x89PNG\r\n\x1a\n" + png_text(
            "parameters",
            "2girls, source#kneeling, target#standing, from behind\nNegative prompt: lowres\nSteps: 28, Sampler: Euler a, CFG scale: 7, Seed: 42, Size: 832x1216",
        )
        result = read_bytes(data, filename="sample.png")
        self.assertEqual(result["positive_prompt"].split(", ")[0], "2girls")
        self.assertEqual(result["negative_prompt"], "lowres")
        self.assertEqual(result["settings"]["steps"], 28)
        self.assertEqual(result["settings"]["width"], 832)

    def test_distill_keeps_pose_and_removes_identity_style(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "tags.sqlite"
            db.init_db(path)
            conn = db.get_conn(path)
            db.upsert_tags(conn, [
                {"danbooru_name": "original_character", "prompt_tag": "original character", "category": 4, "post_count": 1},
                {"danbooru_name": "artist_x", "prompt_tag": "artist x", "category": 1, "post_count": 1},
                {"danbooru_name": "missionary", "prompt_tag": "missionary", "category": 0, "post_count": 1},
            ])
            result = distill_prompt("2girls, original character, artist x, source#kneeling, target#standing, missionary, from behind", conn=conn)
            conn.close()
        self.assertEqual(result["participant_count"], 2)
        self.assertIn("missionary", result["base_tags"])
        self.assertEqual(result["role_tags"], [["kneeling"], ["standing"]])
        self.assertTrue(any(x["reason"] == "角色/版权身份" for x in result["removed_tags"]))
        self.assertTrue(any(x["reason"] == "画风/艺术家" for x in result["removed_tags"]))
        self.assertIn("from behind", result["camera_tags"])

    def test_age_ambiguous_is_blocked(self):
        result = distill_prompt("young woman, missionary, sex")
        self.assertTrue(result["blocked"])
        self.assertIn("young woman", result["age_flags"])

    def test_camera_only_does_not_create_adult_evidence(self):
        result = distill_prompt("2girls, from behind")
        self.assertFalse(result["adult_evidence"])
        self.assertEqual(result["relations"][0]["action"], "interact")

    def test_comfyui_workflow_nodes_extracts_clip_text(self):
        result = parse_comfyui({"nodes": [
            {"id": 1, "type": "CLIPTextEncode", "title": "Positive", "widgets_values": ["2girls, missionary"]},
            {"id": 2, "type": "CLIPTextEncode", "title": "Negative", "widgets_values": ["lowres"]},
        ]})
        self.assertIn("missionary", result["positive_prompt"])
        self.assertEqual(result["negative_prompt"], "lowres")

    def test_import_text_returns_pending_candidate(self):
        result = import_text("2girls, missionary, from behind")
        self.assertEqual(result["review"]["status"], "pending")
        self.assertEqual(result["distilled"]["participant_count"], 2)
        self.assertEqual(result["source"]["source_type"], "text")

    def test_civitai_id_validation_and_response(self):
        payload = {"items": [{"id": 123, "nsfwLevel": "X", "width": 832, "height": 1216, "meta": {"prompt": "2girls, missionary", "negativePrompt": "lowres", "steps": 28}}]}
        with patch("prompt.template_import.urllib.request.urlopen", return_value=_Response(payload)):
            result = fetch_civitai_image("https://civitai.com/images/123")
        self.assertEqual(result["image_id"], "123")
        self.assertEqual(result["negative_prompt"], "lowres")
        with self.assertRaises(ValueError):
            fetch_civitai_image("https://example.com/images/123")


if __name__ == "__main__":
    unittest.main()
