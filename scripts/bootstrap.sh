#!/bin/zsh
set -euo pipefail

# Pinned default stable version
DEFAULT_VERSION="v0.1.2"
VERSION="${1:-$DEFAULT_VERSION}"

# Validate version format vMAJOR.MINOR.PATCH
if [[ ! "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Error: Invalid version format '$VERSION'. Expected vMAJOR.MINOR.PATCH" >&2
    exit 1
fi

# Define download filenames
TARBALL_NAME="pet-pomodoro-for-codex-$VERSION.tar.gz"
CHECKSUM_FILE="SHA256SUMS"

# Helper to resolve absolute tool path or fallback
resolve_tool() {
    local cmd="$1"
    local fallback="$2"
    if [ -x "$fallback" ]; then
        echo "$fallback"
    else
        echo "$cmd"
    fi
}

# Verify mode and configure URL / paths
if [ "${CODEX_BOOTSTRAP_TEST:-0}" = "1" ]; then
    # Test mode safety requirements
    if [ -z "${CODEX_RELEASE_URL_BASE:-}" ] || [[ "${CODEX_RELEASE_URL_BASE}" != http://* && "${CODEX_RELEASE_URL_BASE}" != https://* ]]; then
        echo "Error: Test mode requires a valid absolute CODEX_RELEASE_URL_BASE (http:// or https://)." >&2
        exit 1
    fi
    URL_BASE="${CODEX_RELEASE_URL_BASE}"

    # Executable overrides validation (must be absolute, no arguments allowed)
    validate_override() {
        local val="$1"
        local name="$2"
        if [ -n "$val" ]; then
            if [[ "$val" != /* ]]; then
                echo "Error: Test override $name must be an absolute path: '$val'" >&2
                exit 1
            fi
            if [[ "$val" == *" "* ]]; then
                echo "Error: Test override $name cannot contain arguments: '$val'" >&2
                exit 1
            fi
        fi
    }

    validate_override "${CURL_BIN:-}" "CURL_BIN"
    validate_override "${TAR_BIN:-}" "TAR_BIN"
    validate_override "${SHASUM_BIN:-}" "SHASUM_BIN"
    validate_override "${GH_BIN:-}" "GH_BIN"
    validate_override "${CODEX_TEST_ULTRADIAN_BIN:-}" "CODEX_TEST_ULTRADIAN_BIN"
    validate_override "${CODEX_TEST_COMPANION_BIN:-}" "CODEX_TEST_COMPANION_BIN"

    CURL_BIN="${CURL_BIN:-/usr/bin/curl}"
    TAR_BIN="${TAR_BIN:-/usr/bin/tar}"
    ULTRADIAN_BIN="${CODEX_TEST_ULTRADIAN_BIN:-$HOME/.local/bin/ultradian}"
    COMPANION_BIN="${CODEX_TEST_COMPANION_BIN:-$HOME/.local/bin/codex-pet-companion}"
    GH_BIN="${GH_BIN:-$(command -v gh || true)}"
else
    # Production mode: No overrides allowed, enforce strict URLs and paths
    URL_BASE="https://github.com/Xmemo/codex-pet-pomodoro/releases/download/$VERSION"
    CURL_BIN="/usr/bin/curl"
    TAR_BIN="/usr/bin/tar"
    SHASUM_BIN="/usr/bin/shasum"
    GH_BIN="$(command -v gh || true)"
    ULTRADIAN_BIN="$HOME/.local/bin/ultradian"
    COMPANION_BIN="$HOME/.local/bin/codex-pet-companion"
fi

MKTEMP_BIN=$(resolve_tool mktemp /usr/bin/mktemp)
RM_BIN=$(resolve_tool rm /bin/rm)
AWK_BIN=$(resolve_tool awk /usr/bin/awk)

# Create a private temporary directory and set up cleanup trap
TEMP_DIR=$("$MKTEMP_BIN" -d -t codex-bootstrap-XXXXXX)
if [ -z "${TEMP_DIR:-}" ] || [ ! -d "$TEMP_DIR" ]; then
    echo "Error: Failed to create temporary directory." >&2
    exit 1
fi

cleanup() {
    # Ensure cleanup is strictly bounded to the mktemp directory
    if [ -n "${TEMP_DIR:-}" ] && [ -d "$TEMP_DIR" ]; then
        if [[ "$TEMP_DIR" == /tmp/* ]] || [[ "$TEMP_DIR" == /var/* ]] || [[ "$TEMP_DIR" == /private/* ]]; then
            "$RM_BIN" -rf "$TEMP_DIR"
        fi
    fi
}
trap cleanup EXIT

# 1. Download SHA256SUMS and tarball
# Production curl must enforce HTTPS for initial URL and redirects with --proto '=https' and --proto-redir '=https', TLS 1.2+, fail, location, silent, show-error.
# We always supply these flags. In test mode with http url, the fake curl parses these and mocks them.
if ! "$CURL_BIN" --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --location --silent --show-error "$URL_BASE/$CHECKSUM_FILE" -o "$TEMP_DIR/$CHECKSUM_FILE"; then
    echo "Error: Failed to download $CHECKSUM_FILE." >&2
    exit 1
fi

if ! "$CURL_BIN" --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --location --silent --show-error "$URL_BASE/$TARBALL_NAME" -o "$TEMP_DIR/$TARBALL_NAME"; then
    echo "Error: Failed to download $TARBALL_NAME." >&2
    exit 1
fi

# 2. Parse and validate the checksum file
# Must contain exactly one non-empty line
lines=()
while IFS= read -r line || [ -n "$line" ]; do
    # Trim leading/trailing whitespace
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    if [ -n "$line" ]; then
        lines+=("$line")
    fi
done < "$TEMP_DIR/$CHECKSUM_FILE"

if [ "${#lines[@]}" -ne 1 ]; then
    echo "Error: Checksum file must contain exactly one entry." >&2
    exit 1
fi

checksum_line="${lines[1]}"
expected_hash=""
filename=""
# Read columns
read -r expected_hash filename <<< "$checksum_line"

# Normalize or consistently handle hash case
expected_hash=$(echo "$expected_hash" | tr '[:upper:]' '[:lower:]')

if [[ ! "$expected_hash" =~ ^[a-fA-F0-9]{64}$ ]]; then
    echo "Error: Malformed checksum hash: '$expected_hash'" >&2
    exit 1
fi

if [ "$filename" != "$TARBALL_NAME" ]; then
    echo "Error: Checksum filename mismatch: expected '$TARBALL_NAME', got '$filename'" >&2
    exit 1
fi

# 3. Calculate and compare SHA256
SHASUM_ARGS=()
if [ -z "${SHASUM_BIN:-}" ]; then
    SHASUM_BIN="/usr/bin/shasum"
fi
if [ "$SHASUM_BIN" = "/usr/bin/shasum" ]; then
    SHASUM_ARGS=(-a 256)
fi
if [ ! -x "$SHASUM_BIN" ]; then
    echo "Error: SHA256 utility is unavailable: $SHASUM_BIN" >&2
    exit 1
fi

actual_hash=$("$SHASUM_BIN" "${SHASUM_ARGS[@]}" "$TEMP_DIR/$TARBALL_NAME" | "$AWK_BIN" '{print $1}')
actual_hash=$(echo "$actual_hash" | tr '[:upper:]' '[:lower:]')

if [ "$actual_hash" != "$expected_hash" ]; then
    echo "Error: SHA256 checksum mismatch (expected: $expected_hash, got: $actual_hash)." >&2
    exit 1
fi

# 4. Authenticate release provenance before inspecting or executing its contents.
if [ -z "${GH_BIN:-}" ] || [ ! -x "$GH_BIN" ]; then
    echo "Error: GitHub CLI (gh) is required to verify the signed release attestation." >&2
    exit 1
fi
if ! "$GH_BIN" attestation verify "$TEMP_DIR/$TARBALL_NAME" \
    --repo Xmemo/codex-pet-pomodoro \
    --signer-workflow Xmemo/codex-pet-pomodoro/.github/workflows/release.yml \
    --source-ref "refs/tags/$VERSION"; then
    echo "Error: Release provenance verification failed; refusing to install." >&2
    exit 1
fi

# 5. Verify tarball entries (Safe layout validation)
# All entries must reside inside pet-pomodoro-for-codex-$VERSION/
if ! entries=$("$TAR_BIN" -tzf "$TEMP_DIR/$TARBALL_NAME" 2>/dev/null); then
    echo "Error: Failed to list tarball entries." >&2
    exit 1
fi
expected_prefix="pet-pomodoro-for-codex-$VERSION/"
while IFS= read -r entry || [ -n "$entry" ]; do
    [ -z "$entry" ] && continue
    # Normalize entry path (remove ./ prefix if present)
    clean_entry="${entry#./}"
    if [[ "$clean_entry" != "$expected_prefix"* ]] && [ "$clean_entry" != "pet-pomodoro-for-codex-$VERSION" ]; then
        echo "Error: Unsafe archive layout: entry '$entry' lies outside version root." >&2
        exit 1
    fi
    # Check for directory traversal
    if [[ "$clean_entry" == *"/../"* ]] || [[ "$clean_entry" == "../"* ]] || [[ "$clean_entry" == *"/.." ]]; then
        echo "Error: Path traversal detected in archive entry: $entry" >&2
        exit 1
    fi
done <<< "$entries"

# Before extraction, reject every symlink and hardlink archive entry
if ! entries_details=$("$TAR_BIN" -tvzf "$TEMP_DIR/$TARBALL_NAME" 2>/dev/null); then
    echo "Error: Failed to list tarball entries with details." >&2
    exit 1
fi
while IFS= read -r line || [ -n "$line" ]; do
    [ -z "$line" ] && continue
    if [[ "$line" == l* ]] || [[ "$line" == h* ]] || [[ "$line" == *" -> "* ]] || [[ "$line" == *" link to "* ]]; then
        echo "Error: Symlinks and hardlinks are forbidden in the archive: $line" >&2
        exit 1
    fi
done <<< "$entries_details"

# 6. Extract and verify installer file
if ! "$TAR_BIN" -xzf "$TEMP_DIR/$TARBALL_NAME" -C "$TEMP_DIR"; then
    echo "Error: Failed to extract release archive." >&2
    exit 1
fi

extracted_root="$TEMP_DIR/pet-pomodoro-for-codex-$VERSION"
installer_path="$extracted_root/scripts/install.sh"

if [ ! -f "$installer_path" ]; then
    echo "Error: Installer script 'scripts/install.sh' not found in archive." >&2
    exit 1
fi

if [ -L "$installer_path" ]; then
    echo "Error: Installer script 'scripts/install.sh' cannot be a symlink." >&2
    exit 1
fi

# 7. Invoke packaged installer
# Execute installer within the temp workspace
if ! /bin/zsh "$installer_path"; then
    echo "Error: Package installation failed." >&2
    exit 1
fi

# 8. Health check verification
if ! "$ULTRADIAN_BIN" status --json >/dev/null; then
    echo "Error: Health check for 'ultradian' failed." >&2
    exit 1
fi

if ! "$COMPANION_BIN" status --json >/dev/null; then
    echo "Error: Health check for 'codex-pet-companion' failed." >&2
    exit 1
fi

echo "Successfully bootstrapped and validated Pet Pomodoro version $VERSION."
