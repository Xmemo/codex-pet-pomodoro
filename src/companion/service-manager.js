const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const paths = require('./paths.js');

const LABEL = 'io.github.codex-pet-companion';
const PLIST_PATH = process.env.CODEX_PET_LAUNCH_AGENT || path.join(os.homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);
const LAUNCHCTL = process.env.LAUNCHCTL_BIN || '/bin/launchctl';
const SFLTOOL = process.env.SFLTOOL_BIN || '/usr/bin/sfltool';
const SYSTEM_COMMAND_TIMEOUT_MS = 8000;

function run(file, args, timeout = SYSTEM_COMMAND_TIMEOUT_MS) {
  return execFileSync(file, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) { return null; }
}

function launchctlPrint(uid = process.getuid()) {
  try {
    const output = run(LAUNCHCTL, ['print', `gui/${uid}/${LABEL}`]);
    const pid = Number(output.match(/^\s*pid\s*=\s*(\d+)\s*$/m)?.[1]) || null;
    return { loaded: true, running: /(?:job )?state = running/.test(output), pid, output };
  } catch (error) {
    const detail = `${error.stdout || ''}\n${error.stderr || ''}`;
    return { loaded: false, running: false, pid: null, output: detail, error: error.message };
  }
}

function backgroundPermission(timeout = SYSTEM_COMMAND_TIMEOUT_MS) {
  try {
    const output = run(SFLTOOL, ['dumpbtm'], timeout);
    const marker = `Identifier: 8.${LABEL}`;
    const index = output.indexOf(marker);
    if (index < 0) return 'unknown';
    const prefix = output.slice(0, index);
    const starts = [...prefix.matchAll(/^\s*#\s*\d+:\s*$/gm)];
    const block = prefix.slice(starts.at(-1)?.index ?? Math.max(0, index - 1200));
    const disposition = block.match(/Disposition:\s*\[([^\]]+)\]/)?.[1];
    if (!disposition) return 'unknown';
    if (/disallowed/i.test(disposition)) return 'disallowed';
    if (/allowed/i.test(disposition)) return 'allowed';
    return 'unknown';
  } catch (_) {
    return 'unknown';
  }
}

function verifyRuntimeManifest() {
  const manifestPath = path.join(paths.INSTALL_DIR, 'runtime-manifest.json');
  const manifest = readJson(manifestPath);
  if (!manifest || manifest.schemaVersion !== 1 || !manifest.node || !manifest.python) {
    return { ok: false, error: 'runtime manifest is missing or invalid' };
  }
  const checks = {};
  const expectedPaths = {
    node: path.join(paths.INSTALL_DIR, 'runtime/bin/node'),
    python: path.join(paths.INSTALL_DIR, 'runtime/python/bin', path.basename(manifest.python.path || '')),
  };
  for (const runtimeName of ['node', 'python']) {
    const runtime = manifest[runtimeName];
    try {
      const expectedPath = expectedPaths[runtimeName];
      if (fs.realpathSync(runtime.path) !== fs.realpathSync(expectedPath)) {
        checks[runtimeName] = { ok: false, path: runtime.path, error: 'runtime path is outside the managed installation' };
        continue;
      }
      const actual = crypto.createHash('sha256').update(fs.readFileSync(runtime.path)).digest('hex');
      checks[runtimeName] = {
        ok: actual === runtime.sha256,
        path: runtime.path,
        expectedVersion: runtime.version,
        sha256Matches: actual === runtime.sha256,
      };
    } catch (error) {
      checks[runtimeName] = { ok: false, path: runtime.path, error: error.message };
    }
  }
  return { ok: checks.node.ok && checks.python.ok, manifestPath, checks };
}

function doctor() {
  const uid = process.getuid();
  const launchctl = launchctlPrint(uid);
  const supervisor = readJson(paths.SUPERVISOR_STATUS_PATH);
  const companion = readJson(paths.COMPANION_STATUS_PATH);
  const runtime = verifyRuntimeManifest();
  const permission = backgroundPermission();
  const timerRunning = supervisor && supervisor.timer === 'running';
  const gptRunning = supervisor && supervisor.gpt === 'running';
  const petReady = supervisor && supervisor.companion === 'running';
  const petAnchorFound = companion?.petAnchorFound ?? null;
  const mainWindowFallbackAnchor = companion?.mainWindowFallbackAnchor ?? null;
  const timerPanelVisible = companion?.timerPanelVisible ?? null;
  const supervisorMatchesLaunchd = launchctl.running && Number(supervisor?.pid) === launchctl.pid;
  const petHealthy = !gptRunning || petReady;
  const warnings = [];
  if (permission === 'unknown') {
    warnings.push('macOS background permission could not be verified. Check System Settings > General > Login Items & Extensions.');
  }
  if (!petHealthy) {
    warnings.push('The timer is healthy, but the pet window is hidden because pet recognition or the companion worker is unavailable.');
  }
  if (gptRunning && timerPanelVisible === false) {
    warnings.push(mainWindowFallbackAnchor
      ? `Codex is running, but no pet window or supported voice-host geometry was found, so the timer panel is hidden. Anchor diagnostic: ${companion?.visualAnchorDiagnostic || 'unavailable'}.`
      : 'Codex is running, but the timer panel is hidden. The pet may be hidden or its anchor may not be recognized.');
  }
  const result = {
    ok: permission !== 'disallowed' && supervisorMatchesLaunchd && !!supervisor &&
      supervisor.service === 'running' && timerRunning && runtime.ok,
    warnings,
    backgroundPermission: permission,
    launchAgent: { label: LABEL, path: PLIST_PATH, loaded: launchctl.loaded, running: launchctl.running, pid: launchctl.pid },
    supervisor: supervisor || { service: 'not-running' },
    pet: {
      ...(companion || { engineState: 'stopped', anchorFound: false, windowVisible: false }),
      petAnchorFound,
      mainWindowFallbackAnchor,
      visualAnchorDiagnostic: companion?.visualAnchorDiagnostic ?? null,
      timerPanelVisible,
      expected: !!gptRunning,
      healthy: petHealthy,
      workerState: supervisor?.companion || 'waiting',
    },
    runtime,
    stateDir: paths.URD_STATE_DIR,
  };
  if (permission === 'disallowed') {
    result.action = 'Open System Settings > General > Login Items & Extensions and allow Pet Pomodoro Companion to run in the background. Then run codex-pet-companion repair.';
  } else if (!launchctl.running) {
    result.action = 'Run codex-pet-companion start after confirming the background item is allowed.';
  } else if (!supervisorMatchesLaunchd) {
    result.action = 'Supervisor status is stale or belongs to another process. Run codex-pet-companion repair.';
  } else if (supervisor && !timerRunning) {
    result.action = 'Inspect ~/.codex/ultradian-rhythm/supervisor.log and runtime-manifest.json, then run codex-pet-companion repair.';
  } else if (!runtime.ok) {
    result.action = 'The pinned runtime failed its integrity check. Reinstall from a trusted source, then run doctor again.';
  } else if (permission === 'unknown') {
    result.action = 'Check Pet Pomodoro Companion under System Settings > General > Login Items & Extensions, then run doctor again.';
  } else if (gptRunning && timerPanelVisible === false && mainWindowFallbackAnchor) {
    result.action = 'Show the Codex pet. The main app window exists, but no pet window or supported voice-host window geometry was found; the timer stays hidden rather than guessing a screen location.';
  } else if (gptRunning && timerPanelVisible === false) {
    result.action = 'Show the Codex pet. If the timer remains hidden, run codex-pet-companion repair and check pet anchor diagnostics.';
  } else if (!petHealthy) {
    result.action = 'Inspect pet status and supervisor.log. The timer remains active; the pet window stays hidden until detection recovers.';
  }
  return result;
}

function ensureAllowed() {
  const permission = backgroundPermission();
  if (permission === 'disallowed') {
    throw new Error('macOS has disallowed this background item. Enable Pet Pomodoro Companion in System Settings > General > Login Items & Extensions, then run repair. The service will not bypass this setting.');
  }
}

function start() {
  ensureAllowed();
  const uid = process.getuid();
  const current = launchctlPrint(uid);
  if (current.loaded && /(?:job )?state = running/.test(current.output)) return { started: true, alreadyRunning: true };
  if (!current.loaded) run(LAUNCHCTL, ['bootstrap', `gui/${uid}`, PLIST_PATH]);
  run(LAUNCHCTL, ['kickstart', `gui/${uid}/${LABEL}`]);
  return { started: true, alreadyRunning: false };
}

function stop() {
  const uid = process.getuid();
  const current = launchctlPrint(uid);
  if (!current.loaded) return { stopped: true, alreadyStopped: true };
  run(LAUNCHCTL, ['bootout', `gui/${uid}/${LABEL}`]);
  return { stopped: true, alreadyStopped: false };
}

function repair() {
  ensureAllowed();
  if (!fs.existsSync(PLIST_PATH)) throw new Error(`LaunchAgent plist is missing: ${PLIST_PATH}`);
  const uid = process.getuid();
  const current = launchctlPrint(uid);
  if (!current.loaded) run(LAUNCHCTL, ['bootstrap', `gui/${uid}`, PLIST_PATH]);
  run(LAUNCHCTL, ['kickstart', '-k', `gui/${uid}/${LABEL}`]);
  return { repaired: true, action: 'supervisor restarted; timer state remains persisted' };
}

module.exports = { LABEL, PLIST_PATH, backgroundPermission, verifyRuntimeManifest, doctor, start, stop, repair };
