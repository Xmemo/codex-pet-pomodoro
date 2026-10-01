const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { TextDecoder } = require('util');

const FIXED_USER_HOME_PATH = /\/Users\/[^$<{][^/]*/;
const FILE_URL_PREFIX = new RegExp('file' + String.fromCharCode(58, 47, 47));
const LOCAL_MACHINE_EMAIL = /@[A-Za-z0-9._-]+\.local\b/i;
const FORBIDDEN_PATTERNS = [
  { label: 'hardcoded fixed user home path', value: FIXED_USER_HOME_PATH },
  { label: 'file URL prefix', value: FILE_URL_PREFIX },
  { label: '.local email pattern', value: LOCAL_MACHINE_EMAIL },
];
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  '__pycache__',
  '.pytest_cache',
  '.venv',
  'dist',
  'build',
  'evidence',
  'pet-run',
  'companion-build',
  'private-assets',
]);
const IMAGE_EXTENSIONS = new Set(['.png', '.webp']);
const APPROVED_PRESENTATION_IMAGES = new Set([
  'docs/images/pet-pomodoro-companion-panel.png',
  'docs/images/pet-pomodoro-focus-controls.png',
  'docs/images/pet-pomodoro-rest-takeover.png',
]);
const textDecoder = new TextDecoder('utf-8', { fatal: true });

function isSkippedDirectory(entryName) {
  return SKIPPED_DIRECTORIES.has(entryName) || entryName.endsWith('.egg-info');
}

function isAllowedReleaseImage(repoRoot, filePath) {
  const relativePath = path.relative(repoRoot, filePath).split(path.sep).join('/');
  return relativePath.startsWith('examples/example-pet/') || APPROVED_PRESENTATION_IMAGES.has(relativePath);
}

function listCandidateFiles(repoRoot) {
  const files = [];
  const directories = [];

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (isSkippedDirectory(entry.name)) continue;
        directories.push(fullPath);
        walk(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }

  walk(repoRoot);
  return { files, directories };
}

function readUtf8TextIfPlain(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.includes(0)) return null;
  try {
    return textDecoder.decode(buffer);
  } catch (_) {
    return null;
  }
}

function findForbiddenMatches(text) {
  return FORBIDDEN_PATTERNS
    .filter(pattern => pattern.value instanceof RegExp ? pattern.value.test(text) : text.includes(pattern.value))
    .map(pattern => pattern.label);
}

