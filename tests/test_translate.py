import hashlib
import json
import os
import stat
import tempfile
import unittest
import urllib.error
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
            # 隔离百度翻译凭据环境变量：即使用户按 README export 了
            # BAIDU_TRANSLATE_APPID / BAIDU_TRANSLATE_SECRET，未配置测试也必须稳定命中 428，
            # 不能走真实网络。空白化后 _load_user_settings 回退到设置文件值（默认空）。
            patch.dict(os.environ, {"BAIDU_TRANSLATE_APPID": "", "BAIDU_TRANSLATE_SECRET": ""}),
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

    def test_baidu_error_codes_are_diagnosable(self):
        cases = {
            "52001": "超时",
            "52002": "系统错误",
            "52003": "未开通",       # 服务未开通 / 未授权用户
            "54000": "必填参数",
            "54001": "签名错误",     # 错误凭据
            "54003": "访问频率受限",  # QPS
            "54004": "余额不足",     # 余额
            "54005": "频繁",
            "58000": "IP",          # IP 限制
            "58001": "语言方向",
            "58002": "已关闭",       # 服务已关闭
            "90107": "认证",
        }
        for code, needle in cases.items():
            msg = app._translate_error_message({"error_code": code})
            self.assertIn(code, msg, f"错误码 {code} 未回显")
            self.assertIn(needle, msg, f"错误码 {code} 缺少可诊断文案")
        # 未知错误码也要回显原始码与错误信息，避免「暂时不可用」式不可诊断
        unknown = app._translate_error_message({"error_code": "99999", "error_msg": "boom"})
        self.assertIn("99999", unknown)
        self.assertIn("boom", unknown)

    def test_effective_proxy_resolution_and_fallback(self):
        # 用户设置代理优先
        self.assertEqual(
            app._effective_proxy({"proxy_enabled": True, "proxy_url": "http://user:1"}),
            "http://user:1",
        )
        with patch.object(app, "SETTINGS", {"proxy": {"enabled": True, "url": "http://127.0.0.1:7890"}}):
            # 显式关闭代理 → 强制直连，不回退 app_settings
            self.assertEqual(app._effective_proxy({"proxy_enabled": False, "proxy_url": ""}), "")
            # 用户未配置代理 → 回退 config/app_settings.json 的 proxy.enabled/url 兜底
            self.assertEqual(
                app._effective_proxy({"proxy_enabled": True, "proxy_url": ""}),
                "http://127.0.0.1:7890",
            )
        with patch.object(app, "SETTINGS", {"proxy": {"enabled": False, "url": "http://127.0.0.1:7890"}}):
            self.assertEqual(app._effective_proxy({"proxy_enabled": True, "proxy_url": ""}), "")
        # 无任何代理配置 → 直连
        with patch.object(app, "SETTINGS", {}):
            self.assertEqual(app._effective_proxy({"proxy_enabled": True, "proxy_url": ""}), "")

    def test_translate_connection_error_mentions_effective_proxy(self):
        app._save_user_settings({
            **app.DEFAULT_USER_SETTINGS,
            "baidu_translate_appid": "test-app-id",
            "baidu_translate_secret": "test-key-value",
            "proxy_enabled": True,
            "proxy_url": "http://127.0.0.1:7890",
        })

        class FailingOpener:
            def open(self, request, timeout):
                raise urllib.error.URLError("boom")

        with patch.object(app.urllib.request, "build_opener", return_value=FailingOpener()):
            with self.assertRaises(app.HTTPException) as ctx:
                app.translate(app.TranslateBody(text="你好", **{"from": "zh", "to": "en"}))
        self.assertIn("连接失败", ctx.exception.detail)
        self.assertIn("http://127.0.0.1:7890", ctx.exception.detail)

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
