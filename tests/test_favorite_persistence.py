"""Stage 2 收藏持久化测试：收藏与购物车分离、同 tag 不重复、取消即消失。"""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import db


class FavoritePersistenceTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db_path = Path(self.tmp) / "t.sqlite"
        db.init_db(self.db_path)

    def conn(self):
        return db.get_conn(self.db_path)

    def _add(self, conn, tag):
        conn.execute(
            "INSERT INTO favorites (tag_name, created_at) VALUES (?, ?) "
            "ON CONFLICT(tag_name) DO NOTHING",
            (tag, db.now_iso()),
        )
        conn.commit()

    def _count(self, conn):
        return conn.execute("SELECT COUNT(*) c FROM favorites").fetchone()["c"]

    def test_duplicate_favorite_is_idempotent(self):
        conn = self.conn()
        try:
            self._add(conn, "blue eyes")
            self._add(conn, "blue eyes")
            self.assertEqual(self._count(conn), 1)
        finally:
            conn.close()

    def test_unfavorite_removes_immediately(self):
        conn = self.conn()
        try:
            self._add(conn, "blue eyes")
            conn.execute("DELETE FROM favorites WHERE tag_name=?", ("blue eyes",))
            conn.commit()
            self.assertEqual(self._count(conn), 0)
        finally:
            conn.close()

    def test_favorite_persists_across_reopen(self):
        # 写入后关闭连接，重新打开仍在（模拟刷新页面）
        conn = self.conn()
        self._add(conn, "long hair")
        conn.close()
        conn2 = self.conn()
        try:
            rows = conn2.execute("SELECT tag_name FROM favorites").fetchall()
            self.assertEqual([r["tag_name"] for r in rows], ["long hair"])
        finally:
            conn2.close()

    def test_favorite_does_not_touch_recent(self):
        # 收藏与最近使用分离：收藏不应写入 recent_tags
        conn = self.conn()
        try:
            self._add(conn, "blue eyes")
            recent = conn.execute("SELECT COUNT(*) c FROM recent_tags").fetchone()["c"]
            self.assertEqual(recent, 0)
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main()
