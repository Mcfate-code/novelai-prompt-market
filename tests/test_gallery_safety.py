import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app
from importer import sync_danbooru


class GallerySafetyTest(unittest.TestCase):
    def test_gallery_path_rejects_traversal(self):
        with self.assertRaises(Exception):
            app._safe_gallery_path("../outside")
        with self.assertRaises(Exception):
            app._safe_gallery_path("/tmp/outside")

    def test_gallery_path_stays_under_root(self):
        target = app._safe_gallery_path("demo-gallery")
        self.assertEqual(target.parent, app.GALLERY_DIR.resolve())

    def test_dir_name_is_sanitized(self):
        self.assertEqual(app._sanitize_dir_name("my gallery!.zip"), "my_gallery!.zip".removesuffix(".zip"))
        self.assertEqual(app._sanitize_dir_name("../../.zip"), "gallery")

    def test_auth_uses_environment_variables(self):
        with patch.dict(os.environ, {"DANBOORU_LOGIN": "tester", "DANBOORU_API_KEY": "secret"}, clear=False):
            headers = sync_danbooru._auth_headers()
        self.assertTrue(headers["Authorization"].startswith("Basic "))

    def test_gallery_companion_files_same_dir_only(self):
        with tempfile.TemporaryDirectory() as d:
            main = Path(d) / "abc.png"
            main.write_bytes(b"png")
            (Path(d) / "abc.json").write_bytes(b"{}")
            (Path(d) / "abc.thumb.jpg").write_bytes(b"thumb")
            (Path(d) / "unrelated.jpg").write_bytes(b"other")
            companions = {p.name for p in app._gallery_companion_files(main)}
            self.assertIn("abc.json", companions)
            self.assertIn("abc.thumb.jpg", companions)
            self.assertNotIn("unrelated.jpg", companions)
            self.assertNotIn("abc.png", companions)

    def test_gallery_companion_files_missing_main_returns_empty(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(app._gallery_companion_files(Path(d) / "nope.png"), [])


if __name__ == "__main__":
    unittest.main()
