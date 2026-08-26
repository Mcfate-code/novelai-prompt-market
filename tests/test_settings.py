import asyncio
import io
import json
import os
import stat
import tempfile
import unittest
import zipfile
from io import BytesIO
from pathlib import Path

from PIL import Image
from types import SimpleNamespace
from unittest.mock import patch

import app
import db


class SettingsAndVisibilityTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.settings_path = self.tmp / "tags-market-settings.json"
        self.db_path = self.tmp / "tags.sqlite"
        self.thumb_dir = self.tmp / "thumbs"
        self.novelai_example_dir = self.tmp / "novelai-examples"
        self.gallery_dir = self.tmp / "gallery"
        self.gallery_trash_dir = self.tmp / "待清理" / "图库"
        self.thumb_dir.mkdir()
        self.novelai_example_dir.mkdir()
        self.gallery_dir.mkdir()
        db.init_db(self.db_path)
        self.patches = [
            patch.object(app, "BASE_DIR", self.tmp),
            patch.object(app, "USER_SETTINGS_PATH", self.settings_path),
            patch.object(app, "THUMB_DIR", self.thumb_dir),
            patch.object(app, "NOVELAI_EXAMPLE_DIR", self.novelai_example_dir),
            patch.object(app, "GALLERY_DIR", self.gallery_dir),
            patch.object(app, "GALLERY_ROOT", self.gallery_dir.resolve()),
            patch.object(app, "GALLERY_TRASH_DIR", self.gallery_trash_dir),
            patch.object(db, "DB_PATH", self.db_path),
        ]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()

    def conn(self):
        return db.get_conn(self.db_path)

    def test_default_settings_and_secure_persistence(self):
        data = app.get_settings()
        self.assertTrue(data["adolescent_mode"])
        self.assertEqual(data["cache_limit_mb"], 1024)
        self.assertEqual(data["novelai_batch_max_count"], 6)
        self.assertTrue(data["novelai_example_credit_warning"])
        self.assertFalse(data["has_danbooru_api_key"])
        self.assertFalse(data["novelai_configured"])
        self.assertNotIn("novelai_api_token", data)

        app.save_settings(
            app.UserSettingsBody(
                adolescent_mode=False,
                cache_limit_mb=1024,
                proxy_enabled=False,
                proxy_url="",
                danbooru_login="tester",
                danbooru_api_key="first-secret",
                novelai_api_token="novelai-secret",
                novelai_batch_max_count=42,
                novelai_example_credit_warning=False,
            )
        )
        saved = app.get_settings()
        self.assertFalse(saved["adolescent_mode"])
        self.assertEqual(saved["danbooru_login"], "tester")
        self.assertTrue(saved["has_danbooru_api_key"])
        self.assertTrue(saved["novelai_configured"])
        self.assertEqual(saved["novelai_batch_max_count"], 42)
        self.assertFalse(saved["novelai_example_credit_warning"])
        self.assertNotIn("novelai_api_token", saved)
        self.assertEqual(stat.S_IMODE(self.settings_path.stat().st_mode), 0o600)

        app.save_settings(
            app.UserSettingsBody(
                adolescent_mode=True,
                cache_limit_mb=1024,
                proxy_enabled=True,
                proxy_url="http://example.invalid:1234",
                danbooru_login="tester",
                danbooru_api_key="",
                novelai_api_token="",
            )
        )
        raw = json.loads(self.settings_path.read_text(encoding="utf-8"))
        self.assertEqual(raw["danbooru_api_key"], "first-secret")
        self.assertEqual(raw["novelai_api_token"], "novelai-secret")
        self.assertTrue(app.get_settings()["adolescent_mode"])

    def test_string_boolean_settings_are_parsed_strictly(self):
        self.settings_path.write_text(
            json.dumps({"adolescent_mode": "false", "proxy_enabled": "0"}),
            encoding="utf-8",
        )
        settings = app._load_user_settings()
        self.assertFalse(settings["adolescent_mode"])
        self.assertFalse(settings["proxy_enabled"])

        self.settings_path.write_text(
            json.dumps({"adolescent_mode": "unexpected", "proxy_enabled": "unexpected"}),
            encoding="utf-8",
        )
        settings = app._load_user_settings()
        self.assertTrue(settings["adolescent_mode"])
        self.assertTrue(settings["proxy_enabled"])

    def test_gallery_item_rejects_invalid_base64_and_mime(self):
        invalid = app.GalleryItemBody(image_base64="not base64", mime="image/png")
        with self.assertRaisesRegex(app.HTTPException, "base64"):
            asyncio.run(app.gallery_item(invalid))

        invalid_mime = app.GalleryItemBody(image_base64="aGVsbG8=", mime="image/")
        with self.assertRaisesRegex(app.HTTPException, "非法图片类型"):
            asyncio.run(app.gallery_item(invalid_mime))

    def test_gallery_item_accepts_data_url_with_allowed_mime(self):
        body = app.GalleryItemBody(
            image_base64="data:image/png;base64,aGVsbG8=",
            mime=" IMAGE/PNG ",
            prompt="test",
        )
        with (
            patch.object(app, "BASE_DIR", self.tmp.resolve()),
            patch.object(app, "GALLERY_DIR", self.gallery_dir),
            patch.object(app, "GALLERY_ROOT", self.gallery_dir.resolve()),
            patch.object(app.imageutil, "compress_image_bytes", return_value=b"jpeg"),
        ):
            result = asyncio.run(app.gallery_item(body))
        self.assertTrue(result["ok"])
        self.assertEqual(result["prompt"], "test")
        self.assertTrue(result["file_path"].endswith(".png"))
        self.assertEqual((self.tmp / result["file_path"]).read_bytes(), b"hello")

    def test_environment_novelai_token_overrides_local_setting(self):
        self.settings_path.write_text(json.dumps({"novelai_api_token": "local-secret"}), encoding="utf-8")
        with patch.dict(os.environ, {"NOVELAI_API_KEY": "environment-secret"}, clear=False):
            settings = app._load_user_settings()
        self.assertEqual(settings["novelai_api_token"], "environment-secret")

    def test_settings_boolean_parser_rejects_ambiguous_values(self):
        self.settings_path.write_text(
            json.dumps({
                "adolescent_mode": "false",
                "proxy_enabled": "0",
            }),
            encoding="utf-8",
        )
        settings = app._load_user_settings()
        self.assertFalse(settings["adolescent_mode"])
        self.assertFalse(settings["proxy_enabled"])

        self.settings_path.write_text(
            json.dumps({
                "adolescent_mode": "unknown",
                "proxy_enabled": 2,
            }),
            encoding="utf-8",
        )
        settings = app._load_user_settings()
        self.assertTrue(settings["adolescent_mode"])
        self.assertTrue(settings["proxy_enabled"])

    def test_connection_enables_busy_timeout_wal_and_foreign_keys(self):
        conn = self.conn()
        try:
            self.assertEqual(conn.execute("PRAGMA busy_timeout").fetchone()[0], 5000)
            self.assertEqual(conn.execute("PRAGMA journal_mode").fetchone()[0], "wal")
            self.assertEqual(conn.execute("PRAGMA foreign_keys").fetchone()[0], 1)
        finally:
            conn.close()

    def test_novelai_service_reuses_existing_process(self):
        with (
            patch.object(app, "_novelai_service_ready", return_value=True),
            patch.object(app.subprocess, "Popen") as popen,
        ):
            process, log_handle = app._start_novelai_service()
        self.assertIsNone(process)
        self.assertIsNone(log_handle)
        popen.assert_not_called()

    def test_novelai_service_starts_and_stops_managed_process(self):
        server_dir = self.tmp / "server"
        server_dir.mkdir()
        server_entry = server_dir / "server.mjs"
        server_entry.write_text("// test", encoding="utf-8")
        node = self.tmp / "node"
        node.write_text("", encoding="utf-8")

        class FakeProcess:
            returncode = None

            def __init__(self):
                self.terminated = False
                self.killed = False

            def poll(self):
                return None if not self.terminated else 0

            def terminate(self):
                self.terminated = True

            def wait(self, timeout):
                return 0

            def kill(self):
                self.killed = True

        process = FakeProcess()
        with (
            patch.object(app, "_novelai_service_ready", side_effect=[False, True]),
            patch.object(app, "_node_executable", return_value=str(node)),
            patch.object(app.subprocess, "Popen", return_value=process) as popen,
        ):
            started, log_handle = app._start_novelai_service()

        self.assertIs(started, process)
        command = popen.call_args.args[0]
        self.assertEqual(command[-3:], ["--port", "8787", "--no-boot"])
        self.assertIn("--experimental-sqlite", command)
        self.assertIn("--watch", command)
        self.assertEqual(popen.call_args.kwargs["cwd"], server_dir)
        self.assertEqual(popen.call_args.kwargs["env"]["PYTHON_APP_URL"], "http://127.0.0.1:8123")

        app._stop_novelai_service(started, log_handle)
        self.assertTrue(process.terminated)
        self.assertFalse(process.killed)
        self.assertTrue(log_handle.closed)

    def test_live_reload_can_be_disabled_for_a_stable_runtime(self):
        with patch.dict(os.environ, {"TAGS_MARKET_RELOAD": "0"}, clear=False):
            self.assertFalse(app._live_reload_enabled())
        with patch.dict(os.environ, {"TAGS_MARKET_RELOAD": "1"}, clear=False):
            self.assertTrue(app._live_reload_enabled())

    def test_cache_headers_distinguish_app_and_gallery_assets(self):
        async def call(path, status_code=200):
            request = SimpleNamespace(url=SimpleNamespace(path=path))
            response = SimpleNamespace(headers={}, status_code=status_code)

            async def next_handler(_request):
                return response

            return await app.add_cache_headers(request, next_handler)

        static_response = asyncio.run(call("/static/app.js"))
        gallery_response = asyncio.run(call("/gallery/demo/image.jpg"))
        missing_gallery_response = asyncio.run(call("/gallery/demo/missing.jpg", 404))
        self.assertEqual(static_response.headers["Cache-Control"], "no-cache")
        self.assertEqual(gallery_response.headers["Cache-Control"], "public, max-age=31536000, immutable")
        self.assertNotIn("Cache-Control", missing_gallery_response.headers)

    def test_hidden_tags_are_counted_out_before_pagination(self):
        conn = self.conn()
        try:
            rows = [
                ("safe_one", "safe_one", 100, 0),
                ("safe_two", "safe_two", 90, 0),
                ("adult_one", "adult_one", 80, 0),
            ]
            conn.executemany(
                "INSERT INTO tags (danbooru_name, prompt_tag, post_count, category) VALUES (?,?,?,?)",
                rows,
            )
            conn.executemany(
                "INSERT INTO taxonomy_map (tag_name, category_l1, category_l2, category_l3) VALUES (?,?,?,?)",
                [
                    ("safe_one", "普通", "", ""),
                    ("safe_two", "普通", "", ""),
                    ("adult_one", "NSFW", "", ""),
                ],
            )
            conn.execute(
                "INSERT INTO tag_catalog (id, kind, label, nsfw, config_json) VALUES (?,?,?,?,?)",
                ("normal", "taxonomy_category", "普通", 0, json.dumps({"taxonomy_label": "普通"})),
            )
            conn.commit()
        finally:
            conn.close()

        result = app.catalog_tags("normal", page=1, page_size=40, sort="hot")
        self.assertEqual(result["total"], 2)
        self.assertEqual(result["pages"], 1)
        self.assertEqual({item["tag"] for item in result["tags"]}, {"safe_one", "safe_two"})

    def test_storage_settings_report_three_independent_directories(self):
        (self.thumb_dir / "web.jpg").write_bytes(b"w" * 1024 * 1024)
        (self.novelai_example_dir / "nai.jpg").write_bytes(b"n" * 2 * 1024 * 1024)
        (self.gallery_dir / "gallery.jpg").write_bytes(b"g" * 3 * 1024 * 1024)
        settings = app.get_settings()
        self.assertEqual(settings["cache_usage_mb"], 1.0)
        self.assertEqual(settings["novelai_example_usage_mb"], 2.0)
        self.assertEqual(settings["gallery_usage_mb"], 3.0)

    def test_clear_novelai_example_cache_keeps_web_and_gallery_files(self):
        web_file = self.thumb_dir / "web.jpg"
        nai_file = self.novelai_example_dir / "nai.jpg"
        gallery_file = self.gallery_dir / "gallery.jpg"
        web_file.write_bytes(b"web")
        nai_file.write_bytes(b"nai")
        gallery_file.write_bytes(b"gallery")
        conn = self.conn()
        try:
            conn.execute("INSERT INTO tag_novelai_examples (tag_name,prompt,file_url,model,width,height,steps,seed,status,error_message,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", ("safe_one", "safe_one", "/static/novelai-examples/nai.jpg", app.NOVELAI_EXAMPLE_MODEL, 832, 832, 28, 1, "ready", "", db.now_iso(), db.now_iso()))
            conn.commit()
        finally:
            conn.close()
        result = app.clear_novelai_example_cache()
        self.assertTrue(result["ok"])
        self.assertEqual(result["removed"], 1)
        self.assertTrue(web_file.exists())
        self.assertFalse(nai_file.exists())
        self.assertTrue(gallery_file.exists())
        conn = self.conn()
        try:
            self.assertIsNone(conn.execute("SELECT 1 FROM tag_novelai_examples LIMIT 1").fetchone())
        finally:
            conn.close()

    def test_list_novelai_examples_only_returns_ready_cached_records(self):
        ready = self.novelai_example_dir / "ready.jpg"
        ready.write_bytes(b"ready")
        conn = self.conn()
        try:
            now = db.now_iso()
            conn.executemany("INSERT INTO tag_novelai_examples (tag_name,prompt,file_url,model,width,height,steps,seed,status,error_message,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", [("ready_tag", "ready_tag", "/static/novelai-examples/ready.jpg", app.NOVELAI_EXAMPLE_MODEL, 832, 832, 28, 1, "ready", "", now, now), ("pending_tag", "pending_tag", "", app.NOVELAI_EXAMPLE_MODEL, 832, 832, 28, None, "pending", "", now, now)])
            conn.commit()
        finally:
            conn.close()
        result = app.list_novelai_examples("ready_tag,pending_tag")
        self.assertEqual(set(result["examples"]), {"ready_tag"})

    def test_novelai_example_generation_hits_cache_without_calling_service(self):
        tag = "blue eyes"
        target = app._novelai_example_path(tag)
        target.write_bytes(b"cached-jpeg")
        now = db.now_iso()
        conn = self.conn()
        try:
            conn.execute("INSERT INTO tag_novelai_examples (tag_name,prompt,file_url,model,width,height,steps,seed,status,error_message,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", (tag, tag, f"/static/novelai-examples/{target.name}", app.NOVELAI_EXAMPLE_MODEL, 832, 832, 28, 123, "ready", "", now, now))
            conn.commit()
        finally:
            conn.close()
        with patch.object(app.urllib.request, "urlopen") as urlopen:
            result = app.generate_novelai_example(tag, app.NovelAIExampleBody(prompt=tag))
        self.assertTrue(result["cached"])
        self.assertEqual(result["example"]["file_url"], f"/static/novelai-examples/{target.name}")
        urlopen.assert_not_called()

    def test_novelai_example_prompt_includes_the_tag_rating_constraint(self):
        self.assertEqual(
            app._novelai_example_prompt("blue eyes", False),
            "{{blue eyes}}, safe, masterpiece, best quality, very aesthetic, absurdres",
        )
        self.assertEqual(
            app._novelai_example_prompt("explicit_tag", True),
            "{{explicit_tag}}, nsfw, masterpiece, best quality, very aesthetic, absurdres",
        )

    def test_novelai_example_prompt_uses_custom_template(self):
        custom = "{tag}, {rating}, foo, bar"
        self.assertEqual(app._novelai_example_prompt("blue eyes", False, custom), "{{blue eyes}}, safe, foo, bar")
        self.assertEqual(app._novelai_example_prompt("x", True, custom), "{{x}}, nsfw, foo, bar")

    def test_novelai_example_prompt_falls_back_when_template_missing_tag(self):
        rendered = app._novelai_example_prompt("blue eyes", False, "no placeholder here")
        self.assertIn("{{blue eyes}}", rendered)
        self.assertIn("masterpiece", rendered)

    def test_save_settings_accepts_valid_example_prompt_template(self):
        saved = app.save_settings(
            app.UserSettingsBody(
                adolescent_mode=True,
                cache_limit_mb=1024,
                proxy_enabled=True,
                proxy_url="http://example.invalid:1234",
                danbooru_login="",
                danbooru_api_key="",
                novelai_api_token="",
                novelai_example_prompt_template="{tag}, {rating}, custom quality",
            )
        )
        self.assertEqual(saved["novelai_example_prompt_template"], "{tag}, {rating}, custom quality")

    def test_save_settings_rejects_example_prompt_without_tag(self):
        with self.assertRaisesRegex(app.HTTPException, "必须包含 \\{tag\\}"):
            app.save_settings(
                app.UserSettingsBody(
                    adolescent_mode=True,
                    cache_limit_mb=1024,
                    proxy_enabled=True,
                    proxy_url="http://example.invalid:1234",
                    danbooru_login="",
                    danbooru_api_key="",
                    novelai_api_token="",
                    novelai_example_prompt_template="missing placeholder",
                )
            )

    def test_user_tags_add_list_delete(self):
        app.add_user_tag(app.UserTagRequest(tag="my_custom_tag", note="测试备注"))
        listed = app.list_user_tags()
        self.assertTrue(any(t["tag"] == "my_custom_tag" and t["note"] == "测试备注" for t in listed["tags"]))
        app.del_user_tag("my_custom_tag")
        listed = app.list_user_tags()
        self.assertFalse(any(t["tag"] == "my_custom_tag" for t in listed["tags"]))

    def test_novelai_example_requires_explicit_anlas_confirmation(self):
        with self.assertRaisesRegex(app.HTTPException, "消耗 Anlas") as context:
            app.generate_novelai_example("uncached tag", app.NovelAIExampleBody(prompt="uncached tag"))
        self.assertEqual(context.exception.status_code, 428)

    def test_clear_thumb_cache_keeps_gallery_files(self):
        thumb = self.thumb_dir / "cached.jpg"
        thumb.write_bytes(b"thumb")
        gallery_file = self.gallery_dir / "imported.jpg"
        gallery_file.write_bytes(b"gallery")
        conn = self.conn()
        try:
            conn.execute(
                "INSERT INTO tag_thumbs (tag_name, thumb_url, thumb_large_url, fetched_at) VALUES (?,?,?,?)",
                ("safe_one", "/static/thumbs/cached.jpg", "", db.now_iso()),
            )
            conn.commit()
        finally:
            conn.close()

        result = app.clear_thumb_cache()
        self.assertTrue(result["ok"])
        self.assertFalse(thumb.exists())
        self.assertTrue(gallery_file.exists())
        conn = self.conn()
        try:
            self.assertIsNone(conn.execute("SELECT 1 FROM tag_thumbs LIMIT 1").fetchone())
        finally:
            conn.close()

    def test_gallery_cleanup_moves_selected_files_and_removes_index(self):
        source = self.gallery_dir / "demo"
        source.mkdir()
        image = source / "image.jpg"
        image.write_bytes(b"gallery")
        conn = self.conn()
        try:
            conn.execute(
                "INSERT INTO gallery (dir_name, file_name, prompt, file_path, created_at) VALUES (?,?,?,?,?)",
                ("demo", "source.png", "prompt", str(image.relative_to(self.tmp)), db.now_iso()),
            )
            conn.execute(
                "INSERT INTO gallery_favorites (dir_name, file_name, created_at) VALUES (?,?,?)",
                ("demo", "source.png", db.now_iso()),
            )
            conn.commit()
        finally:
            conn.close()
        result = app.gallery_cleanup(app.GalleryCleanupBody(items=[app.GalleryItemRef(dir_name="demo", file_name="source.png")]))
        self.assertTrue(result["ok"])
        self.assertEqual(result["count"], 1)
        self.assertFalse(image.exists())
        moved = list((self.gallery_trash_dir / "用户待清理").glob("*"))
        self.assertEqual(len(moved), 1)
        conn = self.conn()
        try:
            self.assertIsNone(conn.execute("SELECT 1 FROM gallery WHERE dir_name='demo'").fetchone())
            self.assertIsNone(conn.execute("SELECT 1 FROM gallery_favorites WHERE dir_name='demo'").fetchone())
        finally:
            conn.close()

    def test_gallery_delete_moves_files_to_cleanup_before_removing_index(self):
        source = self.gallery_dir / "demo"
        source.mkdir()
        (source / "image.jpg").write_bytes(b"gallery")
        conn = self.conn()
        try:
            conn.execute(
                "INSERT INTO gallery (dir_name, file_name, prompt, file_path, created_at) VALUES (?,?,?,?,?)",
                ("demo", "source.png", "prompt", "gallery/demo/image.jpg", db.now_iso()),
            )
            conn.commit()
        finally:
            conn.close()

        result = app.gallery_delete("demo")

        self.assertTrue(result["ok"])
        self.assertFalse(source.exists())
        cleanup_path = self.tmp / result["cleanup_path"]
        self.assertTrue((cleanup_path / "image.jpg").exists())
        conn = self.conn()
        try:
            self.assertIsNone(conn.execute("SELECT 1 FROM gallery WHERE dir_name='demo'").fetchone())
        finally:
            conn.close()

    def test_gallery_item_delete_moves_file_and_companions_and_removes_index(self):
        source = self.gallery_dir / "demo"
        source.mkdir()
        (source / "image.jpg").write_bytes(b"gallery")
        (source / "image.json").write_bytes(b"{}")
        (source / "image.thumb.jpg").write_bytes(b"thumb")
        conn = self.conn()
        try:
            conn.execute(
                "INSERT INTO gallery (dir_name, file_name, prompt, file_path, created_at) VALUES (?,?,?,?,?)",
                ("demo", "source.png", "prompt", "gallery/demo/image.jpg", db.now_iso()),
            )
            conn.execute(
                "INSERT INTO gallery_favorites (dir_name, file_name, created_at) VALUES (?,?,?)",
                ("demo", "source.png", db.now_iso()),
            )
            conn.commit()
        finally:
            conn.close()

        result = app.gallery_item_delete(app.GalleryItemRef(dir_name="demo", file_name="source.png"))

        self.assertTrue(result["ok"])
        self.assertFalse((source / "image.jpg").exists())
        self.assertFalse((source / "image.json").exists())
        self.assertFalse((source / "image.thumb.jpg").exists())
        moved = list((self.gallery_trash_dir / "已删除图片").glob("*"))
        self.assertEqual(len(moved), 3)
        conn = self.conn()
        try:
            self.assertIsNone(conn.execute("SELECT 1 FROM gallery WHERE dir_name='demo'").fetchone())
            self.assertIsNone(conn.execute("SELECT 1 FROM gallery_favorites WHERE dir_name='demo'").fetchone())
        finally:
            conn.close()

    def test_gallery_item_delete_rejects_missing_file(self):
        source = self.gallery_dir / "demo"
        source.mkdir()
        conn = self.conn()
        try:
            conn.execute(
                "INSERT INTO gallery (dir_name, file_name, prompt, file_path, created_at) VALUES (?,?,?,?,?)",
                ("demo", "ghost.png", "prompt", "gallery/demo/ghost.png", db.now_iso()),
            )
            conn.commit()
        finally:
            conn.close()
        with self.assertRaises(app.HTTPException) as ctx:
            app.gallery_item_delete(app.GalleryItemRef(dir_name="demo", file_name="ghost.png"))
        self.assertEqual(ctx.exception.status_code, 404)

    def test_gallery_zip_import_rolls_back_files_and_rows_on_batch_failure(self):
        archive = io.BytesIO()
        png_buffer = BytesIO()
        Image.new("RGBA", (1, 1), (255, 255, 255, 255)).save(png_buffer, format="PNG")
        valid_png = png_buffer.getvalue()
        with zipfile.ZipFile(archive, "w") as zf:
            zf.writestr("first.png", valid_png)
            zf.writestr("second.png", valid_png)

        class MemoryUpload:
            filename = "broken-batch.zip"

            def __init__(self, data):
                self._data = data
                self._read = False

            async def read(self, _size):
                if self._read:
                    return b""
                self._read = True
                return self._data

            async def close(self):
                return None

        real_conn = app._conn

        class FailingConnection:
            def __init__(self, conn):
                self.conn = conn
                self.inserts = 0

            def execute(self, sql, parameters=()):
                if sql.startswith("INSERT INTO gallery"):
                    self.inserts += 1
                    if self.inserts == 2:
                        raise RuntimeError("forced batch failure")
                return self.conn.execute(sql, parameters)

            def __getattr__(self, name):
                return getattr(self.conn, name)

        def failing_conn():
            return FailingConnection(real_conn())

        upload = MemoryUpload(archive.getvalue())
        with (
            patch.object(app, "BASE_DIR", self.tmp.resolve()),
            patch.object(app, "_conn", side_effect=failing_conn),
            patch.object(app.imageutil, "compress_image_bytes", return_value=b"jpeg"),
        ):
            with self.assertRaisesRegex(RuntimeError, "forced batch failure"):
                asyncio.run(app.gallery_import(upload))

        target = self.gallery_dir / "broken-batch"
        self.assertEqual(list(target.glob("*.jpg")), [])
        recovered = list((self.gallery_trash_dir / "ZIP导入失败").glob("*"))
        self.assertEqual(len(recovered), 2)
        conn = self.conn()
        try:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM gallery WHERE dir_name='broken-batch'").fetchone()[0], 0)
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main()
