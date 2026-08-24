import os
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


if __name__ == "__main__":
    unittest.main()
