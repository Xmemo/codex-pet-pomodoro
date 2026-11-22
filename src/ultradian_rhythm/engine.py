import time
import uuid
import os
from typing import Optional
from .models import TimerState, PRESETS
from .storage import Storage
from .notifier import BaseNotifier
from .history import HistoryManager

class TimerEngine:
    def __init__(self, storage: Storage, notifier: BaseNotifier, time_func=time.time, history_mgr: Optional[HistoryManager] = None) -> None:
        self.storage = storage
        self.notifier = notifier
        self.time_func = time_func
        self.state: TimerState = self.storage.load()
        if history_mgr is None:
            db_dir = os.path.dirname(storage.path)
            db_path = os.path.join(db_dir, "sessions.sqlite") if db_dir else "sessions.sqlite"
            self.history_mgr = HistoryManager(db_path)
        else:
            self.history_mgr = history_mgr
        self.history_mgr.init_db()

        # Idempotent legacy session bootstrapping
        if self.state.status in ("running", "paused") and self.state.cycle_id:
            preset_key = self.state.preset
            if preset_key in PRESETS:
                preset = PRESETS[preset_key]
                started_at = self.state.started_at if self.state.started_at is not None else self.time_func()
                intention_text = self.state.intention_text if self.state.intention_text is not None else ""
                self.history_mgr.bootstrap_legacy_session(
                    session_id=self.state.cycle_id,
                    preset=preset_key,
                    intention_text=intention_text,
                    planned_work=preset.work_seconds,
                    planned_rest=preset.rest_seconds,
                    started_at=started_at
                )

    def start_cycle(self, preset_key: str = "flow", replace: bool = False, intention_text: str = "") -> TimerState:
        """Starts a new rhythm cycle with the given preset.
        If a cycle is already active and replace is False, raises ValueError.
        """
        if preset_key not in PRESETS:
            raise ValueError(f"Invalid preset key: {preset_key}")

        trimmed_intention = intention_text.strip()
        if not trimmed_intention:
            raise ValueError("Intention text cannot be empty.")

        if self.state.status in ("running", "paused") and not replace:
            raise ValueError("An active cycle is already running. Use replacement flag to override.")

        preset = PRESETS[preset_key]
        now = self.time_func()
        new_cycle_id = str(uuid.uuid4())

        new_state = TimerState(
            schema_version=2,
            cycle_id=new_cycle_id,
            preset=preset_key,
            status="running",
            phase="work",
            started_at=now,
            deadline=now + preset.work_seconds,
            remaining_seconds=None,
            closure_notified=False,
            work_end_notified=False,
            rest_end_notified=False,
            last_error=None,
            intention_text=trimmed_intention,
            midpoint_notified=False,
            review_pending=False
        )

        old_state = TimerState.from_dict(self.state.to_dict())
        state_save_attempted = False
        try:
            with self.history_mgr.transaction() as conn:
                if self.state.status in ("running", "paused") and replace:
                    old_cycle_id = self.state.cycle_id
                    if old_cycle_id:
                        self.history_mgr.update_session_terminal(old_cycle_id, now, "replaced", conn=conn)
                        self.history_mgr.log_event(old_cycle_id, "replace", now, conn=conn)

                self.history_mgr.create_session(
                    session_id=new_cycle_id,
                    preset=preset_key,
                    intention_text=trimmed_intention,
                    planned_work=preset.work_seconds,
                    planned_rest=preset.rest_seconds,
                    timestamp=now,
                    conn=conn
                )
                state_save_attempted = True
                self.storage.save(new_state)
            self.state = new_state
        except Exception:
            if state_save_attempted:
                try:
                    self.storage.save(old_state)
                except Exception:
                    pass
            raise
        return self.state

    def pause_cycle(self) -> TimerState:
        """Pauses the current active cycle, preserving remaining duration."""
        if self.state.status != "running":
            raise ValueError("No running cycle to pause.")

        now = self.time_func()
        remaining = max(0.0, self.state.deadline - now)

        new_state = TimerState(
            schema_version=self.state.schema_version,
            cycle_id=self.state.cycle_id,
            preset=self.state.preset,
            status="paused",
            phase=self.state.phase,
            started_at=self.state.started_at,
            deadline=None,
            remaining_seconds=remaining,
            closure_notified=self.state.closure_notified,
            work_end_notified=self.state.work_end_notified,
            rest_end_notified=self.state.rest_end_notified,
            last_error=self.state.last_error,
            intention_text=self.state.intention_text,
            midpoint_notified=self.state.midpoint_notified,
            review_pending=False
        )

        old_state = TimerState.from_dict(self.state.to_dict())
        state_save_attempted = False
        try:
            with self.history_mgr.transaction() as conn:
                if self.state.cycle_id:
                    self.history_mgr.log_event(self.state.cycle_id, "pause", now, conn=conn)
                state_save_attempted = True
                self.storage.save(new_state)
            self.state = new_state
        except Exception:
            if state_save_attempted:
                try:
                    self.storage.save(old_state)
                except Exception:
                    pass
            raise
        return self.state

    def resume_cycle(self) -> TimerState:
        """Resumes the current paused cycle, restoring the deadline."""
        if self.state.status != "paused":
            raise ValueError("No paused cycle to resume.")

        now = self.time_func()
        remaining = self.state.remaining_seconds if self.state.remaining_seconds is not None else 0.0

        new_state = TimerState(
            schema_version=self.state.schema_version,
            cycle_id=self.state.cycle_id,
            preset=self.state.preset,
            status="running",
            phase=self.state.phase,
            started_at=self.state.started_at,
            deadline=now + remaining,
            remaining_seconds=None,
            closure_notified=self.state.closure_notified,
            work_end_notified=self.state.work_end_notified,
            rest_end_notified=self.state.rest_end_notified,
            last_error=self.state.last_error,
            intention_text=self.state.intention_text,
            midpoint_notified=self.state.midpoint_notified,
            review_pending=False
        )

        old_state = TimerState.from_dict(self.state.to_dict())
        state_save_attempted = False
        try:
            with self.history_mgr.transaction() as conn:
                if self.state.cycle_id:
                    self.history_mgr.log_event(self.state.cycle_id, "resume", now, conn=conn)
                state_save_attempted = True
                self.storage.save(new_state)
            self.state = new_state
        except Exception:
            if state_save_attempted:
                try:
                    self.storage.save(old_state)
                except Exception:
                    pass
            raise
        return self.state

    def stop_cycle(self) -> TimerState:
        """Stops the current active cycle, entering completed status."""
        if self.state.status == "idle":
            return self.state

        now = self.time_func()
        if self.state.status in ("running", "paused"):
            new_state = TimerState(
                schema_version=self.state.schema_version,
                cycle_id=self.state.cycle_id,
                preset=self.state.preset,
                status="completed",
                phase="none",
                started_at=self.state.started_at,
                deadline=None,
                remaining_seconds=None,
                closure_notified=False,
                work_end_notified=self.state.work_end_notified,
                rest_end_notified=self.state.rest_end_notified,
                last_error=self.state.last_error,
                intention_text=self.state.intention_text,
                midpoint_notified=self.state.midpoint_notified,
                review_pending=False
            )

            old_state = TimerState.from_dict(self.state.to_dict())
            state_save_attempted = False
            try:
                with self.history_mgr.transaction() as conn:
                    if self.state.cycle_id:
                        self.history_mgr.update_session_terminal(self.state.cycle_id, now, "stopped", conn=conn)
                        self.history_mgr.log_event(self.state.cycle_id, "stop", now, conn=conn)
                    state_save_attempted = True
                    self.storage.save(new_state)
                self.state = new_state
            except Exception:
                if state_save_attempted:
                    try:
                        self.storage.save(old_state)
                    except Exception:
                        pass
                raise
        return self.state

    def repeat_cycle(self) -> TimerState:
        """Repeats the last completed or stopped cycle preset exactly once."""
        if self.state.status in ("running", "paused"):
            raise ValueError("Cannot repeat while a cycle is active.")

        preset_key = self.state.preset if self.state.preset in PRESETS else "flow"
        intention_text = (self.state.intention_text or "").strip()
        if not intention_text:
            raise ValueError("Cannot repeat without a saved goal. Start a new cycle with a specific goal.")
        return self.start_cycle(preset_key, replace=True, intention_text=intention_text)

    def review_cycle(self, outcome: str, text: Optional[str] = None) -> TimerState:
        """Submits review for the completed/rest phase work."""
        if not self.state.review_pending:
            raise ValueError("No pending review.")
        if outcome not in ("done", "partial", "switched"):
            raise ValueError(f"Invalid review outcome: {outcome}")

        now = self.time_func()
        new_state = TimerState(
            schema_version=self.state.schema_version,
            cycle_id=self.state.cycle_id,
            preset=self.state.preset,
            status=self.state.status,
            phase=self.state.phase,
            started_at=self.state.started_at,
            deadline=self.state.deadline,
            remaining_seconds=self.state.remaining_seconds,
            closure_notified=self.state.closure_notified,
            work_end_notified=self.state.work_end_notified,
            rest_end_notified=self.state.rest_end_notified,
            last_error=self.state.last_error,
            intention_text=self.state.intention_text,
            midpoint_notified=self.state.midpoint_notified,
            review_pending=False
        )

        old_state = TimerState.from_dict(self.state.to_dict())
        state_save_attempted = False
        try:
            with self.history_mgr.transaction() as conn:
                if self.state.cycle_id:
                    self.history_mgr.save_review(self.state.cycle_id, outcome, text, now, conn=conn)
                state_save_attempted = True
                self.storage.save(new_state)
            self.state = new_state
        except Exception:
            if state_save_attempted:
                try:
                    self.storage.save(old_state)
                except Exception:
                    pass
            raise
        return self.state

    def get_next_event_time(self) -> Optional[float]:
        """Calculates the absolute wall-clock timestamp of the next expected event (midpoint or deadline).
        Returns None if the timer is not running.
        """
        if self.state.status != "running":
            return None

        deadline = self.state.deadline
        if deadline is None:
            return None

        if self.state.phase == "work":
            preset = PRESETS.get(self.state.preset)
            if preset and not self.state.midpoint_notified:
                midpoint_time = deadline - (preset.work_seconds / 2)
                now = self.time_func()
                if now < midpoint_time:
                    return midpoint_time
        return deadline

    def tick(self, now: float) -> bool:
        """Advances the state based on current timestamp. Delivers internal state transitions.
        Returns True if the state was updated and saved, False otherwise.
        """
        if self.state.status != "running":
            return False

        preset = PRESETS.get(self.state.preset)
        if not preset:
            return False

        midpoint_needed = False
        if self.state.phase == "work" and not self.state.midpoint_notified:
            midpoint_time = self.state.deadline - (preset.work_seconds / 2)
            if now >= midpoint_time and now < self.state.deadline:
                midpoint_needed = True

        temp_state = TimerState.from_dict(self.state.to_dict())
        history_actions = []

        if midpoint_needed:
            temp_state.midpoint_notified = True
            history_actions.append(("log_event", temp_state.cycle_id, "midpoint", now))

        while temp_state.status == "running" and now >= (temp_state.deadline or 0.0):
            if temp_state.phase == "work":
                temp_state.phase = "rest"
                temp_state.started_at = temp_state.deadline
                temp_state.deadline = (temp_state.started_at or now) + preset.rest_seconds
                temp_state.work_end_notified = True
                temp_state.closure_notified = False
                temp_state.review_pending = False
                history_actions.append(("update_session_work_end", temp_state.cycle_id, now))
            elif temp_state.phase == "rest":
                temp_state.status = "completed"
                temp_state.phase = "none"
                temp_state.deadline = None
                temp_state.remaining_seconds = None
                temp_state.rest_end_notified = True
                temp_state.review_pending = False
                history_actions.append(("update_session_rest_end", temp_state.cycle_id, now, "completed"))

        if not history_actions:
            return False

        old_state = TimerState.from_dict(self.state.to_dict())
        state_save_attempted = False
        try:
            with self.history_mgr.transaction() as conn:
                for action in history_actions:
                    method_name = action[0]
                    args = action[1:]
                    method = getattr(self.history_mgr, method_name)
                    method(*args, conn=conn)
                state_save_attempted = True
                self.storage.save(temp_state)
            self.state = temp_state
        except Exception:
            if state_save_attempted:
                try:
                    self.storage.save(old_state)
                except Exception:
                    pass
            raise
        return True
