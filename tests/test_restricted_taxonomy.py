"""Stage 3 受限 taxonomy 接入测试：schema / 解析统计 / 无重复 canonical / unresolved 保留。"""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import db
from importer import import_restricted


class RestrictedTaxonomyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db_path = Path(self.tmp) / "t.sqlite"
        db.init_db(self.db_path)
        conn = db.get_conn(self.db_path)
        # 预置少量 canonical + alias，用于验证解析
        db.upsert_tags(conn, [
            {"danbooru_name": "exposed_breasts", "prompt_tag": "exposed breasts", "category": 0, "post_count": 100},
            {"danbooru_name": "nude", "prompt_tag": "nude", "category": 0, "post_count": 200},
        ])
        db.upsert_aliases(conn, [
            {"alias": "topless", "canonical_name": "nude", "lang": "en", "source": "test"},
        ])
        conn.close()

    def conn(self):
        return db.get_conn(self.db_path)

    def test_schema_exists(self):
        conn = self.conn()
        try:
            conn.execute("SELECT section_id, seed, status, canonical_name FROM restricted_taxonomy_map LIMIT 0")
        finally:
            conn.close()

    def test_resolution_counts(self):
        seed = {
            "sections": [
                {"id": "1", "title": "测试分区", "tags": [
                    "exposed breasts",   # exact canonical
                    "topless",           # exact alias -> nude
                    "nude",              # exact canonical
                    "totally_made_up_tag_xyz",  # unresolved
                ]},
            ]
        }
        conn = self.conn()
        try:
            stats = import_restricted.import_restricted(conn, seed)
            self.assertEqual(stats["categories"], 1)
            self.assertEqual(stats["memberships"], 4)
            self.assertEqual(stats["resolved_canonical"], 2)
            self.assertEqual(stats["resolved_alias"], 1)
            self.assertEqual(stats["unresolved_seed"], 1)
        finally:
            conn.close()

    def test_no_duplicate_canonical_counted(self):
        # 两个不同 seed 解析到同一 canonical -> duplicates 计 1
        seed = {
            "sections": [
                {"id": "1", "title": "x", "tags": ["exposed breasts", "exposed_breasts"]},
            ]
        }
        conn = self.conn()
        try:
            stats = import_restricted.import_restricted(conn, seed)
            self.assertEqual(stats["duplicates"], 1)
        finally:
            conn.close()

    def test_unresolved_preserved(self):
        seed = {
            "sections": [
                {"id": "1", "title": "x", "tags": ["totally_made_up_tag_xyz"]},
            ]
        }
        conn = self.conn()
        try:
            import_restricted.import_restricted(conn, seed)
            row = conn.execute(
                "SELECT seed, status, canonical_name FROM restricted_taxonomy_map WHERE seed='totally_made_up_tag_xyz'"
            ).fetchone()
            self.assertIsNotNone(row)
            self.assertEqual(row["status"], "unresolved_seed")
            self.assertIsNone(row["canonical_name"])
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main()
