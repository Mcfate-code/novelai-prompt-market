"""NovelAI 本地服务进程守卫单测：验证 _stop_novelai_service 的防互杀逻辑。

不真实拉起 node / app.py，只用 fake Popen 替身 + 临时 pidfile 验证 terminate 决策。
"""
import json
import os
import socket
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app


class FakeProc:
    """最小可用的 Popen 替身，记录是否被 terminate / kill。"""

    def __init__(self, alive=True):
        self._alive = alive
        self.terminated = False
        self.killed = False

    def poll(self):
        return None if self._alive else 0

    def terminate(self):
        self.terminated = True
        self._alive = False

    def kill(self):
        self.killed = True
        self._alive = False

    def wait(self, timeout=None):
        return 0


class NovelaiGuardTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self.tmp.name)
        self.base_patch = patch.object(app, "BASE_DIR", self.tmp_path)
        self.base_patch.start()

    def tearDown(self):
        self.base_patch.stop()
        self.tmp.cleanup()

    def _pidfile_path(self):
        return app._novelai_pidfile_path()

    def _write_owner(self, parent_pid):
        path = self._pidfile_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"parent_pid": parent_pid, "node_pid": 12345}), encoding="utf-8")

    def test_stop_skips_other_instances_node(self):
        # pidfile 声明 owner 是别的进程 → 绝不 terminate，也不删别人的 pidfile
        self._write_owner(os.getpid() + 1000)
        proc = FakeProc()
        with patch.object(app, "_novelai_service_ready", return_value=True):
            app._stop_novelai_service(proc, None, graceful=True)
        self.assertFalse(proc.terminated)
        self.assertFalse(proc.killed)
        self.assertTrue(self._pidfile_path().exists())

    def test_stop_terminates_own_node_on_graceful_shutdown(self):
        # pidfile owner == 本进程 且 graceful 关闭 → 正常 terminate 并清理 pidfile
        self._write_owner(os.getpid())
        proc = FakeProc()
        with patch.object(app, "_novelai_service_ready", return_value=True):
            app._stop_novelai_service(proc, None, graceful=True)
        self.assertTrue(proc.terminated)
        self.assertFalse(proc.killed)
        self.assertFalse(self._pidfile_path().exists())

    def test_stop_skips_own_healthy_node_when_port_not_taken_over(self):
        # 本实例 spawn 了 node 但并未接管 8123（graceful=False）且 node 仍健康 → 不杀
        self._write_owner(os.getpid())
        proc = FakeProc()
        with patch.object(app, "_novelai_service_ready", return_value=True):
            app._stop_novelai_service(proc, None, graceful=False)
        self.assertFalse(proc.terminated)
        self.assertFalse(proc.killed)
        # 只清理自己的 pidfile 声明，不拖垮仍在服务的 node
        self.assertFalse(self._pidfile_path().exists())

    def test_stop_cleans_up_own_dead_node_when_port_not_taken_over(self):
        # 未接管 8123 且 node 已不健康 → 仍可 terminate 自己的死进程
        self._write_owner(os.getpid())
        proc = FakeProc()
        with patch.object(app, "_novelai_service_ready", return_value=False):
            app._stop_novelai_service(proc, None, graceful=False)
        self.assertTrue(proc.terminated)
        self.assertFalse(self._pidfile_path().exists())

    def test_stop_noop_without_process(self):
        app._stop_novelai_service(None, None, graceful=True)
        app._stop_novelai_service(None, None, graceful=False)

    def test_pidfile_roundtrip(self):
        app._write_novelai_pidfile(999)
        owner = app._read_novelai_pidfile()
        self.assertEqual(owner["parent_pid"], os.getpid())
        self.assertEqual(owner["node_pid"], 999)

    def test_app_port_available(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(("127.0.0.1", 0))
            s.listen(1)
            port = s.getsockname()[1]
            self.assertFalse(app._app_port_available("127.0.0.1", port))
        self.assertTrue(app._app_port_available("127.0.0.1", port))


if __name__ == "__main__":
    unittest.main()
