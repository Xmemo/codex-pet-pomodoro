import os
import sys
import socket
import select
import time
import fcntl
import stat
from .storage import Storage, STATE_DIR
from .notifier import MacNotifier
from .engine import TimerEngine
from .protocol import recv_message, send_message

SOCKET_PATH = os.path.join(STATE_DIR, "daemon.sock")
LOCK_PATH = os.path.join(STATE_DIR, "daemon.lock")


def acquire_single_instance_lock(lock_path: str) -> int:
    flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(lock_path, flags, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
            raise RuntimeError("daemon lock must be a regular file owned by the current user")
        os.fchmod(fd, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError("timer daemon is already running") from exc
        return fd
    except Exception:
        os.close(fd)
        raise

def validate_command_payload(msg: dict) -> None:
    if not isinstance(msg, dict):
        raise ValueError("Payload must be a dictionary")

    cmd = msg.get("command")
    if not cmd:
        raise ValueError("Missing 'command' field")

    allowed_commands = {"start", "status", "pause", "resume", "stop", "repeat", "review", "history", "notify-test"}
    if cmd not in allowed_commands:
        raise ValueError(f"Unknown command: {cmd}")

    if cmd == "start":
        required_fields = {"command", "preset", "intentionText", "replace"}
        actual_keys = set(msg.keys())
        if actual_keys != required_fields:
            raise ValueError(f"Invalid fields for start command. Expected {required_fields}, got {actual_keys}")

        preset = msg["preset"]
        if not isinstance(preset, str) or preset not in ("start", "flow", "deep"):
            raise ValueError(f"preset must be a string and one of start/flow/deep, got {preset}")

        intention = msg["intentionText"]
        if not isinstance(intention, str) or not intention.strip():
            raise ValueError("intentionText must be a non-empty string")

        replace = msg["replace"]
        if not isinstance(replace, bool):
            raise ValueError("replace must be a boolean")

    elif cmd == "review":
        required_fields = {"command", "outcome", "text"}
        actual_keys = set(msg.keys())
        if actual_keys != required_fields:
            raise ValueError(f"Invalid fields for review command. Expected {required_fields}, got {actual_keys}")

        outcome = msg["outcome"]
        if not isinstance(outcome, str) or outcome not in ("done", "partial", "switched"):
            raise ValueError(f"outcome must be a string and one of done/partial/switched, got {outcome}")

        text = msg["text"]
        if not isinstance(text, str):
            raise ValueError("text must be a string")

    elif cmd == "history":
        allowed_fields = {"command", "limit"}
        actual_keys = set(msg.keys())
        if not actual_keys.issubset(allowed_fields):
            raise ValueError(f"Invalid fields for history command. Allowed: {allowed_fields}")

        if "limit" in msg:
            limit = msg["limit"]
            if isinstance(limit, bool) or not isinstance(limit, int):
                raise ValueError("limit must be an integer, bool not allowed")
            if limit < 1 or limit > 200:
                raise ValueError(f"limit must be between 1 and 200, got {limit}")

    else:
        required_fields = {"command"}
        actual_keys = set(msg.keys())
        if actual_keys != required_fields:
            raise ValueError(f"Command '{cmd}' does not accept additional fields, got {actual_keys}")

class TimerDaemon:
    def __init__(self, socket_path: str = SOCKET_PATH) -> None:
        self.socket_path = socket_path
        self.lock_path = f"{socket_path}.lock"
        self.lock_fd = None
        self.storage = Storage()
        self.notifier = MacNotifier()
        self.engine = TimerEngine(self.storage, self.notifier, time_func=time.time)
        self.running = True

    def run(self) -> None:
        socket_dir = os.path.dirname(self.socket_path)
        if socket_dir:
            os.makedirs(socket_dir, exist_ok=True)
        try:
            self.lock_fd = acquire_single_instance_lock(self.lock_path)
        except Exception as e:
            sys.stderr.write(f"Failed to acquire timer daemon lock: {e}\n")
            sys.exit(4)

        # 1. Immediate recovery upon start
        try:
            self.engine.tick(time.time())
        except Exception as e:
            sys.stderr.write(f"Startup recovery error: {e}\n")

        # 2. Clean and bind Unix domain socket
        if os.path.exists(self.socket_path):
            try:
                os.remove(self.socket_path)
            except Exception as e:
                sys.stderr.write(f"Failed to remove existing socket file: {e}\n")
                sys.exit(3)

        server_sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            server_sock.bind(self.socket_path)
            # Restrict socket access to the current user
            os.chmod(self.socket_path, 0o600)
            server_sock.listen(5)
        except Exception as e:
            sys.stderr.write(f"Failed to bind socket {self.socket_path}: {e}\n")
            sys.exit(3)

        sys.stdout.write(f"Daemon started. Listening on {self.socket_path}\n")
        sys.stdout.flush()

        try:
            while self.running:
                # 3. Calculate next timeout to avoid active polling
                next_event = self.engine.get_next_event_time()
                timeout = None
                if next_event is not None:
                    now = time.time()
                    timeout = max(0.01, next_event - now)

                # 4. Wait for connection or timeout
                r, _, _ = select.select([server_sock], [], [], timeout)

                now = time.time()
                # 5. Process background time ticks
                try:
                    self.engine.tick(now)
                except Exception as e:
                    sys.stderr.write(f"Error during tick update: {e}\n")

                # 6. Accept and handle socket client request
                if r:
                    try:
                        conn, _ = server_sock.accept()
                        self.handle_connection(conn)
                    except Exception as e:
                        sys.stderr.write(f"Failed to accept client connection: {e}\n")
        finally:
            server_sock.close()
            if os.path.exists(self.socket_path):
                try:
                    os.remove(self.socket_path)
                except Exception:
                    pass
            if self.lock_fd is not None:
                os.close(self.lock_fd)
                self.lock_fd = None

    def handle_connection(self, conn: socket.socket) -> None:
        buffer = bytearray()
        try:
            msg = recv_message(conn, buffer)
            if not msg:
                return

            cmd = msg.get("command")
            response = self.process_command(cmd, msg)
            send_message(conn, response)
        except Exception as e:
            try:
                send_message(conn, {
                    "ok": False,
                    "operation": "unknown",
                    "error": f"Failed to process connection: {str(e)}",
                    "state": self.serialize_state(time.time())
                })
            except Exception:
                pass
        finally:
            try:
                conn.close()
            except Exception:
                pass

    def process_command(self, cmd: str, msg: dict) -> dict:
        now = time.time()
        op = cmd
        error_msg = None
        ok = True
        extra_fields = {}

        try:
            validate_command_payload(msg)
            cmd = msg.get("command")
            op = cmd

            if cmd == "start":
                preset = msg.get("preset", "flow")
                replace = msg.get("replace", False)
                intention_text = msg.get("intentionText", "")
                self.engine.start_cycle(preset, replace, intention_text)
            elif cmd == "status":
                self.engine.tick(now)
            elif cmd == "pause":
                self.engine.pause_cycle()
            elif cmd == "resume":
                self.engine.resume_cycle()
            elif cmd == "stop":
                self.engine.stop_cycle()
            elif cmd == "repeat":
                self.engine.repeat_cycle()
            elif cmd == "review":
                outcome = msg.get("outcome")
                text = msg.get("text")
                self.engine.review_cycle(outcome, text)
            elif cmd == "history":
                limit = msg.get("limit", 50)
                sessions = self.engine.history_mgr.get_history(limit)
                extra_fields["history"] = sessions
            elif cmd == "notify-test":
                success = self.notifier.notify(
                    title="测试通知",
                    subtitle="通知功能测试",
                    message="这是一条来自 Codex 专注计时器服务的测试通知。"
                )
                if not success:
                    ok = False
                    error_msg = "MacNotifier failed to post notification"
            else:
                ok = False
                error_msg = f"Unknown command: {cmd}"
        except ValueError as ve:
            ok = False
            error_msg = str(ve)
        except Exception as e:
            ok = False
            error_msg = f"Daemon process error: {str(e)}"

        state_dict = self.serialize_state(now)
        res = {
            "ok": ok,
            "operation": op,
            "state": state_dict
        }
        res.update(extra_fields)
        if error_msg:
            res["error"] = error_msg
        return res

    def serialize_state(self, now: float) -> dict:
        state = self.engine.state
        state_dict = state.to_dict()

        # Formulate transient fields for client convenience
        if state.status == "running":
            state_dict["remaining_seconds"] = max(0.0, (state.deadline or 0.0) - now)
        elif state.status == "paused":
            state_dict["remaining_seconds"] = state.remaining_seconds
        else:
            state_dict["remaining_seconds"] = None

        return state_dict

def main() -> None:
    daemon = TimerDaemon()
    daemon.run()

if __name__ == "__main__":
    main()