test('release-sanitize: strict zero-exception candidate gate', async (t) => {
  const repoRoot = path.join(__dirname, '..');
  const { files, directories } = listCandidateFiles(repoRoot);

  await t.test('candidate paths and UTF-8 text contain no private identifiers', () => {
    const failures = [];
    for (const entryPath of [...directories, ...files]) {
      const relativePath = path.relative(repoRoot, entryPath).split(path.sep).join('/');
      const pathMatches = findForbiddenMatches(relativePath);
      if (pathMatches.length > 0) {
        failures.push(`${relativePath}: path contains ${pathMatches.join(', ')}`);
      }
    }
    for (const file of files) {
      if (IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
      const text = readUtf8TextIfPlain(file);
      if (text == null) continue;
      const matches = findForbiddenMatches(text);
      if (matches.length > 0) {
        const relativePath = path.relative(repoRoot, file).split(path.sep).join('/');
        failures.push(`${relativePath}: content contains ${matches.join(', ')}`);
      }
    }
    assert.deepStrictEqual(failures, []);
  });

  await t.test('PNG and WebP files are limited to the licensed example pet and approved README visuals', () => {
    const failures = [];
    const exampleRasterAssets = [];
    for (const file of files) {
      if (!IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
      const relativePath = path.relative(repoRoot, file).split(path.sep).join('/');
      if (!isAllowedReleaseImage(repoRoot, file)) {
        failures.push(relativePath);
      } else {
        if (relativePath.startsWith('examples/example-pet/')) exampleRasterAssets.push(file);
      }
    }
    assert.deepStrictEqual(failures, []);
    assert.ok(exampleRasterAssets.length > 0, 'examples/example-pet must include at least one redistributable raster asset');
    assert.ok(fs.existsSync(path.join(repoRoot, 'examples/example-pet/LICENSE')),
      'examples/example-pet must include a LICENSE adjacent to redistributable assets');
    for (const relativePath of APPROVED_PRESENTATION_IMAGES) {
      assert.ok(fs.existsSync(path.join(repoRoot, relativePath)), `${relativePath} must exist`);
    }
  });

  await t.test('Packaging plists use {{HOME}} placeholder', () => {
    const pkgDir = path.join(repoRoot, 'packaging');
    if (!fs.existsSync(pkgDir)) return;
    for (const entry of fs.readdirSync(pkgDir)) {
      if (!entry.endsWith('.plist') || entry.endsWith('-Info.plist')) continue;
      const content = fs.readFileSync(path.join(pkgDir, entry), 'utf8');
      assert.ok(!FIXED_USER_HOME_PATH.test(content), `${entry} must not contain hardcoded home paths`);
      assert.ok(content.includes('{{HOME}}'), `${entry} should use {{HOME}} placeholder`);
    }
  });
});

function makeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

function readCalls(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function makeHarness() {
  const repoRoot = path.join(__dirname, '..');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-urd-install-'));
  const home = path.join(root, 'home');
  const fakeBin = path.join(root, 'fake-bin');
  const logPath = path.join(root, 'launchctl.jsonl');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });

  const launchctl = path.join(fakeBin, 'launchctl');
  const python = path.join(fakeBin, 'python3');
  const node = path.join(fakeBin, 'node');
  const xcrun = path.join(fakeBin, 'xcrun');
  const sfltool = path.join(fakeBin, 'sfltool');

  makeExecutable(launchctl, `#!/bin/sh
printf '%s\\n' "$("$REAL_NODE" -e 'console.log(JSON.stringify({tool:"launchctl",argv:process.argv.slice(1)}))' -- "$@")" >> "$LAUNCHCTL_LOG"
case "$*" in
  *"$FAIL_LAUNCHCTL_MATCH"*) [ -n "$FAIL_LAUNCHCTL_MATCH" ] && exit 7 ;;
esac
case "$*" in
  *"kickstart"*"io.github.codex-pet-companion"*)
    mkdir -p "$(dirname "$SUPERVISOR_STATUS_FILE")"
    printf '{"service":"running","pid":4242,"gpt":"not-running","timer":"%s","companion":"waiting","errors":{}}\\n' "\${SUPERVISOR_TIMER_STATE:-running}" > "$SUPERVISOR_STATUS_FILE"
    printf 'pid = 4242\\n'
    printf 'state = running\\n'
    ;;
  *"print"*) printf 'pid = 4242\\nstate = running\\n' ;;
esac
exit 0
`);
  makeExecutable(python, `#!/bin/sh
if [ "$1" = "-m" ] && [ "$2" = "ultradian_rhythm.cli" ] && [ "$3" = "status" ]; then
  printf '%s\\n' "$("$REAL_NODE" -e 'console.log(JSON.stringify({tool:"python",argv:process.argv.slice(1)}))' -- "$@")" >> "$LAUNCHCTL_LOG"
  [ "$FAIL_TIMER_STATUS" = "1" ] && exit 8
  count=0
  [ -f "$TIMER_STATUS_COUNT_FILE" ] && count="$(cat "$TIMER_STATUS_COUNT_FILE")"
  count=$((count + 1))
  printf '%s\\n' "$count" > "$TIMER_STATUS_COUNT_FILE"
  [ "$count" -le "\${TIMER_STATUS_FAILURES:-0}" ] && exit 8
  printf '{"ok":true}\\n'
  exit 0
fi
case "$*" in
  *"-V"*|*"--version"*)
    [ "$FAIL_PYTHON_VERSION" = "1" ] && exit 12
    if [ "\${FAKE_PYTHON_VERSION+set}" = "set" ]; then
      printf '%s\\n' "$FAKE_PYTHON_VERSION"
    else
      printf 'Python 3.12.0\\n'
    fi
    exit 0
    ;;
esac
exit 0
`);
  makeExecutable(node, `#!/bin/sh
printf '%s\\n' "$("$REAL_NODE" -e 'console.log(JSON.stringify({tool:"node",argv:process.argv.slice(1)}))' -- "$@")" >> "$LAUNCHCTL_LOG"
case "$*" in
  *"--version"*|*"-e"*|*"write-runtime-manifest.js"*|*"codex-pet-companion.js"*)
    exec "$REAL_NODE" "$@"
    ;;
esac
exit 0
`);
  makeExecutable(sfltool, `#!/bin/sh
printf ' #1:\\n          Disposition: [%s] (0xa)\\n           Identifier: 8.io.github.codex-pet-companion\\n' "\${FAKE_BTM_DISPOSITION:-enabled, allowed, notified}"
`);
  makeExecutable(xcrun, `#!/bin/sh
printf '%s\\n' "$("$REAL_NODE" -e 'console.log(JSON.stringify({tool:"xcrun",argv:process.argv.slice(1)}))' -- "$@")" >> "$LAUNCHCTL_LOG"
[ "$FAIL_XCRUN" = "1" ] && exit 10
if [ "$1" = "swiftc" ]; then
  shift
  while [ "$1" != "" ]; do
    if [ "$1" = "-o" ]; then
      shift
      mkdir -p "$(dirname "$1")"
      printf '#!/bin/sh\\nexit 0\\n' > "$1"
      chmod +x "$1"
      if [ "$XCRUN_REMOVE_BIN_DIR" = "1" ]; then
        rm -rf "$(dirname "$1")"
      fi
      exit 0
    fi
    shift
  done
fi
exit 1
`);

  const env = {
    ...process.env,
    HOME: home,
    CODEX_TIMER_OVERLAY_HOME: home,
    LAUNCHCTL_BIN: launchctl,
    PYTHON_BIN: python,
    NODE_BIN: node,
    XCRUN_BIN: xcrun,
    SFLTOOL_BIN: sfltool,
    CODEX_INSTALL_REAL_HOME: home,
    VERIFY_ATTEMPTS: '1',
    VERIFY_DELAY: '0',
    LAUNCHCTL_LOG: logPath,
    TIMER_STATUS_COUNT_FILE: path.join(root, 'timer-status-count'),
    COMPANION_STATUS_COUNT_FILE: path.join(root, 'companion-status-count'),
    SUPERVISOR_STATUS_FILE: path.join(home, '.codex/ultradian-rhythm/supervisor-status.json'),
    CODEX_INSTALL_TEST_MODE: '1',
    REAL_NODE: process.execPath,
    PATH: `${fakeBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
  };

  return {
    repoRoot,
    root,
    home,
    fakeBin,
    node,
    logPath,
    env,
    runInstall(extraEnv = {}) {
      return spawnSync('/bin/zsh', [path.join(repoRoot, 'scripts/install.sh')], {
        cwd: repoRoot,
        env: { ...env, ...extraEnv },
        encoding: 'utf8',
      });
    },
    runUninstall(args = [], extraEnv = {}) {
      return spawnSync('/bin/zsh', [path.join(repoRoot, 'scripts/uninstall.sh'), ...args], {
        cwd: repoRoot,
        env: { ...env, ...extraEnv },
        encoding: 'utf8',
      });
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function callStrings(calls) {
  return calls.map(c => c.argv.join(' '));
}

function seedOldPayload(h) {
  const installDir = path.join(h.home, '.local/share/codex-ultradian-rhythm');
  fs.mkdirSync(path.join(installDir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(installDir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(installDir, 'src/old-src.marker'), 'old-src');
  fs.writeFileSync(path.join(installDir, 'bin/old-bin.marker'), 'old-bin');
  return installDir;
}

function transientPayloadEntries(installDir) {
  if (!fs.existsSync(installDir)) return [];
  return fs.readdirSync(installDir).filter(name => name.startsWith('.stage.') || name.startsWith('.backup.'));
}

test('Gate4 packaging install/uninstall migration uses fake launchctl only', async (t) => {
  await t.test('installer never searches Codex or ChatGPT private Node runtimes', () => {
    const install = fs.readFileSync(path.join(__dirname, '../scripts/install.sh'), 'utf8');
    const chatgpt = '/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node';
    const codex = '/Applications/Codex.app/Contents/Resources/cua_node/bin/node';
    assert.ok(!install.includes(chatgpt));
    assert.ok(!install.includes(codex));
    assert.ok(install.includes('command -v node'));
    assert.ok(!install.includes('ChatGPT Helper'));
  });

  await t.test('PATH Node is copied to the fixed managed runtime location', () => {
    const h = makeHarness();
    try {
      const result = h.runInstall({ NODE_BIN: '' });
      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      const plist = fs.readFileSync(path.join(h.home, 'Library/LaunchAgents/io.github.codex-pet-companion.plist'), 'utf8');
      assert.ok(plist.includes(`${h.home}/.local/share/codex-ultradian-rhythm/runtime/bin/node</string>`));
      assert.ok(fs.existsSync(path.join(h.home, '.local/share/codex-ultradian-rhythm/runtime/bin/node')));
    } finally {
      h.cleanup();
    }
  });

  await t.test('timer verification retries before companion startup', () => {
    const h = makeHarness();
    try {
      const result = h.runInstall({ VERIFY_ATTEMPTS: '3', VERIFY_DELAY: '0', TIMER_STATUS_FAILURES: '2' });
      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      const calls = readCalls(h.logPath);
      const timerStatuses = calls.filter(c => c.tool === 'python' && c.argv.join(' ').includes('ultradian_rhythm.cli status'));
      const companionBootstrap = calls.findIndex(c => c.tool === 'launchctl' && c.argv.join(' ').includes('bootstrap') && c.argv.join(' ').includes('io.github.codex-pet-companion.plist'));
      const lastTimerStatus = calls.map((c, index) => ({ c, index })).filter(({ c }) => c.tool === 'python').at(-1).index;
      assert.strictEqual(timerStatuses.length, 3);
      assert.ok(companionBootstrap >= 0);
      assert.ok(lastTimerStatus > companionBootstrap, 'timer health is checked after the supervisor is launched');
    } finally {
      h.cleanup();
    }
  });

  await t.test('first install pins runtimes and registers one supervisor LaunchAgent', () => {
    const h = makeHarness();
    try {
      const result = h.runInstall();
      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      assert.ok(fs.existsSync(path.join(h.home, '.local/share/codex-ultradian-rhythm/src/ultradian_rhythm/daemon.py')));
      assert.ok(fs.existsSync(path.join(h.home, '.local/share/codex-ultradian-rhythm/bin/codex-pet-companion.js')));
      assert.ok(fs.existsSync(path.join(h.home, '.local/share/codex-ultradian-rhythm/bin/Pet Pomodoro Companion.app/Contents/MacOS/companion_renderer')));
      assert.ok(fs.existsSync(path.join(h.home, '.local/share/codex-ultradian-rhythm/bin/Pet Pomodoro Companion.app/Contents/Info.plist')));
      assert.ok(fs.existsSync(path.join(h.home, '.local/bin/ultradian')));
      assert.ok(fs.existsSync(path.join(h.home, '.local/bin/codex-pet-companion')));
      assert.ok(fs.existsSync(path.join(h.home, '.codex/skills/ultradian-rhythm/SKILL.md')));

      const companionPlist = fs.readFileSync(path.join(h.home, 'Library/LaunchAgents/io.github.codex-pet-companion.plist'), 'utf8');
      assert.ok(companionPlist.includes(`${h.home}/.local/share/codex-ultradian-rhythm/bin/codex-pet-supervisor</string>`));
      assert.ok(companionPlist.includes('<key>KeepAlive</key>\n    <true/>'));
      assert.ok(!fs.existsSync(path.join(h.home, 'Library/LaunchAgents/io.github.codex-ultradian-rhythm.plist')));
      assert.ok(fs.existsSync(path.join(h.home, '.local/share/codex-ultradian-rhythm/runtime-manifest.json')));

      const calls = callStrings(readCalls(h.logPath));
      const companionBootstrap = calls.findIndex(s => s.includes('bootstrap') && s.includes('io.github.codex-pet-companion.plist'));
      const companionKickstart = calls.findIndex(s => s.includes('kickstart -k') && s.includes('io.github.codex-pet-companion'));
      assert.ok(companionBootstrap >= 0);
      assert.ok(companionKickstart > companionBootstrap);
      assert.strictEqual(calls.filter(s => s.includes('bootstrap') && s.includes('.plist')).length, 1);
    } finally {
      h.cleanup();
    }
  });

  await t.test('idempotent reinstall repeats bootout/bootstrap without removing state', () => {
    const h = makeHarness();
    try {
      fs.mkdirSync(path.join(h.home, '.codex/ultradian-rhythm'), { recursive: true });
      fs.writeFileSync(path.join(h.home, '.codex/ultradian-rhythm/state.json'), '{"keep":true}');
      assert.strictEqual(h.runInstall().status, 0);
      assert.strictEqual(h.runInstall().status, 0);
      assert.strictEqual(fs.readFileSync(path.join(h.home, '.codex/ultradian-rhythm/state.json'), 'utf8'), '{"keep":true}');
      const calls = callStrings(readCalls(h.logPath));
      assert.ok(calls.filter(s => s.includes('bootstrap') && s.includes('io.github.codex-pet-companion.plist')).length >= 2);
    } finally {
      h.cleanup();
    }
  });

  await t.test('compile failure preserves existing payload and cleans transaction directories', () => {
    const h = makeHarness();
    try {
      const installDir = seedOldPayload(h);
      fs.mkdirSync(path.join(h.home, '.codex/ultradian-rhythm'), { recursive: true });
      fs.writeFileSync(path.join(h.home, '.codex/ultradian-rhythm/state.json'), '{"keep":true}');
      const result = h.runInstall({ FAIL_XCRUN: '1' });
      assert.notStrictEqual(result.status, 0);
      assert.strictEqual(fs.readFileSync(path.join(installDir, 'src/old-src.marker'), 'utf8'), 'old-src');
      assert.strictEqual(fs.readFileSync(path.join(installDir, 'bin/old-bin.marker'), 'utf8'), 'old-bin');
      assert.deepStrictEqual(transientPayloadEntries(installDir), []);
      assert.ok(fs.existsSync(path.join(h.home, '.codex/ultradian-rhythm/state.json')));
    } finally {
      h.cleanup();
    }
  });

  await t.test('activation failure restores both old payload directories and cleans transaction directories', () => {
    const h = makeHarness();
    try {
      const installDir = seedOldPayload(h);
      const result = h.runInstall({ XCRUN_REMOVE_BIN_DIR: '1' });
      assert.notStrictEqual(result.status, 0);
      assert.strictEqual(fs.readFileSync(path.join(installDir, 'src/old-src.marker'), 'utf8'), 'old-src');
      assert.strictEqual(fs.readFileSync(path.join(installDir, 'bin/old-bin.marker'), 'utf8'), 'old-bin');
      assert.deepStrictEqual(transientPayloadEntries(installDir), []);
    } finally {
      h.cleanup();
    }
  });

  await t.test('explicit legacy timer is booted out only after new supervisor is healthy', () => {
    const h = makeHarness();
    try {
      const legacy = path.join(h.home, 'Library/LaunchAgents/legacy.timer.plist');
      fs.mkdirSync(path.dirname(legacy), { recursive: true });
      fs.writeFileSync(legacy, '<plist/>');
      fs.mkdirSync(path.join(h.home, '.codex/ultradian-rhythm'), { recursive: true });
      fs.writeFileSync(path.join(h.home, '.codex/ultradian-rhythm/state.json'), '{"history":true}');
      const result = h.runInstall({ LEGACY_TIMER_LABEL: 'org.example.legacy-timer', LEGACY_TIMER_PLIST: legacy });
      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      assert.ok(!fs.existsSync(legacy));
      assert.ok(fs.existsSync(path.join(h.home, '.codex/ultradian-rhythm/state.json')));
      const calls = callStrings(readCalls(h.logPath));
      const oldBootout = calls.findIndex(s => s.includes('bootout') && s.includes(legacy));
      const newBootstrap = calls.findIndex(s => s.includes('bootstrap') && s.includes('io.github.codex-pet-companion.plist'));
      assert.ok(oldBootout >= 0 && newBootstrap > oldBootout);
    } finally {
      h.cleanup();
    }
  });

  await t.test('new timer verification failure rolls back new service and preserves old plist', () => {
    const h = makeHarness();
    try {
      const legacy = path.join(h.home, 'Library/LaunchAgents/legacy.timer.plist');
      fs.mkdirSync(path.dirname(legacy), { recursive: true });
      fs.writeFileSync(legacy, '<plist/>');
      const result = h.runInstall({ LEGACY_TIMER_LABEL: 'org.example.legacy-timer', LEGACY_TIMER_PLIST: legacy, FAIL_TIMER_STATUS: '1' });
      assert.notStrictEqual(result.status, 0);
      assert.ok(fs.existsSync(legacy));
      const calls = callStrings(readCalls(h.logPath));
      assert.ok(calls.some(s => s.includes('bootout') && s.includes('io.github.codex-ultradian-rhythm.plist')));
      assert.ok(calls.some(s => s.includes('bootstrap') && s.includes(legacy)));
      assert.ok(calls.some(s => s.includes('kickstart -k') && s.includes('org.example.legacy-timer')));
    } finally {
      h.cleanup();
    }
  });

  await t.test('timer health failure rolls back the new supervisor and preserves state', () => {
    const h = makeHarness();
    try {
      fs.mkdirSync(path.join(h.home, '.codex/ultradian-rhythm'), { recursive: true });
      fs.writeFileSync(path.join(h.home, '.codex/ultradian-rhythm/state.json'), '{"safe":true}');
      const result = h.runInstall({ FAIL_TIMER_STATUS: '1' });
      assert.notStrictEqual(result.status, 0);
      assert.ok(!fs.existsSync(path.join(h.home, 'Library/LaunchAgents/io.github.codex-pet-companion.plist')));
      assert.ok(fs.existsSync(path.join(h.home, '.codex/ultradian-rhythm/state.json')));
      const calls = callStrings(readCalls(h.logPath));
      assert.ok(calls.some(s => s.includes('bootout') && s.includes('io.github.codex-pet-companion.plist')));
      assert.ok(!calls.some(s => s.includes('bootout') && s.includes('legacy')));
    } finally {
      h.cleanup();
    }
  });

  await t.test('supervisor kickstart failure is fatal and rolls legacy service back', () => {
    const h = makeHarness();
    try {
      const legacy = path.join(h.home, 'Library/LaunchAgents/legacy.timer.plist');
      fs.mkdirSync(path.dirname(legacy), { recursive: true });
      fs.writeFileSync(legacy, '<plist/>');
      const timerTarget = `kickstart -k gui/${process.getuid()}/io.github.codex-pet-companion`;
      const result = h.runInstall({
        LEGACY_TIMER_LABEL: 'org.example.legacy-timer',
        LEGACY_TIMER_PLIST: legacy,
        FAIL_LAUNCHCTL_MATCH: timerTarget,
      });
      assert.notStrictEqual(result.status, 0);
      assert.ok(fs.existsSync(legacy));
      const calls = callStrings(readCalls(h.logPath));
      assert.ok(calls.includes(timerTarget));
      assert.ok(calls.some(s => s.includes('bootstrap') && s.includes(legacy)));
    } finally {
      h.cleanup();
    }
  });

  await t.test('companion kickstart failure is fatal while verified timer remains installed', () => {
    const h = makeHarness();
    try {
      const companionTarget = `kickstart -k gui/${process.getuid()}/io.github.codex-pet-companion`;
      const result = h.runInstall({ FAIL_LAUNCHCTL_MATCH: companionTarget });
      assert.notStrictEqual(result.status, 0);
      assert.ok(!fs.existsSync(path.join(h.home, 'Library/LaunchAgents/io.github.codex-pet-companion.plist')));
      const calls = callStrings(readCalls(h.logPath));
      assert.ok(calls.includes(companionTarget));
      assert.ok(calls.some(s => s.includes('bootout') && s.includes('io.github.codex-pet-companion.plist')));
    } finally {
      h.cleanup();
    }
  });

  await t.test('old service is booted out after compile and new supervisor starts after payload swap', () => {
    const h = makeHarness();
    try {
      const result = h.runInstall();
      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      const calls = callStrings(readCalls(h.logPath));
      const xcrunIndex = readCalls(h.logPath).findIndex(c => c.tool === 'xcrun');
      const companionBootout = calls.findIndex(s => s.includes('bootout') && s.includes('io.github.codex-pet-companion.plist'));
      const companionBootstrap = calls.findIndex(s => s.includes('bootstrap') && s.includes('io.github.codex-pet-companion.plist'));

      assert.ok(xcrunIndex >= 0);
      assert.ok(companionBootout >= 0);
      assert.ok(companionBootstrap >= 0);

      assert.ok(companionBootout > xcrunIndex, 'bootout must occur after compile');
      const companionKickstart = calls.findIndex(s => s.includes('kickstart -k') && s.includes('io.github.codex-pet-companion'));
      assert.ok(companionKickstart > companionBootstrap, 'supervisor must be kicked after bootstrap');
    } finally {
      h.cleanup();
    }
  });

  await t.test('companion stop failure prevents bootstrap, preserves old payload and cleans staging', () => {
    const h = makeHarness();
    try {
      const installDir = seedOldPayload(h);
      const binDir = path.join(h.home, '.local/bin');
      fs.mkdirSync(binDir, { recursive: true });
      const oldWrapper = path.join(binDir, 'codex-pet-companion');
      fs.writeFileSync(oldWrapper, `#!/bin/sh\nexec "${h.env.NODE_BIN}" "${installDir}/bin/codex-pet-companion.js" "$@"\n`, { mode: 0o755 });

      const result = h.runInstall({ FAIL_COMPANION_STOP: '1' });
      assert.notStrictEqual(result.status, 0);

      assert.strictEqual(fs.readFileSync(path.join(installDir, 'src/old-src.marker'), 'utf8'), 'old-src');
      assert.strictEqual(fs.readFileSync(path.join(installDir, 'bin/old-bin.marker'), 'utf8'), 'old-bin');
      assert.deepStrictEqual(transientPayloadEntries(installDir), []);

      const calls = callStrings(readCalls(h.logPath));
      const companionStop = calls.findIndex(s => s.includes('codex-pet-companion.js stop'));
      const companionBootstrap = calls.findIndex(s => s.includes('bootstrap') && s.includes('io.github.codex-pet-companion.plist'));
      assert.ok(companionStop >= 0, 'stop must be attempted');
      assert.strictEqual(companionBootstrap, -1, 'bootstrap must not occur after stop failure');
    } finally {
      h.cleanup();
    }
  });

  await t.test('successful reinstall stops exactly once, installs new payload, and preserves state', () => {
    const h = makeHarness();
    try {
      const stateFile = path.join(h.home, '.codex/ultradian-rhythm/state.json');
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, '{"keep":true}');

      assert.strictEqual(h.runInstall().status, 0);

      const installDir = path.join(h.home, '.local/share/codex-ultradian-rhythm');
      const oldSrcMarker = path.join(installDir, 'src/old-src-marker.txt');
      const oldBinMarker = path.join(installDir, 'bin/old-bin-marker.txt');
      fs.writeFileSync(oldSrcMarker, 'should-be-deleted');
      fs.writeFileSync(oldBinMarker, 'should-be-deleted');

      fs.writeFileSync(h.logPath, '');
      assert.strictEqual(h.runInstall().status, 0);

      assert.strictEqual(fs.readFileSync(stateFile, 'utf8'), '{"keep":true}');

      const calls = callStrings(readCalls(h.logPath));
      const stops = calls.filter(s => s.includes('codex-pet-companion.js stop'));
      assert.strictEqual(stops.length, 1, 'companion stop must be called exactly once on reinstall');

      assert.ok(!fs.existsSync(oldSrcMarker), 'old src marker must be absent');
      assert.ok(!fs.existsSync(oldBinMarker), 'old bin marker must be absent');

      assert.ok(fs.existsSync(path.join(installDir, 'bin/codex-pet-companion.js')));
      assert.ok(fs.existsSync(path.join(installDir, 'src/ultradian_rhythm/daemon.py')));
    } finally {
      h.cleanup();
    }
  });

  await t.test('nonstandard HOME is rejected before launchctl for install and uninstall', () => {
    const h = makeHarness();
    try {
      const mismatchedHome = path.join(h.root, 'system-home');
      let result = h.runInstall({ CODEX_INSTALL_REAL_HOME: mismatchedHome });
      assert.notStrictEqual(result.status, 0);
      assert.ok(!readCalls(h.logPath).some(c => c.tool === 'launchctl'));
      result = h.runUninstall([], { CODEX_INSTALL_REAL_HOME: mismatchedHome });
      assert.notStrictEqual(result.status, 0);
      assert.ok(!readCalls(h.logPath).some(c => c.tool === 'launchctl'));
    } finally {
      h.cleanup();
    }
  });

  await t.test('unsafe legacy label and plist paths are rejected before bootout or removal', () => {
    const h = makeHarness();
    try {
      const launchAgents = path.join(h.home, 'Library/LaunchAgents');
      const validPlist = path.join(launchAgents, 'legacy.timer.plist');
      fs.mkdirSync(launchAgents, { recursive: true });
      fs.writeFileSync(validPlist, '<plist/>');
      let result = h.runInstall({ LEGACY_TIMER_LABEL: '../unsafe', LEGACY_TIMER_PLIST: validPlist });
      assert.notStrictEqual(result.status, 0);
      assert.ok(fs.existsSync(validPlist));
      assert.ok(!readCalls(h.logPath).some(c => c.tool === 'launchctl'));

      const outsidePlist = path.join(h.home, 'outside.plist');
      const traversingPath = path.join(launchAgents, '..', '..', 'outside.plist');
      fs.writeFileSync(outsidePlist, '<plist/>');
      result = h.runInstall({ LEGACY_TIMER_LABEL: 'org.example.safe', LEGACY_TIMER_PLIST: traversingPath });
      assert.notStrictEqual(result.status, 0);
      assert.ok(fs.existsSync(outsidePlist));
      assert.ok(!readCalls(h.logPath).some(c => c.tool === 'launchctl'));
    } finally {
      h.cleanup();
    }
  });

  await t.test('uninstall removes companion before timer and preserves state unless purged', () => {
    const h = makeHarness();
    try {
      assert.strictEqual(h.runInstall().status, 0);
      fs.writeFileSync(path.join(h.home, '.codex/ultradian-rhythm/state.json'), '{"keep":true}');
      fs.writeFileSync(h.logPath, '');
      const result = h.runUninstall();
      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      assert.ok(fs.existsSync(path.join(h.home, '.codex/ultradian-rhythm/state.json')));
      assert.ok(!fs.existsSync(path.join(h.home, 'Library/LaunchAgents/io.github.codex-pet-companion.plist')));
      assert.ok(!fs.existsSync(path.join(h.home, 'Library/LaunchAgents/io.github.codex-ultradian-rhythm.plist')));
      const calls = callStrings(readCalls(h.logPath));
      const companionStop = calls.findIndex(s => s.includes('codex-pet-companion.js stop'));
      const companionBootout = calls.findIndex(s => s.includes('bootout') && s.includes('io.github.codex-pet-companion.plist'));
      assert.ok(companionStop >= 0 && companionBootout > companionStop);
      assert.ok(companionBootout >= 0);
      assert.ok(!calls.some(s => s.includes('bootout') && s.includes('io.github.codex-ultradian-rhythm.plist')));
      assert.strictEqual(h.runUninstall(['--purge-state']).status, 0);
      assert.ok(!fs.existsSync(path.join(h.home, '.codex/ultradian-rhythm')));
    } finally {
      h.cleanup();
    }
  });
});

