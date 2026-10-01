# Contract: CLI Command Interface (codex-pet-companion)

**Binary**: `codex-pet-companion`
**Version**: 1.0
**Platform**: macOS (primary)

---

## Commands

### `codex-pet-companion validate-pet <path>`

Offline validation of a pet package directory.

| Aspect | Specification |
|--------|---------------|
| **Arguments** | `<path>`: absolute or relative path to a pet package directory |
| **Exit code 0** | Package is valid: `pet.json` parses correctly (id, displayName, description, spritesheetPath), atlas image exists with width 1536, height divisible by 208 and ≥1872, columns=8 and rows≥9 derived, optional `companion.json` passes schema and path security validation |
| **Exit code 1** | Package is invalid: stdout contains structured error report with specific failure reasons |
| **stdout** | JSON: `{"valid": true, "pet": "<id>", "atlasRows": <n>, "companionJson": true|false}` on success; `{"valid": false, "errors": [...]}` on failure |
| **Network** | None |
| **Disk writes** | None |

### `codex-pet-companion preview --pet <id> --state enter|rest|exit`

Standalone preview window for a specific animation state.

| Aspect | Specification |
|--------|---------------|
| **Flags** | `--pet <id>`: pet identifier (loads from `~/.codex/pets/<id>/`); `--state enter|rest|exit`: which clip to preview |
| **Behavior** | Opens a standalone transparent AppKit window showing the requested animation clip. If pet anchor is not found via CGWindowList, enters draggable preview mode. Window closes on Ctrl+C / SIGTERM. |
| **Exit code 0** | Normal termination |
| **Exit code 1** | Pet not found or assets invalid |
| **Network** | None |

### `codex-pet-companion start`

Idempotently load and start the user-level supervisor LaunchAgent.

| Aspect | Specification |
|--------|---------------|
| **Behavior** | Loads the single LaunchAgent if necessary and kickstarts the supervisor. macOS owns its login-session lifetime. The timer daemon runs independently; the pet worker starts only while a supported Codex/ChatGPT app is running. |
| **Prerequisites** | macOS must allow the background item; the installed runtime manifest and binaries must be intact. |
| **Exit code 0** | Service is loaded or has been started. |
| **Exit code 1** | macOS has disallowed the background item or launchd rejected the service. |
| **Idempotency** | An already-running LaunchAgent is left untouched. |

### `codex-pet-companion stop`

Unload the supervisor LaunchAgent and stop its timer and companion child processes for the current login session.

| Aspect | Specification |
|--------|---------------|
| **Behavior** | Uses `launchctl bootout` on the exact user LaunchAgent label. The timer state remains persisted; no PID-name matching or broad process kill is used. |
| **Exit code 0** | Service stopped or was not loaded |
| **Idempotency** | Safe to call multiple times. |

### `codex-pet-companion status`

Query engine status.

| Aspect | Specification |
|--------|---------------|
| **stdout** | Human-readable status summary by default. With `--json` flag: JSON object per data-model §6. |
| **Exit code 0** | Status retrieved (engine may be running or stopped) |

### `codex-pet-companion doctor --json`

Read-only diagnostics for launchd/background permission, supervisor and timer state, Codex app state, pet status, and installed runtime hashes. A disallowed macOS background item is reported with the Settings path; no system permission database is changed.

### `codex-pet-companion repair`

After a cause is resolved, performs a bounded restart of the supervisor LaunchAgent. It does not bypass macOS background-item permissions or delete timer/session data.

### `codex-pet-companion config set pet auto|<id>`

Override the active pet binding.

| Aspect | Specification |
|--------|---------------|
| **`auto`** | Restore default behavior: read `selected-avatar-id` on next start. |
| **`<id>`** | Force engine to use specific pet ID, overriding auto-detection. Persisted to `~/.codex/ultradian-rhythm/companion-config.json`. |
| **Exit code 0** | Configuration updated |
| **Exit code 1** | Invalid pet ID (not found in `~/.codex/pets/`) |

---

## Common Rules

1. No command establishes network connections.
2. Built-in pet resolution may read one matching atlas entry from an installed Codex or ChatGPT app ASAR. It never writes to or modifies the app.
3. All commands exit with non-zero on unrecoverable errors and print diagnostics to stderr.
4. All commands are safe to run while the existing `ultradian` timer is active — they do not modify timer state or daemon behavior.
