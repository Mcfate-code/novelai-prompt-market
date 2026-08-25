"""Alias resolution —— 别名/中文命中后必须转成英文 canonical。"""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import db
import search
from importer import import_aliases, import_taxonomy


class AliasResolutionTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db_path = Path(self.tmp) / "t.sqlite"
        db.init_db(self.db_path)
        conn = db.get_conn(self.db_path)
        import_taxonomy.import_taxonomy(conn)
        import_aliases.import_zh(conn)
        conn.close()

    def conn(self):
        return db.get_conn(self.db_path)

    def test_exact_zh_alias_resolves_to_canonical(self):
        conn = self.conn()
        try:
            r = search.resolve_tag(conn, "蓝眼睛")
            self.assertIsNotNone(r)
            self.assertEqual(r["canonical"], "blue_eyes")
            self.assertEqual(r["tag"], "blue eyes")
        finally:
            conn.close()

    def test_zh_prefix_matches(self):
        conn = self.conn()
        try:
            r = search.resolve_tag(conn, "蓝眼")
            self.assertIsNotNone(r)
            self.assertEqual(r["tag"], "blue eyes")
        finally:
            conn.close()

    def test_english_resolves_to_underscore_canonical(self):
        conn = self.conn()
        try:
            r = search.resolve_tag(conn, "long hair")
            self.assertEqual(r["canonical"], "long_hair")
        finally:
            conn.close()

    def test_canonical_forms_resolve_equivalently(self):
        conn = self.conn()
        try:
            for query in ("blue_eyes", "blue eyes", "BLUE_EYES", "Blue Eyes"):
                with self.subTest(query=query):
                    resolved = search.resolve_tag(conn, query)
                    self.assertIsNotNone(resolved)
                    self.assertEqual(resolved["canonical"], "blue_eyes")
                    self.assertEqual(resolved["tag"], "blue eyes")
        finally:
            conn.close()

    def _insert(self, conn, prompt_tag, post_count=100):
        db.upsert_tags(conn, [{
            "danbooru_name": prompt_tag.replace(" ", "_"),
            "prompt_tag": prompt_tag,
            "category": 0,
            "post_count": post_count,
        }])

    def test_token_order_reversed_resolves(self):
        """词序颠倒的自定义写法应解析到 canonical：'Range Murata' -> 'murata range'。"""
        conn = self.conn()
        try:
            self._insert(conn, "murata range")
            r = search.resolve_tag(conn, "Range Murata")
            self.assertIsNotNone(r)
            self.assertEqual(r["tag"], "murata range")
            self.assertEqual(r["via"], "token_key")
        finally:
            conn.close()

    def test_token_order_reversed_search_first(self):
        """搜索词序颠倒时，token 全等的 canonical 排第一（rank 1.5，先于 prefix）。"""
        conn = self.conn()
        try:
            self._insert(conn, "murata range")
            results = search.search(conn, "range murata", limit=10)
            self.assertTrue(results)
            self.assertEqual(results[0]["tag"], "murata range")
        finally:
            conn.close()

    def test_token_key_keeps_duplicate_tokens(self):
        """token_key 保留重复 token：'foo foo bar' 不等于 'foo bar'。"""
        self.assertNotEqual(search.token_key("foo foo bar"), search.token_key("foo bar"))

    def test_token_collision_not_auto_resolved(self):
        """同 token_key 存在多个不同 canonical 时不自动解析（collision 防御）。"""
        conn = self.conn()
        try:
            self._insert(conn, "test alpha beta")
            self._insert(conn, "beta alpha test")
            r = search.resolve_tag(conn, "alpha test beta")
            self.assertIsNone(r)
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main()
