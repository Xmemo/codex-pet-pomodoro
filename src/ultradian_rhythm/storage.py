import os
import json
import time
import stat
import secrets
from typing import Tuple
from .models import TimerState, Preset, PRESETS

STATE_DIR = os.path.expanduser("~/.codex/ultradian-rhythm")
STATE_PATH = os.path.join(STATE_DIR, "state.json")


def ensure_private_directory(path: str, tighten_mode: bool = True) -> None:
    os.makedirs(path, mode=0o700, exist_ok=True)
    info = os.lstat(path)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise RuntimeError("state directory must be a real directory owned by the current user")
    if tighten_mode:
        os.chmod(path, 0o700)


def secure_private_file(path: str, create: bool = False) -> bool:
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        if not create:
            return False
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(path, flags, 0o600)
        os.close(fd)
        info = os.lstat(path)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
        raise RuntimeError("state file must be a regular file owned by the current user")
    os.chmod(path, 0o600)
    return True

class Storage:
    def __init__(self, path: str = STATE_PATH):
        self.path = path
        self.dir = os.path.dirname(self.path)

    def save(self, state: TimerState) -> None:
        """Saves the state atomically to the file, first validating it."""
        state.validate()
        if self.dir:
            ensure_private_directory(self.dir)
        secure_private_file(self.path)
        temp_path = f"{self.path}.{os.getpid()}.{secrets.token_hex(8)}.tmp"
        try:
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
            fd = os.open(temp_path, flags, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                os.fchmod(f.fileno(), 0o600)
                json.dump(state.to_dict(), f, indent=2, ensure_ascii=False)
                f.flush()
                os.fsync(f.fileno())
            os.replace(temp_path, self.path)
            os.chmod(self.path, 0o600)
        except Exception as e:
            if os.path.lexists(temp_path):
                try:
                    os.remove(temp_path)
                except Exception:
                    pass
            raise RuntimeError(f"Failed to save state atomically: {e}") from e

    def load(self) -> TimerState:
        """Loads state from the file. If corrupt or invalid, quarantines it and returns a clean idle state."""
        if self.dir:
            ensure_private_directory(self.dir)
        if not os.path.lexists(self.path):
            return TimerState()
        secure_private_file(self.path)

        try:
            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
            fd = os.open(self.path, flags)
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
                os.close(fd)
                raise RuntimeError("state file changed to an unsafe type or owner")
            with os.fdopen(fd, "r", encoding="utf-8") as f:
                data = json.load(f)
            if not isinstance(data, dict):
                raise ValueError("State data must be a JSON object")
            state = TimerState.from_dict(data)
            state.validate()
            return state
        except Exception as e:
            # Quarantine the corrupt file
            corrupt_path = f"{self.path}.corrupt.{time.time_ns()}"
            try:
                os.rename(self.path, corrupt_path)
            except Exception:
                # If rename fails, try to remove or leave it
                pass
            
            # Create a clean idle state with error details
            idle_state = TimerState()
            idle_state.last_error = f"Quarantined corrupt state: {str(e)}"
            try:
                self.save(idle_state)
            except Exception:
                pass
            return idle_state
