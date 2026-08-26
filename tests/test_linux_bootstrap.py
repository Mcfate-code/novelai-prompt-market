from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

import app
import db
from importer import build_catalog, import_aliases, import_restricted, import_taxonomy


class LinuxBootstrapTests(unittest.TestCase):
    def test_default_navigation_is_available_without_runtime_data(self):
        with tempfile.TemporaryDirectory() as td:
            missing_runtime_nav = Path(td) / "navigation.json"
            with mock.patch.object(build_catalog, "NAV_PATH", missing_runtime_nav):
                nav = build_catalog.load_navigation()

        groups = nav.get("nav", [])
        self.assertTrue(groups)
        child_ids = {
            child["id"]
            for group in groups
            for child in group.get("children", [])
        }
        self.assertTrue({"general", "artist", "copyright", "character", "meta"}.issubset(child_ids))
        self.assertTrue({"favorites", "recent"}.issubset(child_ids))

    def test_restricted_seed_lookup_does_not_require_app_settings(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td) / "repo"
            base.mkdir()
            with mock.patch.object(db, "BASE_DIR", base):
                self.assertIsNone(import_restricted.locate_seed())

    def test_fresh_clone_bootstrap_skips_optional_taxonomy_seed(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            database = root / "data" / "tags.sqlite"
            missing_taxonomy = root / "data" / "taxonomy_seed.json"
            missing_navigation = root / "data" / "navigation.json"

            with (
                mock.patch.object(db, "DB_PATH", database),
                mock.patch.object(import_taxonomy, "SEED_PATH", missing_taxonomy),
                mock.patch.object(build_catalog, "NAV_PATH", missing_navigation),
                mock.patch.object(import_aliases, "import_zh", return_value={}),
                mock.patch.object(import_restricted, "import_restricted", side_effect=FileNotFoundError),
                mock.patch.object(import_taxonomy, "import_taxonomy") as taxonomy_import,
            ):
                app.ensure_seeded()

            taxonomy_import.assert_not_called()
            self.assertTrue(database.is_file())
            conn = db.get_conn(database)
            try:
                catalog_ids = {
                    row["id"] for row in conn.execute(
                        "SELECT id FROM tag_catalog WHERE kind != 'group'"
                    ).fetchall()
                }
            finally:
                conn.close()
            self.assertTrue({"general", "favorites", "recent"}.issubset(catalog_ids))


if __name__ == "__main__":
    unittest.main()