test('T005: renderer build has a stable app bundle identity and no screen-capture usage description', () => {
  const install = fs.readFileSync(path.join(__dirname, '../scripts/install.sh'), 'utf8');
  const compileLine = install.split('\n').find(line => line.includes('swiftc') && line.includes('companion_renderer'));
  assert.ok(compileLine, 'must have a swiftc compile line for companion_renderer');
  assert.ok(compileLine.includes('companion_renderer.swift'), 'must include companion_renderer.swift');
  assert.ok(compileLine.includes('timer_panel.swift'), 'must include timer_panel.swift');
  assert.ok(compileLine.includes('Pet Pomodoro Companion.app'), 'renderer must live inside a dedicated app bundle');
  const infoPlist = fs.readFileSync(path.join(__dirname, '../packaging/companion-renderer-Info.plist'), 'utf8');
  assert.ok(infoPlist.includes('io.github.codex-pet-companion.renderer'));
  assert.ok(!infoPlist.includes('NSScreenCaptureUsageDescription'));
  const renderer = fs.readFileSync(path.join(__dirname, '../src/companion_renderer.swift'), 'utf8');
  assert.ok(!renderer.includes('CGRequestScreenCaptureAccess'));
  assert.ok(!renderer.includes('CGPreflightScreenCaptureAccess'));
  assert.ok(!renderer.includes('CGWindowListCreateImage'));
});

