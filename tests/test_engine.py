import unittest
import os
import tempfile
from src.ultradian_rhythm.models import TimerState, PRESETS
from src.ultradian_rhythm.storage import Storage
from src.ultradian_rhythm.notifier import FakeNotifier
from src.ultradian_rhythm.engine import TimerEngine

class TestTimerEngine(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.state_path = os.path.join(self.temp_dir.name, "state.json")
        self.storage = Storage(self.state_path)
        self.notifier = FakeNotifier()
        self.current_time = 1000.0
        self.engine = TimerEngine(self.storage, self.notifier, time_func=self.get_time)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def get_time(self) -> float:
        return self.current_time

    def test_default_state(self) -> None:
        self.assertEqual(self.engine.state.status, "idle")
        self.assertEqual(self.engine.state.phase, "none")

    def test_start_flow_cycle(self) -> None:
        state = self.engine.start_cycle("flow", intention_text="Write tests")
        self.assertEqual(state.status, "running")
        self.assertEqual(state.phase, "work")
        self.assertEqual(state.preset, "flow")
        self.assertEqual(state.deadline, 1000.0 + 3000)
        self.assertEqual(state.started_at, 1000.0)

        # Check that file was persisted and matches memory
        loaded = self.storage.load()
        self.assertEqual(loaded.cycle_id, state.cycle_id)
        self.assertEqual(loaded.status, "running")

    def test_state_file_and_directory_are_private(self) -> None:
        self.state_path = os.path.join(self.temp_dir.name, "private", "state.json")
        self.storage = Storage(self.state_path)
        self.engine = TimerEngine(self.storage, self.notifier, time_func=self.get_time)
        self.engine.start_cycle("flow", intention_text="Private goal")
        self.assertEqual(os.stat(os.path.dirname(self.state_path)).st_mode & 0o777, 0o700)
        self.assertEqual(os.stat(self.state_path).st_mode & 0o777, 0o600)

    def test_conflict_on_start(self) -> None:
        self.engine.start_cycle("flow", intention_text="Write code")
        with self.assertRaises(ValueError):
            self.engine.start_cycle("start", intention_text="Another code")  # conflict without replace=True

        # Should work with replace=True
        state = self.engine.start_cycle("start", replace=True, intention_text="Another code")
        self.assertEqual(state.preset, "start")

    def test_midpoint_and_transitions(self) -> None:
        # Start flow: work 3000s, rest 600s
        self.engine.start_cycle("flow", intention_text="Complete the first draft")

        # Next event time should be midpoint time = 1000.0 + 1500.0 = 2500.0
        self.assertEqual(self.engine.get_next_event_time(), 2500.0)

        # Tick at 2499 -> nothing happens
        self.current_time = 2499.0
        changed = self.engine.tick(self.current_time)
        self.assertFalse(changed)
        self.assertEqual(len(self.notifier.notifications), 0)

        # Tick at 2500 -> midpoint notified
        self.current_time = 2500.0
        changed = self.engine.tick(self.current_time)
        self.assertTrue(changed)
        self.assertTrue(self.engine.state.midpoint_notified)

        # Get next event time should now be the deadline: 4000.0
        self.assertEqual(self.engine.get_next_event_time(), 4000.0)

        # Tick at 3999 -> nothing happens
        self.current_time = 3999.0
        changed = self.engine.tick(self.current_time)
        self.assertFalse(changed)

        # Tick at 4000 -> transition to rest
        self.current_time = 4000.0
        changed = self.engine.tick(self.current_time)
        self.assertTrue(changed)
        self.assertEqual(self.engine.state.phase, "rest")
        self.assertFalse(self.engine.state.review_pending)
        self.assertEqual(self.engine.state.deadline, 4000.0 + 600.0)
        self.assertEqual(len(self.notifier.notifications), 0)  # No notifications sent

        # Get next event time should be rest deadline: 4600.0
        self.assertEqual(self.engine.get_next_event_time(), 4600.0)

        # Tick at 4600 -> transition to completed
        self.current_time = 4600.0
        changed = self.engine.tick(self.current_time)
        self.assertTrue(changed)
        self.assertEqual(self.engine.state.status, "completed")
        self.assertEqual(self.engine.state.phase, "none")
        self.assertFalse(self.engine.state.review_pending)
        self.assertEqual(len(self.notifier.notifications), 0)  # No notifications sent
        self.assertIsNone(self.engine.get_next_event_time())

    def test_pause_and_resume(self) -> None:
        self.engine.start_cycle("flow", intention_text="Rest pause")
        # 10s elapsed
        self.current_time = 1010.0

        # Pause
        self.engine.pause_cycle()
        self.assertEqual(self.engine.state.status, "paused")
        self.assertEqual(self.engine.state.remaining_seconds, 2990.0)
        self.assertIsNone(self.engine.state.deadline)

        # Wait some mock time in paused state
        self.current_time = 2000.0

        # Resume
        self.engine.resume_cycle()
        self.assertEqual(self.engine.state.status, "running")
        self.assertEqual(self.engine.state.deadline, 2000.0 + 2990.0)
        self.assertIsNone(self.engine.state.remaining_seconds)

    def test_stop(self) -> None:
        self.engine.start_cycle("flow", intention_text="Stopping task")
        cycle_id = self.engine.state.cycle_id
        self.engine.stop_cycle()
        self.assertEqual(self.engine.state.status, "completed")
        self.assertEqual(self.engine.state.phase, "none")
        self.assertEqual(self.engine.state.cycle_id, cycle_id)
        self.assertFalse(self.engine.state.review_pending)

    def test_repeat(self) -> None:
        self.engine.start_cycle("start", intention_text="Initial task")
        self.current_time = 1000 + 1500 + 300  # complete the cycle (1800s total)
        self.engine.tick(self.current_time)
        self.assertEqual(self.engine.state.status, "completed")

        # Repeat directly without mandatory review lock
        self.engine.repeat_cycle()
        self.assertEqual(self.engine.state.status, "running")
        self.assertEqual(self.engine.state.preset, "start")

    def test_repeat_requires_saved_goal(self) -> None:
        self.engine.state.intention_text = " \n "
        with self.assertRaisesRegex(ValueError, "without a saved goal"):
            self.engine.repeat_cycle()

    def test_v2_backward_compatibility(self) -> None:
        v1_data = {
            "schema_version": 1,
            "cycle_id": "v1-cycle",
            "preset": "flow",
            "status": "running",
            "phase": "work",
            "started_at": 1000.0,
            "deadline": 4000.0,
            "closure_notified": False,
            "work_end_notified": False,
            "rest_end_notified": False
        }
        state = TimerState.from_dict(v1_data)
        # Should upgrade to version 2 in memory and load defaults
        self.assertEqual(state.schema_version, 2)
        self.assertIsNone(state.intention_text)
        self.assertFalse(state.midpoint_notified)
        self.assertFalse(state.review_pending)

    def test_start_intention_validation(self) -> None:
        with self.assertRaises(ValueError):
            self.engine.start_cycle("flow", intention_text="")
        with self.assertRaises(ValueError):
            self.engine.start_cycle("flow", intention_text="   ")
        with self.assertRaises(ValueError):
            self.engine.start_cycle("flow", intention_text="\n")

        state = self.engine.start_cycle("flow", intention_text="  Read documentation  ")
        self.assertEqual(state.intention_text, "Read documentation")
        self.assertEqual(state.schema_version, 2)

    def test_midpoint_exact(self) -> None:
        # Start a flow cycle (3000s work, 600s rest) at time 1000.0
        # Midpoint is at 1000.0 + 1500.0 = 2500.0
        self.engine.start_cycle("flow", intention_text="Write tests")
        self.assertEqual(self.engine.get_next_event_time(), 2500.0)

        # Tick at 2499.0 -> no midpoint
        self.current_time = 2499.0
        self.assertFalse(self.engine.tick(self.current_time))
        self.assertFalse(self.engine.state.midpoint_notified)

        # Tick at 2500.0 -> midpoint notified
        self.current_time = 2500.0
        self.assertTrue(self.engine.tick(self.current_time))
        self.assertTrue(self.engine.state.midpoint_notified)

        # Next event time is work end: 4000.0
        self.assertEqual(self.engine.get_next_event_time(), 4000.0)

    def test_no_review_blocking_and_lifecycle(self) -> None:
        self.engine.start_cycle("start", intention_text="Quick task")

        # Complete work phase (1500s) -> enters rest, review_pending remains False
        self.current_time = 1000.0 + 1500.0
        self.engine.tick(self.current_time)
        self.assertEqual(self.engine.state.phase, "rest")
        self.assertFalse(self.engine.state.review_pending)

        # Complete rest phase (300s) -> status completed, review_pending remains False
        self.current_time = 1000.0 + 1500.0 + 300.0
        self.engine.tick(self.current_time)
        self.assertEqual(self.engine.state.status, "completed")
        self.assertFalse(self.engine.state.review_pending)

        # Starting new cycle or repeating is completely unblocked
        self.engine.start_cycle("flow", intention_text="Unblocked task")
        self.assertEqual(self.engine.state.status, "running")

    def test_repeated_tick_idempotency(self) -> None:
        self.engine.start_cycle("flow", intention_text="Idempotency test")

        # Tick at 2500 -> midpoint notified
        self.current_time = 2500.0
        self.assertTrue(self.engine.tick(self.current_time))

        # Repeated tick at 2500 or 2501 -> should be False (idempotent, no changes)
        self.assertFalse(self.engine.tick(2500.0))
        self.assertFalse(self.engine.tick(2501.0))

    def test_midpoint_recalculation_after_pause_resume(self) -> None:
        # Start flow: work 3000s, rest 600s. Started at 1000.0, initial midpoint is 2500.0
        self.engine.start_cycle("flow", intention_text="Recalc test")

        self.current_time = 1500.0  # Worked 500s, 2500s remaining.
        self.engine.pause_cycle()

        self.current_time = 2000.0
        self.engine.resume_cycle()  # Resumed at 2000.0. New deadline = 2000 + 2500 = 4500.0
        # New absolute midpoint = 4500 - (3000 / 2) = 3000.0
        self.assertEqual(self.engine.get_next_event_time(), 3000.0)

        self.current_time = 2999.0
        self.assertFalse(self.engine.tick(self.current_time))
        self.assertFalse(self.engine.state.midpoint_notified)

        self.current_time = 3000.0
        self.assertTrue(self.engine.tick(self.current_time))
        self.assertTrue(self.engine.state.midpoint_notified)

    def test_sleeping_past_midpoint_but_before_deadline(self) -> None:
        self.engine.start_cycle("flow", intention_text="Sleep midpoint")
        # Started at 1000, midpoint at 2500, deadline at 4000
        # Sleep until 3500. Active work interval is still active (3500 < 4000).
        self.current_time = 3500.0
        self.assertTrue(self.engine.tick(self.current_time))
        self.assertTrue(self.engine.state.midpoint_notified)
        self.assertEqual(self.engine.state.phase, "work")

    def test_sleeping_past_work_deadline(self) -> None:
        self.engine.start_cycle("flow", intention_text="Sleep deadline")
        # Started at 1000, midpoint 2500, work deadline 4000, rest deadline 4600.
        # Sleep until 4200. This is past work deadline (4000) but before rest deadline (4600).
        # It must transition directly to rest without notifying midpoint.
        self.current_time = 4200.0
        self.assertTrue(self.engine.tick(self.current_time))
        self.assertEqual(self.engine.state.phase, "rest")
        self.assertFalse(self.engine.state.midpoint_notified)

    def test_stop_idle_remains_idle(self) -> None:
        self.assertEqual(self.engine.state.status, "idle")
        self.assertEqual(self.engine.state.phase, "none")
        self.engine.stop_cycle()
        self.assertEqual(self.engine.state.status, "idle")
        self.assertFalse(self.engine.state.review_pending)

    def test_stop_during_rest(self) -> None:
        self.engine.start_cycle("flow", intention_text="Stop rest test")

        # Go to rest phase
        self.current_time = 4000.0
        self.engine.tick(self.current_time)
        self.assertEqual(self.engine.state.phase, "rest")
        self.assertFalse(self.engine.state.review_pending)

        # Stop cycle while in rest
        self.engine.stop_cycle()
        self.assertEqual(self.engine.state.status, "completed")
        self.assertFalse(self.engine.state.review_pending)
