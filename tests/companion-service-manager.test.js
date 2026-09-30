const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');

const serviceManagerPath = path.resolve(__dirname, '../src/companion/service-manager.js');

function createFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-service-manager-'));
  const installDir = path.join(home, '.local/share/codex-ultradian-rhythm');
  const stateDir = path.join(home, '.codex/ultradian-rhythm');
  const launchAgents = path.join(home, 'Library/LaunchAgents');
  const fakeBin = path.join(home, 'fake-bin');
  const nodePath = path.join(installDir, 'runtime/bin/node');
  const pythonPath = path.join(installDir, 'runtime/python/bin/python3.12');
  const launchctlPath = path.join(fakeBin, 'launchctl');
  const sfltoolPath = path.join(fakeBin, 'sfltool');
  const launchctlLog = path.join(home, 'launchctl.log');
  const supervisorPid = 4242;

  fs.mkdirSync(path.dirname(nodePath), { recursive: true });
  fs.mkdirSync(path.dirname(pythonPath), { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(launchAgents, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(nodePath, 'pinned-node-runtime');
  fs.writeFileSync(pythonPath, 'pinned-python-runtime');
  fs.writeFileSync(path.join(launchAgents, 'io.github.codex-pet-companion.plist'), '<plist/>');

  const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  fs.writeFileSync(path.join(installDir, 'runtime-manifest.json'), JSON.stringify({
    schemaVersion: 1,
    node: { path: nodePath, version: 'v22.0.0', sha256: sha256(nodePath) },
    python: { path: pythonPath, version: 'Python 3.12.0', sha256: sha256(pythonPath) },
  }));
  fs.writeFileSync(path.join(stateDir, 'supervisor-status.json'), JSON.stringify({
    service: 'running', pid: supervisorPid, gpt: 'not-running', timer: 'running', companion: 'waiting', errors: {},
  }));
  fs.writeFileSync(launchctlPath, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FAKE_LAUNCHCTL_LOG"\ncase "$*" in *print*) if [ "$FAKE_LAUNCHCTL_UNLOADED" = "1" ]; then exit 1; fi ;; esac\nprintf "pid = %s\\nstate = %s\\n" "$FAKE_LAUNCHCTL_PID" "$FAKE_LAUNCHCTL_STATE"\n');
  fs.writeFileSync(sfltoolPath, '#!/bin/sh\nprintf "# 1:\\nDisposition: [%s] (0xa)\\nIdentifier: 8.io.github.codex-pet-companion\\n" "$FAKE_BTM_DISPOSITION"\n');
  fs.chmodSync(launchctlPath, 0o755);
  fs.chmodSync(sfltoolPath, 0o755);

  const env = {
    ...process.env,
    HOME: home,
    CODEX_TIMER_OVERLAY_HOME: home,
    CODEX_PET_INSTALL_DIR: installDir,
    CODEX_PET_LAUNCH_AGENT: path.join(launchAgents, 'io.github.codex-pet-companion.plist'),
    LAUNCHCTL_BIN: launchctlPath,
    SFLTOOL_BIN: sfltoolPath,
    FAKE_LAUNCHCTL_LOG: launchctlLog,
    FAKE_LAUNCHCTL_PID: String(supervisorPid),
    FAKE_LAUNCHCTL_STATE: 'running',
    FAKE_BTM_DISPOSITION: 'enabled, allowed, notified',
  };

  return {
    home,
    installDir,
    stateDir,
    nodePath,
    env,
    invoke(method, overrides = {}) {
      const output = execFileSync(process.execPath, ['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(serviceManagerPath)})[${JSON.stringify(method)}]()))`], {
        encoding: 'utf8',
        env: { ...env, ...overrides },
      });
      return JSON.parse(output);
    },
    doctor(overrides = {}) { return this.invoke('doctor', overrides); },
    launchctlCalls() { return fs.readFileSync(launchctlLog, 'utf8').trim().split('\n').filter(Boolean); },
    cleanup() { fs.rmSync(home, { recursive: true, force: true }); },
  };
}

test('doctor accepts only a live launchd job whose PID matches current supervisor status', () => {
  const fixture = createFixture();
  try {
    assert.equal(fixture.doctor().ok, true);
    const stale = JSON.parse(fs.readFileSync(path.join(fixture.stateDir, 'supervisor-status.json'), 'utf8'));
    stale.pid += 1;
    fs.writeFileSync(path.join(fixture.stateDir, 'supervisor-status.json'), JSON.stringify(stale));
    const result = fixture.doctor();
    assert.equal(result.ok, false);
    assert.match(result.action, /stale|repair/i);
  } finally {
    fixture.cleanup();
  }
});

test('doctor rejects a loaded-but-not-running job, denied background permission, and modified runtime', () => {
  const fixture = createFixture();
  try {
    assert.equal(fixture.doctor({ FAKE_LAUNCHCTL_STATE: 'waiting' }).ok, false);
    assert.equal(fixture.doctor({ FAKE_BTM_DISPOSITION: 'enabled, disallowed, notified' }).ok, false);
    fs.appendFileSync(fixture.nodePath, '-tampered');
    const result = fixture.doctor();
    assert.equal(result.ok, false);
    assert.equal(result.runtime.checks.node.sha256Matches, false);
  } finally {
    fixture.cleanup();
  }
});

test('doctor keeps timer healthy while reporting a hidden pet worker as degraded', () => {
  const fixture = createFixture();
  try {
    const statusPath = path.join(fixture.stateDir, 'supervisor-status.json');
    const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    status.gpt = 'running';
    status.companion = 'paused-after-failures';
    fs.writeFileSync(statusPath, JSON.stringify(status));

    const result = fixture.doctor();
    assert.equal(result.ok, true);
    assert.equal(result.pet.healthy, false);
    assert.equal(result.pet.workerState, 'paused-after-failures');
    assert.match(result.warnings[0], /timer is healthy.*pet window is hidden/i);
    assert.match(result.action, /timer remains active/i);
  } finally {
    fixture.cleanup();
  }
});

test('doctor distinguishes the Codex main-window fallback from a recognized pet and visible timer panel', () => {
  const fixture = createFixture();
  try {
    const supervisorPath = path.join(fixture.stateDir, 'supervisor-status.json');
    const supervisor = JSON.parse(fs.readFileSync(supervisorPath, 'utf8'));
    supervisor.gpt = 'running';
    supervisor.companion = 'running';
    fs.writeFileSync(supervisorPath, JSON.stringify(supervisor));
    fs.writeFileSync(path.join(fixture.stateDir, 'companion-status.json'), JSON.stringify({
      anchorFound: true,
      petAnchorFound: false,
      mainWindowFallbackAnchor: true,
      visualAnchorDiagnostic: 'voice-host-geometry-unavailable',
      timerPanelVisible: false,
    }));

    const result = fixture.doctor();
    assert.equal(result.ok, true);
    assert.equal(result.pet.petAnchorFound, false);
    assert.equal(result.pet.mainWindowFallbackAnchor, true);
    assert.equal(result.pet.visualAnchorDiagnostic, 'voice-host-geometry-unavailable');
    assert.equal(result.pet.timerPanelVisible, false);
    assert.match(result.warnings[0], /no pet window or supported voice-host geometry/i);
    assert.match(result.action, /stays hidden rather than guessing/i);
  } finally {
    fixture.cleanup();
  }
});

test('doctor does not require Screen Recording permission for timer health', () => {
  const fixture = createFixture();
  try {
    const supervisorPath = path.join(fixture.stateDir, 'supervisor-status.json');
    const supervisor = JSON.parse(fs.readFileSync(supervisorPath, 'utf8'));
    supervisor.gpt = 'running';
    supervisor.companion = 'running';
    fs.writeFileSync(supervisorPath, JSON.stringify(supervisor));
    fs.writeFileSync(path.join(fixture.stateDir, 'companion-status.json'), JSON.stringify({
      mainWindowFallbackAnchor: true,
      visualAnchorDiagnostic: 'voice-host-geometry-estimate',
      timerPanelVisible: false,
    }));
    const result = fixture.doctor();
    assert.equal(result.ok, true);
    assert.equal(result.pet.healthy, true);
    assert.doesNotMatch(result.action || '', /Screen Recording|screen capture/i);
  } finally {
    fixture.cleanup();
  }
});

test('doctor remains usable when macOS does not expose a background permission record', () => {
  const fixture = createFixture();
  const unknownPermissionTool = path.join(fixture.home, 'unknown-sfltool');
  try {
    fs.writeFileSync(unknownPermissionTool, '#!/bin/sh\nprintf "no matching background item\\n"\n');
    fs.chmodSync(unknownPermissionTool, 0o755);
    const result = fixture.doctor({ SFLTOOL_BIN: unknownPermissionTool });
    assert.equal(result.ok, true);
    assert.equal(result.backgroundPermission, 'unknown');
    assert.match(result.warnings[0], /permission could not be verified/i);
    assert.match(result.action, /System Settings.*Login Items/i);
  } finally {
    fixture.cleanup();
  }
});

test('background permission inspection has a bounded timeout', () => {
  const fixture = createFixture();
  const hangingTool = path.join(fixture.home, 'hanging-sfltool');
  try {
    fs.writeFileSync(hangingTool, '#!/bin/sh\nexec /usr/bin/sleep 10\n');
    fs.chmodSync(hangingTool, 0o755);
    const result = execFileSync(process.execPath, ['-e', `process.stdout.write(require(${JSON.stringify(serviceManagerPath)}).backgroundPermission(100))`], {
      encoding: 'utf8',
      env: { ...fixture.env, SFLTOOL_BIN: hangingTool },
    });
    assert.equal(result, 'unknown');
  } finally {
    fixture.cleanup();
  }
});

test('start is idempotent; stop unloads only the current service; repair kickstarts it', () => {
  const fixture = createFixture();
  try {
    const alreadyRunning = fixture.invoke('start');
    assert.equal(alreadyRunning.alreadyRunning, true);
    assert.deepEqual(fixture.launchctlCalls(), ['print gui/' + process.getuid() + '/io.github.codex-pet-companion']);

    fs.writeFileSync(fixture.env.FAKE_LAUNCHCTL_LOG, '');
    assert.deepEqual(fixture.invoke('stop'), { stopped: true, alreadyStopped: false });
    assert.ok(fixture.launchctlCalls().some(call => call.startsWith('bootout ')));

    fs.writeFileSync(fixture.env.FAKE_LAUNCHCTL_LOG, '');
    assert.deepEqual(fixture.invoke('repair'), {
      repaired: true,
      action: 'supervisor restarted; timer state remains persisted',
    });
    assert.ok(fixture.launchctlCalls().some(call => call.includes('kickstart -k')));

    fs.writeFileSync(fixture.env.FAKE_LAUNCHCTL_LOG, '');
    assert.ok(fixture.invoke('start', { FAKE_LAUNCHCTL_UNLOADED: '1' }).started);
    assert.ok(fixture.launchctlCalls().some(call => call.startsWith('bootstrap ')));
  } finally {
    fixture.cleanup();
  }
});

test('start refuses a background item denied by macOS without calling launchctl', () => {
  const fixture = createFixture();
  try {
    const result = execFileSync(process.execPath, ['-e', `require(${JSON.stringify(serviceManagerPath)}).start()`], {
      encoding: 'utf8',
      env: { ...fixture.env, FAKE_BTM_DISPOSITION: 'enabled, disallowed, notified' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.fail(`expected start to reject denied permission, got ${result}`);
  } catch (error) {
    assert.match(error.stderr, /System Settings.*Login Items.*repair/i);
    assert.equal(fs.existsSync(fixture.env.FAKE_LAUNCHCTL_LOG), false);
  } finally {
    fixture.cleanup();
  }
});
