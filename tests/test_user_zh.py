"""自定义标签中文备注持久化：备注覆盖默认、可清除、可重开。"""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import db
import search
import app as app_mod  # noqa: E402  复用 _apply_user_zh（接口层覆盖逻辑）


class UserZhNoteTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db_path = Path(self.tmp) / "t.sqlite"
        db.init_db(self.db_path)

    def conn(self):
        return db.get_conn(self.db_path)

    def _save(self, conn, tag, zh):
        if zh:
            conn.execute(
                "INSERT INTO user_zh (tag_name, zh, updated_at) VALUES (?,?,?) "
                "ON CONFLICT(tag_name) DO UPDATE SET zh=excluded.zh, updated_at=excluded.updated_at",
                (tag, zh, db.now_iso()),
            )
        else:
            conn.execute("DELETE FROM user_zh WHERE tag_name=?", (tag,))
        conn.commit()

    def test_note_upsert_and_override(self):
        conn = self.conn()
        try:
            self._save(conn, "my custom tag", "自定义")
            self._save(conn, "my custom tag", "改过的备注")
            row = conn.execute("SELECT zh FROM user_zh WHERE tag_name=?", ("my custom tag",)).fetchone()
            self.assertEqual(row["zh"], "改过的备注")
        finally:
            conn.close()

    def test_clear_note(self):
        conn = self.conn()
        try:
            self._save(conn, "my custom tag", "自定义")
            self._save(conn, "my custom tag", "")  # 空串 = 清除
            row = conn.execute("SELECT 1 FROM user_zh WHERE tag_name=?", ("my custom tag",)).fetchone()
            self.assertIsNone(row)
        finally:
            conn.close()

    def test_note_persists_across_reopen(self):
        conn = self.conn()
        self._save(conn, "my custom tag", "自定义")
        conn.close()
        conn2 = self.conn()
        try:
            row = conn2.execute("SELECT zh FROM user_zh WHERE tag_name=?", ("my custom tag",)).fetchone()
            self.assertEqual(row["zh"], "自定义")
        finally:
            conn2.close()

    def test_search_dto_applies_user_note_override(self):
        """回归：搜索等接口返回的 zh 必须应用 user_zh 备注覆盖（不只购物车显示）。"""
        conn = self.conn()
        try:
            db.upsert_tags(conn, [
                {
                    "danbooru_name": "test_tag_x",
                    "prompt_tag": "test tag x",
                    "category": 0,
                    "post_count": 100,
                    "zh_name": "默认中文",
                }
            ])
            # 无备注时返回 DB 中文
            results = search.search(conn, "test tag x")
            self.assertEqual(results[0]["zh"], "默认中文")
            # 添加用户备注后，接口 DTO 应被覆盖
            self._save(conn, "test tag x", "我的备注")
            app_mod._apply_user_zh(conn, results)
            self.assertEqual(results[0]["zh"], "我的备注")
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main()
