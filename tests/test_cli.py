import unittest
from unittest.mock import patch, MagicMock
import sys
import io
import json
from src.ultradian_rhythm import cli

class TestTimerCLI(unittest.TestCase):
    @patch("src.ultradian_rhythm.cli.socket.socket")
    @patch("src.ultradian_rhythm.cli.recv_message")
    @patch("src.ultradian_rhythm.cli.send_message")
    @patch("src.ultradian_rhythm.cli.os.path.exists", return_value=True)
    def test_cli_status_json(self, mock_exists: MagicMock, mock_send: MagicMock, mock_recv: MagicMock, mock_socket: MagicMock) -> None:
        mock_conn = MagicMock()
        mock_socket.return_value = mock_conn

        mock_recv.return_value = {
            "ok": True,
            "operation": "status",
            "state": {
                "status": "running",
                "phase": "work",
                "preset": "flow",
                "remaining_seconds": 1800.0,
                "deadline": 2000.0
            }
        }

        stdout_capture = io.StringIO()
        with patch.object(sys, "argv", ["ultradian", "status", "--json"]):
            with patch.object(sys, "stdout", stdout_capture):
                with self.assertRaises(SystemExit) as cm:
                    cli.main()
                self.assertEqual(cm.exception.code, 0)

        output = json.loads(stdout_capture.getvalue())
        self.assertTrue(output["ok"])
        self.assertEqual(output["state"]["status"], "running")
        self.assertEqual(output["state"]["preset"], "flow")

        mock_send.assert_called_once()
        sent_cmd = mock_send.call_args[0][1]
        self.assertEqual(sent_cmd["command"], "status")

    @patch("src.ultradian_rhythm.cli.socket.socket")
    @patch("src.ultradian_rhythm.cli.recv_message")
    @patch("src.ultradian_rhythm.cli.send_message")
    @patch("src.ultradian_rhythm.cli.os.path.exists", return_value=True)
    def test_cli_start_conflict(self, mock_exists: MagicMock, mock_send: MagicMock, mock_recv: MagicMock, mock_socket: MagicMock) -> None:
        mock_recv.return_value = {
            "ok": False,
            "operation": "start",
            "error": "An active cycle is already running.",
            "state": {}
        }

        with patch.object(sys, "argv", ["ultradian", "start", "start", "--goal", "some goal"]):
            with self.assertRaises(SystemExit) as cm:
                cli.main()
            self.assertEqual(cm.exception.code, 2)  # conflict is exit code 2

    @patch("src.ultradian_rhythm.cli.socket.socket")
    @patch("src.ultradian_rhythm.cli.recv_message")
    @patch("src.ultradian_rhythm.cli.send_message")
    @patch("src.ultradian_rhythm.cli.os.path.exists", return_value=True)
    def test_cli_notifier_failure(self, mock_exists: MagicMock, mock_send: MagicMock, mock_recv: MagicMock, mock_socket: MagicMock) -> None:
        mock_recv.return_value = {
            "ok": False,
            "operation": "notify-test",
            "error": "MacNotifier failed to post notification",
            "state": {}
        }

        with patch.object(sys, "argv", ["ultradian", "notify-test"]):
            with self.assertRaises(SystemExit) as cm:
                cli.main()
            self.assertEqual(cm.exception.code, 4)  # notification error code is 4

    @patch("src.ultradian_rhythm.cli.socket.socket")
    @patch("src.ultradian_rhythm.cli.os.path.exists", return_value=False)
    def test_cli_daemon_unavailable(self, mock_exists: MagicMock, mock_socket: MagicMock) -> None:
        with patch.object(sys, "argv", ["ultradian", "status"]):
            with self.assertRaises(SystemExit) as cm:
                cli.main()
            self.assertEqual(cm.exception.code, 3)  # daemon unavailable code is 3

    @patch("src.ultradian_rhythm.cli.socket.socket")
    @patch("src.ultradian_rhythm.cli.recv_message")
    @patch("src.ultradian_rhythm.cli.send_message")
    @patch("src.ultradian_rhythm.cli.os.path.exists", return_value=True)
    def test_cli_start_with_intention(self, mock_exists: MagicMock, mock_send: MagicMock, mock_recv: MagicMock, mock_socket: MagicMock) -> None:
        mock_recv.return_value = {
            "ok": True,
            "operation": "start",
            "state": {}
        }
        with patch.object(sys, "argv", ["ultradian", "start", "flow", "--goal", "Finish task"]):
            with self.assertRaises(SystemExit) as cm:
                cli.main()
            self.assertEqual(cm.exception.code, 0)

        mock_send.assert_called_once()
        sent_cmd = mock_send.call_args[0][1]
        self.assertEqual(sent_cmd["command"], "start")
        self.assertEqual(sent_cmd["preset"], "flow")
        self.assertEqual(sent_cmd["intentionText"], "Finish task")

    @patch("src.ultradian_rhythm.cli.socket.socket")
    @patch("src.ultradian_rhythm.cli.recv_message")
    @patch("src.ultradian_rhythm.cli.send_message")
    @patch("src.ultradian_rhythm.cli.os.path.exists", return_value=True)
    def test_cli_start_reads_adversarial_goal_literally_from_stdin(self, mock_exists: MagicMock, mock_send: MagicMock, mock_recv: MagicMock, mock_socket: MagicMock) -> None:
        mock_recv.return_value = {"ok": True, "operation": "start", "state": {}}
        goal = "--literal $(touch /tmp/should-not-exist) `whoami`; quote ' and \"\nsecond line"
        with patch.object(sys, "argv", ["ultradian", "start", "flow", "--goal-stdin"]):
            with patch.object(sys, "stdin", io.StringIO(goal)):
                with self.assertRaises(SystemExit) as cm:
                    cli.main()
                self.assertEqual(cm.exception.code, 0)

        sent_cmd = mock_send.call_args[0][1]
        self.assertEqual(sent_cmd["intentionText"], goal)

    @patch("src.ultradian_rhythm.cli.socket.socket")
    @patch("src.ultradian_rhythm.cli.recv_message")
    @patch("src.ultradian_rhythm.cli.send_message")
    @patch("src.ultradian_rhythm.cli.os.path.exists", return_value=True)
    def test_cli_rejects_oversized_goal_stdin(self, mock_exists: MagicMock, mock_send: MagicMock, mock_recv: MagicMock, mock_socket: MagicMock) -> None:
        from src.ultradian_rhythm.cli import MAX_GOAL_CHARS
        with patch.object(sys, "argv", ["ultradian", "start", "flow", "--goal-stdin"]):
            with patch.object(sys, "stdin", io.StringIO("x" * (MAX_GOAL_CHARS + 1))):
                with self.assertRaises(SystemExit) as cm:
                    cli.main()
                self.assertEqual(cm.exception.code, 2)
        mock_send.assert_not_called()

    @patch("src.ultradian_rhythm.cli.socket.socket")
    @patch("src.ultradian_rhythm.cli.recv_message")
    @patch("src.ultradian_rhythm.cli.send_message")
    @patch("src.ultradian_rhythm.cli.os.path.exists", return_value=True)
    def test_cli_start_implicit_preset_with_intention(self, mock_exists: MagicMock, mock_send: MagicMock, mock_recv: MagicMock, mock_socket: MagicMock) -> None:
        mock_recv.return_value = {
            "ok": True,
            "operation": "start",
            "state": {}
        }
        with patch.object(sys, "argv", ["ultradian", "start", "--goal", "Finish task"]):
            with self.assertRaises(SystemExit) as cm:
                cli.main()
            self.assertEqual(cm.exception.code, 0)

        mock_send.assert_called_once()
        sent_cmd = mock_send.call_args[0][1]
        self.assertEqual(sent_cmd["command"], "start")
        self.assertEqual(sent_cmd["preset"], "flow")
        self.assertEqual(sent_cmd["intentionText"], "Finish task")

    @patch("src.ultradian_rhythm.cli.socket.socket")
    @patch("src.ultradian_rhythm.cli.recv_message")
    @patch("src.ultradian_rhythm.cli.send_message")
    @patch("src.ultradian_rhythm.cli.os.path.exists", return_value=True)
    def test_cli_review(self, mock_exists: MagicMock, mock_send: MagicMock, mock_recv: MagicMock, mock_socket: MagicMock) -> None:
        mock_recv.return_value = {
            "ok": True,
            "operation": "review",
            "state": {}
        }
        with patch.object(sys, "argv", ["ultradian", "review", "--outcome", "partial", "--text", "Some comments"]):
            with self.assertRaises(SystemExit) as cm:
                cli.main()
            self.assertEqual(cm.exception.code, 0)

        mock_send.assert_called_once()
        sent_cmd = mock_send.call_args[0][1]
        self.assertEqual(sent_cmd["command"], "review")
        self.assertEqual(sent_cmd["outcome"], "partial")
        self.assertEqual(sent_cmd["text"], "Some comments")

    @patch("src.ultradian_rhythm.cli.socket.socket")
    @patch("src.ultradian_rhythm.cli.recv_message")
    @patch("src.ultradian_rhythm.cli.send_message")
    @patch("src.ultradian_rhythm.cli.os.path.exists", return_value=True)
    def test_cli_history(self, mock_exists: MagicMock, mock_send: MagicMock, mock_recv: MagicMock, mock_socket: MagicMock) -> None:
        mock_recv.return_value = {
            "ok": True,
            "operation": "history",
            "history": []
        }
        with patch.object(sys, "argv", ["ultradian", "history", "--limit", "10"]):
            with self.assertRaises(SystemExit) as cm:
                cli.main()
            self.assertEqual(cm.exception.code, 0)

        mock_send.assert_called_once()
        sent_cmd = mock_send.call_args[0][1]
        self.assertEqual(sent_cmd["command"], "history")
        self.assertEqual(sent_cmd["limit"], 10)
