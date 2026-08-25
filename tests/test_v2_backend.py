import asyncio
import base64
import json
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import Mock, patch

import app
import db
import search
from prompt import sections


class V2BackendTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmp.name) / "v2.sqlite"
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
            {"danbooru_name": "murata_range", "prompt_tag": "murata range", "category": 0, "post_count": 10},
            {"danbooru_name": "orange_hat", "prompt_tag": "orange hat", "category": 0, "post_count": 1000},
            {"danbooru_name": "blue_eyes", "prompt_tag": "blue eyes", "category": 0, "post_count": 500},
            {"danbooru_name": "alice", "prompt_tag": "alice", "category": 4, "post_count": 10},
            {"danbooru_name": "some_artist", "prompt_tag": "some artist", "category": 1, "post_count": 10},
        ])
        conn.execute("INSERT INTO tag_aliases VALUES ('azure optics', 'blue_eyes', 'en', 'test')")
        conn.commit()
        conn.close()

    def test_connection_uses_busy_timeout(self):
        conn = self.conn()
        self.assertEqual(conn.execute("PRAGMA busy_timeout").fetchone()[0], 5000)
        conn.close()

    def test_schema_is_idempotent(self):
        db.init_db(self.db_path)
        conn = self.conn()
        tables = {row["name"] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        self.assertTrue({"tag_bundle", "tag_cooccurrence", "prompt_snapshot", "generation"} <= tables)
        self.assertEqual(conn.execute("PRAGMA user_version").fetchone()[0], 3)
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM tag_conflict").fetchone()[0], 3)
        conn.close()

    def test_search_normalizes_underscore_canonical_names(self):
        self.insert_tags()
        conn = self.conn()
        result = search.resolve_tag(conn, "BLUE_EYES")
        self.assertIsNotNone(result)
        self.assertEqual(result["tag"], "blue eyes")
        self.assertEqual(result["canonical"], "blue_eyes")
        conn.close()

    def test_search_layers_and_explanation(self):
        self.insert_tags()
        conn = self.conn()
        results = search.search(conn, "range--murata")
        self.assertEqual(results[0]["tag"], "murata range")
        self.assertEqual(results[0]["match_type"], "token_unordered")
        self.assertNotEqual(results[0]["tag"], "orange hat")
        alias = search.search(conn, "Azure_Optics")[0]
        self.assertEqual(alias["match_type"], "token_exact")
        self.assertIn("别名", alias["match_reason"])
        conn.close()

    def test_search_recalls_user_tags_and_resolves(self):
        self.insert_tags()
        conn = self.conn()
        conn.execute("INSERT INTO user_tags VALUES ('my custom tag', '', 'now')")
        conn.commit()
        # 完整 / 子串召回
        full = search.search(conn, "my custom tag")
        self.assertTrue(any(r["tag"] == "my custom tag" and r["via"] == "user_tags" for r in full))
        sub = search.search(conn, "my custom")
        self.assertTrue(any(r["tag"] == "my custom tag" and r["via"] == "user_tags" for r in sub))
        # 前缀召回
        pre = search.search(conn, "my cust")
        self.assertTrue(any(r["tag"] == "my custom tag" and r["via"] == "user_tags" for r in pre))
        # resolve
        resolved = search.resolve_tag(conn, "my custom tag")
        self.assertIsNotNone(resolved)
        self.assertEqual(resolved["tag"], "my custom tag")
        self.assertEqual(resolved["via"], "user_tags")
        self.assertEqual(resolved["canonical"], "my_custom_tag")
        conn.close()

    def test_search_user_tag_does_not_override_builtin(self):
        self.insert_tags()
        conn = self.conn()
        # 与内置标签 blue eyes 同名的自定义标签：内置优先，不重复
        conn.execute("INSERT INTO user_tags VALUES ('blue eyes', '', 'now')")
        conn.commit()
        results = search.search(conn, "blue eyes")
        self.assertEqual(len([r for r in results if r["tag"] == "blue eyes"]), 1)
        self.assertNotEqual(results[0].get("via"), "user_tags")
        conn.close()

    def test_classification_override(self):
        self.insert_tags()
        definitions = app.prompt_section_list()["sections"]
        self.assertEqual(definitions[0], {"id": "character", "label": "角色"})
        classified = app.prompt_classify(app.ClassifyRequest(tags=["alice"]))
        self.assertEqual(classified["items"], classified["results"])
        conn = self.conn()
        self.assertEqual(sections.classify_tag(conn, "alice"), "character")
        self.assertEqual(sections.classify_tag(conn, "some artist"), "style")
        conn.execute("INSERT INTO tag_section_override VALUES ('alice', 'scene', 'now')")
        conn.commit()
        self.assertEqual(sections.classify_tag(conn, "alice"), "scene")
        conn.close()

    def test_bundle_crud(self):
        created = app.bundle_create(app.BundleBody(name="Look", items=[
            app.BundleItemBody(tag="custom tag", weight=1.25, section="style", sort_order=2)
        ]))
        self.assertEqual(created["items"][0]["tag"], "custom tag")
        updated = app.bundle_update(created["id"], app.BundleBody(name="Look 2", items=[]))
        self.assertEqual(updated["name"], "Look 2")
        self.assertEqual(app.bundle_get(created["id"])["items"], [])
        self.assertTrue(app.bundle_delete(created["id"])["ok"])

    def test_import_preview_four_states(self):
        self.insert_tags()
        conn = self.conn()
        conn.execute("INSERT INTO user_tags VALUES ('my custom', '', 'now')")
        conn.commit()
        conn.close()
        result = app.import_preview(app.ImportPreviewRequest(
            text="blue eyes, Blue--Eyes, range murata, my custom, impossible qzx"
        ))
        entries = result["segments"][0]["entries"]
        self.assertEqual([entry["status"] for entry in entries], [
            "exact", "normalized", "normalized", "custom", "candidate"
        ])
        self.assertEqual(entries[1]["match"]["canonical"], "blue_eyes")
        self.assertIsNone(entries[-1]["match"])

    def test_cooccurrence_and_snapshot_restore(self):
        result = app.cooccurrence_record(app.TagsRequest(tags=["blue eyes", "long hair", "blue eyes"]))
        self.assertEqual(result["pairs"], 1)
        rec = app.recommendations(app.TagsRequest(tags=["blue eyes"], limit=5))
        recommendation = rec["recommendations"][0]
        self.assertEqual(recommendation["tag"], "long hair")
        self.assertEqual(recommendation["canonical"], "long_hair")
        self.assertIn(recommendation["section"], sections.SECTIONS)
        snapshot = app.snapshot_create(app.SnapshotBody(
            structured_state={"sections": {
                "style": [{"tag": "anime", "weight": 1}],
                "composition": [{"tag": "portrait"}],
                "scene": ["not-an-entry"],
            }},
            generation={"seed": 42},
        ))
        restored = app.snapshot_restore(snapshot["id"], "style,composition")
        self.assertEqual(set(restored["structured_state"]["sections"]), {"style", "composition"})
        conn = self.conn()
        usage = {row["tag_name"] for row in conn.execute("SELECT tag_name FROM recent_tags")}
        conn.close()
        self.assertIn("anime", usage)
        self.assertNotIn("not an entry", usage)

    def test_export_preserves_structured_character_uc(self):
        result = app.export(app.ExportRequest(
            model="v5",
            structured_state={
                "sections": {"scene": [{"tag": "cafe"}]},
                "characters": [{
                    "name": "Alice",
                    "prompt_sections": {"appearance": [{"tag": "red hair"}]},
                    "uc_sections": {"appearance": [{"tag": "blue hair"}]},
                    "position": {"x": 0.25, "y": 0.5},
                }],
                "global_uc_sections": {"quality": [{"tag": "lowres"}]},
                "free_text": "soft light",
            },
        ))
        self.assertEqual(result["base"], "cafe")
        self.assertEqual(result["characters"][0]["prompt"], "red hair")
        self.assertEqual(result["characters"][0]["uc"], "blue hair")
        self.assertEqual(result["characters"][0]["position"], {"x": 0.25, "y": 0.5})
        self.assertEqual(result["global_uc"], "lowres")

    def test_semantic_request_payload_respects_adolescent_mode(self):
        payload = app._semantic_request_payload(app.SemanticSearchBody(query="白色水手服的女孩"), True)
        self.assertFalse(payload["show_nsfw"])
        self.assertEqual(payload["query"], "白色水手服的女孩")
        self.assertIn("中文核心词", payload["target_layers"])
        self.assertEqual(payload["target_categories"], ["General", "Character", "Copyright"])
        filtered = app._semantic_request_payload(app.SemanticSearchBody(query="角色", category=4), True)
        self.assertEqual(filtered["target_categories"], ["Character"])
        with self.assertRaises(app.HTTPException):
            app._semantic_request_payload(app.SemanticSearchBody(query="  "), True)

    def test_semantic_response_resolves_canonical_alias_and_candidate(self):
        self.insert_tags()
        conn = self.conn()
        raw = {"results": [
            {"tag": "blue_eyes", "cn_name": "蓝眼", "category": "General", "final_score": 0.9, "layer": "英文"},
            {"tag": "azure_optics", "cn_name": "蓝色光学", "category": "General", "final_score": 0.8, "layer": "中文扩展词"},
            {"tag": "white_sailor_uniform", "cn_name": "白色水手服", "category": "General", "final_score": 0.7, "layer": "释义"},
        ]}
        results = app._normalize_semantic_response(raw, conn, set())
        conn.close()
        self.assertEqual([r["local_status"] for r in results], ["canonical", "alias", "candidate"])
        self.assertEqual(results[0]["tag"], "blue eyes")
        self.assertEqual(results[0]["category"], 0)
        self.assertEqual(results[1]["tag"], "blue eyes")
        self.assertEqual(results[2]["source_tag"], "white sailor uniform")

    def test_semantic_response_filters_hidden_and_category(self):
        self.insert_tags()
        conn = self.conn()
        raw = {"results": [
            {"tag": "blue_eyes", "category": "General"},
            {"tag": "alice", "category": "Character"},
            {"tag": "white_sailor_uniform", "category": "General"},
        ]}
        results = app._normalize_semantic_response(raw, conn, {"blue eyes"}, category=4)
        conn.close()
        self.assertEqual([r["tag"] for r in results], ["alice"])

    def test_semantic_search_errors_and_does_not_write_database(self):
        class FakeResponse:
            status = 200
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def read(self): return json.dumps({"results": [{"tag": "white_sailor_uniform", "category": "General"}]}).encode()

        opener = Mock()
        opener.open.return_value = FakeResponse()
        conn = self.conn()
        before = conn.execute("SELECT COUNT(*) FROM tags").fetchone()[0]
        conn.close()
        with patch.object(app, "_load_user_settings", return_value={**app.DEFAULT_USER_SETTINGS, "adolescent_mode": True}), patch.object(app.urllib.request, "build_opener", return_value=opener):
            result = app.semantic_search(app.SemanticSearchBody(query="白色水手服"))
        conn = self.conn()
        after = conn.execute("SELECT COUNT(*) FROM tags").fetchone()[0]
        conn.close()
        self.assertFalse(result["show_nsfw"])
        self.assertEqual(result["results"][0]["local_status"], "candidate")
        self.assertEqual(before, after)
        opener.open.assert_called_once()

        with patch.object(app.urllib.request, "build_opener", side_effect=urllib.error.URLError("offline")):
            with self.assertRaises(app.HTTPException) as ctx:
                app.semantic_search(app.SemanticSearchBody(query="测试"))
        self.assertEqual(ctx.exception.status_code, 502)

    def test_gallery_idempotent_snapshot_link(self):
        snapshot = app.snapshot_create(app.SnapshotBody(structured_state={"sections": {"style": ["anime"]}}))
        gallery_dir = Path(self.tmp.name) / "gallery"
        gallery_dir.mkdir()
        tiny_png = base64.b64encode(
            b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89"
            b"\x00\x00\x00\rIDAT\x08\xd7c\xf8\xcf\xc0\xf0\x1f\x00\x05\x00\x01\xff\x89\x99=\x1d\x00\x00\x00\x00IEND\xaeB`\x82"
        ).decode()
        body = app.GalleryItemBody(image_base64=tiny_png, snapshot_id=snapshot["id"], source_asset_id="asset-1")
        with patch.object(app, "BASE_DIR", Path(self.tmp.name).resolve()), patch.object(app, "GALLERY_DIR", gallery_dir), patch.object(app, "GALLERY_ROOT", gallery_dir.resolve()), patch.object(app.imageutil, "compress_image_bytes", return_value=b"jpeg"):
            first = asyncio.run(app.gallery_item(body))
            second = asyncio.run(app.gallery_item(body))
        self.assertEqual(first["source_asset_id"], "asset-1")
        self.assertEqual(first["id"], second["id"])
        self.assertTrue(first["file_path"].endswith(".png"))
        self.assertEqual((Path(self.tmp.name) / first["file_path"]).read_bytes(), base64.b64decode(tiny_png))
        conn = self.conn()
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM gallery").fetchone()[0], 1)
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM generation").fetchone()[0], 1)
        conn.execute("UPDATE gallery SET parameters_json='broken' WHERE id=?", (first["id"],))
        conn.commit()
        conn.close()
        listed = app.gallery_dir("nai_generated")
        self.assertIsNone(listed["items"][0]["parameters"])
    def test_gallery_item_accepts_data_url_and_rejects_invalid_image_inputs(self):
        gallery_dir = Path(self.tmp.name) / "gallery"
        gallery_dir.mkdir()
        valid_data_url = "data:image/png;base64," + base64.b64encode(b"valid image").decode()
        with (
            patch.object(app, "BASE_DIR", Path(self.tmp.name).resolve()),
            patch.object(app, "GALLERY_DIR", gallery_dir),
            patch.object(app, "GALLERY_ROOT", gallery_dir.resolve()),
            patch.object(app.imageutil, "compress_image_bytes", return_value=b"jpeg"),
        ):
            created = asyncio.run(app.gallery_item(app.GalleryItemBody(
                image_base64=valid_data_url,
                mime=" Image/PNG ",
            )))
            self.assertTrue(created["ok"])

            for body in (
                app.GalleryItemBody(image_base64="data:image/png;base64,%%%", mime="image/png"),
                app.GalleryItemBody(image_base64="", mime="image/png"),
                app.GalleryItemBody(image_base64=base64.b64encode(b"image").decode(), mime="image/"),
            ):
                with self.subTest(body=body):
                    with self.assertRaises(app.HTTPException) as context:
                        asyncio.run(app.gallery_item(body))
                    self.assertEqual(context.exception.status_code, 400)

    def test_do_search_clamps_direct_call_limits(self):
        with (
            patch.object(app, "_hidden_tag_names", return_value=set()),
            patch.object(app.search, "search", return_value=[] ) as search_mock,
        ):
            self.assertEqual(app.do_search(q="blue", limit=-5), {"results": []})
            self.assertEqual(search_mock.call_args.kwargs["limit"], 1)
            self.assertEqual(app.do_search(q="blue", limit=999), {"results": []})
            self.assertEqual(search_mock.call_args.kwargs["limit"], 200)


if __name__ == "__main__":
    unittest.main()