test('T005: installer normalizes Swift build paths for stable ad-hoc supervisor identity', () => {
  const install = fs.readFileSync(path.join(__dirname, '../scripts/install.sh'), 'utf8');
  assert.match(install, /-debug-prefix-map "\$REPO_ROOT=\/codex-pet-companion\/source"/);
  assert.match(install, /-file-prefix-map "\$REPO_ROOT=\/codex-pet-companion\/source"/);
  assert.match(install, /-debug-prefix-map "\$STAGE_DIR=\/codex-pet-companion\/build"/);
  assert.match(install, /-file-prefix-map "\$STAGE_DIR=\/codex-pet-companion\/build"/);
  assert.match(install, /codesign --force --sign - "\$STAGE_DIR\/bin\/codex-pet-supervisor"/);
  assert.match(install, /codesign --verify --strict "\$STAGE_DIR\/bin\/codex-pet-supervisor"/);
  assert.match(install, /process\.exit\(d\.ok === true \? 0 : 1\)/);
});

test('T005: compile failure preserves existing installed bin and src via rollback', () => {
  const h = makeHarness();
  try {
    const installDir = seedOldPayload(h);
    fs.mkdirSync(path.join(h.home, '.codex/ultradian-rhythm'), { recursive: true });
    fs.writeFileSync(path.join(h.home, '.codex/ultradian-rhythm/state.json'), '{"keep":true}');
    const result = h.runInstall({ FAIL_XCRUN: '1' });
    assert.notStrictEqual(result.status, 0);
    assert.strictEqual(fs.readFileSync(path.join(installDir, 'src/old-src.marker'), 'utf8'), 'old-src');
    assert.strictEqual(fs.readFileSync(path.join(installDir, 'bin/old-bin.marker'), 'utf8'), 'old-bin');
    assert.deepStrictEqual(transientPayloadEntries(installDir), []);
  } finally {
    h.cleanup();
  }
});

