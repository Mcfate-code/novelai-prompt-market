"""PHASE 8 交付契约：/api/offline-prior/status 优雅降级（先验库缺失不抛错）。"""
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app
from prompt import prior as prior_mod
from prompt.prior_schema import ensure_prior_schema


class OfflinePriorStatusTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.db_path = self.tmp / "offline_prompt_prior.sqlite"
        self._saved_singleton = prior_mod._singleton

    def tearDown(self):
        prior_mod._singleton = self._saved_singleton

    def _patch_singleton(self, path: Path) -> None:
        prior_mod._singleton = prior_mod.PromptPrior(str(path))

    def _make_prior_db(self) -> None:
        conn = sqlite3.connect(str(self.db_path))
        try:
            ensure_prior_schema(conn)
            conn.executemany(
                "INSERT INTO tag_semantic_node (tag, node_id, rule_source) VALUES (?,?,?)",
                [("blue eyes", "appearance", "nav_seed"), ("1girl", "character", "nav_seed")],
            )
            conn.execute(
                "INSERT INTO prior_manifest (source_id, source_type, revision) VALUES (?,?,?)",
                ("public-corpus", "public", "r1"),
            )
            conn.execute(
                "INSERT INTO prior_manifest (source_id, source_type, revision) VALUES (?,?,?)",
                ("siliconflow-embedding", "embedding", "r2"),
            )
            conn.execute(
                "INSERT INTO prior_manifest (source_id, source_type, revision) VALUES (?,?,?)",
                ("manual", "curated", "r3"),
            )
            conn.commit()
        finally:
            conn.close()

    def test_status_missing_db_is_graceful(self):
        self._patch_singleton(self.tmp / "missing.sqlite")
        status = prior_mod.get_prior().status()
        self.assertFalse(status["available"])
        self.assertEqual(status["node_count"], 0)
        self.assertEqual(status["source_count"], 0)
        self.assertIn("missing", status["note"])

    def test_status_present_db_reports_counts(self):
        self._make_prior_db()
        self._patch_singleton(self.db_path)
        status = prior_mod.get_prior().status()
        self.assertTrue(status["available"])
        self.assertEqual(status["node_count"], 2)
        self.assertEqual(status["source_count"], 3)  # distinct (source_id, source_type)

    def test_endpoint_returns_gracefully_when_db_missing(self):
        self._patch_singleton(self.tmp / "missing.sqlite")
        result = app.offline_prior_status()
        self.assertFalse(result["available"])
        self.assertEqual(result["node_count"], 0)
        self.assertEqual(result["source_count"], 0)
        self.assertIn("path", result)

    def test_endpoint_reports_counts_when_db_present(self):
        self._make_prior_db()
        self._patch_singleton(self.db_path)
        result = app.offline_prior_status()
        self.assertTrue(result["available"])
        self.assertEqual(result["node_count"], 2)
        self.assertEqual(result["source_count"], 3)


if __name__ == "__main__":
    unittest.main()