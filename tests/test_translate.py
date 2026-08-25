import hashlib
import json
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app
import db
from prompt import novelai_export


class FakeResponse:
    status = 200

    def __init__(self, payload):
        self.payload = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self):
        return self.payload


class TranslateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.settings = self.tmp / "settings.json"
        self.db_path = self.tmp / "tags.sqlite"
        db.init_db(self.db_path)
        self.patches = [
            patch.object(app, "USER_SETTINGS_PATH", self.settings),
            patch.object(app, "DB_PATH", self.db_path, create=True),
            patch.object(db, "DB_PATH", self.db_path),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()

    def test_official_signature_order(self):
        expected = hashlib.md5("2015063000000001apple123456789abcdef".encode("utf-8")).hexdigest()
        self.assertEqual(app.baidu_translate_sign("2015063000000001", "apple", "123456789", "abcdef"), expected)

    def test_translate_success_uses_form_proxy_and_timeout(self):
        app._save_user_settings({**app.DEFAULT_USER_SETTINGS, "baidu_translate_appid": "test-app-id", "baidu_translate_secret": "test-key-value", "proxy_enabled": False})
        captured = {}
        class Opener:
            def open(self, request, timeout):
                captured["request"] = request
                captured["timeout"] = timeout
                return FakeResponse({"trans_result": [{"src": "你好", "dst": "Hello"}]})
        with patch.object(app.urllib.request, "build_opener", return_value=Opener()):
            result = app.translate(app.TranslateBody(text="你好", **{"from": "zh", "to": "en"}))
        self.assertEqual(result["translated"], "Hello")
        request = captured["request"]
        self.assertEqual(request.headers["Content-type"], "application/x-www-form-urlencoded")
        self.assertEqual(captured["timeout"], app.BAIDU_TRANSLATE_TIMEOUT)

    def test_translate_rejects_unconfigured_and_invalid(self):
        with self.assertRaisesRegex(app.HTTPException, "尚未配置"):
            app.translate(app.TranslateBody(text="hello"))
        with self.assertRaises(app.HTTPException):
            app.translate(app.TranslateBody(text="hello", **{"from": "fr", "to": "en"}))
        with self.assertRaises(app.HTTPException):
            app.translate(app.TranslateBody(text="x" * 1001))

    def test_settings_does_not_echo_baidu_secret(self):
        app.save_settings(app.UserSettingsBody(baidu_translate_appid="test-app-id", baidu_translate_secret="test-key-value"))
        response = app.get_settings()
        self.assertTrue(response["baidu_translate_configured"])
        self.assertNotIn("test-key-value", json.dumps(response))
        self.assertEqual(stat.S_IMODE(self.settings.stat().st_mode), 0o600)

    def test_export_uses_translated_free_text_without_overwriting_raw(self):
        state = {"base_prompt": [], "characters": [], "global_uc": [], "free_text": "中文原文", "free_text_en": "English raw", "use_free_text_en": True}
        result = novelai_export.export(state)
        self.assertEqual(result["free_text"], "English raw")
        self.assertEqual(result["free_text_raw"], "中文原文")
        state["use_free_text_en"] = False
        self.assertEqual(novelai_export.export(state)["free_text"], "中文原文")


if __name__ == "__main__":
    unittest.main()