test('T006: LEGACY_OVERLAY_LABEL and LEGACY_OVERLAY_PLIST must be provided together', () => {
  const h = makeHarness();
  try {
    const launchAgents = path.join(h.home, 'Library/LaunchAgents');
    const legacy = path.join(launchAgents, 'legacy.overlay.plist');
    fs.mkdirSync(launchAgents, { recursive: true });
    fs.writeFileSync(legacy, '<plist/>');
    let result = h.runInstall({ LEGACY_OVERLAY_LABEL: 'org.example.overlay' });
    assert.notStrictEqual(result.status, 0, 'label alone must fail');
    assert.ok(fs.existsSync(legacy));
    result = h.runInstall({ LEGACY_OVERLAY_PLIST: legacy });
    assert.notStrictEqual(result.status, 0, 'plist alone must fail');
    assert.ok(fs.existsSync(legacy));
  } finally {
    h.cleanup();
  }
});

test('T006: LEGACY_OVERLAY_LABEL unsafe characters rejected', () => {
  const h = makeHarness();
  try {
    const launchAgents = path.join(h.home, 'Library/LaunchAgents');
    const legacy = path.join(launchAgents, 'legacy.overlay.plist');
    fs.mkdirSync(launchAgents, { recursive: true });
    fs.writeFileSync(legacy, '<plist/>');
    const result = h.runInstall({ LEGACY_OVERLAY_LABEL: '../unsafe', LEGACY_OVERLAY_PLIST: legacy });
    assert.notStrictEqual(result.status, 0);
    assert.ok(fs.existsSync(legacy));
  } finally {
    h.cleanup();
  }
});

