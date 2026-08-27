"""Phase A：作用域化学习 + 离线 Prompt 先验 测试。

覆盖：
  1. 跨角色污染防护（base/character/base_character_context/interaction 作用域隔离）
  2. 手动快照不触发学习
  3. 成功生成只学习一次（positive_weight=1.0）
  4. 运行时零 HF/PyArrow/Polars 依赖
  5. 离线先验构建确定性（两次构建行数一致）
  6. 推荐 local_cooccurrence 作用域查询
  7. adult/general 先验分割
  8. 无 tag 黑名单（loli/shota/young 参与学习）
  9. 先验库缺失时优雅降级
"""
import asyncio
import base64
import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app
import db
import prompt.prior as prior
import prompt.prior_build as prior_build
from prompt.recommendation import RecommendationContext, RecommendationService

REPO_ROOT = Path(__file__).resolve().parent.parent

NAV = {
    "schema_version": 1,
    "base": {
        "id": "base", "label": "Base", "zh": "基础画面", "target": "base", "section": "scene",
        "nsfw": False, "seed_tags": [], "children": [
            {"id": "base_style", "label": "Style", "zh": "风格", "target": "base", "section": "style",
             "nsfw": False, "seed_tags": ["masterpiece"], "children": []},
            {"id": "base_environment", "label": "Environment", "zh": "环境", "target": "base", "section": "scene",
             "nsfw": False, "seed_tags": ["bedroom", "night"], "children": []},
        ],
    },
    "character": {
        "id": "character", "label": "Character", "zh": "角色", "target": "character", "section": "character",
        "nsfw": False, "seed_tags": [], "children": [
            {"id": "char_identity", "label": "Identity", "zh": "身份", "target": "character", "section": "character",
             "nsfw": False, "seed_tags": ["solo"], "children": []},
            {"id": "char_appearance", "label": "Appearance", "zh": "外观", "target": "character", "section": "appearance",
             "nsfw": False, "seed_tags": ["long hair", "blue eyes"], "children": []},
            {"id": "char_action", "label": "Action", "zh": "动作", "target": "character", "section": "action",
             "nsfw": False, "seed_tags": ["standing"], "children": []},
        ],
    },
}


class ScopedLearningTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmp.name) / "rec.sqlite"
        db.init_db(self.db_path)
        self.conn_patch = patch.object(app, "_conn", side_effect=lambda: db.get_conn(self.db_path))
        self.conn_patch.start()
        self.settings_patch = patch.object(
            app, "_load_user_settings",
            return_value={**app.DEFAULT_USER_SETTINGS, "adolescent_mode": False},
        )
        self.settings_patch.start()

    def tearDown(self):
        self.settings_patch.stop()
        self.conn_patch.stop()
        self.tmp.cleanup()

    def conn(self):
        return db.get_conn(self.db_path)

    def insert_tags(self, rows):
        conn = self.conn()
        db.upsert_tags(conn, rows)
        conn.close()

    def all_scoped_pairs(self):
        conn = self.conn()
        rows = conn.execute("SELECT scope, tag_a, tag_b FROM tag_cooccurrence_scoped").fetchall()
        conn.close()
        pairs = {}
        for r in rows:
            pairs.setdefault(r["scope"], set()).add(tuple(sorted((r["tag_a"], r["tag_b"]))))
        return pairs

    # ------------------------------------------------------------------ #
    # 1. 跨角色污染防护
    # ------------------------------------------------------------------ #
    def test_cross_character_pollution_prevention(self):
        self.insert_tags([
            {"danbooru_name": "citlali", "prompt_tag": "citlali", "category": 4, "post_count": 1000},
            {"danbooru_name": "furina", "prompt_tag": "furina", "category": 4, "post_count": 900},
            {"danbooru_name": "white_hair", "prompt_tag": "white hair", "category": 0, "post_count": 800},
            {"danbooru_name": "blue_eyes", "prompt_tag": "blue eyes", "category": 0, "post_count": 700},
            {"danbooru_name": "bedroom", "prompt_tag": "bedroom", "category": 0, "post_count": 600},
            {"danbooru_name": "night", "prompt_tag": "night", "category": 0, "post_count": 500},
        ])
        state = {
            "sections": {"scene": [{"tag": "bedroom"}, {"tag": "night"}]},
            "characters": [
                {"name": "C1", "prompt_sections": {
                    "character": [{"tag": "citlali"}],
                    "appearance": [{"tag": "white hair"}]}},
                {"name": "C2", "prompt_sections": {
                    "character": [{"tag": "furina"}],
                    "appearance": [{"tag": "blue eyes"}]}},
            ],
        }
        conn = self.conn()
        scoped = app._collect_scoped_positive_tags(state, conn)
        self.assertEqual([c["identity"] for c in scoped["characters"]], ["citlali", "furina"])
        app._record_scoped_cooccurrence(conn, scoped, event_weight=1.0)
        conn.commit()
        conn.close()

        pairs = self.all_scoped_pairs()
        # 跨角色外观对绝不进入任何作用域
        for scope, ps in pairs.items():
            self.assertNotIn(("white hair", "blue eyes"), ps,
                             f"cross-character appearance pair leaked into {scope}")
        # base × 角色外观绝不进入 base / character 作用域
        for scope in ("base", "character"):
            self.assertNotIn(("bedroom", "white hair"), pairs.get(scope, set()))
        # base × 角色身份进入 base_character_context
        self.assertIn(("bedroom", "citlali"), pairs.get("base_character_context", set()))
        # 单角色内部配对进入 character 作用域
        self.assertIn(tuple(sorted(("citlali", "white hair"))), pairs.get("character", set()))
        self.assertIn(tuple(sorted(("furina", "blue eyes"))), pairs.get("character", set()))

    # ------------------------------------------------------------------ #
    # 2. 手动快照不触发学习
    # ------------------------------------------------------------------ #
    def test_manual_snapshot_does_not_learn(self):
        self.insert_tags([
            {"danbooru_name": "citlali", "prompt_tag": "citlali", "category": 4, "post_count": 1000},
        ])
        app.snapshot_create(app.SnapshotBody(structured_state={
            "sections": {"scene": [{"tag": "bedroom"}, {"tag": "night"}]},
            "characters": [{"name": "C1", "prompt_sections": {
                "character": [{"tag": "citlali"}],
                "appearance": [{"tag": "white hair"}]}}],
        }))
        conn = self.conn()
        scoped = conn.execute("SELECT COUNT(*) FROM tag_cooccurrence_scoped").fetchone()[0]
        legacy = conn.execute("SELECT COUNT(*) FROM tag_cooccurrence").fetchone()[0]
        recent = conn.execute("SELECT COUNT(*) FROM recent_tags").fetchone()[0]
        conn.close()
        self.assertEqual(scoped, 0)
        self.assertEqual(legacy, 0)
        self.assertEqual(recent, 0)

    # ------------------------------------------------------------------ #
    # 3. 成功生成只学习一次
    # ------------------------------------------------------------------ #
    def test_successful_generate_learns_once(self):
        snapshot = app.snapshot_create(app.SnapshotBody(structured_state={
            "sections": {"style": [{"tag": "anime"}, {"tag": "bedroom"}]},
        }))
        gallery_dir = Path(self.tmp.name) / "gallery"
        gallery_dir.mkdir()
        tiny_png = base64.b64encode(
            b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89"
            b"\x00\x00\x00\rIDAT\x08\xd7c\xf8\xcf\xc0\xf0\x1f\x00\x05\x00\x01\xff\x89\x99=\x1d\x00\x00\x00\x00IEND\xaeB`\x82"
        ).decode()
        body = app.GalleryItemBody(
            image_base64=tiny_png, prompt="anime", snapshot_id=snapshot["id"],
        )
        with (
            patch.object(app, "BASE_DIR", Path(self.tmp.name).resolve()),
            patch.object(app, "GALLERY_DIR", gallery_dir),
            patch.object(app, "GALLERY_ROOT", gallery_dir.resolve()),
            patch.object(app.imageutil, "compress_image_bytes", return_value=b"jpeg"),
        ):
            created = asyncio.run(app.gallery_item(body))
        self.assertTrue(created["ok"])
        conn = self.conn()
        rows = conn.execute(
            "SELECT scope, tag_a, tag_b, positive_weight, negative_weight FROM tag_cooccurrence_scoped"
        ).fetchall()
        events = conn.execute(
            "SELECT event_type FROM gallery_events WHERE event_type='successful_generate'"
        ).fetchall()
        conn.close()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["scope"], "base")
        self.assertEqual({rows[0]["tag_a"], rows[0]["tag_b"]}, {"anime", "bedroom"})
        self.assertEqual(rows[0]["positive_weight"], 1.0)
        self.assertEqual(rows[0]["negative_weight"], 0.0)
        self.assertEqual(len(events), 1)

    # ------------------------------------------------------------------ #
    # 6. 推荐 local_cooccurrence 作用域查询
    # ------------------------------------------------------------------ #
    def test_scoped_query_in_recommendation(self):
        self.insert_tags([
            {"danbooru_name": "citlali", "prompt_tag": "citlali", "category": 4, "post_count": 1000},
            {"danbooru_name": "white_hair", "prompt_tag": "white hair", "category": 0, "post_count": 800},
            {"danbooru_name": "bedroom", "prompt_tag": "bedroom", "category": 0, "post_count": 600},
            {"danbooru_name": "night", "prompt_tag": "night", "category": 0, "post_count": 500},
        ])
        state = {
            "sections": {"scene": [{"tag": "bedroom"}, {"tag": "night"}]},
            "characters": [{"name": "C1", "prompt_sections": {
                "character": [{"tag": "citlali"}],
                "appearance": [{"tag": "white hair"}]}}],
        }
        conn = self.conn()
        scoped = app._collect_scoped_positive_tags(state, conn)
        app._record_scoped_cooccurrence(conn, scoped, event_weight=1.0)
        conn.commit()

        service = RecommendationService(conn)
        base_ctx = RecommendationContext(tags=("bedroom",), target="base")
        base_tags = {r["tag"] for r in service._source("local_cooccurrence", base_ctx)}
        # base 目标：读 base + base_character_context + interaction
        self.assertIn("night", base_tags)
        self.assertIn("citlali", base_tags)
        self.assertNotIn("white hair", base_tags)

        char_ctx = RecommendationContext(tags=("white hair",), target="character")
        char_tags = {r["tag"] for r in service._source("local_cooccurrence", char_ctx)}
        # character 目标：读 character + interaction
        self.assertIn("citlali", char_tags)
        self.assertNotIn("night", char_tags)
        self.assertNotIn("bedroom", char_tags)
        conn.close()


