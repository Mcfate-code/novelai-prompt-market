import json
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app
import db


class SettingsAndVisibilityTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.settings_path = self.tmp / "tags-market-settings.json"
        self.db_path = self.tmp / "tags.sqlite"
        self.thumb_dir = self.tmp / "thumbs"
        self.gallery_dir = self.tmp / "gallery"
        self.thumb_dir.mkdir()
        self.gallery_dir.mkdir()
        db.init_db(self.db_path)
        self.patches = [
            patch.object(app, "USER_SETTINGS_PATH", self.settings_path),
            patch.object(app, "THUMB_DIR", self.thumb_dir),
            patch.object(app, "GALLERY_DIR", self.gallery_dir),
            patch.object(app, "GALLERY_ROOT", self.gallery_dir.resolve()),
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
        self.assertFalse(data["has_danbooru_api_key"])

        app.save_settings(
            app.UserSettingsBody(
                adolescent_mode=False,
                cache_limit_mb=1024,
                proxy_enabled=False,
                proxy_url="",
                danbooru_login="tester",
                danbooru_api_key="first-secret",
            )
        )
        saved = app.get_settings()
        self.assertFalse(saved["adolescent_mode"])
        self.assertEqual(saved["danbooru_login"], "tester")
        self.assertTrue(saved["has_danbooru_api_key"])
        self.assertEqual(stat.S_IMODE(self.settings_path.stat().st_mode), 0o600)

        app.save_settings(
            app.UserSettingsBody(
                adolescent_mode=True,
                cache_limit_mb=1024,
                proxy_enabled=True,
                proxy_url="http://127.0.0.1:7890",
                danbooru_login="tester",
                danbooru_api_key="",
            )
        )
        raw = json.loads(self.settings_path.read_text(encoding="utf-8"))
        self.assertEqual(raw["danbooru_api_key"], "first-secret")
        self.assertTrue(app.get_settings()["adolescent_mode"])

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


if __name__ == "__main__":
    unittest.main()
