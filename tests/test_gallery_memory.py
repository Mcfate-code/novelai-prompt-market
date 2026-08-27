"""Gallery Preference Memory v1 测试：事件、抽取、聚合、合集、血缘。

只针对本机 SQLite 逻辑，不发起任何 NovelAI / 第三方调用。
"""
import asyncio
import base64
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app
import db
import gallery_memory


def _insert_gallery(conn, dir_name, file_name, prompt="1girl, blue hair", parameters=None,
                    negative_prompt="", source_asset_id=None, snapshot_id=None):
    conn.execute(
        "INSERT INTO gallery (dir_name, file_name, prompt, file_path, created_at, negative_prompt, "
        "parameters_json, snapshot_id, source_asset_id) VALUES (?,?,?,?,?,?,?,?,?)",
        (dir_name, file_name, prompt, f"gallery/{dir_name}/{file_name}", db.now_iso(),
         negative_prompt, json.dumps(parameters, ensure_ascii=False) if parameters else None,
         snapshot_id, source_asset_id),
    )
    conn.commit()
    return conn.execute(
        "SELECT * FROM gallery WHERE dir_name=? AND file_name=?", (dir_name, file_name)
    ).fetchone()


class GalleryMemoryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmp.name) / "gm.sqlite"
        db.init_db(self.db_path)
        self.conn_patch = patch.object(app, "_conn", side_effect=lambda: db.get_conn(self.db_path))
        self.conn_patch.start()

    def tearDown(self):
        self.conn_patch.stop()
        self.tmp.cleanup()

    def conn(self):
        return db.get_conn(self.db_path)

    def insert_tags(self):
        conn = self.conn()
        db.upsert_tags(conn, [
            {"danbooru_name": "blue_hair", "prompt_tag": "blue hair", "category": 0, "post_count": 500},
            {"danbooru_name": "long_hair", "prompt_tag": "long hair", "category": 0, "post_count": 400},
            {"danbooru_name": "citlali_(genshin_impact)", "prompt_tag": "citlali (genshin impact)", "category": 4, "post_count": 1000},
            {"danbooru_name": "genshin_impact", "prompt_tag": "genshin impact", "category": 3, "post_count": 900},
            {"danbooru_name": "masterpiece", "prompt_tag": "masterpiece", "category": 5, "post_count": 999999},
        ])
        conn.close()

    # ---- 事件 ----

    def test_favorite_event_written_once_per_state_change(self):
        self.insert_tags()
        _insert_gallery(self.conn(), "demo", "a.png")
        # 收藏 → 1 条 favorite
        app.gallery_favorite(app.GalleryFavRequest(dir_name="demo", file_name="a.png", favorite=True))
        conn = self.conn()
        self.assertEqual(conn.execute("SELECT COUNT(*) c FROM gallery_events WHERE event_type='favorite'").fetchone()["c"], 1)
        # 重复收藏（无状态变化）→ 仍 1 条
        app.gallery_favorite(app.GalleryFavRequest(dir_name="demo", file_name="a.png", favorite=True))
        self.assertEqual(conn.execute("SELECT COUNT(*) c FROM gallery_events WHERE event_type='favorite'").fetchone()["c"], 1)
        # 取消收藏 → 1 条 unfavorite
        app.gallery_favorite(app.GalleryFavRequest(dir_name="demo", file_name="a.png", favorite=False))
        self.assertEqual(conn.execute("SELECT COUNT(*) c FROM gallery_events WHERE event_type='unfavorite'").fetchone()["c"], 1)
        # 再取消（无状态变化）→ 仍 1 条
        app.gallery_favorite(app.GalleryFavRequest(dir_name="demo", file_name="a.png", favorite=False))
        self.assertEqual(conn.execute("SELECT COUNT(*) c FROM gallery_events WHERE event_type='unfavorite'").fetchone()["c"], 1)
        conn.close()

    def test_render_and_list_endpoints_do_not_write_events(self):
        self.insert_tags()
        _insert_gallery(self.conn(), "demo", "a.png")
        app.gallery_list()
        app.gallery_dir("demo")
        app.gallery_preferences()
        app.gallery_collections()
        conn = self.conn()
        self.assertEqual(conn.execute("SELECT COUNT(*) c FROM gallery_events").fetchone()["c"], 0)
        conn.close()

    def test_preferences_and_collections_routes_not_shadowed_by_dir_route(self):
        # FastAPI 按定义顺序匹配：单段 /api/gallery/preferences 与 /api/gallery/collections
        # 必须先于 /api/gallery/{dir_name}，否则会被目录路由吞掉。
        paths = [r.path for r in app.app.routes if r.path.startswith("/api/gallery")]
        self.assertLess(paths.index("/api/gallery/preferences"), paths.index("/api/gallery/{dir_name}"))
        self.assertLess(paths.index("/api/gallery/collections"), paths.index("/api/gallery/{dir_name}"))

    def test_event_endpoint_validates_type(self):
        with self.assertRaises(app.HTTPException) as ctx:
            app.gallery_events(app.GalleryEventBody(dir_name="demo", file_name="a.png", event_type="hover"))
        self.assertEqual(ctx.exception.status_code, 400)

    # ---- 抽取 ----

    def test_extraction_separates_global_character_and_preserves_authored_quality(self):
        self.insert_tags()
        params = {
            "meta": {
                "promptSources": {"userPositive": ["1girl", "blue hair", "masterpiece"]},
                "rawNegative": "",
                "characterPrompts": [{"prompt": "citlali (genshin impact), long hair", "negative_prompt": "", "position": None}],
            }
        }
        row = _insert_gallery(self.conn(), "demo", "a.png", parameters=params)
        base_tags, characters = gallery_memory.extract_asset_preferences(self.conn(), row)
        self.assertEqual(base_tags, ["1girl", "blue hair", "masterpiece"])
        self.assertEqual(characters[0]["identity"], "citlali (genshin impact)")
        self.assertEqual(characters[0]["tags"], ["citlali (genshin impact)", "long hair"])

    def test_extraction_excludes_negative_tokens(self):
        self.insert_tags()
        params = {
            "meta": {
                "promptSources": {"userPositive": ["blue hair", "long hair"]},
                "rawNegative": "blue hair",
                "characterPrompts": [],
            }
        }
        row = _insert_gallery(self.conn(), "demo", "a.png", parameters=params)
        base_tags, _ = gallery_memory.extract_asset_preferences(self.conn(), row)
        self.assertEqual(base_tags, ["long hair"])  # 出现在负面里的 blue hair 不学正面

    def test_character_identity_none_for_generic_prompt(self):
        self.insert_tags()
        params = {"meta": {"promptSources": {"userPositive": []}, "characterPrompts": [{"prompt": "1girl, long hair", "negative_prompt": "", "position": None}]}}
        row = _insert_gallery(self.conn(), "demo", "a.png", parameters=params)
        _, characters = gallery_memory.extract_asset_preferences(self.conn(), row)
        self.assertIsNone(characters[0]["identity"])  # 无 Character/Copyright 标签 → 不用 Character N 当身份
        self.assertEqual(characters[0]["tags"], ["1girl", "long hair"])

    # ---- 删除上下文 ----

    def test_delete_event_captures_compact_context(self):
        self.insert_tags()
        params = {
            "meta": {
                "promptSources": {"userPositive": ["1girl", "blue hair", "masterpiece"]},
                "characterPrompts": [{"prompt": "citlali (genshin impact), long hair", "negative_prompt": "", "position": None}],
            }
        }
        row = _insert_gallery(self.conn(), "demo", "a.png", parameters=params)
        context = gallery_memory.compact_delete_context(self.conn(), row)
        self.assertEqual(context["positive_base"], ["1girl", "blue hair", "masterpiece"])
        self.assertEqual(context["characters"][0]["identity"], "citlali (genshin impact)")
        self.assertNotIn("parameters_json", json.dumps(context))  # 只存紧凑正向标签，不存完整元数据

    def test_gallery_item_delete_writes_event_before_removal(self):
        self.insert_tags()
        gallery_dir = Path(self.tmp.name) / "gallery"
        (gallery_dir / "demo").mkdir(parents=True)
        (gallery_dir / "demo" / "x.png").write_bytes(b"png")
        _insert_gallery(self.conn(), "demo", "x.png", parameters={"meta": {"promptSources": {"userPositive": ["blue hair"]}}})
        with (
            patch.object(app, "BASE_DIR", Path(self.tmp.name).resolve()),
            patch.object(app, "GALLERY_DIR", gallery_dir),
            patch.object(app, "GALLERY_ROOT", gallery_dir.resolve()),
            patch.object(app, "GALLERY_TRASH_DIR", Path(self.tmp.name).resolve() / "待清理" / "图库"),
        ):
            app.gallery_item_delete(app.GalleryItemRef(dir_name="demo", file_name="x.png"))
        conn = self.conn()
        events = conn.execute("SELECT * FROM gallery_events WHERE event_type='delete'").fetchall()
        self.assertEqual(len(events), 1)
        ctx = json.loads(events[0]["context_json"])
        self.assertIn("blue hair", ctx["positive_base"])
        self.assertIsNone(conn.execute("SELECT 1 FROM gallery WHERE file_name='x.png'").fetchone())
        conn.close()

    def test_provenance_fixtures_keep_authored_and_exclude_auto(self):
        self.insert_tags()
        conn = self.conn()
        # A: raw authored quality and transparency are learnable.
        row = _insert_gallery(conn, "demo", "a.png", prompt="nahida, very aesthetic, masterpiece, no text, transparent background",
            parameters={"meta": {"rawPrompt": "nahida, masterpiece, transparent background",
                "effectivePrompt": "nahida, masterpiece, transparent background, very aesthetic, no text",
                "promptSources": {"userPositive": ["nahida", "masterpiece", "transparent background"], "autoPositive": ["very aesthetic", "no text"]}}})
        self.assertEqual(gallery_memory.extract_asset_preferences(conn, row)[0], ["nahida", "masterpiece", "transparent background"])
        # B/C: provenance says these are automatic, including transparent toggle.
        row = _insert_gallery(conn, "demo", "b.png", parameters={"meta": {
            "rawPrompt": "nahida", "effectivePrompt": "nahida, very aesthetic, masterpiece, no text, transparent background",
            "promptSources": {"userPositive": ["nahida"], "autoPositive": ["very aesthetic", "masterpiece", "no text", "transparent background"]},
            "model": "nai-diffusion-5-full", "positiveTier": "standard", "transparentBackground": True}})
        self.assertEqual(gallery_memory.extract_asset_preferences(conn, row)[0], ["nahida"])
        conn.close()

    def test_legacy_effective_fallback_uses_shared_preset_or_skips_ambiguous(self):
        self.insert_tags()
        conn = self.conn()
        row = _insert_gallery(conn, "demo", "known.png", prompt="nahida, very aesthetic, masterpiece, no text",
            parameters={"meta": {"effectivePrompt": "nahida, very aesthetic, masterpiece, no text",
                                  "model": "nai-diffusion-5-full", "positiveTier": "standard"}})
        self.assertEqual(gallery_memory.extract_asset_preferences(conn, row)[0], ["nahida"])
        row = _insert_gallery(conn, "demo", "unknown.png", prompt="nahida, masterpiece, transparent background",
            parameters={"meta": {"effectivePrompt": "nahida, masterpiece, transparent background"}})
        self.assertEqual(gallery_memory.extract_asset_preferences(conn, row)[0], [])
        conn.close()

    def test_legacy_effective_off_tier_keeps_authored_tags(self):
        # 生产路径回归：legacy effective-only + 可靠 positiveTier="off"（空自动档位）→
        # effective prompt 全部视为亲手写的标签，照常可学；不依赖全局黑名单。
        self.insert_tags()
        conn = self.conn()
        row = _insert_gallery(conn, "demo", "off.png", prompt="nahida",
            parameters={"meta": {"effectivePrompt": "nahida",
                                  "model": "nai-diffusion-5-full", "positiveTier": "off"}})
        self.assertEqual(gallery_memory.extract_asset_preferences(conn, row)[0], ["nahida"])
        conn.close()

    # ---- 聚合 / 排名 ----

    def test_build_preferences_strong_and_delete_exclusion(self):
        self.insert_tags()
        conn = self.conn()
        params_a = {"meta": {"promptSources": {"userPositive": ["blue hair"]}}}
        params_b = {"meta": {"promptSources": {"userPositive": ["blue hair"]}}}
        _insert_gallery(conn, "demo", "a.png", parameters=params_a, source_asset_id="asset-a")
        _insert_gallery(conn, "demo", "b.png", parameters=params_b, source_asset_id="asset-b")
        # 收藏 a → strong 归 a 所有
        conn.execute("INSERT INTO gallery_favorites (dir_name, file_name, created_at) VALUES ('demo','a.png',?)", (db.now_iso(),))
        conn.commit()
        prefs = gallery_memory.build_preferences(conn)
        self.assertEqual(prefs["global_tags"]["blue hair"]["count"], 2)
        self.assertEqual(prefs["global_tags"]["blue hair"]["strong"], 1)
        # 删除 b（记录 delete 事件 + 移除行）→ 重建后 count 只算现存资产
        row_b = conn.execute("SELECT * FROM gallery WHERE dir_name='demo' AND file_name='b.png'").fetchone()
        gallery_memory.record_event(conn, "demo", "b.png", "asset-b", "delete",
                                    gallery_memory.compact_delete_context(conn, row_b))
        conn.execute("DELETE FROM gallery WHERE dir_name='demo' AND file_name='b.png'")
        conn.commit()
        prefs = gallery_memory.build_preferences(conn)
        self.assertEqual(prefs["global_tags"]["blue hair"]["count"], 1)
        self.assertEqual(prefs["global_tags"]["blue hair"]["strong"], 1)
        # delete 事件只进 totals，不进 ranking
        self.assertEqual(prefs["totals"]["deletes"], 1)
        conn.close()

    def test_favorite_final_state_controls_strong_not_event_history(self):
        self.insert_tags()
        conn = self.conn()
        _insert_gallery(conn, "demo", "a.png", parameters={"meta": {"promptSources": {"userPositive": ["blue hair"]}}})
        app.gallery_favorite(app.GalleryFavRequest(dir_name="demo", file_name="a.png", favorite=True))
        app.gallery_favorite(app.GalleryFavRequest(dir_name="demo", file_name="a.png", favorite=False))
        self.assertEqual(gallery_memory.build_preferences(conn)["global_tags"]["blue hair"]["strong"], 0)
        app.gallery_favorite(app.GalleryFavRequest(dir_name="demo", file_name="a.png", favorite=True))
        self.assertEqual(gallery_memory.build_preferences(conn)["global_tags"]["blue hair"]["strong"], 1)
        self.assertEqual(conn.execute("SELECT COUNT(*) c FROM gallery_events WHERE event_type IN ('favorite','unfavorite')").fetchone()["c"], 3)
        conn.close()

    def test_build_preferences_character_tags_keyed_by_identity(self):
        self.insert_tags()
        params = {"meta": {"promptSources": {"userPositive": ["1girl"]},
                           "characterPrompts": [{"prompt": "citlali (genshin impact), blue hair", "negative_prompt": "", "position": None}]}}
        _insert_gallery(self.conn(), "demo", "a.png", parameters=params)
        prefs = gallery_memory.build_preferences(self.conn())
        self.assertIn("citlali (genshin impact)", prefs["character_tags"])
        self.assertEqual(prefs["character_tags"]["citlali (genshin impact)"]["tags"]["blue hair"], 1)

    # ---- Smart Collections ----

    def test_collections_filter_index_only(self):
        self.insert_tags()
        conn = self.conn()
        _insert_gallery(conn, "d1", "a.png", parameters={"meta": {"promptSources": {"userPositive": ["blue hair"]}}}, source_asset_id="a")
        _insert_gallery(conn, "d1", "b.png", parameters={"meta": {"promptSources": {"userPositive": ["long hair"]}}}, source_asset_id="b")
        _insert_gallery(conn, "d2", "c.png", parameters={"meta": {"promptSources": {"userPositive": ["blue hair"]}}}, source_asset_id="c")
        conn.execute("INSERT INTO gallery_favorites (dir_name, file_name, created_at) VALUES ('d1','a.png',?)", (db.now_iso(),))
        gallery_memory.record_event(conn, "d1", "b.png", "b", "continue_generate")
        gallery_memory.record_event(conn, "d2", "c.png", "c", "restore")
        conn.commit()

        meta = gallery_memory.collection_meta(conn)
        self.assertEqual(meta["favorites"], 1)
        self.assertEqual(meta["continued"], 1)
        self.assertEqual(meta["restored"], 1)
        # 标签合集只列出当前图库真实存在的标签（含计数），不是整个 catalog
        tags = {t["tag"]: t["count"] for t in meta["tags"]}
        self.assertEqual(tags.get("blue hair"), 2)
        self.assertEqual(tags.get("long hair"), 1)
        self.assertNotIn("masterpiece", tags)

        favs = gallery_memory.collection_items(conn, "favorites")
        self.assertEqual([(r["dir_name"], r["file_name"]) for r in favs], [("d1", "a.png")])
        continued = gallery_memory.collection_items(conn, "continue_generate")
        self.assertEqual([r["file_name"] for r in continued], ["b.png"])
        restored = gallery_memory.collection_items(conn, "restore")
        self.assertEqual([r["file_name"] for r in restored], ["c.png"])
        tag_hits = gallery_memory.collection_items(conn, "tag", "blue hair")
        self.assertEqual({r["file_name"] for r in tag_hits}, {"a.png", "c.png"})
        conn.close()

    # ---- 血缘 ----

    def test_parent_payload_sanitized(self):
        self.assertEqual(
            gallery_memory.parent_payload({"dir_name": "d", "file_name": "f", "source_asset_id": "s"}, None),
            {"dir_name": "d", "file_name": "f", "source_asset_id": "s"},
        )
        self.assertIsNone(gallery_memory.parent_payload({"junk": 1}, None))  # 缺 dir/file 身份 → 丢弃
        self.assertEqual(
            gallery_memory.parent_payload(None, {"meta": {"parent": {"dir_name": "d", "file_name": "f"}}}),
            {"dir_name": "d", "file_name": "f"},
        )

    def test_gallery_item_stores_parent_and_marks_availability(self):
        self.insert_tags()
        gallery_dir = Path(self.tmp.name) / "gallery"
        gallery_dir.mkdir()
        valid = "data:image/png;base64," + base64.b64encode(b"img").decode()
        with (
            patch.object(app, "BASE_DIR", Path(self.tmp.name).resolve()),
            patch.object(app, "GALLERY_DIR", gallery_dir),
            patch.object(app, "GALLERY_ROOT", gallery_dir.resolve()),
            patch.object(app.imageutil, "compress_image_bytes", return_value=b"img"),
        ):
            parent = asyncio.run(app.gallery_item(app.GalleryItemBody(
                image_base64=valid, mime="image/png", dir_name="nai_generated", source_asset_id="parent-asset",
            )))
            child = asyncio.run(app.gallery_item(app.GalleryItemBody(
                image_base64=valid, mime="image/png", dir_name="nai_generated",
                parent={"dir_name": parent["dir_name"], "file_name": parent["file_name"], "source_asset_id": "parent-asset"},
            )))
        self.assertIsNotNone(child.get("parent"))
        self.assertTrue(child["parent"]["available"])
        self.assertEqual(child["parent"]["dir_name"], parent["dir_name"])
        # 删除父级 → 子级 parent 标记为不可用（不报错）
        conn = self.conn()
        conn.execute("DELETE FROM gallery WHERE file_name=?", (parent["file_name"],))
        conn.commit()
        items = app.gallery_dir("nai_generated")["items"]
        child_after = next(i for i in items if i["file_name"] == child["file_name"])
        self.assertFalse(child_after["parent"]["available"])
        conn.close()


if __name__ == "__main__":
    unittest.main()