class PriorRuntimeTest(unittest.TestCase):
    """离线先验构建 + 运行时（不含 app 学习路径）。"""

    def make_tags_db(self, path: Path) -> None:
        conn = sqlite3.connect(str(path))
        conn.executescript(
            "CREATE TABLE tags (id INTEGER PRIMARY KEY, danbooru_name TEXT, prompt_tag TEXT, "
            "category INTEGER, post_count INTEGER, is_deprecated INTEGER DEFAULT 0, source TEXT DEFAULT 'danbooru');"
        )
        rows = [
            ("blue_eyes", "blue eyes", 0, 700),
            ("long_hair", "long hair", 0, 800),
            ("loli", "loli", 0, 200),
            ("shota", "shota", 0, 180),
            ("young", "young", 0, 150),
            ("sex", "sex", 0, 900),
            ("group_sex", "group sex", 0, 500),
            ("nude", "nude", 0, 950),
        ]
        conn.executemany(
            "INSERT INTO tags (danbooru_name, prompt_tag, category, post_count) VALUES (?,?,?,?)",
            rows,
        )
        conn.commit()
        conn.close()

    def make_nsfw_taxonomy(self, path: Path) -> None:
        data = {
            "categories": [
                {"id": "nsfw_sex", "label": "sex", "tags": ["sex", "group sex"]},
                {"id": "nsfw_undress", "label": "undress", "tags": ["nude"]},
            ]
        }
        path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

    def make_nav(self, path: Path) -> None:
        path.write_text(json.dumps(NAV, ensure_ascii=False), encoding="utf-8")

    def build_fixture(self, out: Path) -> Path:
        tmp = Path(tempfile.mkdtemp())
        tags_db = tmp / "tags.sqlite"
        nsfw = tmp / "nsfw.json"
        nav = tmp / "nav.json"
        self.make_tags_db(tags_db)
        self.make_nsfw_taxonomy(nsfw)
        self.make_nav(nav)
        prior_build.build(out, use_hf=False, quiet=True,
                          tags_db_path=tags_db, nsfw_path=nsfw, nav_path=nav)
        return out

    # ------------------------------------------------------------------ #
    # 4. 运行时零 HF/PyArrow/Polars 依赖
    # ------------------------------------------------------------------ #
    def test_runtime_no_heavy_deps(self):
        code = (
            "import sys; import prompt.prior; "
            "p = prompt.prior.PromptPrior(); "
            "assert p.is_available() in (True, False); "
            "print('datasets' in sys.modules, 'pyarrow' in sys.modules, 'polars' in sys.modules, "
            "'huggingface_hub' in sys.modules)"
        )
        result = subprocess.run(
            [sys.executable, "-c", code],
            capture_output=True, text=True, cwd=REPO_ROOT,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        datasets, pyarrow, polars, hf_hub = result.stdout.strip().split()
        self.assertEqual(datasets, "False")
        self.assertEqual(pyarrow, "False")
        self.assertEqual(polars, "False")
        self.assertEqual(hf_hub, "False")

    # ------------------------------------------------------------------ #
    # 5. 离线先验构建确定性
    # ------------------------------------------------------------------ #
    def test_offline_prior_deterministic(self):
        tmp = Path(tempfile.mkdtemp())
        out1 = tmp / "p1.sqlite"
        out2 = tmp / "p2.sqlite"
        self.build_fixture(out1)
        self.build_fixture(out2)

        def counts(path: Path) -> dict:
            conn = sqlite3.connect(str(path))
            tables = ("prior_tag_assoc", "prior_slot_tag", "prior_context_tag",
                      "prior_slot_transition", "tag_semantic_node", "prior_manifest")
            out = {t: conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in tables}
            conn.close()
            return out

        self.assertEqual(counts(out1), counts(out2))

    # ------------------------------------------------------------------ #
    # 7. adult/general 先验分割
    # ------------------------------------------------------------------ #
    def test_adult_prior_split(self):
        tmp = Path(tempfile.mkdtemp())
        out = tmp / "prior.sqlite"
        self.build_fixture(out)
        conn = sqlite3.connect(str(out))
        split = {r[0]: r[1] for r in conn.execute(
            "SELECT is_adult, COUNT(*) FROM prior_tag_assoc GROUP BY is_adult")}
        conn.close()
        self.assertIn(0, split)
        self.assertIn(1, split)
        self.assertGreater(split[0], 0)
        self.assertGreater(split[1], 0)

        p = prior.PromptPrior(str(out))
        general = p.related_tags("blue eyes", limit=50, adult=False)
        self.assertTrue(general)
        for item in general:
            self.assertEqual(item["is_adult"], 0)
        adult = p.related_tags("sex", limit=50, adult=True)
        self.assertTrue(adult)
        self.assertIn("group sex", [item["tag"] for item in adult])

    # ------------------------------------------------------------------ #
    # 8. 无 tag 黑名单
    # ------------------------------------------------------------------ #
    def test_no_tag_blocklist(self):
        tmp = Path(tempfile.mkdtemp())
        out = tmp / "prior.sqlite"
        self.build_fixture(out)
        conn = sqlite3.connect(str(out))
        conn.row_factory = sqlite3.Row
        for tag in ("loli", "shota", "young"):
            n = conn.execute(
                "SELECT COUNT(*) FROM prior_tag_assoc WHERE tag_a=? OR tag_b=?", (tag, tag)
            ).fetchone()[0]
            node = conn.execute(
                "SELECT semantic_node_id FROM tag_semantic_node WHERE tag=?", (tag,)
            ).fetchone()
            adult_n = conn.execute(
                "SELECT COUNT(*) FROM prior_tag_assoc WHERE (tag_a=? OR tag_b=?) AND is_adult=1",
                (tag, tag),
            ).fetchone()[0]
            self.assertGreater(n, 0, f"{tag} was excluded from prior_tag_assoc")
            self.assertEqual(adult_n, 0, f"{tag} must be general (is_adult=0)")
            self.assertEqual(node["semantic_node_id"], "char_appearance")
        conn.close()

    # ------------------------------------------------------------------ #
    # 9. 先验库缺失时优雅降级
    # ------------------------------------------------------------------ #
    def test_graceful_fallback_missing_db(self):
        missing = Path(tempfile.mkdtemp()) / "nope.sqlite"
        p = prior.PromptPrior(str(missing))
        self.assertFalse(p.is_available())
        self.assertEqual(p.related_tags("blue eyes", limit=5), [])
        self.assertEqual(p.slot_candidates("char_hair", limit=5), [])
        self.assertEqual(p.context_candidates("blue eyes", limit=5), [])
        self.assertEqual(p.next_slot_prior(["char_identity"]), [])
        self.assertIsNone(p.semantic_node_for_tag("blue eyes"))
        # 模块级便捷函数委托单例；临时把单例指向缺失库验证其同样优雅降级。
        old_singleton = prior._singleton
        prior._singleton = prior.PromptPrior(str(missing))
        try:
            self.assertEqual(prior.related_tags("blue eyes"), [])
            self.assertEqual(prior.slot_candidates("char_hair"), [])
            self.assertEqual(prior.context_candidates("blue eyes"), [])
            self.assertIsNone(prior.semantic_node_for_tag("blue eyes"))
        finally:
            prior._singleton = old_singleton

    def test_graceful_fallback_missing_table(self):
        tmp = Path(tempfile.mkdtemp())
        path = tmp / "partial.sqlite"
        conn = sqlite3.connect(str(path))
        conn.execute(
            "CREATE TABLE prior_tag_assoc (tag_a TEXT, tag_b TEXT, npmi REAL, "
            "support INTEGER, quality_weight REAL, is_adult INTEGER)"
        )
        conn.execute("INSERT INTO prior_tag_assoc VALUES ('a','b',0.5,10,1.0,0)")
        conn.commit()
        conn.close()
        p = prior.PromptPrior(str(path))
        self.assertTrue(p.is_available())
        self.assertEqual([x["tag"] for x in p.related_tags("a")], ["b"])
        # 缺失表（如并行任务的 prior_semantic_neighbor / 其它槽位表）不崩
        self.assertEqual(p.slot_candidates("char_hair"), [])
        self.assertEqual(p.context_candidates("a"), [])
        self.assertEqual(p.next_slot_prior(["x"]), [])
        self.assertIsNone(p.semantic_node_for_tag("a"))


if __name__ == "__main__":
    unittest.main()