test('T006: LEGACY_OVERLAY_PLIST must exist, be regular non-symlink, inside LaunchAgents, with .plist extension', () => {
  const h = makeHarness();
  try {
    const launchAgents = path.join(h.home, 'Library/LaunchAgents');
    fs.mkdirSync(launchAgents, { recursive: true });
    const label = 'org.example.overlay';

    let result = h.runInstall({ LEGACY_OVERLAY_LABEL: label, LEGACY_OVERLAY_PLIST: path.join(launchAgents, 'nonexistent.plist') });
    assert.notStrictEqual(result.status, 0, 'missing plist must fail');

    const notPlist = path.join(launchAgents, 'notaplist.txt');
    fs.writeFileSync(notPlist, 'data');
    result = h.runInstall({ LEGACY_OVERLAY_LABEL: label, LEGACY_OVERLAY_PLIST: notPlist });
    assert.notStrictEqual(result.status, 0, 'non-.plist must fail');

    const outside = path.join(h.home, 'outside.plist');
    fs.writeFileSync(outside, '<plist/>');
    result = h.runInstall({ LEGACY_OVERLAY_LABEL: label, LEGACY_OVERLAY_PLIST: outside });
    assert.notStrictEqual(result.status, 0, 'outside LaunchAgents must fail');
  } finally {
    h.cleanup();
  }
});

test('T006: LEGACY_OVERLAY_PAYLOAD must be under ~/.local/share, exist, and be non-symlink', () => {
  const h = makeHarness();
  try {
    const launchAgents = path.join(h.home, 'Library/LaunchAgents');
    const overlayPlist = path.join(launchAgents, 'legacy.overlay.plist');
    fs.mkdirSync(launchAgents, { recursive: true });
    fs.writeFileSync(overlayPlist, '<plist/>');
    const label = 'org.example.overlay';

    const outside = path.join(h.home, 'outside-payload');
    fs.mkdirSync(outside);
    let result = h.runInstall({ LEGACY_OVERLAY_LABEL: label, LEGACY_OVERLAY_PLIST: overlayPlist, LEGACY_OVERLAY_PAYLOAD: outside });
    assert.notStrictEqual(result.status, 0, 'payload outside ~/.local/share must fail');

    const nonexistent = path.join(h.home, '.local/share/nonexistent');
    result = h.runInstall({ LEGACY_OVERLAY_LABEL: label, LEGACY_OVERLAY_PLIST: overlayPlist, LEGACY_OVERLAY_PAYLOAD: nonexistent });
    assert.notStrictEqual(result.status, 0, 'nonexistent payload must fail');
  } finally {
    h.cleanup();
  }
});

test('T006: LEGACY_OVERLAY_PAYLOAD dot-dot escape fails and preserves overlay plist and outside payload', () => {
  const h = makeHarness();
  try {
    const launchAgents = path.join(h.home, 'Library/LaunchAgents');
    const overlayPlist = path.join(launchAgents, 'legacy.overlay.plist');
    fs.mkdirSync(launchAgents, { recursive: true });
    fs.writeFileSync(overlayPlist, '<plist/>');
    const outsidePayload = path.join(h.home, 'outside-payload');
    fs.mkdirSync(outsidePayload);
    fs.writeFileSync(path.join(outsidePayload, 'marker.txt'), 'untouched');
    const escapedPath = `${path.join(h.home, '.local/share')}/../../outside-payload`;
    const result = h.runInstall({
      LEGACY_OVERLAY_LABEL: 'org.example.overlay',
      LEGACY_OVERLAY_PLIST: overlayPlist,
      LEGACY_OVERLAY_PAYLOAD: escapedPath,
    });
    assert.notStrictEqual(result.status, 0);
    assert.ok(fs.existsSync(overlayPlist), 'overlay plist must be preserved');
    assert.ok(fs.existsSync(outsidePayload), 'outside payload must still exist');
    assert.strictEqual(fs.readFileSync(path.join(outsidePayload, 'marker.txt'), 'utf8'), 'untouched');
    // Verify no launchctl calls were made (failure before bootstrap)
    assert.ok(!readCalls(h.logPath).some(c => c.tool === 'launchctl'));
  } finally {
    h.cleanup();
  }
});

test('T006: LEGACY_OVERLAY_PAYLOAD intermediate symlink escape fails and preserves overlay plist', () => {
  const h = makeHarness();
  try {
    const launchAgents = path.join(h.home, 'Library/LaunchAgents');
    const overlayPlist = path.join(launchAgents, 'legacy.overlay.plist');
    fs.mkdirSync(launchAgents, { recursive: true });
    fs.writeFileSync(overlayPlist, '<plist/>');
    const outsidePayload = path.join(h.home, 'outside-payload');
    fs.mkdirSync(outsidePayload);
    fs.writeFileSync(path.join(outsidePayload, 'marker.txt'), 'untouched');
    const shareDir = path.join(h.home, '.local/share');
    fs.mkdirSync(shareDir, { recursive: true });
    const escapeLink = path.join(shareDir, 'escape-link');
    fs.symlinkSync(outsidePayload, escapeLink);
    const result = h.runInstall({
      LEGACY_OVERLAY_LABEL: 'org.example.overlay',
      LEGACY_OVERLAY_PLIST: overlayPlist,
      LEGACY_OVERLAY_PAYLOAD: escapeLink,
    });
    assert.notStrictEqual(result.status, 0);
    assert.ok(fs.existsSync(overlayPlist), 'overlay plist must be preserved');
    assert.ok(fs.existsSync(outsidePayload), 'outside payload must still exist');
    assert.strictEqual(fs.readFileSync(path.join(outsidePayload, 'marker.txt'), 'utf8'), 'untouched');
    // Verify no launchctl calls were made (failure before bootstrap)
    assert.ok(!readCalls(h.logPath).some(c => c.tool === 'launchctl'));
  } finally {
    h.cleanup();
  }
});

test('T006: legacy overlay retirement creates backup, bootouts, removes original only after companion verify', () => {
  const h = makeHarness();
  try {
    const launchAgents = path.join(h.home, 'Library/LaunchAgents');
    const overlayPlist = path.join(launchAgents, 'legacy.overlay.plist');
    fs.mkdirSync(launchAgents, { recursive: true });
    fs.writeFileSync(overlayPlist, '<plist/>overlay-content');
    const result = h.runInstall({
      LEGACY_OVERLAY_LABEL: 'org.example.overlay',
      LEGACY_OVERLAY_PLIST: overlayPlist,
    });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.ok(!fs.existsSync(overlayPlist), 'original overlay plist must be removed');
    const backupDir = path.join(h.home, '.codex/ultradian-rhythm/legacy-overlay-backups');
    const backups = fs.readdirSync(backupDir);
    const backupFile = backups.find(f => f.startsWith('org.example.overlay.') && f.endsWith('.plist'));
    assert.ok(backupFile, 'backup file must exist');
    assert.strictEqual(fs.readFileSync(path.join(backupDir, backupFile), 'utf8'), '<plist/>overlay-content');
    const calls = callStrings(readCalls(h.logPath));
    assert.ok(calls.some(s => s.includes('bootout') && s.includes(overlayPlist)), 'must bootout overlay plist');
  } finally {
    h.cleanup();
  }
});

test('T006: legacy overlay old payload unchanged after retirement', () => {
  const h = makeHarness();
  try {
    const launchAgents = path.join(h.home, 'Library/LaunchAgents');
    const overlayPlist = path.join(launchAgents, 'legacy.overlay.plist');
    fs.mkdirSync(launchAgents, { recursive: true });
    fs.writeFileSync(overlayPlist, '<plist/>');
    const payloadDir = path.join(h.home, '.local/share/old-overlay-payload');
    fs.mkdirSync(payloadDir, { recursive: true });
    fs.writeFileSync(path.join(payloadDir, 'marker.txt'), 'preserved');
    const result = h.runInstall({
      LEGACY_OVERLAY_LABEL: 'org.example.overlay',
      LEGACY_OVERLAY_PLIST: overlayPlist,
      LEGACY_OVERLAY_PAYLOAD: payloadDir,
    });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.ok(fs.existsSync(payloadDir), 'payload directory must still exist');
    assert.strictEqual(fs.readFileSync(path.join(payloadDir, 'marker.txt'), 'utf8'), 'preserved');
  } finally {
    h.cleanup();
  }
});

