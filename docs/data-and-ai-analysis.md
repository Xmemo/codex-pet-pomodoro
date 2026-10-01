# Local Data and User-Directed AI Analysis

Pet Pomodoro records session history locally so users can inspect their own work/rest patterns or provide an export to an AI assistant of their choice. The application itself does not call an AI model.

## Storage

- Database: `~/.codex/ultradian-rhythm/sessions.sqlite`
- Current state: `~/.codex/ultradian-rhythm/state.json`
- Network sync: none
- Telemetry: none

The `sessions` table stores the selected preset, goal, planned durations, start/end timestamps, and terminal status. The schema retains review columns for compatibility with earlier development work, but the simplified v0.1.0 panel does not collect reviews. The `session_events` table stores semantic events such as start, pause, resume, midpoint, work end, rest end, stop, and replace.

The timer writes on semantic events. It does not append a database row every second.

## Window tracking and positioning

The companion uses visible-window metadata and geometry to position the timer beside a supported Codex pet. It does not request Screen Recording, Screen & System Audio Recording, or Accessibility permissions; it does not capture window pixels or audio. In voice mode it estimates the pet position from the host window geometry, so the estimate can drift if the host layout changes. If no supported window is available, the companion hides the timer rather than guessing an unrelated screen position. The app does not upload screen content, session data, or telemetry.

## Export

```bash
ultradian history --limit 50 --json > pet-pomodoro-history.json
```

The command uses the timer daemon's read-only history path and returns up to 200 recent sessions. Review the file before sharing it: goals and review text may contain private project information.

## Suggested Analysis Prompt

```text
Analyze the attached Pet Pomodoro history as a personal work-pattern log.

Separate observations from hypotheses. Report:
1. session count and completion rate by 25/50/90-minute preset;
2. common pause, stop, switch, and incomplete patterns;
3. time-of-day patterns, long gaps between recorded sessions, and possible missing-timer periods;
4. whether the written goals match the selected cycle length;
5. two small experiments for the next week.

Do not diagnose health or attention conditions. Do not assume unrecorded time was unproductive. State data quality limitations and ask for the user's normal working hours before interpreting long gaps.
```

## Delete

The normal uninstaller preserves state. To remove timer state and history:

```bash
./scripts/uninstall.sh --purge-state
```

Back up the SQLite file first if you want to retain your records.
