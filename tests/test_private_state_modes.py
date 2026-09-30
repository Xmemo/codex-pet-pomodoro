import os
import stat
import tempfile
import unittest

from src.ultradian_rhythm.history import HistoryManager
from src.ultradian_rhythm.models import TimerState
from src.ultradian_rhythm.storage import Storage


class TestPrivateStateModes(unittest.TestCase):
    def test_state_and_database_are_private_under_permissive_umask(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            state_dir = os.path.join(root, "state")
            os.mkdir(state_dir, 0o755)
            state_path = os.path.join(state_dir, "state.json")
            with open(state_path, "w", encoding="utf-8") as handle:
                handle.write('{"schema_version": 1, "status": "idle"}')
            os.chmod(state_path, 0o644)

            old_umask = os.umask(0)
            try:
                storage = Storage(state_path)
                storage.load()
                storage.save(TimerState())
                history = HistoryManager(os.path.join(state_dir, "sessions.sqlite"))
                history.init_db()
                conn = history._get_conn()
                conn.execute("PRAGMA journal_mode=WAL")
                conn.execute(
                    "INSERT INTO sessions (id, preset, intention_text, planned_work_seconds, planned_rest_seconds, started_at) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    ("private-test", "flow", "test", 3000, 600, 1.0),
                )
                history._secure_sqlite_modes()
                sidecar_modes = {
                    name: stat.S_IMODE(os.stat(f"{history.db_path}-{name}").st_mode)
                    for name in ("wal", "shm")
                    if os.path.exists(f"{history.db_path}-{name}")
                }
                conn.close()
            finally:
                os.umask(old_umask)

            self.assertEqual(stat.S_IMODE(os.stat(state_dir).st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(os.stat(state_path).st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(os.stat(history.db_path).st_mode), 0o600)
            self.assertTrue(sidecar_modes)
            self.assertTrue(all(mode == 0o600 for mode in sidecar_modes.values()))

    def test_state_symlink_is_rejected_without_following_target(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            state_dir = os.path.join(root, "state")
            os.mkdir(state_dir, 0o700)
            target = os.path.join(root, "target.json")
            with open(target, "w", encoding="utf-8") as handle:
                handle.write("{}")
            link = os.path.join(state_dir, "state.json")
            os.symlink(target, link)

            with self.assertRaisesRegex(RuntimeError, "regular file"):
                Storage(link).load()
            self.assertTrue(os.path.islink(link))


if __name__ == "__main__":
    unittest.main()
