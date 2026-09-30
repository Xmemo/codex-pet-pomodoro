import os
import sqlite3
import json
import contextlib
from typing import Optional, List, Dict, Any
from .storage import STATE_DIR, ensure_private_directory, secure_private_file

DB_PATH = os.path.join(STATE_DIR, "sessions.sqlite")

class HistoryManager:
    def __init__(self, db_path: str = DB_PATH) -> None:
        self.db_path = db_path

    def _get_conn(self) -> sqlite3.Connection:
        db_dir = os.path.dirname(self.db_path)
        if db_dir:
            ensure_private_directory(db_dir, tighten_mode=os.path.abspath(db_dir) == os.path.abspath(STATE_DIR))
        secure_private_file(self.db_path, create=True)
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        self._secure_sqlite_modes()
        return conn

    def _secure_sqlite_modes(self) -> None:
        secure_private_file(self.db_path)
        secure_private_file(f"{self.db_path}-wal")
        secure_private_file(f"{self.db_path}-shm")

    def _get_read_only_conn(self) -> sqlite3.Connection:
        db_path = os.path.abspath(self.db_path)
        db_dir = os.path.dirname(db_path)
        if db_dir:
            ensure_private_directory(db_dir, tighten_mode=db_dir == os.path.abspath(STATE_DIR))
        secure_private_file(db_path)
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        self._secure_sqlite_modes()
        return conn

    @contextlib.contextmanager
    def transaction(self):
        conn = self._get_conn()
        try:
            conn.execute("BEGIN TRANSACTION")
            yield conn
            conn.commit()
            self._secure_sqlite_modes()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def init_db(self) -> None:
        with self._get_conn() as conn:
            cursor = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'")
            table_exists = cursor.fetchone()

            if not table_exists:
                conn.execute("""
                    CREATE TABLE sessions (
                        id TEXT PRIMARY KEY,
                        preset TEXT NOT NULL,
                        intention_text TEXT NOT NULL,
                        planned_work_seconds INTEGER NOT NULL,
                        planned_rest_seconds INTEGER NOT NULL,
                        started_at REAL NOT NULL,
                        work_ended_at REAL,
                        rest_ended_at REAL,
                        terminal_at REAL,
                        terminal_status TEXT,
                        review_outcome TEXT,
                        review_text TEXT,
                        review_time REAL
                    )
                """)
            else:
                cursor = conn.execute("PRAGMA table_info(sessions)")
                columns = [row["name"] for row in cursor.fetchall()]
                expected_columns = {
                    "id": "TEXT PRIMARY KEY",
                    "preset": "TEXT NOT NULL",
                    "intention_text": "TEXT NOT NULL",
                    "planned_work_seconds": "INTEGER NOT NULL",
                    "planned_rest_seconds": "INTEGER NOT NULL",
                    "started_at": "REAL NOT NULL",
                    "work_ended_at": "REAL",
                    "rest_ended_at": "REAL",
                    "terminal_at": "REAL",
                    "terminal_status": "TEXT",
                    "review_outcome": "TEXT",
                    "review_text": "TEXT",
                    "review_time": "REAL"
                }
                for col_name, col_type in expected_columns.items():
                    if col_name not in columns:
                        conn.execute(f"ALTER TABLE sessions ADD COLUMN {col_name} {col_type.split(' NOT')[0]}")

            cursor = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='session_events'")
            events_table_exists = cursor.fetchone()

            if not events_table_exists:
                conn.execute("""
                    CREATE TABLE session_events (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        session_id TEXT NOT NULL,
                        event_type TEXT NOT NULL,
                        timestamp REAL NOT NULL,
                        metadata TEXT,
                        FOREIGN KEY(session_id) REFERENCES sessions(id)
                    )
                """)
            else:
                cursor = conn.execute("PRAGMA table_info(session_events)")
                columns = [row["name"] for row in cursor.fetchall()]
                if "metadata" not in columns:
                    conn.execute("ALTER TABLE session_events ADD COLUMN metadata TEXT")

            cursor = conn.execute("PRAGMA user_version")
            row = cursor.fetchone()
            version = row[0] if row else 0
            if version < 2:
                conn.execute("PRAGMA user_version = 2")
            conn.commit()
            self._secure_sqlite_modes()

    def bootstrap_legacy_session(self, session_id: str, preset: str, intention_text: str, planned_work: int, planned_rest: int, started_at: float) -> None:
        with self.transaction() as conn:
            cursor = conn.execute("SELECT 1 FROM sessions WHERE id = ?", (session_id,))
            if cursor.fetchone() is None:
                conn.execute("""
                    INSERT INTO sessions (
                        id, preset, intention_text, planned_work_seconds, planned_rest_seconds, started_at
                    ) VALUES (?, ?, ?, ?, ?, ?)
                """, (session_id, preset, intention_text, planned_work, planned_rest, started_at))
                conn.execute("""
                    INSERT INTO session_events (
                        session_id, event_type, timestamp
                    ) VALUES (?, ?, ?)
                """, (session_id, "legacy_import", started_at))

    def create_session(self, session_id: str, preset: str, intention_text: str, planned_work: int, planned_rest: int, timestamp: float, conn: Optional[sqlite3.Connection] = None) -> None:
        def _run(c):
            c.execute("""
                INSERT INTO sessions (
                    id, preset, intention_text, planned_work_seconds, planned_rest_seconds, started_at
                ) VALUES (?, ?, ?, ?, ?, ?)
            """, (session_id, preset, intention_text, planned_work, planned_rest, timestamp))
            c.execute("""
                INSERT INTO session_events (
                    session_id, event_type, timestamp
                ) VALUES (?, ?, ?)
            """, (session_id, "start", timestamp))

        if conn is None:
            with self._get_conn() as c:
                _run(c)
                c.commit()
        else:
            _run(conn)

    def log_event(self, session_id: str, event_type: str, timestamp: float, metadata: Optional[Dict[str, Any]] = None, conn: Optional[sqlite3.Connection] = None) -> None:
        metadata_str = json.dumps(metadata) if metadata is not None else None
        def _run(c):
            c.execute("""
                INSERT INTO session_events (
                    session_id, event_type, timestamp, metadata
                ) VALUES (?, ?, ?, ?)
            """, (session_id, event_type, timestamp, metadata_str))

        if conn is None:
            with self._get_conn() as c:
                _run(c)
                c.commit()
        else:
            _run(conn)

    def update_session_work_end(self, session_id: str, timestamp: float, conn: Optional[sqlite3.Connection] = None) -> None:
        def _run(c):
            c.execute("""
                UPDATE sessions
                SET work_ended_at = ?
                WHERE id = ?
            """, (timestamp, session_id))
            c.execute("""
                INSERT INTO session_events (
                    session_id, event_type, timestamp
                ) VALUES (?, ?, ?)
            """, (session_id, "work_end", timestamp))

        if conn is None:
            with self._get_conn() as c:
                _run(c)
                c.commit()
        else:
            _run(conn)

    def update_session_rest_end(self, session_id: str, timestamp: float, status: str, conn: Optional[sqlite3.Connection] = None) -> None:
        def _run(c):
            c.execute("""
                UPDATE sessions
                SET rest_ended_at = ?, terminal_at = ?, terminal_status = ?
                WHERE id = ?
            """, (timestamp, timestamp, status, session_id))
            c.execute("""
                INSERT INTO session_events (
                    session_id, event_type, timestamp
                ) VALUES (?, ?, ?)
            """, (session_id, "rest_end", timestamp))

        if conn is None:
            with self._get_conn() as c:
                _run(c)
                c.commit()
        else:
            _run(conn)

    def update_session_terminal(self, session_id: str, timestamp: float, status: str, conn: Optional[sqlite3.Connection] = None) -> None:
        def _run(c):
            c.execute("""
                UPDATE sessions
                SET terminal_at = ?, terminal_status = ?
                WHERE id = ?
            """, (timestamp, status, session_id))

        if conn is None:
            with self._get_conn() as c:
                _run(c)
                c.commit()
        else:
            _run(conn)

    def save_review(self, session_id: str, outcome: str, text: Optional[str], timestamp: float, conn: Optional[sqlite3.Connection] = None) -> None:
        metadata_str = json.dumps({"outcome": outcome, "text": text})
        def _run(c):
            c.execute("""
                UPDATE sessions
                SET review_outcome = ?, review_text = ?, review_time = ?
                WHERE id = ?
            """, (outcome, text, timestamp, session_id))
            c.execute("""
                INSERT INTO session_events (
                    session_id, event_type, timestamp, metadata
                ) VALUES (?, ?, ?, ?)
            """, (session_id, "review", timestamp, metadata_str))

        if conn is None:
            with self._get_conn() as c:
                _run(c)
                c.commit()
        else:
            _run(conn)

    def get_history(self, limit: int = 50) -> List[Dict[str, Any]]:
        limit = max(1, min(200, limit))
        if not os.path.exists(self.db_path):
            return []
        with self._get_read_only_conn() as conn:
            cursor = conn.execute("""
                SELECT * FROM sessions
                ORDER BY started_at DESC
                LIMIT ?
            """, (limit,))
            rows = cursor.fetchall()
            return [dict(row) for row in rows]