test('T006: verified-new-companion ordering before legacy overlay bootout', () => {
  const h = makeHarness();
  try {
    const launchAgents = path.join(h.home, 'Library/LaunchAgents');
    const overlayPlist = path.join(launchAgents, 'legacy.overlay.plist');
    fs.mkdirSync(launchAgents, { recursive: true });
    fs.writeFileSync(overlayPlist, '<plist/>');
    const result = h.runInstall({
      LEGACY_OVERLAY_LABEL: 'org.example.overlay',
      LEGACY_OVERLAY_PLIST: overlayPlist,
    });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    const calls = callStrings(readCalls(h.logPath));
    const companionBootstrap = calls.findIndex(s => s.includes('bootstrap') && s.includes('io.github.codex-pet-companion.plist'));
    const companionKickstart = calls.findIndex(s => s.includes('kickstart') && s.includes('io.github.codex-pet-companion'));
    const companionVerify = calls.findIndex(s => s.includes('codex-pet-companion.js doctor --json'));
    const overlayBootout = calls.findIndex(s => s.includes('bootout') && s.includes(overlayPlist));
    assert.ok(companionBootstrap >= 0);
    assert.ok(companionKickstart > companionBootstrap);
    assert.ok(companionVerify > companionKickstart);
    assert.ok(overlayBootout > companionVerify, 'overlay bootout must occur after companion verify');
  } finally {
    h.cleanup();
  }
});

test('T006: timer verification failure preserves legacy overlay', () => {
  const h = makeHarness();
  try {
    const launchAgents = path.join(h.home, 'Library/LaunchAgents');
    const overlayPlist = path.join(launchAgents, 'legacy.overlay.plist');
    fs.mkdirSync(launchAgents, { recursive: true });
    fs.writeFileSync(overlayPlist, '<plist/>');
    const result = h.runInstall({
      LEGACY_OVERLAY_LABEL: 'org.example.overlay',
      LEGACY_OVERLAY_PLIST: overlayPlist,
      FAIL_TIMER_STATUS: '1',
    });
    assert.notStrictEqual(result.status, 0);
    assert.ok(fs.existsSync(overlayPlist), 'overlay plist must be preserved');
    const calls = callStrings(readCalls(h.logPath));
    assert.ok(!calls.some(s => s.includes('bootout') && s.includes(overlayPlist)), 'must not bootout overlay');
  } finally {
    h.cleanup();
  }
});

test('T006: companion verification failure preserves legacy overlay', () => {
  const h = makeHarness();
  try {
    const launchAgents = path.join(h.home, 'Library/LaunchAgents');
    const overlayPlist = path.join(launchAgents, 'legacy.overlay.plist');
    fs.mkdirSync(launchAgents, { recursive: true });
    fs.writeFileSync(overlayPlist, '<plist/>');
    const result = h.runInstall({
      LEGACY_OVERLAY_LABEL: 'org.example.overlay',
      LEGACY_OVERLAY_PLIST: overlayPlist,
      FAKE_BTM_DISPOSITION: 'enabled, disallowed, notified',
    });
    assert.notStrictEqual(result.status, 0);
    assert.ok(fs.existsSync(overlayPlist), 'overlay plist must be preserved');
    const calls = callStrings(readCalls(h.logPath));
    assert.ok(!calls.some(s => s.includes('bootout') && s.includes(overlayPlist)), 'must not bootout overlay');
  } finally {
    h.cleanup();
  }
});

test('T006: bootout failure preserves legacy overlay plist', () => {
  const h = makeHarness();
  try {
    const launchAgents = path.join(h.home, 'Library/LaunchAgents');
    const overlayPlist = path.join(launchAgents, 'legacy.overlay.plist');
    fs.mkdirSync(launchAgents, { recursive: true });
    fs.writeFileSync(overlayPlist, '<plist/>');
    const result = h.runInstall({
      LEGACY_OVERLAY_LABEL: 'org.example.overlay',
      LEGACY_OVERLAY_PLIST: overlayPlist,
      FAIL_LAUNCHCTL_MATCH: overlayPlist,
    });
    assert.notStrictEqual(result.status, 0);
    assert.ok(fs.existsSync(overlayPlist), 'overlay plist must not be removed');
  } finally {
    h.cleanup();
  }
});

test('T006: unloaded legacy overlay label skips bootout but removes original plist after backup', () => {
  const h = makeHarness();
  try {
    const launchAgents = path.join(h.home, 'Library/LaunchAgents');
    const overlayPlist = path.join(launchAgents, 'legacy.overlay.plist');
    fs.mkdirSync(launchAgents, { recursive: true });
    fs.writeFileSync(overlayPlist, '<plist/>unloaded-overlay');
    fs.mkdirSync(path.join(h.home, '.codex/ultradian-rhythm'), { recursive: true });
    fs.writeFileSync(path.join(h.home, '.codex/ultradian-rhythm/state.json'), '{"state":"safe"}');
    // FAIL_LAUNCHCTL_MATCH on the label causes `launchctl print` to fail → job not loaded
    const result = h.runInstall({
      LEGACY_OVERLAY_LABEL: 'org.example.overlay',
      LEGACY_OVERLAY_PLIST: overlayPlist,
      FAIL_LAUNCHCTL_MATCH: 'org.example.overlay',
    });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.ok(!fs.existsSync(overlayPlist), 'original overlay plist must be removed when job was unloaded');
    const backupDir = path.join(h.home, '.codex/ultradian-rhythm/legacy-overlay-backups');
    const backups = fs.readdirSync(backupDir);
    assert.ok(backups.some(f => f.endsWith('.plist')), 'backup must exist');
    const calls = callStrings(readCalls(h.logPath));
    assert.ok(!calls.some(s => s.includes('bootout') && s.includes(overlayPlist)), 'must not bootout unloaded overlay');
    assert.ok(fs.existsSync(path.join(h.home, '.codex/ultradian-rhythm/state.json')), 'state must be preserved');
  } finally {
    h.cleanup();
  }
});

test('T006: backup failure preserves legacy overlay plist', () => {
  const h = makeHarness();
  try {
    const launchAgents = path.join(h.home, 'Library/LaunchAgents');
    const overlayPlist = path.join(launchAgents, 'legacy.overlay.plist');
    fs.mkdirSync(launchAgents, { recursive: true });
    fs.writeFileSync(overlayPlist, '<plist/>');
    const backupDir = path.join(h.home, '.codex/ultradian-rhythm/legacy-overlay-backups');
    fs.mkdirSync(backupDir, { recursive: true });
    fs.chmodSync(backupDir, 0o444);
    const result = h.runInstall({
      LEGACY_OVERLAY_LABEL: 'org.example.overlay',
      LEGACY_OVERLAY_PLIST: overlayPlist,
    });
    assert.notStrictEqual(result.status, 0);
    assert.ok(fs.existsSync(overlayPlist), 'overlay plist must not be removed when backup fails');
  } finally {
    h.cleanup();
  }
});

