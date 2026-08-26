"""Full-stack-shaped deterministic E2E: real app routes, no NovelAI paid endpoint."""
import inspect
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app
import db


class Phase3ApiE2ETest(unittest.TestCase):
    def test_auto_split_is_proposal_only_and_scene_options_are_gated(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "phase3.sqlite"
            db.init_db(path)
            with patch.object(app, "_conn", side_effect=lambda: db.get_conn(path)), patch.object(
                app, "_load_user_settings", return_value={**app.DEFAULT_USER_SETTINGS, "adolescent_mode": False}
            ):
                response = app.prompt_auto_split(app.AutoSplitRequest(text="2girls, citlali (genshin impact), furina (genshin impact)"))
                self.assertIn("proposal", response)
                self.assertEqual(response["proposal"]["assistant_context"]["participant_count"], 2)
                options = app.nsfw_builder_options()
                self.assertEqual([item["key"] for item in options["participants"]], ["1", "2", "3", "4+"])
            with patch.object(app, "_conn", side_effect=lambda: db.get_conn(path)), patch.object(
                app, "_load_user_settings", return_value={**app.DEFAULT_USER_SETTINGS, "adolescent_mode": True}
            ):
                self.assertEqual(app.nsfw_builder_options()["participants"], [])

    def test_local_routes_have_no_paid_generation_dependency(self):
        # Inspect the actual route callables exercised above, rather than a
        # hardcoded route list. This fails if either local route starts calling
        # the NovelAI generation surface directly.
        for route in (app.prompt_auto_split, app.nsfw_builder_options):
            source = inspect.getsource(route).lower()
            self.assertNotIn("novelai.com", source)
            self.assertNotIn("generate", source)


if __name__ == "__main__":
    unittest.main()
