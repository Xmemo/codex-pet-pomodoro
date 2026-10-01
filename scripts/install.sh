#!/bin/zsh
set -e
umask 077

TIMER_LABEL="io.github.codex-ultradian-rhythm"
COMPANION_LABEL="io.github.codex-pet-companion"
INSTALL_DIR="$HOME/.local/share/codex-ultradian-rhythm"
RUNTIME_DIR="$INSTALL_DIR/runtime"
STATE_DIR="$HOME/.codex/ultradian-rhythm"
SIGNING_IDENTITY_PATH="$STATE_DIR/code-signing-identity"
BIN_DIR="$HOME/.local/bin"
SKILL_DIR="$HOME/.codex/skills/ultradian-rhythm"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
TIMER_PLIST="$LAUNCH_AGENTS_DIR/$TIMER_LABEL.plist"
COMPANION_PLIST="$LAUNCH_AGENTS_DIR/$COMPANION_LABEL.plist"

SCRIPT_DIR="${0:A:h}"
REPO_ROOT="${SCRIPT_DIR:h}"

LAUNCHCTL_BIN="${LAUNCHCTL_BIN:-/bin/launchctl}"
PYTHON_BIN="${PYTHON_BIN:-}"
NODE_BIN="${NODE_BIN:-}"
XCRUN_BIN="${XCRUN_BIN:-/usr/bin/xcrun}"
PLUTIL_BIN="${PLUTIL_BIN:-/usr/bin/plutil}"
VERIFY_ATTEMPTS="${VERIFY_ATTEMPTS:-200}"
VERIFY_DELAY="${VERIFY_DELAY:-0.2}"

resolve_system_home() {
    local username
    username="$(/usr/bin/id -un)"
    /usr/bin/dscl . -read "/Users/$username" NFSHomeDirectory 2>/dev/null | /usr/bin/awk '{print $2}'
}

REAL_HOME="${CODEX_INSTALL_REAL_HOME:-$(resolve_system_home)}"
if [ -z "$REAL_HOME" ]; then
    echo "Error: unable to determine the current UID system home." >&2
    exit 1
fi
if [ "$HOME" != "$REAL_HOME" ] && [ "${ALLOW_NONSTANDARD_HOME:-0}" != "1" ]; then
    echo "Error: HOME ($HOME) does not match the current UID system home ($REAL_HOME)." >&2
    exit 1
fi

case "$VERIFY_ATTEMPTS" in
    ''|*[!0-9]*|0) echo "Error: VERIFY_ATTEMPTS must be a positive integer." >&2; exit 1 ;;
esac
if [[ "$VERIFY_DELAY" != <-> && "$VERIFY_DELAY" != <->.<-> ]]; then
    echo "Error: VERIFY_DELAY must be a non-negative number." >&2
    exit 1
fi

if [ -z "$NODE_BIN" ]; then
    NODE_BIN="$(command -v node 2>/dev/null || true)"
fi
if [ -z "$PYTHON_BIN" ]; then
    UV_BIN="${UV_BIN:-$HOME/.local/bin/uv}"
    if [ -x "$UV_BIN" ]; then
        PYTHON_BIN="$("$UV_BIN" python find --managed-python 3.12 2>/dev/null || true)"
    fi
fi
if [ -z "$PYTHON_BIN" ]; then
    PYTHON_BIN="$(command -v python3.12 2>/dev/null || command -v python3.11 2>/dev/null || command -v python3 2>/dev/null || true)"
fi

