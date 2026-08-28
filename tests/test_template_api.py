"""姿势模板候选审核与 NSFW Builder 接口回归。"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app
import db
from prompt.template_import import import_text


class TemplateApiTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "templates.sqlite"
        db.init_db(self.path)
        self.conn_patch = patch.object(app, "_conn", side_effect=lambda: db.get_conn(self.path))
        self.settings_patch = patch.object(app, "_load_user_settings", return_value={**app.DEFAULT_USER_SETTINGS, "adolescent_mode": False})
        self.conn_patch.start()
        self.settings_patch.start()

    def tearDown(self):
        self.settings_patch.stop()
        self.conn_patch.stop()
        self.tmp.cleanup()

    def test_template_routes_and_runtime_contract_are_registered(self):
        paths = {route.path for route in app.app.routes}
        self.assertIn("/api/runtime-info", paths)
        self.assertIn("/api/templates/import/file", paths)
        self.assertIn("/api/templates/{template_id}/review", paths)
        self.assertEqual(app.runtime_info()["template_api_version"], 1)

    def test_candidate_requires_review_then_can_feed_builder(self):
        conn = db.get_conn(self.path)
        candidate = import_text("2girls, missionary, from behind", conn=conn)
        item, duplicate = app._template_persist(conn, candidate)
        conn.close()
        self.assertFalse(duplicate)
        self.assertEqual(item["status"], "pending")

        reviewed = app.template_review(1, app.TemplateReviewRequest(status="approved", note="姿势与构图可替换"))
        self.assertEqual(reviewed["template"]["status"], "approved")
        listed = app.template_list(status="approved")
        self.assertEqual(len(listed["templates"]), 1)
        self.assertEqual(listed["templates"][0]["participant_count"], 2)
        options = app.nsfw_builder_options()
        self.assertEqual(len(options["poseTemplates"]), 1)
        self.assertEqual(options["poseTemplates"][0]["baseTags"], ["missionary"])

    def test_blocked_candidate_cannot_be_approved(self):
        conn = db.get_conn(self.path)
        candidate = import_text("young woman, missionary", conn=conn)
        app._template_persist(conn, candidate)
        conn.close()
        with self.assertRaises(Exception):
            app.template_review(1, app.TemplateReviewRequest(status="approved"))

    def test_adolescent_mode_hides_templates(self):
        self.settings_patch.stop()
        self.settings_patch = patch.object(app, "_load_user_settings", return_value={**app.DEFAULT_USER_SETTINGS, "adolescent_mode": True})
        self.settings_patch.start()
        self.assertEqual(app.template_list()["templates"], [])
        self.assertEqual(app.nsfw_builder_options()["poseTemplates"], [])


if __name__ == "__main__":
    unittest.main()
