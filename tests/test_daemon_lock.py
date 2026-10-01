import os
import tempfile
import unittest

from src.ultradian_rhythm.daemon import acquire_single_instance_lock


class TestDaemonLock(unittest.TestCase):
    def test_lock_is_exclusive_and_released_with_descriptor(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            lock_path = os.path.join(directory, "daemon.lock")
            first_fd = acquire_single_instance_lock(lock_path)
            try:
                self.assertEqual(os.stat(lock_path).st_mode & 0o777, 0o600)
                with self.assertRaisesRegex(RuntimeError, "already running"):
                    acquire_single_instance_lock(lock_path)
            finally:
                os.close(first_fd)

            second_fd = acquire_single_instance_lock(lock_path)
            os.close(second_fd)

    def test_lock_refuses_symlink(self) -> None:
        if not hasattr(os, "O_NOFOLLOW"):
            self.skipTest("platform does not support O_NOFOLLOW")
        with tempfile.TemporaryDirectory() as directory:
            target = os.path.join(directory, "target")
            link = os.path.join(directory, "daemon.lock")
            with open(target, "w", encoding="utf-8") as stream:
                stream.write("untouched")
            os.symlink(target, link)
            with self.assertRaises(OSError):
                acquire_single_instance_lock(link)
            with open(target, encoding="utf-8") as stream:
                self.assertEqual(stream.read(), "untouched")


if __name__ == "__main__":
    unittest.main()