require_executable() {
    local name="$1"
    local value="$2"
    if [ -z "$value" ] || [ ! -x "$value" ]; then
        echo "Error: $name must be an executable absolute path: $value" >&2
        exit 1
    fi
    case "$value" in
        /*) ;;
        *) echo "Error: $name must be absolute: $value" >&2; exit 1 ;;
    esac
}

require_executable LAUNCHCTL_BIN "$LAUNCHCTL_BIN"
require_executable PYTHON_BIN "$PYTHON_BIN"
require_executable NODE_BIN "$NODE_BIN"
require_executable XCRUN_BIN "$XCRUN_BIN"
require_executable PLUTIL_BIN "$PLUTIL_BIN"

NODE_REAL="${NODE_BIN:A}"
PYTHON_REAL="${PYTHON_BIN:A}"
case "$NODE_REAL" in
    /Applications/*.app/Contents/*|*/Applications/*.app/Contents/*)
        echo "Error: NODE_BIN cannot come from an application's private bundle. Install Node independently." >&2
        exit 1 ;;
esac
case "$PYTHON_REAL" in
    /Applications/*.app/Contents/*|*/Applications/*.app/Contents/*)
        echo "Error: PYTHON_BIN cannot come from an application's private bundle." >&2
        exit 1 ;;
esac
if ! NODE_VERSION_OUTPUT="$("$NODE_REAL" --version 2>&1)" || ! [[ "$NODE_VERSION_OUTPUT" =~ ^v(20|22|24)\. ]]; then
    echo "Error: NODE_BIN must be Node.js 20, 22, or 24: $NODE_VERSION_OUTPUT" >&2
    exit 1
fi
if [ "${CODEX_INSTALL_TEST_MODE:-0}" != "1" ] && ! /usr/bin/codesign --verify --strict "$NODE_REAL" >/dev/null 2>&1; then
    echo "Error: NODE_BIN must have a valid code signature. Use the official signed Node.js distribution." >&2
    exit 1
fi
if [ "${CODEX_INSTALL_TEST_MODE:-0}" != "1" ]; then
    NODE_TEAM="$(/usr/bin/codesign -dv --verbose=4 "$NODE_REAL" 2>&1 | /usr/bin/awk -F= '/^TeamIdentifier=/{print $2}')"
    if [ "$NODE_TEAM" != "HX7739G8FX" ]; then
        echo "Error: NODE_BIN must be signed by the official Node.js Foundation (Team ID HX7739G8FX); found '${NODE_TEAM:-none}'." >&2
        exit 1
    fi
    case "$PYTHON_REAL" in
        "$HOME"/.local/share/uv/python/*/bin/python*|/Library/Frameworks/Python.framework/Versions/*/bin/python*|/opt/homebrew/Cellar/python@3.*/*/bin/python*|/usr/local/Cellar/python@3.*/*/bin/python*) ;;
        *)
            echo "Error: use a Python managed by uv, python.org, or Homebrew; refusing an unverified interpreter source: $PYTHON_REAL" >&2
            exit 1 ;;
    esac
fi

if ! PYTHON_VERSION_OUTPUT="$("$PYTHON_BIN" -V 2>&1)" || [ -z "$PYTHON_VERSION_OUTPUT" ]; then
    echo "Error: PYTHON_BIN must be Python 3.11 or newer: failed to obtain version from $PYTHON_BIN" >&2
    exit 1
fi
if [[ "$PYTHON_VERSION_OUTPUT" =~ ^[[:space:]]*(Python[[:space:]]+)?([0-9]+)\.([0-9]+) ]]; then
    python_major="${match[2]}"
    python_minor="${match[3]}"
    if ! (( python_major > 3 || (python_major == 3 && python_minor >= 11) )); then
        echo "Error: PYTHON_BIN must be Python 3.11 or newer (found Python $python_major.$python_minor at $PYTHON_BIN)." >&2
        exit 1
    fi
else
    echo "Error: PYTHON_BIN must be Python 3.11 or newer: unable to parse version output from $PYTHON_BIN ($PYTHON_VERSION_OUTPUT)." >&2
    exit 1
fi

LEGACY_CONFIGURED=0
if [ -n "${LEGACY_TIMER_LABEL:-}" ] || [ -n "${LEGACY_TIMER_PLIST:-}" ]; then
    if [ -z "${LEGACY_TIMER_LABEL:-}" ] || [ -z "${LEGACY_TIMER_PLIST:-}" ]; then
        echo "Error: LEGACY_TIMER_LABEL and LEGACY_TIMER_PLIST must be provided together." >&2
        exit 1
    fi
    case "$LEGACY_TIMER_LABEL" in
        *[!A-Za-z0-9._-]*) echo "Error: LEGACY_TIMER_LABEL contains unsafe characters." >&2; exit 1 ;;
    esac
    if [ ! -f "$LEGACY_TIMER_PLIST" ] || [ -L "$LEGACY_TIMER_PLIST" ]; then
        echo "Error: LEGACY_TIMER_PLIST must be a regular, non-symlink plist file." >&2
        exit 1
    fi
    case "$LEGACY_TIMER_PLIST" in
        *.plist) ;;
        *) echo "Error: LEGACY_TIMER_PLIST must end in .plist." >&2; exit 1 ;;
    esac
    LEGACY_TIMER_PLIST="${LEGACY_TIMER_PLIST:A}"
    LEGACY_PARENT="$(/usr/bin/dirname "$LEGACY_TIMER_PLIST")"
    LAUNCH_AGENTS_REAL="${LAUNCH_AGENTS_DIR:A}"
    if [ "$LEGACY_PARENT" != "$LAUNCH_AGENTS_REAL" ]; then
        echo "Error: LEGACY_TIMER_PLIST must be directly inside $LAUNCH_AGENTS_DIR." >&2
        exit 1
    fi
    LEGACY_CONFIGURED=1
fi

LEGACY_OVERLAY_CONFIGURED=0
if [ -n "${LEGACY_OVERLAY_LABEL:-}" ] || [ -n "${LEGACY_OVERLAY_PLIST:-}" ] || [ -n "${LEGACY_OVERLAY_PAYLOAD:-}" ]; then
    if [ -z "${LEGACY_OVERLAY_LABEL:-}" ] || [ -z "${LEGACY_OVERLAY_PLIST:-}" ]; then
        echo "Error: LEGACY_OVERLAY_LABEL and LEGACY_OVERLAY_PLIST must be provided together." >&2
        exit 1
    fi
    case "$LEGACY_OVERLAY_LABEL" in
        *[!A-Za-z0-9._-]*) echo "Error: LEGACY_OVERLAY_LABEL contains unsafe characters." >&2; exit 1 ;;
    esac
    if [ ! -f "$LEGACY_OVERLAY_PLIST" ] || [ -L "$LEGACY_OVERLAY_PLIST" ]; then
        echo "Error: LEGACY_OVERLAY_PLIST must be a regular, non-symlink plist file." >&2
        exit 1
    fi
    case "$LEGACY_OVERLAY_PLIST" in
        *.plist) ;;
        *) echo "Error: LEGACY_OVERLAY_PLIST must end in .plist." >&2; exit 1 ;;
    esac
    LEGACY_OVERLAY_PLIST="${LEGACY_OVERLAY_PLIST:A}"
    LEGACY_OVERLAY_PARENT="$(/usr/bin/dirname "$LEGACY_OVERLAY_PLIST")"
    LAUNCH_AGENTS_REAL="${LAUNCH_AGENTS_DIR:A}"
    if [ "$LEGACY_OVERLAY_PARENT" != "$LAUNCH_AGENTS_REAL" ]; then
        echo "Error: LEGACY_OVERLAY_PLIST must be directly inside $LAUNCH_AGENTS_DIR." >&2
        exit 1
    fi
    if [ -n "${LEGACY_OVERLAY_PAYLOAD:-}" ]; then
        if [ -L "$LEGACY_OVERLAY_PAYLOAD" ]; then
            echo "Error: LEGACY_OVERLAY_PAYLOAD must not be a symlink." >&2
            exit 1
        fi
        LEGACY_OVERLAY_PAYLOAD="${LEGACY_OVERLAY_PAYLOAD:A}"
        legacy_overlay_share_canon="$HOME/.local/share"
        legacy_overlay_share_canon="${legacy_overlay_share_canon:A}"
        case "$LEGACY_OVERLAY_PAYLOAD" in
            "$legacy_overlay_share_canon/"*) ;;
            *) echo "Error: LEGACY_OVERLAY_PAYLOAD must be under ~/.local/share." >&2; exit 1 ;;
        esac
        if [ ! -d "$LEGACY_OVERLAY_PAYLOAD" ]; then
            echo "Error: LEGACY_OVERLAY_PAYLOAD does not exist or is not a directory." >&2
            exit 1
        fi
    fi
    LEGACY_OVERLAY_CONFIGURED=1
fi

STAGE_DIR="$INSTALL_DIR/.stage.$$"
BACKUP_DIR="$INSTALL_DIR/.backup.$$"
PAYLOAD_TRANSACTION_ACTIVE=0
NEW_SRC_ACTIVE=0
NEW_BIN_ACTIVE=0
NEW_RUNTIME_ACTIVE=0
OLD_SRC_BACKED_UP=0
OLD_BIN_BACKED_UP=0
OLD_RUNTIME_BACKED_UP=0
OLD_COMPANION_WAS_LOADED=0
OLD_TIMER_WAS_LOADED=0
NEW_ULTRADIAN_WRAPPER_ACTIVE=0
NEW_COMPANION_WRAPPER_ACTIVE=0
NEW_SKILL_ACTIVE=0
NEW_MANIFEST_ACTIVE=0
NEW_COMPANION_PLIST_ACTIVE=0
RUNTIME_BIN_NAME="node"
PYTHON_BIN_NAME="${PYTHON_REAL:t}"
PYTHON_HOME="${PYTHON_REAL:h:h}"
PYTHON_RUNTIME_BIN="$RUNTIME_DIR/python/bin/$PYTHON_BIN_NAME"
NODE_RUNTIME_BIN="$RUNTIME_DIR/bin/$RUNTIME_BIN_NAME"

remove_transaction_path() {
    local target="$1"
    case "$target" in
        "$STAGE_DIR"|"$BACKUP_DIR"|"$INSTALL_DIR/src"|"$INSTALL_DIR/bin"|"$INSTALL_DIR/runtime") ;;
        *) echo "Error: unauthorized transaction cleanup: $target" >&2; return 1 ;;
    esac
    if [ -d "$target" ]; then
        /bin/rm -r "$target"
    elif [ -e "$target" ] || [ -L "$target" ]; then
        /bin/rm "$target"
    fi
}

remove_managed_file() {
    local target="$1"
    case "$target" in
        "$BIN_DIR/ultradian"|"$BIN_DIR/codex-pet-companion"|"$COMPANION_PLIST"|"$TIMER_PLIST"|"$INSTALL_DIR/runtime-manifest.json") ;;
        *) echo "Error: unauthorized managed-file cleanup: $target" >&2; return 1 ;;
    esac
    if [ -e "$target" ] || [ -L "$target" ]; then /bin/rm "$target"; fi
}

remove_managed_dir() {
    local target="$1"
    case "$target" in
        "$SKILL_DIR") ;;
        *) echo "Error: unauthorized managed-directory cleanup: $target" >&2; return 1 ;;
    esac
    if [ -d "$target" ]; then /bin/rm -r "$target"; elif [ -e "$target" ] || [ -L "$target" ]; then /bin/rm "$target"; fi
}

cleanup_install() {
    local exit_code="$1"
    local restore_failed=0
    trap - EXIT

    if [ "$PAYLOAD_TRANSACTION_ACTIVE" -eq 1 ]; then
        launch_bootout_plist "$COMPANION_PLIST"
        if [ "$NEW_SRC_ACTIVE" -eq 1 ]; then
            remove_transaction_path "$INSTALL_DIR/src" >/dev/null 2>&1 || restore_failed=1
        fi
        if [ "$NEW_BIN_ACTIVE" -eq 1 ]; then
            remove_transaction_path "$INSTALL_DIR/bin" >/dev/null 2>&1 || restore_failed=1
        fi
        if [ "$NEW_RUNTIME_ACTIVE" -eq 1 ]; then
            remove_transaction_path "$INSTALL_DIR/runtime" >/dev/null 2>&1 || restore_failed=1
        fi
        if [ "$OLD_SRC_BACKED_UP" -eq 1 ] && [ -e "$BACKUP_DIR/src" ]; then
            /bin/mv "$BACKUP_DIR/src" "$INSTALL_DIR/src" >/dev/null 2>&1 || restore_failed=1
        fi
        if [ "$OLD_BIN_BACKED_UP" -eq 1 ] && [ -e "$BACKUP_DIR/bin" ]; then
            /bin/mv "$BACKUP_DIR/bin" "$INSTALL_DIR/bin" >/dev/null 2>&1 || restore_failed=1
        fi
        if [ "$OLD_RUNTIME_BACKED_UP" -eq 1 ] && [ -e "$BACKUP_DIR/runtime" ]; then
            /bin/mv "$BACKUP_DIR/runtime" "$INSTALL_DIR/runtime" >/dev/null 2>&1 || restore_failed=1
        fi
        if [ "$NEW_ULTRADIAN_WRAPPER_ACTIVE" -eq 1 ]; then remove_managed_file "$BIN_DIR/ultradian" >/dev/null 2>&1 || restore_failed=1; fi
        if [ "$NEW_COMPANION_WRAPPER_ACTIVE" -eq 1 ]; then remove_managed_file "$BIN_DIR/codex-pet-companion" >/dev/null 2>&1 || restore_failed=1; fi
        if [ "$NEW_MANIFEST_ACTIVE" -eq 1 ]; then remove_managed_file "$INSTALL_DIR/runtime-manifest.json" >/dev/null 2>&1 || restore_failed=1; fi
        if [ "$NEW_COMPANION_PLIST_ACTIVE" -eq 1 ]; then remove_managed_file "$COMPANION_PLIST" >/dev/null 2>&1 || restore_failed=1; fi
        if [ "$NEW_SKILL_ACTIVE" -eq 1 ]; then remove_managed_dir "$SKILL_DIR" >/dev/null 2>&1 || restore_failed=1; fi
        for pair in \
            "ultradian-wrapper:$BIN_DIR/ultradian" \
            "companion-wrapper:$BIN_DIR/codex-pet-companion" \
            "runtime-manifest:$INSTALL_DIR/runtime-manifest.json" \
            "companion-plist:$COMPANION_PLIST" \
            "timer-plist:$TIMER_PLIST"; do
            local backup_name="${pair%%:*}"
            local target="${pair#*:}"
            if [ -e "$BACKUP_DIR/$backup_name" ]; then
                /bin/mv "$BACKUP_DIR/$backup_name" "$target" >/dev/null 2>&1 || restore_failed=1
            fi
        done
        if [ -d "$BACKUP_DIR/skill" ]; then
            /bin/mv "$BACKUP_DIR/skill" "$SKILL_DIR" >/dev/null 2>&1 || restore_failed=1
        fi
        if [ "$restore_failed" -eq 0 ] && [ "$OLD_COMPANION_WAS_LOADED" -eq 1 ] && [ -f "$COMPANION_PLIST" ]; then
            launch_bootstrap_plist "$COMPANION_PLIST" >/dev/null 2>&1 || restore_failed=1
            "$LAUNCHCTL_BIN" kickstart -k "gui/$UID/$COMPANION_LABEL" >/dev/null 2>&1 || restore_failed=1
        fi
        if [ "$restore_failed" -eq 0 ] && [ "$OLD_TIMER_WAS_LOADED" -eq 1 ] && [ -f "$TIMER_PLIST" ]; then
            launch_bootstrap_plist "$TIMER_PLIST" >/dev/null 2>&1 || restore_failed=1
            "$LAUNCHCTL_BIN" kickstart -k "gui/$UID/$TIMER_LABEL" >/dev/null 2>&1 || restore_failed=1
        fi
        if [ "$restore_failed" -eq 0 ] && [ "$LEGACY_CONFIGURED" -eq 1 ] && [ -f "$LEGACY_TIMER_PLIST" ]; then
            "$LAUNCHCTL_BIN" bootstrap "gui/$UID" "$LEGACY_TIMER_PLIST" >/dev/null 2>&1 || true
            "$LAUNCHCTL_BIN" kickstart -k "gui/$UID/$LEGACY_TIMER_LABEL" >/dev/null 2>&1 || true
        fi
    fi

    remove_transaction_path "$STAGE_DIR" >/dev/null 2>&1 || true
    if [ "$restore_failed" -eq 0 ]; then
        remove_transaction_path "$BACKUP_DIR" >/dev/null 2>&1 || true
    else
        echo "Error: payload restoration was incomplete; preserved backup at $BACKUP_DIR." >&2
    fi
    exit "$exit_code"
}
trap 'cleanup_install $?' EXIT

safe_rm_file() {
    local target="$1"
    case "$target" in
        "$BIN_DIR/ultradian"|"$BIN_DIR/codex-pet-companion"|"$TIMER_PLIST"|"$COMPANION_PLIST"|"$INSTALL_DIR/runtime-manifest.json") ;;
        *) echo "Error: unauthorized file removal: $target" >&2; exit 1 ;;
    esac
    if [ -e "$target" ] || [ -L "$target" ]; then
        /bin/rm "$target"
    fi
}

render_plist() {
    local template="$1"
    local output="$2"
    /usr/bin/sed \
        -e "s|{{HOME}}|$HOME|g" \
        -e "s|{{INSTALL_DIR}}|$INSTALL_DIR|g" \
        -e "s|{{PYTHON_BIN_NAME}}|$PYTHON_BIN_NAME|g" \
        "$template" > "$output"
    /bin/chmod 644 "$output"
    "$PLUTIL_BIN" -lint "$output" >/dev/null
}

launch_bootout_plist() {
    local plist="$1"
    "$LAUNCHCTL_BIN" bootout "gui/$UID" "$plist" >/dev/null 2>&1 || true
}

launch_bootstrap_plist() {
    local plist="$1"
    "$LAUNCHCTL_BIN" bootstrap "gui/$UID" "$plist"
}

launch_kickstart_label() {
    local label="$1"
    "$LAUNCHCTL_BIN" kickstart -k "gui/$UID/$label"
}

verify_timer() {
    local attempt=1
    while [ "$attempt" -le "$VERIFY_ATTEMPTS" ]; do
        if "$BIN_DIR/ultradian" status --json >/dev/null 2>&1; then
            return 0
        fi
        if [ "$attempt" -lt "$VERIFY_ATTEMPTS" ] && [ "$VERIFY_DELAY" != "0" ]; then
            /bin/sleep "$VERIFY_DELAY"
        fi
        attempt=$((attempt + 1))
    done
    return 1
}

verify_companion() {
    local attempt=1
    local status_json
    local ready=0
    local supervisor_status="$STATE_DIR/supervisor-status.json"
    while [ "$attempt" -le "$VERIFY_ATTEMPTS" ]; do
        if [ -f "$supervisor_status" ] && "$NODE_RUNTIME_BIN" -e 'const fs=require("fs"); try { const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.exit(d.service === "running" && d.timer === "running" && (d.gpt !== "running" || d.companion === "running") ? 0 : 1); } catch(e) { process.exit(1); }' "$supervisor_status" >/dev/null 2>&1; then
            ready=1
            break
        fi
        if [ "$attempt" -lt "$VERIFY_ATTEMPTS" ] && [ "$VERIFY_DELAY" != "0" ]; then
            /bin/sleep "$VERIFY_DELAY"
        fi
        attempt=$((attempt + 1))
    done
    if [ "$ready" -ne 1 ]; then
        LAST_DOCTOR_STATUS="$("$BIN_DIR/codex-pet-companion" doctor --json 2>/dev/null || true)"
        return 1
    fi
    if ! verify_timer; then
        LAST_DOCTOR_STATUS="$("$BIN_DIR/codex-pet-companion" doctor --json 2>/dev/null || true)"
        return 1
    fi
    LAST_DOCTOR_STATUS="$("$BIN_DIR/codex-pet-companion" doctor --json 2>/dev/null || true)"
    echo "$LAST_DOCTOR_STATUS" | "$NODE_RUNTIME_BIN" -e 'const fs=require("fs"); try { const d=JSON.parse(fs.readFileSync(0,"utf8")); process.exit(d.ok === true ? 0 : 1); } catch(e) { process.exit(1); }' >/dev/null 2>&1
}

rollback_legacy() {
    if [ "$LEGACY_CONFIGURED" -eq 1 ] && [ -f "$LEGACY_TIMER_PLIST" ]; then
        "$LAUNCHCTL_BIN" bootstrap "gui/$UID" "$LEGACY_TIMER_PLIST" >/dev/null 2>&1 || true
        "$LAUNCHCTL_BIN" kickstart -k "gui/$UID/$LEGACY_TIMER_LABEL" >/dev/null 2>&1 || true
    fi
}

fail_timer_startup() {
    local message="$1"
    launch_bootout_plist "$TIMER_PLIST"
    rollback_legacy
    echo "Error: $message" >&2
    exit 1
}

fail_companion_startup() {
    local message="$1"
    launch_bootout_plist "$COMPANION_PLIST"
    if [ -n "$LAST_DOCTOR_STATUS" ]; then echo "$LAST_DOCTOR_STATUS" >&2; fi
    echo "Error: $message" >&2
    exit 1
}

/bin/mkdir -p "$INSTALL_DIR" "$BIN_DIR" "$SKILL_DIR" "$LAUNCH_AGENTS_DIR" "$STATE_DIR"
/bin/chmod 700 "$STATE_DIR"
remove_transaction_path "$STAGE_DIR"
remove_transaction_path "$BACKUP_DIR"
/bin/mkdir -p "$STAGE_DIR/runtime"

/bin/cp -R "$REPO_ROOT/src" "$STAGE_DIR/src"
/bin/mkdir -p "$STAGE_DIR/bin"
/bin/cp "$REPO_ROOT/bin/codex-pet-companion.js" "$STAGE_DIR/bin/codex-pet-companion.js"
/bin/chmod +x "$STAGE_DIR/bin/codex-pet-companion.js"
/bin/mkdir -p "$STAGE_DIR/skill"
/bin/cp "$REPO_ROOT/packaging/skill/SKILL.md" "$STAGE_DIR/skill/SKILL.md"
/bin/mkdir -p "$STAGE_DIR/bin/Pet Pomodoro Companion.app/Contents/MacOS"
/bin/cp "$REPO_ROOT/packaging/companion-renderer-Info.plist" "$STAGE_DIR/bin/Pet Pomodoro Companion.app/Contents/Info.plist"
"$XCRUN_BIN" swiftc -O -o "$STAGE_DIR/bin/Pet Pomodoro Companion.app/Contents/MacOS/companion_renderer" "$REPO_ROOT/src/companion_renderer.swift" "$REPO_ROOT/src/timer_panel.swift"
/bin/chmod 755 "$STAGE_DIR/bin/Pet Pomodoro Companion.app/Contents/MacOS/companion_renderer"
if [ "${CODEX_INSTALL_TEST_MODE:-0}" != "1" ]; then
    /usr/bin/codesign --force --deep --sign - "$STAGE_DIR/bin/Pet Pomodoro Companion.app"
    /usr/bin/codesign --verify --strict "$STAGE_DIR/bin/Pet Pomodoro Companion.app"
fi
"$XCRUN_BIN" swiftc -O \
    -debug-prefix-map "$REPO_ROOT=/codex-pet-companion/source" \
    -file-prefix-map "$REPO_ROOT=/codex-pet-companion/source" \
    -debug-prefix-map "$STAGE_DIR=/codex-pet-companion/build" \
    -file-prefix-map "$STAGE_DIR=/codex-pet-companion/build" \
    -o "$STAGE_DIR/bin/codex-pet-supervisor" "$REPO_ROOT/src/codex_pet_supervisor.swift"
if [ "${CODEX_INSTALL_TEST_MODE:-0}" != "1" ]; then
    /usr/bin/codesign --force --sign - "$STAGE_DIR/bin/codex-pet-supervisor"
    /usr/bin/codesign --verify --strict "$STAGE_DIR/bin/codex-pet-supervisor"
fi
/bin/mkdir -p "$STAGE_DIR/runtime/bin"
/bin/cp "$NODE_REAL" "$STAGE_DIR/runtime/bin/$RUNTIME_BIN_NAME"
/bin/chmod 755 "$STAGE_DIR/runtime/bin/$RUNTIME_BIN_NAME"
if [ -d "$PYTHON_HOME/lib" ]; then
    /bin/cp -R "$PYTHON_HOME" "$STAGE_DIR/runtime/python"
else
    /bin/mkdir -p "$STAGE_DIR/runtime/python/bin"
    /bin/cp "$PYTHON_REAL" "$STAGE_DIR/runtime/python/bin/$PYTHON_BIN_NAME"
fi
/bin/chmod 700 "$STAGE_DIR/runtime" "$STAGE_DIR/runtime/python" "$STAGE_DIR/runtime/bin"
if ! "$STAGE_DIR/runtime/bin/$RUNTIME_BIN_NAME" --version >/dev/null 2>&1 || ! "$STAGE_DIR/runtime/python/bin/$PYTHON_BIN_NAME" -V >/dev/null 2>&1; then
    echo "Error: copied runtimes failed their startup checks." >&2
    exit 1
fi
if [ "${CODEX_INSTALL_TEST_MODE:-0}" != "1" ] && ! /usr/bin/codesign --verify --strict "$STAGE_DIR/runtime/bin/$RUNTIME_BIN_NAME" >/dev/null 2>&1; then
    echo "Error: copied Node.js signature did not verify." >&2
    exit 1
fi

if "$LAUNCHCTL_BIN" print "gui/$UID/$COMPANION_LABEL" >/dev/null 2>&1; then OLD_COMPANION_WAS_LOADED=1; fi
if "$LAUNCHCTL_BIN" print "gui/$UID/$TIMER_LABEL" >/dev/null 2>&1; then OLD_TIMER_WAS_LOADED=1; fi
if [ -x "$BIN_DIR/codex-pet-companion" ]; then
    if ! "$BIN_DIR/codex-pet-companion" stop; then
        fail_companion_startup "companion stop failed."
    fi
elif [ -f "$INSTALL_DIR/bin/codex-pet-companion.js" ]; then
    "$NODE_BIN" "$INSTALL_DIR/bin/codex-pet-companion.js" stop >/dev/null 2>&1 || true
fi
launch_bootout_plist "$COMPANION_PLIST"
launch_bootout_plist "$TIMER_PLIST"

/bin/mkdir -p "$BACKUP_DIR"
PAYLOAD_TRANSACTION_ACTIVE=1
if [ -e "$INSTALL_DIR/src" ] || [ -L "$INSTALL_DIR/src" ]; then
    /bin/mv "$INSTALL_DIR/src" "$BACKUP_DIR/src"
    OLD_SRC_BACKED_UP=1
fi
if [ -e "$INSTALL_DIR/bin" ] || [ -L "$INSTALL_DIR/bin" ]; then
    /bin/mv "$INSTALL_DIR/bin" "$BACKUP_DIR/bin"
    OLD_BIN_BACKED_UP=1
fi
if [ -e "$INSTALL_DIR/runtime" ] || [ -L "$INSTALL_DIR/runtime" ]; then
    /bin/mv "$INSTALL_DIR/runtime" "$BACKUP_DIR/runtime"
    OLD_RUNTIME_BACKED_UP=1
fi
for item in \
    "$BIN_DIR/ultradian:$BACKUP_DIR/ultradian-wrapper" \
    "$BIN_DIR/codex-pet-companion:$BACKUP_DIR/companion-wrapper" \
    "$INSTALL_DIR/runtime-manifest.json:$BACKUP_DIR/runtime-manifest" \
    "$COMPANION_PLIST:$BACKUP_DIR/companion-plist" \
    "$TIMER_PLIST:$BACKUP_DIR/timer-plist"; do
    source_path="${item%%:*}"
    backup_path="${item#*:}"
    if [ -e "$source_path" ] || [ -L "$source_path" ]; then
        /bin/mv "$source_path" "$backup_path"
    fi
done
if [ -e "$SKILL_DIR" ] || [ -L "$SKILL_DIR" ]; then
    /bin/mv "$SKILL_DIR" "$BACKUP_DIR/skill"
fi
/bin/mv "$STAGE_DIR/src" "$INSTALL_DIR/src"
NEW_SRC_ACTIVE=1
/bin/mv "$STAGE_DIR/bin" "$INSTALL_DIR/bin"
NEW_BIN_ACTIVE=1
/bin/mv "$STAGE_DIR/runtime" "$INSTALL_DIR/runtime"
NEW_RUNTIME_ACTIVE=1

NEW_ULTRADIAN_WRAPPER_ACTIVE=1
/bin/cat > "$BIN_DIR/ultradian" <<EOF
#!/bin/zsh
export HOME="$HOME"
export PYTHONPATH="$INSTALL_DIR/src"
exec "$PYTHON_RUNTIME_BIN" -m ultradian_rhythm.cli "\$@"
EOF
/bin/chmod +x "$BIN_DIR/ultradian"

NEW_COMPANION_WRAPPER_ACTIVE=1
/bin/cat > "$BIN_DIR/codex-pet-companion" <<EOF
#!/bin/zsh
export HOME="$HOME"
export CODEX_PET_INSTALL_DIR="$INSTALL_DIR"
exec "$RUNTIME_DIR/bin/$RUNTIME_BIN_NAME" "$INSTALL_DIR/bin/codex-pet-companion.js" "\$@"
EOF
/bin/chmod +x "$BIN_DIR/codex-pet-companion"

NEW_SKILL_ACTIVE=1
/bin/mv "$STAGE_DIR/skill" "$SKILL_DIR"
NEW_COMPANION_PLIST_ACTIVE=1
render_plist "$REPO_ROOT/packaging/io.github.codex-pet-companion.plist" "$COMPANION_PLIST"

if [ -x "$INSTALL_DIR/runtime/bin/$RUNTIME_BIN_NAME" ]; then
    NEW_MANIFEST_ACTIVE=1
    "$INSTALL_DIR/runtime/bin/$RUNTIME_BIN_NAME" "$REPO_ROOT/scripts/write-runtime-manifest.js" \
        "$INSTALL_DIR/runtime/bin/$RUNTIME_BIN_NAME" \
        "$INSTALL_DIR/runtime/python/bin/$PYTHON_BIN_NAME" \
        "$INSTALL_DIR"
else
    echo "Error: installed Node.js runtime is missing." >&2
    exit 1
fi

if [ "$LEGACY_CONFIGURED" -eq 1 ]; then
    "$LAUNCHCTL_BIN" bootout "gui/$UID" "$LEGACY_TIMER_PLIST" >/dev/null 2>&1 || true
fi

if ! launch_bootstrap_plist "$COMPANION_PLIST"; then
    fail_companion_startup "companion service bootstrap failed."
fi
if ! launch_kickstart_label "$COMPANION_LABEL"; then
    fail_companion_startup "companion service kickstart failed."
fi
if ! verify_companion; then
    fail_companion_startup "companion service status verification failed."
fi

if [ "$LEGACY_CONFIGURED" -eq 1 ]; then
    /bin/rm "$LEGACY_TIMER_PLIST"
fi

if [ -n "$(/usr/bin/find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
    migration_backup_root="$STATE_DIR/migration-backups"
    /bin/mkdir -p "$migration_backup_root"
    migration_backup="$migration_backup_root/$(/bin/date +%Y%m%dT%H%M%S).$$"
    /bin/mv "$BACKUP_DIR" "$migration_backup"
    PAYLOAD_TRANSACTION_ACTIVE=0
    NEW_SRC_ACTIVE=0
    NEW_BIN_ACTIVE=0
    NEW_RUNTIME_ACTIVE=0
    echo "Previous installation preserved at $migration_backup."
else
    remove_transaction_path "$BACKUP_DIR"
    PAYLOAD_TRANSACTION_ACTIVE=0
fi
/bin/rmdir "$STAGE_DIR" 2>/dev/null || true

if [ "$LEGACY_OVERLAY_CONFIGURED" -eq 1 ]; then
    overlay_backup_dir="$STATE_DIR/legacy-overlay-backups"
    /bin/mkdir -p "$overlay_backup_dir"
    overlay_backup_file="${overlay_backup_dir}/${LEGACY_OVERLAY_LABEL}.$(/bin/date +%s).$$.plist"
    if ! /bin/cp "$LEGACY_OVERLAY_PLIST" "$overlay_backup_file"; then
        echo "Error: failed to backup legacy overlay plist." >&2
        exit 1
    fi
    if "$LAUNCHCTL_BIN" print "gui/$UID/$LEGACY_OVERLAY_LABEL" >/dev/null 2>&1; then
        if ! "$LAUNCHCTL_BIN" bootout "gui/$UID" "$LEGACY_OVERLAY_PLIST"; then
            echo "Error: failed to bootout legacy overlay." >&2
            exit 1
        fi
    fi
    /bin/rm "$LEGACY_OVERLAY_PLIST"
fi

echo "Installed the supervised $COMPANION_LABEL service."
if [ -n "$LAST_DOCTOR_STATUS" ]; then
    echo "$LAST_DOCTOR_STATUS" | "$NODE_RUNTIME_BIN" -e 'const fs=require("fs"); try { const d=JSON.parse(fs.readFileSync(0,"utf8")); for (const warning of d.warnings || []) console.error(`Warning: ${warning}`); if (d.action) console.error(`Next step: ${d.action}`); } catch (_) {}'
fi