test('T006: idempotent when no LEGACY_OVERLAY_* vars supplied and plist absent', () => {
  const h = makeHarness();
  try {
    assert.strictEqual(h.runInstall().status, 0);
  } finally {
    h.cleanup();
  }
});

test('T007: install verifies the resident supervisor rather than requiring an always-open pet worker', async (t) => {
  const h = makeHarness();
  try {
    const result = h.runInstall();
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);

    const calls = readCalls(h.logPath);
    const doctorCalls = calls.filter(c => c.tool === 'node' && c.argv.join(' ').includes('codex-pet-companion.js doctor --json'));
    assert.strictEqual(doctorCalls.length, 1);
    assert.ok(fs.existsSync(h.env.SUPERVISOR_STATUS_FILE));
    assert.ok(!fs.existsSync(path.join(h.home, 'Library/LaunchAgents/io.github.codex-ultradian-rhythm.plist')));
  } finally {
    h.cleanup();
  }
});

test('T007: background item denied by macOS causes rollback with actionable permission diagnosis', async (t) => {
  const h = makeHarness();
  try {
    const result = h.runInstall({
      VERIFY_ATTEMPTS: '3',
      VERIFY_DELAY: '0',
      FAKE_BTM_DISPOSITION: 'enabled, disallowed, notified',
    });
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /System Settings|Login Items|disallowed/i);

    const calls = readCalls(h.logPath);
    const bootoutCall = calls.find(c => c.tool === 'launchctl' && c.argv.join(' ').includes('bootout') && c.argv.join(' ').includes('io.github.codex-pet-companion.plist'));
    assert.ok(bootoutCall, 'must bootout companion plist on verify failure');
    assert.ok(!fs.existsSync(path.join(h.home, 'Library/LaunchAgents/io.github.codex-pet-companion.plist')));
  } finally {
    h.cleanup();
  }
});


test('T006: explicitly supplied missing LEGACY_OVERLAY_PLIST is error', () => {
  const h = makeHarness();
  try {
    const missing = path.join(h.home, 'Library/LaunchAgents/missing.overlay.plist');
    const result = h.runInstall({
      LEGACY_OVERLAY_LABEL: 'org.example.overlay',
      LEGACY_OVERLAY_PLIST: missing,
    });
    assert.notStrictEqual(result.status, 0);
  } finally {
    h.cleanup();
  }
});

test('static check: install.sh default verify attempts and delay', () => {
  const installContent = fs.readFileSync(path.join(__dirname, '../scripts/install.sh'), 'utf8');
  const attemptsMatch = installContent.match(/VERIFY_ATTEMPTS="\$\{VERIFY_ATTEMPTS:-(\d+)\}"/);
  const delayMatch = installContent.match(/VERIFY_DELAY="\$\{VERIFY_DELAY:-([\d.]+)\}"/);
  assert.ok(attemptsMatch, 'Should find VERIFY_ATTEMPTS definition in install.sh');
  assert.ok(delayMatch, 'Should find VERIFY_DELAY definition in install.sh');
  assert.strictEqual(attemptsMatch[1], '200', 'Default VERIFY_ATTEMPTS should be 200');
  assert.strictEqual(delayMatch[1], '0.2', 'Default VERIFY_DELAY should be 0.2');
});

test('T004/T005: pre-mutation Python 3.11+ version gate', async (t) => {
  function assertNoFilesystemMutation(h) {
    assert.ok(!fs.existsSync(path.join(h.home, '.local/share/codex-ultradian-rhythm')), 'install dir must not be created');
    assert.ok(!fs.existsSync(path.join(h.home, '.local/bin/ultradian')), 'ultradian wrapper must not be created');
    assert.ok(!fs.existsSync(path.join(h.home, '.local/bin/codex-pet-companion')), 'companion wrapper must not be created');
    assert.ok(!fs.existsSync(path.join(h.home, '.codex/skills/ultradian-rhythm')), 'skill dir must not be created');
    assert.ok(!fs.existsSync(path.join(h.home, 'Library/LaunchAgents/io.github.codex-ultradian-rhythm.plist')), 'timer plist must not be created');
    assert.ok(!fs.existsSync(path.join(h.home, 'Library/LaunchAgents/io.github.codex-pet-companion.plist')), 'companion plist must not be created');
  }

  await t.test('Python 3.11+ versions are accepted', () => {
    const h = makeHarness();
    try {
      let result = h.runInstall({ FAKE_PYTHON_VERSION: 'Python 3.11.0' });
      assert.strictEqual(result.status, 0, result.stderr || result.stdout);

      fs.writeFileSync(h.logPath, '');
      result = h.runInstall({ FAKE_PYTHON_VERSION: 'Python 3.12.4' });
      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    } finally {
      h.cleanup();
    }
  });

  await t.test('Python 3.10 and older are rejected with error, no mutation, and no launchctl call', () => {
    const h = makeHarness();
    try {
      const stateDir = path.join(h.home, '.codex/ultradian-rhythm');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, 'state.json'), '{"history":123}');

      const result310 = h.runInstall({ FAKE_PYTHON_VERSION: 'Python 3.10.12' });
      assert.notStrictEqual(result310.status, 0);
      assert.match(result310.stderr, /Python 3\.11 or newer/i);
      assert.ok(!readCalls(h.logPath).some(c => c.tool === 'launchctl'));
      assertNoFilesystemMutation(h);
      assert.strictEqual(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'), '{"history":123}');

      const result27 = h.runInstall({ FAKE_PYTHON_VERSION: 'Python 2.7.18' });
      assert.notStrictEqual(result27.status, 0);
      assert.match(result27.stderr, /Python 3\.11 or newer/i);
      assert.ok(!readCalls(h.logPath).some(c => c.tool === 'launchctl'));
      assertNoFilesystemMutation(h);
    } finally {
      h.cleanup();
    }
  });

  await t.test('malformed or failing Python version output is rejected before mutation or launchctl', () => {
    const h = makeHarness();
    try {
      // Command failure
      const failResult = h.runInstall({ FAIL_PYTHON_VERSION: '1' });
      assert.notStrictEqual(failResult.status, 0);
      assert.match(failResult.stderr, /Python 3\.11 or newer/i);
      assert.ok(!readCalls(h.logPath).some(c => c.tool === 'launchctl'));
      assertNoFilesystemMutation(h);

      // Empty output
      const emptyResult = h.runInstall({ FAKE_PYTHON_VERSION: '' });
      assert.notStrictEqual(emptyResult.status, 0);
      assert.match(emptyResult.stderr, /Python 3\.11 or newer/i);
      assert.ok(!readCalls(h.logPath).some(c => c.tool === 'launchctl'));
      assertNoFilesystemMutation(h);

      // Malformed text
      const malformedResult = h.runInstall({ FAKE_PYTHON_VERSION: 'Python invalid-version' });
      assert.notStrictEqual(malformedResult.status, 0);
      assert.match(malformedResult.stderr, /Python 3\.11 or newer/i);
      assert.ok(!readCalls(h.logPath).some(c => c.tool === 'launchctl'));
      assertNoFilesystemMutation(h);

      // Missing minor version
      const missingMinorResult = h.runInstall({ FAKE_PYTHON_VERSION: 'Python 3' });
      assert.notStrictEqual(missingMinorResult.status, 0);
      assert.match(missingMinorResult.stderr, /Python 3\.11 or newer/i);
      assert.ok(!readCalls(h.logPath).some(c => c.tool === 'launchctl'));
      assertNoFilesystemMutation(h);
    } finally {
      h.cleanup();
    }
  });
});
