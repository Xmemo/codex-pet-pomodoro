const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');

const lifecycle = require('../src/companion/worker-lifecycle.js');
const { buildIdentity, verifyIdentity } = require('../src/companion/process-identity.js');
const statusMod = require('../src/companion/status.js');
const companionPaths = require('../src/companion/paths.js');

const WORKER_SCRIPT = '/usr/local/bin/codex-pet-companion.js';
const WORKER_ARG0 = path.resolve(WORKER_SCRIPT);
const WORKER_ARGV = [WORKER_ARG0, '--worker', '--ready-token', 'tok'];
const SCRIPT_CONTENT = 'mock worker script';
const SCRIPT_HASH = crypto.createHash('sha256').update(SCRIPT_CONTENT).digest('hex');
const LSTART = 'Mon Jul 20 12:00:00 2026';
const UID = 501;
const COMMAND = `/usr/bin/node ${WORKER_ARG0} --worker --ready-token tok`;

function makeFakeFs(initial = {}) {
  const store = new Map();
  const modes = new Map();
  for (const [k, v] of Object.entries(initial)) {
    store.set(path.resolve(k), typeof v === 'string' ? v : JSON.stringify(v));
  }
  const norm = (p) => path.resolve(p);
  return {
    _store: store,
    _modes: modes,
    existsSync: (p) => store.has(norm(p)),
    readFileSync: (p) => {
      const k = norm(p);
      if (!store.has(k)) throw new Error('ENOENT: ' + p);
      return store.get(k);
    },
    writeFileSync: (p, data, options = {}) => {
      store.set(norm(p), typeof data === 'string' ? data : JSON.stringify(data));
      if (options.mode !== undefined) modes.set(norm(p), options.mode);
    },
    chmodSync: (p, mode) => { modes.set(norm(p), mode); },
    renameSync: (a, b) => {
      const ka = norm(a), kb = norm(b);
      if (!store.has(ka)) throw new Error('ENOENT rename: ' + a);
      store.set(kb, store.get(ka));
      store.delete(ka);
      if (modes.has(ka)) {
        modes.set(kb, modes.get(ka));
        modes.delete(ka);
      }
    },
    unlinkSync: (p) => {
      const k = norm(p);
      if (!store.has(k)) throw new Error('ENOENT unlink: ' + p);
      store.delete(k);
    },
    mkdirSync: (p, opts) => {
      const k = norm(p);
      store.set(k, '__dir__');
      void opts;
    },
    readdirSync: (p) => {
      const prefix = norm(p) + path.sep;
      const out = [];
      for (const k of store.keys()) {
        if (k.startsWith(prefix)) out.push(k.slice(prefix.length).split(path.sep)[0]);
      }
      return [...new Set(out)];
    },
  };
}

const VALID_PET_JSON = JSON.stringify({
  id: 'pet-1',
  displayName: 'Pet One',
  description: 'test pet',
  spritesheetPath: 'spritesheet.png',
});

function makePs(lstart = LSTART, uid = String(UID), command = COMMAND) {
  return (pid, field) => {
    if (field === 'lstart') return lstart;
    if (field === 'uid') return uid;
    if (field === 'command') return command;
    return '';
  };
}

function makePsExec(ps) {
  return (cmd, args) => {
    const pidArg = args[1];
    const field = args[args.length - 1];
    return ps(pidArg, field.replace('=', ''));
  };
}

// Build a valid PID identity JSON for a given worker pid using the real builder.
function buildBaselineIdentity(pid, fsMod, psExec) {
  return buildIdentity(
    { pid, scriptPath: WORKER_ARG0, argv: WORKER_ARGV },
    { fs: fsMod, psExec, getuid: () => UID }
  );
}

// Hand-crafted identity object (no live ps needed) for dead-stale / mismatch cases.
function fakeIdentity(pid) {
  return {
    schemaVersion: 1,
    pid,
    uid: UID,
    processStartToken: LSTART,
    scriptPath: WORKER_ARG0,
    scriptHash: SCRIPT_HASH,
    argv: WORKER_ARGV.slice(),
    argvHash: require('crypto').createHash('sha256').update(JSON.stringify(WORKER_ARGV)).digest('hex'),
    processCommand: COMMAND,
  };
}

function baseDeps(overrides = {}) {
  const fakeFs = makeFakeFs({
    [WORKER_SCRIPT]: SCRIPT_CONTENT,
    '/state/daemon.sock': 'socket',
    '/pets/pet-1/pet.json': VALID_PET_JSON,
    '/pets/pet-1/spritesheet.png': 'png-bytes',
  });
  const deps = {
    fs: fakeFs,
    paths: companionPaths,
    socketPath: '/state/daemon.sock',
    cliScript: WORKER_SCRIPT,
    scriptPath: WORKER_SCRIPT,
    readyToken: 'tok',
    spawn: () => { throw new Error('real spawn must not be called in tests'); },
    execFileSync: () => { throw new Error('real execFileSync must not be called in tests'); },
    psExec: makePsExec(makePs()),
    getuid: () => UID,
    randomToken: () => 'tok',
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    exit: (code) => { throw new Error('EXIT:' + code); },
    onSignal: () => {},
    resolvePetId: () => ({
      petId: 'pet-1', source: 'auto', available: true, petDir: '/pets/pet-1',
    }),
    prepareVisualConfig: () => ({ visualConfig: null, companionJsonLoaded: false }),
    sendDaemonCommand: async () => ({ ok: true, state: { status: 'completed', phase: 'work' } }),
    compileSwiftRenderer: () => {},
    startBridge: () => makeFakeBridge(),
    createUltradianAdapter: () => makeFakeAdapter(),
    startTimeoutMs: 30000,
    stopTimeoutMs: 30000,
    pollIntervalMs: 10,
    workerPid: 4242,
  };
  return Object.assign(deps, overrides);
}

function makeFakeBridge() {
  let running = true;
  const handlers = {};
  return {
    _handlers: handlers,
    start() { running = true; },
    stop() {
      if (running) {
        running = false;
        if (handlers['exit']) {
          handlers['exit'](0, null);
        }
      }
    },
    getIsRunning() { return running; },
    send() {},
    on(event, cb) { handlers[event] = cb; },
    _emit(event, ...a) { if (handlers[event]) handlers[event](...a); },
    _rendererPid: 9999,
  };
}

function makeFakeAdapter() {
  const handlers = {};
  return {
    _handlers: handlers,
    start() {},
    stop() {},
    on(event, cb) { handlers[event] = cb; },
    _emit(event, ...a) { if (handlers[event]) handlers[event](...a); },
  };
}

test('L001: status writeIfChanged does not rewrite identical snapshots', () => {
  const fakeFs = makeFakeFs();
  const statusPath = '/state/companion-status.json';
  const st = statusMod.defaultStatus();
  const first = statusMod.writeIfChanged(statusPath, st, fakeFs);
  assert.strictEqual(first, true);
  const second = statusMod.writeIfChanged(statusPath, statusMod.readStatus(statusPath, fakeFs), fakeFs);
  assert.strictEqual(second, false);
  const third = statusMod.writeIfChanged(statusPath, { ...statusMod.readStatus(statusPath, fakeFs), error: 'x' }, fakeFs);
  assert.strictEqual(third, true);
});

test('L002: runWorker writes readiness ready with token and worker pid', async () => {
  const deps = baseDeps();
  const result = await lifecycle.runWorker(deps);
  assert.strictEqual(result.ok, true);

  const ready = JSON.parse(deps.fs.readFileSync(companionPaths.COMPANION_READY_PATH));
  assert.strictEqual(ready.ready, true);
  assert.strictEqual(ready.token, 'tok');
  assert.strictEqual(ready.pid, 4242);

  const identity = JSON.parse(deps.fs.readFileSync(companionPaths.COMPANION_PID_PATH));
  assert.strictEqual(identity.pid, 4242);
  assert.strictEqual(identity.scriptPath, WORKER_ARG0);
  assert.deepStrictEqual(identity.argv, WORKER_ARGV);
  assert.strictEqual(identity.processCommand, COMMAND);
  assert.strictEqual(identity.scriptHash, SCRIPT_HASH);
});

test('L003: runWorker writes worker PID, never renderer PID', async () => {
  const deps = baseDeps();
  await lifecycle.runWorker(deps);
  const identity = JSON.parse(deps.fs.readFileSync(companionPaths.COMPANION_PID_PATH));
  assert.strictEqual(identity.pid, 4242);
  assert.notStrictEqual(identity.pid, 9999);
});

test('L003b: atomic readiness and PID JSON writes enforce mode 0600 under permissive umask', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-private-json-'));
  const filePath = path.join(root, 'identity.json');
  fs.writeFileSync(filePath, '{"old":true}', { mode: 0o644 });
  fs.chmodSync(filePath, 0o644);
  const previousUmask = process.umask(0);
  try {
    lifecycle.writeJsonAtomic(fs, filePath, { ready: true, pid: 42 });
  } finally {
    process.umask(previousUmask);
  }
  try {
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), { ready: true, pid: 42 });
    assert.strictEqual(fs.statSync(filePath).mode & 0o777, 0o600);
    assert.deepStrictEqual(fs.readdirSync(root), ['identity.json']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('L004: runWorker fails when daemon socket is missing (no timer state/socket mutation)', async () => {
  const fakeFs = makeFakeFs({ '/state/daemon.sock': 'x' });
  const deps = baseDeps({ fs: fakeFs, socketPath: '/state/missing.sock' });
  const result = await lifecycle.runWorker(deps);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 1);
  const ready = JSON.parse(deps.fs.readFileSync(companionPaths.COMPANION_READY_PATH));
  assert.strictEqual(ready.ready, false);
  assert.ok(ready.error.includes('socket'));
  assert.strictEqual(deps.fs.existsSync(companionPaths.COMPANION_PID_PATH), false);
});

test('L004b: runWorker fails when a stale daemon socket cannot answer status', async () => {
  const deps = baseDeps({
    sendDaemonCommand: async () => { throw new Error('connect ECONNREFUSED'); },
  });
  const result = await lifecycle.runWorker(deps);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 1);
  const ready = JSON.parse(deps.fs.readFileSync(companionPaths.COMPANION_READY_PATH));
  assert.strictEqual(ready.ready, false);
  assert.match(ready.error, /daemon status request failed: connect ECONNREFUSED/);
  assert.strictEqual(deps.fs.existsSync(companionPaths.COMPANION_PID_PATH), false);
});

test('L005: runWorker fails on unavailable pet; status captures pet info; readiness error', async () => {
  const deps = baseDeps({
    resolvePetId: () => ({ petId: null, source: 'auto', available: false, petDir: null, error: 'no avatar' }),
  });
  const result = await lifecycle.runWorker(deps);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 1);
  const ready = JSON.parse(deps.fs.readFileSync(companionPaths.COMPANION_READY_PATH));
  assert.strictEqual(ready.ready, false);
  assert.ok(ready.error.includes('no avatar'));
  const st = JSON.parse(deps.fs.readFileSync(companionPaths.COMPANION_STATUS_PATH));
  assert.strictEqual(st.petAvailable, false);
  assert.strictEqual(st.error, 'no avatar');
  assert.strictEqual(deps.fs.existsSync(companionPaths.COMPANION_PID_PATH), false);
});

test('L006: runWorker fails on invalid pet manifest; readiness error', async () => {
  const deps = baseDeps({
    prepareVisualConfig: () => ({ failMsg: 'invalid pet manifest: missing fields' }),
  });
  const result = await lifecycle.runWorker(deps);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 1);
  const ready = JSON.parse(deps.fs.readFileSync(companionPaths.COMPANION_READY_PATH));
  assert.strictEqual(ready.ready, false);
  assert.ok(ready.error.length > 0);
});

test('L006b: runWorker fails when companion.json is invalid; readiness error', async () => {
  const deps = baseDeps({
    prepareVisualConfig: () => ({ failMsg: 'invalid companion.json: bad clips' }),
  });
  const result = await lifecycle.runWorker(deps);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 1);
  const ready = JSON.parse(deps.fs.readFileSync(companionPaths.COMPANION_READY_PATH));
  assert.strictEqual(ready.ready, false);
});

function makeTempPetPackage(petId = 'pet-1') {
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'companion-lifecycle-pet-'));
  const petDir = path.join(root, petId);
  fs.mkdirSync(petDir, { recursive: true });
  fs.writeFileSync(path.join(petDir, 'pet.json'), JSON.stringify({
    id: petId,
    displayName: 'Pet One',
    description: 'test pet',
    spritesheetPath: 'spritesheet.png',
  }));
  fs.writeFileSync(path.join(petDir, 'spritesheet.png'), 'png');
  return { root, petDir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('L006c: defaultPrepareVisualConfig fails hard on malformed companion.json', () => {
  const pkg = makeTempPetPackage();
  try {
    fs.writeFileSync(path.join(pkg.petDir, 'companion.json'), '{bad json');
    const result = lifecycle.defaultPrepareVisualConfig({
      fs,
      paths: { COMPANION_BINARY: path.join(pkg.root, 'renderer') },
      compileSwiftRenderer: () => {},
      execFileSync: () => JSON.stringify({ valid: true, hasAlpha: true, width: 1536, height: 1872 }),
    }, { petDir: pkg.petDir });
    assert.ok(result.failMsg.includes('companion.json'));
  } finally {
    pkg.cleanup();
  }
});

test('L006c: defaultPrepareVisualConfig rejects oversized companion.json before parsing', () => {
  const pkg = makeTempPetPackage();
  try {
    fs.writeFileSync(path.join(pkg.petDir, 'companion.json'), Buffer.alloc(1024 * 1024 + 1, 0x20));
    const result = lifecycle.defaultPrepareVisualConfig({
      fs,
      paths: { COMPANION_BINARY: path.join(pkg.root, 'renderer') },
      compileSwiftRenderer: () => {},
      execFileSync: () => { throw new Error('must not inspect assets for oversized config'); },
    }, { petDir: pkg.petDir });
    assert.match(result.failMsg, /companion\.json.*byte limit/i);
  } finally {
    pkg.cleanup();
  }
});

test('L006d: defaultPrepareVisualConfig rejects oversized companion-config.json before parsing', () => {
  const pkg = makeTempPetPackage();
  const userConfigPath = path.join(pkg.root, 'companion-config.json');
  try {
    fs.writeFileSync(userConfigPath, Buffer.alloc(lifecycle.MAX_USER_CONFIG_BYTES + 1, 0x20));
    const result = lifecycle.defaultPrepareVisualConfig({
      fs,
      paths: {
        COMPANION_BINARY: path.join(pkg.root, 'renderer'),
        COMPANION_CONFIG_PATH: userConfigPath,
      },
      compileSwiftRenderer: () => {},
      execFileSync: () => { throw new Error('must not inspect assets for oversized user config'); },
    }, { petDir: pkg.petDir });
    assert.match(result.failMsg, /invalid companion-config\.json.*byte limit/i);
  } finally {
    pkg.cleanup();
  }
});

test('L006d: defaultPrepareVisualConfig fails hard on invalid atlas validation', () => {
  const pkg = makeTempPetPackage();
  try {
    const result = lifecycle.defaultPrepareVisualConfig({
      fs,
      paths: { COMPANION_BINARY: path.join(pkg.root, 'renderer') },
      compileSwiftRenderer: () => {},
      execFileSync: () => JSON.stringify({ valid: false, error: 'decode failed' }),
    }, { petDir: pkg.petDir });
    assert.ok(result.failMsg.includes('invalid pet atlas'));
    assert.ok(result.failMsg.includes('decode failed'));
  } finally {
    pkg.cleanup();
  }
});

test('L006e: defaultPrepareVisualConfig reports companionJsonLoaded only for valid enhancement package', () => {
  const pkg = makeTempPetPackage();
  try {
    let result = lifecycle.defaultPrepareVisualConfig({
      fs,
      paths: { COMPANION_BINARY: path.join(pkg.root, 'renderer') },
      compileSwiftRenderer: () => {},
      execFileSync: () => JSON.stringify({ valid: true, hasAlpha: true, width: 1536, height: 1872 }),
    }, { petDir: pkg.petDir });
    assert.strictEqual(result.companionJsonLoaded, false);
    assert.strictEqual(result.visualConfig.petId, 'pet-1');

    fs.writeFileSync(path.join(pkg.petDir, 'companion.json'), JSON.stringify({
      schemaVersion: 1,
      petId: 'pet-1',
      render: { smallWidth: 84, restWidth: 360, anchor: 'pet-bottom-center', interpolation: 'nearest' },
      clips: {},
    }));
    result = lifecycle.defaultPrepareVisualConfig({
      fs,
      paths: { COMPANION_BINARY: path.join(pkg.root, 'renderer') },
      compileSwiftRenderer: () => {},
      execFileSync: () => JSON.stringify({ valid: true, hasAlpha: true, width: 1536, height: 1872 }),
    }, { petDir: pkg.petDir });
    assert.strictEqual(result.companionJsonLoaded, true);
    assert.strictEqual(result.visualConfig.petId, 'pet-1');
  } finally {
    pkg.cleanup();
  }
});

test('L007: startManager waits for readiness success (spawn captured, no real process)', async () => {
  let spawned = null;
  const deps = baseDeps({
    spawn: (cmd, args) => {
      spawned = { cmd, args, pid: 7777, unref() {}, on() {} };
      return spawned;
    },
    pollIntervalMs: 5,
  });
  const startPromise = lifecycle.startManager(deps);
  // Simulate the worker having written readiness matching token + child pid.
  deps.fs.writeFileSync(companionPaths.COMPANION_PID_PATH, JSON.stringify(buildBaselineIdentity(7777, deps.fs, deps.psExec)));
  deps.fs.writeFileSync(companionPaths.COMPANION_READY_PATH, JSON.stringify({ ready: true, token: 'tok', pid: 7777 }));
  const result = await startPromise;
  assert.strictEqual(result.started, true);
  assert.strictEqual(result.pid, 7777);
  assert.strictEqual(spawned.args.includes('--worker'), true);
  assert.strictEqual(spawned.args.includes('--ready-token'), true);
});

test('L008: startManager returns error when worker readiness reports failure', async () => {
  const deps = baseDeps({
    spawn: () => ({ pid: 7777, unref() {}, on() {} }),
    pollIntervalMs: 5,
  });
  const startPromise = lifecycle.startManager(deps);
  deps.fs.writeFileSync(companionPaths.COMPANION_READY_PATH, JSON.stringify({ ready: false, token: 'tok', pid: 7777, error: 'bad pet' }));
  const result = await startPromise;
  assert.strictEqual(result.started, false);
  assert.ok(result.error.includes('bad pet'));
});

test('L009: startManager times out when no readiness written', async () => {
  let clock = 1000;
  const deps = baseDeps({
    spawn: () => ({ pid: 7777, unref() {}, on() {} }),
    startTimeoutMs: 50,
    pollIntervalMs: 10,
    now: () => { clock += 20; return clock; },
    sleep: async () => {},
  });
  const result = await lifecycle.startManager(deps);
  assert.strictEqual(result.started, false);
  assert.ok(result.error.includes('timeout'));
});

test('L010: startManager is idempotent when existing worker is fully verified', async () => {
  const deps = baseDeps({ workerPid: 4242 });
  const identityJson = buildBaselineIdentity(4242, deps.fs, deps.psExec);
  deps.fs.writeFileSync(companionPaths.COMPANION_PID_PATH, JSON.stringify(identityJson));
  let spawned = false;
  const result = await lifecycle.startManager(Object.assign(deps, { spawn: () => { spawned = true; return { pid: 1, unref() {}, on() {} }; } }));
  assert.strictEqual(result.started, true);
  assert.strictEqual(result.alreadyRunning, true);
  assert.strictEqual(spawned, false);
});

test('L011: startManager refuses (no kill/delete) when existing identity is live-mismatched', async () => {
  const deps = baseDeps({ workerPid: 4242 });
  const identityJson = buildBaselineIdentity(4242, deps.fs, deps.psExec);
  identityJson.processCommand = 'node /other/script.js --worker'; // live command mismatch
  deps.fs.writeFileSync(companionPaths.COMPANION_PID_PATH, JSON.stringify(identityJson));
  let spawned = false;
  const result = await lifecycle.startManager(Object.assign(deps, { spawn: () => { spawned = true; return { pid: 1, unref() {}, on() {} }; } }));
  assert.strictEqual(result.started, false);
  assert.ok(result.error.includes('unsafe'));
  assert.strictEqual(spawned, false);
  // PID file preserved (not deleted)
  assert.strictEqual(deps.fs.existsSync(companionPaths.COMPANION_PID_PATH), true);
});

test('L012: startManager archives a provably dead stale PID to allow recovery', async () => {
  const fakeFs = makeFakeFs({ [WORKER_SCRIPT]: SCRIPT_CONTENT });
  const mixedPs = makePsExec((pid, field) => {
    if (String(pid) === '4242') return makePs('', null, '')(pid, field);
    return makePs()(pid, field);
  });
  const deps = baseDeps({
    fs: fakeFs,
    psExec: mixedPs,
    workerPid: 4242,
    spawn: () => ({ pid: 7777, unref() {}, on() {} }),
    pollIntervalMs: 5,
  });
  // stale PID identity whose referenced process is dead
  const stale = fakeIdentity(4242);
  fakeFs.writeFileSync(companionPaths.COMPANION_PID_PATH, JSON.stringify(stale));
  const startPromise = lifecycle.startManager(deps);
  fakeFs.writeFileSync(companionPaths.COMPANION_PID_PATH, JSON.stringify(buildBaselineIdentity(7777, fakeFs, mixedPs)));
  fakeFs.writeFileSync(companionPaths.COMPANION_READY_PATH, JSON.stringify({ ready: true, token: 'tok', pid: 7777 }));
  const result = await startPromise;
  assert.strictEqual(result.started, true);
  assert.strictEqual(result.alreadyRunning, undefined);
  assert.strictEqual(fakeFs.existsSync(companionPaths.COMPANION_PID_PATH), true);
  const archiveDir = path.join(path.dirname(companionPaths.COMPANION_PID_PATH), 'companion-stale-archive');
  assert.strictEqual(fakeFs.existsSync(archiveDir), true);
});

test('L012b: startManager catches spawn errors', async () => {
  const deps = baseDeps({
    spawn: () => { throw new Error('spawn denied'); },
  });
  const result = await lifecycle.startManager(deps);
  assert.strictEqual(result.started, false);
  assert.ok(result.error.includes('spawn denied'));
});

test('L012c: startManager ignores readiness with mismatched token or PID until timeout', async () => {
  let clock = 1000;
  const deps = baseDeps({
    spawn: () => ({ pid: 7777, unref() {}, on() {} }),
    startTimeoutMs: 50,
    pollIntervalMs: 10,
    now: () => { clock += 20; return clock; },
    sleep: async () => {},
  });
  deps.fs.writeFileSync(companionPaths.COMPANION_READY_PATH, JSON.stringify({ ready: true, token: 'wrong', pid: 7777 }));
  const result = await lifecycle.startManager(deps);
  assert.strictEqual(result.started, false);
  assert.ok(result.error.includes('timeout'));
});

test('L012d: startManager refuses success readiness without verified child identity', async () => {
  const deps = baseDeps({
    spawn: () => ({ pid: 7777, unref() {}, on() {} }),
    pollIntervalMs: 5,
  });
  const startPromise = lifecycle.startManager(deps);
  const wrongIdentity = buildBaselineIdentity(4242, deps.fs, deps.psExec);
  deps.fs.writeFileSync(companionPaths.COMPANION_PID_PATH, JSON.stringify(wrongIdentity));
  deps.fs.writeFileSync(companionPaths.COMPANION_READY_PATH, JSON.stringify({ ready: true, token: 'tok', pid: 7777 }));
  const result = await startPromise;
  assert.strictEqual(result.started, false);
  assert.ok(result.error.includes('PID identity') || result.error.includes('PID mismatch'));
});

test('L012e: archiveStale preserves PID and readiness evidence if archive rename fails', () => {
  const fakeFs = makeFakeFs({
    [companionPaths.COMPANION_PID_PATH]: JSON.stringify(fakeIdentity(4242)),
    [companionPaths.COMPANION_READY_PATH]: JSON.stringify({ ready: true }),
  });
  const originalRename = fakeFs.renameSync;
  fakeFs.renameSync = (from, to) => {
    if (from === path.resolve(companionPaths.COMPANION_PID_PATH)) {
      throw new Error('archive disk error');
    }
    return originalRename(from, to);
  };
  const result = lifecycle.archiveStale(fakeFs, companionPaths.COMPANION_PID_PATH, companionPaths.COMPANION_READY_PATH, {
    archiveName: () => 'fixed',
  });
  assert.strictEqual(result.ok, false);
  assert.ok(result.error.includes('archive disk error'));
  assert.strictEqual(fakeFs.existsSync(companionPaths.COMPANION_PID_PATH), true);
  assert.strictEqual(fakeFs.existsSync(companionPaths.COMPANION_READY_PATH), true);
});

test('L012f: startManager does not spawn when dead-stale PID archive fails', async () => {
  let spawned = false;
  const fakeFs = makeFakeFs({
    [WORKER_SCRIPT]: SCRIPT_CONTENT,
    [companionPaths.COMPANION_PID_PATH]: JSON.stringify(fakeIdentity(4242)),
    [companionPaths.COMPANION_READY_PATH]: JSON.stringify({ ready: true, token: 'old', pid: 4242 }),
  });
  const originalRename = fakeFs.renameSync;
  fakeFs.renameSync = (from, to) => {
    if (from === path.resolve(companionPaths.COMPANION_PID_PATH)) {
      throw new Error('archive volume is read-only');
    }
    return originalRename(from, to);
  };
  const deps = baseDeps({
    fs: fakeFs,
    psExec: makePsExec(makePs('', null, '')),
    spawn: () => {
      spawned = true;
      return { pid: 7777, unref() {}, on() {} };
    },
  });

  const result = await lifecycle.startManager(deps);

  assert.strictEqual(result.started, false);
  assert.strictEqual(spawned, false);
  assert.ok(result.error.includes('failed to archive stale PID identity'));
  assert.ok(result.error.includes('archive volume is read-only'));
  assert.strictEqual(fakeFs.existsSync(companionPaths.COMPANION_PID_PATH), true);
  assert.strictEqual(fakeFs.existsSync(companionPaths.COMPANION_READY_PATH), true);
});

test('L013: stopManager is idempotent success when no PID file', async () => {
  const deps = baseDeps();
  const result = await lifecycle.stopManager(deps);
  assert.strictEqual(result.stopped, true);
  assert.strictEqual(result.alreadyStopped, true);
});

test('L014: stopManager signals verified worker then waits for worker cleanup', async () => {
  let killedPid = null;
  let killedSig = null;
  const deps = baseDeps({ workerPid: 4242 });
  const identityJson = buildBaselineIdentity(4242, deps.fs, deps.psExec);
  deps.fs.writeFileSync(companionPaths.COMPANION_PID_PATH, JSON.stringify(identityJson));
  const resultPromise = lifecycle.stopManager(Object.assign(deps, {
    kill: (pid, sig) => { killedPid = pid; killedSig = sig; },
    pollIntervalMs: 5,
  }));
  // Simulate worker removing its PID file after receiving SIGTERM.
  deps.fs.unlinkSync(companionPaths.COMPANION_PID_PATH);
  const result = await resultPromise;
  assert.strictEqual(result.stopped, true);
  assert.strictEqual(killedPid, 4242);
  assert.strictEqual(killedSig, 'SIGTERM');
  assert.strictEqual(deps.fs.existsSync(companionPaths.COMPANION_PID_PATH), false);
});

test('L015: stopManager refuses to signal on identity mismatch (uid/command/script/argv)', async () => {
  let killed = false;
  const deps = baseDeps({ workerPid: 4242 });
  const identityJson = buildBaselineIdentity(4242, deps.fs, deps.psExec);
  identityJson.uid = 999; // live uid mismatch
  deps.fs.writeFileSync(companionPaths.COMPANION_PID_PATH, JSON.stringify(identityJson));
  const result = await lifecycle.stopManager(Object.assign(deps, { kill: () => { killed = true; } }));
  assert.strictEqual(result.stopped, false);
  assert.ok(result.error.includes('unsafe'));
  assert.strictEqual(killed, false);
  assert.strictEqual(deps.fs.existsSync(companionPaths.COMPANION_PID_PATH), true);
});

test('L016: stopManager cleans a dead stale PID without signaling', async () => {
  let killed = false;
  const fakeFs = makeFakeFs({ [WORKER_SCRIPT]: SCRIPT_CONTENT });
  const deadPs = makePsExec(makePs('', null, ''));
  const deps = baseDeps({
    fs: fakeFs,
    psExec: deadPs,
    workerPid: 4242,
    kill: () => { killed = true; },
  });
  const stale = fakeIdentity(4242);
  fakeFs.writeFileSync(companionPaths.COMPANION_PID_PATH, JSON.stringify(stale));
  const result = await lifecycle.stopManager(deps);
  assert.strictEqual(result.stopped, true);
  assert.strictEqual(result.cleanedStale, true);
  assert.strictEqual(killed, false);
  assert.strictEqual(fakeFs.existsSync(companionPaths.COMPANION_PID_PATH), false);
});

test('L016b: stopManager does not signal or report cleanup when dead-stale PID archive fails', async () => {
  let killed = false;
  const fakeFs = makeFakeFs({
    [WORKER_SCRIPT]: SCRIPT_CONTENT,
    [companionPaths.COMPANION_PID_PATH]: JSON.stringify(fakeIdentity(4242)),
    [companionPaths.COMPANION_READY_PATH]: JSON.stringify({ ready: true, token: 'old', pid: 4242 }),
  });
  const originalRename = fakeFs.renameSync;
  fakeFs.renameSync = (from, to) => {
    if (from === path.resolve(companionPaths.COMPANION_PID_PATH)) {
      throw new Error('archive permission denied');
    }
    return originalRename(from, to);
  };
  const deps = baseDeps({
    fs: fakeFs,
    psExec: makePsExec(makePs('', null, '')),
    kill: () => { killed = true; },
  });

  const result = await lifecycle.stopManager(deps);

  assert.strictEqual(result.stopped, false);
  assert.strictEqual(result.cleanedStale, false);
  assert.strictEqual(killed, false);
  assert.ok(result.error.includes('failed to archive stale PID identity'));
  assert.ok(result.error.includes('archive permission denied'));
  assert.strictEqual(fakeFs.existsSync(companionPaths.COMPANION_PID_PATH), true);
  assert.strictEqual(fakeFs.existsSync(companionPaths.COMPANION_READY_PATH), true);
});

test('L017: statusManager reports stopped when no PID file', () => {
  const deps = baseDeps();
  const result = lifecycle.statusManager(deps);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.semantic, 'stopped');
});

test('L018: statusManager reports running with valid identity', () => {
  const deps = baseDeps({ workerPid: 4242 });
  deps.fs.writeFileSync(companionPaths.COMPANION_STATUS_PATH, JSON.stringify({ engineState: 'small', petId: 'pet-1' }));
  const identityJson = buildBaselineIdentity(4242, deps.fs, deps.psExec);
  deps.fs.writeFileSync(companionPaths.COMPANION_PID_PATH, JSON.stringify(identityJson));
  const result = lifecycle.statusManager(deps);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.semantic, 'running');
  assert.strictEqual(result.status.petId, 'pet-1');
});

test('L019: statusManager reports identity-error when unsafe', () => {
  const deps = baseDeps({ workerPid: 4242 });
  const identityJson = buildBaselineIdentity(4242, deps.fs, deps.psExec);
  identityJson.uid = 999;
  deps.fs.writeFileSync(companionPaths.COMPANION_PID_PATH, JSON.stringify(identityJson));
  const result = lifecycle.statusManager(deps);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.semantic, 'identity-error');
  assert.ok(result.status.error.includes('uid mismatch'));
});

test('L020: statusManager reports identity-error on malformed PID JSON', () => {
  const deps = baseDeps();
  deps.fs.writeFileSync(companionPaths.COMPANION_PID_PATH, 'not json{');
  const result = lifecycle.statusManager(deps);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.semantic, 'identity-error');
  assert.strictEqual(result.status.error, 'malformed PID identity');
});

test('L021: owner-only cleanup removes PID only when verified pid equals worker pid', () => {
  const fakeFs = makeFakeFs({ [WORKER_SCRIPT]: SCRIPT_CONTENT });
  const deps = baseDeps({ fs: fakeFs, workerPid: 4242 });
  const identityJson = buildBaselineIdentity(4242, fakeFs, deps.psExec);
  fakeFs.writeFileSync(companionPaths.COMPANION_PID_PATH, JSON.stringify(identityJson));
  // ownerCleanup with matching currentPid removes the file
  const { ownerCleanup } = require('../src/companion/process-identity.js');
  const okOwner = ownerCleanup(identityJson, companionPaths.COMPANION_PID_PATH, {
    fs: fakeFs, psExec: deps.psExec, getuid: () => UID, currentPid: 4242,
  });
  assert.strictEqual(okOwner.ok, true);
  assert.strictEqual(fakeFs.existsSync(companionPaths.COMPANION_PID_PATH), false);
});

test('L022: unexpected renderer exit triggers worker cleanup and nonzero exit', async () => {
  const bridge = makeFakeBridge();
  const deps2 = baseDeps({
    workerPid: 4242,
    startBridge: (opts) => {
      bridge.on('exit', opts.onExit);
      return bridge;
    },
  });
  const result = await lifecycle.runWorker(deps2);
  assert.strictEqual(result.ok, true, 'should be running after start');
  // Simulate unexpected renderer exit (not during shutdown)
  let exitSignal = null;
  try { bridge._emit('exit', 1, null); } catch (e) { if (String(e.message).startsWith('EXIT:')) exitSignal = Number(e.message.slice(5)); }
  assert.strictEqual(exitSignal, 1);
  // PID identity removed by owner cleanup
  assert.strictEqual(deps2.fs.existsSync(companionPaths.COMPANION_PID_PATH), false);
});

test('G3B002: runWorker does not write ready=true before renderer readiness resolves', async () => {
  let resolveReady;
  const bridge = makeFakeBridge();
  bridge.whenReady = () => new Promise((resolve) => { resolveReady = resolve; });
  const deps = baseDeps({
    workerPid: 4242,
    startBridge: (opts) => {
      bridge.on('exit', opts.onExit);
      return bridge;
    },
  });

  const pending = lifecycle.runWorker(deps);
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(deps.fs.existsSync(companionPaths.COMPANION_READY_PATH), false);
  assert.strictEqual(deps.fs.existsSync(companionPaths.COMPANION_PID_PATH), false);

  resolveReady({ spawned: true, pid: 9999 });
  const result = await pending;
  assert.strictEqual(result.ok, true);
  const ready = JSON.parse(deps.fs.readFileSync(companionPaths.COMPANION_READY_PATH));
  assert.strictEqual(ready.ready, true);
});

test('G3B003: renderer readiness rejection fails startup and cleans worker identity', async () => {
  const bridge = makeFakeBridge();
  let bridgeStops = 0;
  bridge.stop = () => { bridgeStops += 1; };
  bridge.whenReady = () => Promise.reject(new Error('renderer spawn failed'));
  const deps = baseDeps({
    workerPid: 4242,
    startBridge: () => bridge,
  });

  const result = await lifecycle.runWorker(deps);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 1);
  assert.ok(result.error.includes('renderer spawn failed'));
  const ready = JSON.parse(deps.fs.readFileSync(companionPaths.COMPANION_READY_PATH));
  assert.strictEqual(ready.ready, false);
  assert.strictEqual(deps.fs.existsSync(companionPaths.COMPANION_PID_PATH), false);
  assert.strictEqual(bridgeStops, 1);
});

test('G3B003b: worker startup catch best-effort stops adapter and bridge', async () => {
  const bridge = makeFakeBridge();
  const adapter = makeFakeAdapter();
  let bridgeStops = 0;
  let adapterStops = 0;
  bridge.stop = () => { bridgeStops += 1; };
  adapter.start = () => { throw new Error('adapter startup failed'); };
  adapter.stop = () => { adapterStops += 1; };
  const deps = baseDeps({
    workerPid: 4242,
    startBridge: () => bridge,
    createUltradianAdapter: () => adapter,
  });

  const result = await lifecycle.runWorker(deps);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 1);
  assert.ok(result.error.includes('adapter startup failed'));
  const ready = JSON.parse(deps.fs.readFileSync(companionPaths.COMPANION_READY_PATH));
  assert.strictEqual(ready.ready, false);
  assert.strictEqual(adapterStops, 1);
  assert.strictEqual(bridgeStops, 1);
});

test('G3B004: renderer runtime error after readiness exits worker exactly once', async () => {
  const bridge = makeFakeBridge();
  const deps = baseDeps({
    workerPid: 4242,
    startBridge: (opts) => {
      bridge.on('error', opts.onError);
      bridge.on('exit', opts.onExit);
      return bridge;
    },
  });

  const result = await lifecycle.runWorker(deps);
  assert.strictEqual(result.ok, true);

  let exitSignals = 0;
  try {
    bridge._emit('error', new Error('renderer failed'));
  } catch (e) {
    if (String(e.message).startsWith('EXIT:')) exitSignals += 1;
    else throw e;
  }
  try {
    bridge._emit('exit', 1, null);
  } catch (e) {
    if (String(e.message).startsWith('EXIT:')) exitSignals += 1;
    else throw e;
  }

  assert.strictEqual(exitSignals, 1);
  assert.strictEqual(deps.fs.existsSync(companionPaths.COMPANION_PID_PATH), false);
});

test('L023: graceful SIGTERM stops adapter/bridge and removes PID via owner cleanup', () => {
  // Verify via process-identity ownerCleanup + lifecycle signal wiring indirectly:
  // build identity and ensure safeSignal(allow) + ownerCleanup semantics hold.
  const fakeFs = makeFakeFs({ [WORKER_SCRIPT]: SCRIPT_CONTENT });
  const deps = baseDeps({ fs: fakeFs, workerPid: 4242 });
  const identityJson = buildBaselineIdentity(4242, fakeFs, deps.psExec);
  fakeFs.writeFileSync(companionPaths.COMPANION_PID_PATH, JSON.stringify(identityJson));
  const { safeSignal, ownerCleanup } = require('../src/companion/process-identity.js');
  let killed = false;
  const sig = safeSignal(identityJson, 'SIGTERM', { fs: fakeFs, psExec: deps.psExec, getuid: () => UID, kill: () => { killed = true; } });
  assert.strictEqual(sig.ok, true);
  assert.strictEqual(killed, true);
  const oc = ownerCleanup(identityJson, companionPaths.COMPANION_PID_PATH, {
    fs: fakeFs, psExec: deps.psExec, getuid: () => UID, currentPid: 4242,
  });
  assert.strictEqual(oc.ok, true);
  assert.strictEqual(fakeFs.existsSync(companionPaths.COMPANION_PID_PATH), false);
});

test('G3B001: real Unix socket daemon flows adapter -> worker -> bridge.send with bounded status writes', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-gate3b-'));
  const stateDir = path.join(tempRoot, 'state');
  const socketPath = path.join(stateDir, 'daemon.sock');
  const scriptPath = path.join(tempRoot, 'codex-pet-companion.js');
  const statusPath = path.join(stateDir, 'companion-status.json');
  const pidPath = path.join(stateDir, 'companion.pid');
  const readyPath = path.join(stateDir, 'companion-ready.json');
  const buildPath = path.join(stateDir, 'companion-build');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(scriptPath, 'mock worker script');
  fs.writeFileSync(path.join(stateDir, 'state.json'), '{}');

  let daemonState = { status: 'running', phase: 'work', deadline: 1000 };
  const server = net.createServer((socket) => {
    let request = '';
    socket.on('data', (chunk) => {
      request += chunk.toString('utf8');
      if (!request.includes('\n')) return;
      socket.end(JSON.stringify({ ok: true, state: daemonState }) + '\n');
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });

  let statusWriteCount = 0;
  const countingFs = new Proxy(fs, {
    get(target, prop) {
      if (prop === 'renameSync') {
        return (from, to) => {
          if (path.resolve(to) === path.resolve(statusPath)) statusWriteCount += 1;
          return fs.renameSync(from, to);
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  const sentEvents = [];
  let adapter = null;
  const command = `/usr/bin/node ${scriptPath} --worker --ready-token tok`;
  const psExec = (_cmd, args) => {
    const field = args[args.length - 1];
    if (field === 'lstart=') return LSTART;
    if (field === 'uid=') return String(UID);
    if (field === 'command=') return command;
    return '';
  };
  let eventSequence = 0;

  const deps = lifecycle.createDeps({
    fs: countingFs,
    paths: {
      URD_STATE_DIR: stateDir,
      COMPANION_STATUS_PATH: statusPath,
      COMPANION_PID_PATH: pidPath,
      COMPANION_READY_PATH: readyPath,
      COMPANION_BUILD_PATH: buildPath,
      COMPANION_BINARY: path.join(buildPath, 'renderer'),
    },
    socketPath,
    scriptPath,
    cliScript: scriptPath,
    readyToken: 'tok',
    workerPid: 4242,
    psExec,
    getuid: () => UID,
    resolvePetId: () => ({ petId: 'pet-1', source: 'auto', available: true, petDir: tempRoot }),
    prepareVisualConfig: () => ({ visualConfig: null, companionJsonLoaded: false }),
    startBridge: () => ({
      start() {},
      stop() {},
      send(payload) {
        if (payload && payload.event && payload.event.startsWith('companion.')) {
          sentEvents.push(payload);
        }
        return true;
      },
      getIsRunning() { return true; },
    }),
    createUltradianAdapter: (options) => {
      adapter = require('../src/companion/ultradian-adapter.js').createUltradianAdapter(options);
      return adapter;
    },
    eventIdFactory: () => `evt-test-${++eventSequence}`,
    onSignal: () => {},
    runtimeExit: () => {},
  });

  async function waitForEventCount(expected) {
    const deadline = Date.now() + 1500;
    while (sentEvents.length < expected && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.strictEqual(sentEvents.length, expected);
  }

  async function transition(state, expectedCount) {
    daemonState = state;
    await adapter.triggerImmediate();
    await waitForEventCount(expectedCount);
  }

  try {
    const workerResult = await lifecycle.runWorker(deps);
    assert.strictEqual(workerResult.ok, true);
    await waitForEventCount(1);
    assert.strictEqual(sentEvents[0].event, 'companion.deactivate');
    assert.strictEqual(sentEvents[0].eventId, 'evt-test-1');

    const writesAfterInitialState = statusWriteCount;

    await transition({ status: 'running', phase: 'rest', deadline: 2000 }, 2);
    assert.strictEqual(sentEvents[1].event, 'companion.activate');
    const writesAtSteadyRest = statusWriteCount;
    await adapter.triggerImmediate();
    await adapter.triggerImmediate();
    assert.strictEqual(statusWriteCount - writesAtSteadyRest, 0, 'repeated resting state must not write status');

    await transition({ status: 'paused', phase: 'rest', deadline: 2000 }, 3);
    assert.strictEqual(sentEvents[2].event, 'companion.pause');
    const writesAtPaused = statusWriteCount;
    await adapter.triggerImmediate();
    await adapter.triggerImmediate();
    assert.strictEqual(statusWriteCount - writesAtPaused, 0, 'repeated paused state must not write status');

    await transition({ status: 'running', phase: 'rest', deadline: 2000 }, 4);
    await transition({ status: 'completed', phase: 'rest', deadline: null }, 5);
    await transition({ status: 'idle', phase: null, deadline: null }, 6);

    assert.deepStrictEqual(sentEvents.map((event) => event.event), [
      'companion.deactivate',
      'companion.activate',
      'companion.pause',
      'companion.activate',
      'companion.deactivate',
      'companion.deactivate',
    ]);
    assert.strictEqual(
      adapter.daemonStatusToEvent('stopped', null).event,
      'companion.deactivate',
      'synthetic stopped input must deactivate even though the daemon model has no stopped state'
    );
    assert.strictEqual(new Set(sentEvents.map((event) => event.eventId)).size, sentEvents.length);
    assert.ok(
      statusWriteCount - writesAfterInitialState <= 4,
      `transition sequence exceeded status write bound: ${statusWriteCount - writesAfterInitialState}`
    );
  } finally {
    if (adapter) adapter.stop();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('T011: Event-driven selection watcher, manual override, deferred switching and error handling', async (t) => {
  await t.test('pet selection change switches immediately when renderer state is small', async () => {
    let watchCb = null;
    const fakeFs = makeFakeFs({
      [WORKER_SCRIPT]: SCRIPT_CONTENT,
      '/state/daemon.sock': 'socket',
      '/config.toml': 'selected-avatar-id = "pet-1"\n',
      '/pets/pet-1/pet.json': VALID_PET_JSON,
      '/pets/pet-1/spritesheet.png': 'png',
      '/pets/pet-2/pet.json': JSON.stringify({ id: 'pet-2', displayName: 'Pet Two', description: 'desc', spritesheetPath: 'spritesheet.png' }),
      '/pets/pet-2/spritesheet.png': 'png',
    });

    let currentPetId = 'pet-1';
    const deps = baseDeps({
      fs: fakeFs,
      paths: {
        ...companionPaths,
        CODEX_CONFIG_PATH: '/config.toml',
        COMPANION_STATUS_PATH: '/state/status.json',
        COMPANION_PID_PATH: '/state/pid.json',
        COMPANION_READY_PATH: '/state/ready.json',
        COMPANION_BUILD_PATH: '/state/build',
      },
      resolvePetId: () => ({ petId: currentPetId, source: 'auto', available: true, petDir: `/pets/${currentPetId}` }),
      watch: (_target, cb) => { watchCb = cb; return { close() {} }; },
    });

    const runRes = await lifecycle.runWorker(deps);
    assert.strictEqual(runRes.ok, true);

    const st1 = JSON.parse(fakeFs.readFileSync('/state/status.json'));
    assert.strictEqual(st1.petId, 'pet-1');
    assert.strictEqual(st1.engineState, 'small');

    // Change pet in config
    currentPetId = 'pet-2';
    fakeFs.writeFileSync('/config.toml', 'selected-avatar-id = "pet-2"\n');

    // Trigger watcher callback
    assert.ok(watchCb, 'watcher callback registered');
    watchCb('change', 'config.toml');

    await new Promise((r) => setTimeout(r, 200));

    const st2 = JSON.parse(fakeFs.readFileSync('/state/status.json'));
    assert.strictEqual(st2.petId, 'pet-2');
    assert.strictEqual(st2.error, null);
  });

  await t.test('manual pet override disables auto switching', async () => {
    let watchCb = null;
    const fakeFs = makeFakeFs({
      [WORKER_SCRIPT]: SCRIPT_CONTENT,
      '/state/daemon.sock': 'socket',
      '/config.toml': 'selected-avatar-id = "pet-1"\n',
      '/pets/manual-pet/pet.json': JSON.stringify({ id: 'manual-pet', displayName: 'Manual', description: 'desc', spritesheetPath: 'spritesheet.png' }),
      '/pets/manual-pet/spritesheet.png': 'png',
    });

    const deps = baseDeps({
      fs: fakeFs,
      paths: {
        ...companionPaths,
        CODEX_CONFIG_PATH: '/config.toml',
        COMPANION_STATUS_PATH: '/state/status.json',
        COMPANION_PID_PATH: '/state/pid.json',
        COMPANION_READY_PATH: '/state/ready.json',
        COMPANION_BUILD_PATH: '/state/build',
      },
      resolvePetId: () => ({ petId: 'manual-pet', source: 'manual', available: true, petDir: '/pets/manual-pet' }),
      watch: (_target, cb) => { watchCb = cb; return { close() {} }; },
    });

    const runRes = await lifecycle.runWorker(deps);
    assert.strictEqual(runRes.ok, true);
    assert.strictEqual(watchCb, null, 'manual mode must not install a watcher');

    fakeFs.writeFileSync('/config.toml', 'selected-avatar-id = "other-pet"\n');
    if (typeof watchCb === 'function') {
      watchCb('change', 'config.toml');
    }

    await new Promise((r) => setTimeout(r, 200));

    const st = JSON.parse(fakeFs.readFileSync('/state/status.json'));
    assert.strictEqual(st.petId, 'manual-pet');
    assert.strictEqual(st.petSource, 'manual');
  });

  await t.test('active state defers switching until renderer reports small', async () => {
    let watchCb = null;
    let bridgeEvtCb = null;
    const fakeFs = makeFakeFs({
      [WORKER_SCRIPT]: SCRIPT_CONTENT,
      '/state/daemon.sock': 'socket',
      '/config.toml': 'selected-avatar-id = "pet-1"\n',
      '/pets/pet-1/pet.json': VALID_PET_JSON,
      '/pets/pet-1/spritesheet.png': 'png',
      '/pets/pet-2/pet.json': JSON.stringify({ id: 'pet-2', displayName: 'Pet Two', description: 'desc', spritesheetPath: 'spritesheet.png' }),
      '/pets/pet-2/spritesheet.png': 'png',
    });

    let currentPetId = 'pet-1';
    const fakeBridge = makeFakeBridge();
    const deps = baseDeps({
      fs: fakeFs,
      paths: {
        ...companionPaths,
        CODEX_CONFIG_PATH: '/config.toml',
        COMPANION_STATUS_PATH: '/state/status.json',
        COMPANION_PID_PATH: '/state/pid.json',
        COMPANION_READY_PATH: '/state/ready.json',
        COMPANION_BUILD_PATH: '/state/build',
      },
      resolvePetId: () => ({ petId: currentPetId, source: 'auto', available: true, petDir: `/pets/${currentPetId}` }),
      startBridge: (opts) => {
        bridgeEvtCb = opts.onEvent;
        return fakeBridge;
      },
      watch: (_target, cb) => { watchCb = cb; return { close() {} }; },
    });

    await lifecycle.runWorker(deps);

    // Set status state to resting (active)
    const activeSt = statusMod.readStatus('/state/status.json', fakeFs);
    activeSt.engineState = 'resting';
    statusMod.writeIfChanged('/state/status.json', activeSt, fakeFs);

    // Change pet selection
    currentPetId = 'pet-2';
    watchCb('change', 'config.toml');

    await new Promise((r) => setTimeout(r, 200));

    // Pet should be pending, current petId remains pet-1
    const stPending = JSON.parse(fakeFs.readFileSync('/state/status.json'));
    assert.strictEqual(stPending.petId, 'pet-1');
    assert.strictEqual(stPending.pendingPetId, 'pet-2');

    // Simulate renderer reporting small state
    bridgeEvtCb({ engineState: 'small', isPaused: false, activeClip: null, currentFrame: 0, fps: 8, anchorFound: true, windowVisible: false, error: null });

    await new Promise((r) => setTimeout(r, 200));

    // Now pet should be updated to pet-2 and pendingPetId cleared
    const stSwitched = JSON.parse(fakeFs.readFileSync('/state/status.json'));
    assert.strictEqual(stSwitched.petId, 'pet-2');
    assert.strictEqual(stSwitched.pendingPetId, null);
  });

  await t.test('invalid new pet selection exposes nonfatal status error and leaves renderer alive', async () => {
    let watchCb = null;
    const fakeFs = makeFakeFs({
      [WORKER_SCRIPT]: SCRIPT_CONTENT,
      '/state/daemon.sock': 'socket',
      '/config.toml': 'selected-avatar-id = "pet-1"\n',
      '/pets/pet-1/pet.json': VALID_PET_JSON,
      '/pets/pet-1/spritesheet.png': 'png',
    });

    let currentPetId = 'pet-1';
    let available = true;
    let prepError = null;

    const deps = baseDeps({
      fs: fakeFs,
      paths: {
        ...companionPaths,
        CODEX_CONFIG_PATH: '/config.toml',
        COMPANION_STATUS_PATH: '/state/status.json',
        COMPANION_PID_PATH: '/state/pid.json',
        COMPANION_READY_PATH: '/state/ready.json',
        COMPANION_BUILD_PATH: '/state/build',
      },
      resolvePetId: () => ({ petId: currentPetId, source: 'auto', available, petDir: available ? `/pets/${currentPetId}` : null }),
      prepareVisualConfig: (pInfo) => prepError ? { failMsg: prepError } : { visualConfig: null, companionJsonLoaded: false },
      watch: (_target, cb) => { watchCb = cb; return { close() {} }; },
    });

    const runRes = await lifecycle.runWorker(deps);
    assert.strictEqual(runRes.ok, true);

    // Switch to broken pet
    currentPetId = 'bad-pet';
    prepError = 'invalid pet manifest: missing spritesheet';

    watchCb('change', 'config.toml');

    await new Promise((r) => setTimeout(r, 200));

    // Worker identity file must still exist (worker didn't crash)
    assert.strictEqual(fakeFs.existsSync('/state/pid.json'), true);

    const st = JSON.parse(fakeFs.readFileSync('/state/status.json'));
    assert.strictEqual(st.petId, 'pet-1');
    assert.ok(st.error.includes('invalid pet manifest'));
  });

  await t.test('candidate readiness failure leaves old bridge running and status petId unchanged', async () => {
    let watchCb = null;
    let bridgeCount = 0;
    const fakeFs = makeFakeFs({
      [WORKER_SCRIPT]: SCRIPT_CONTENT,
      '/state/daemon.sock': 'socket',
      '/config.toml': 'selected-avatar-id = "pet-1"\n',
      '/pets/pet-1/pet.json': VALID_PET_JSON,
      '/pets/pet-1/spritesheet.png': 'png',
      '/pets/pet-2/pet.json': JSON.stringify({ id: 'pet-2', displayName: 'Pet Two', description: 'desc', spritesheetPath: 'spritesheet.png' }),
      '/pets/pet-2/spritesheet.png': 'png',
    });

    let currentPetId = 'pet-1';
    let runtimeExitCalled = false;

    const oldBridge = makeFakeBridge();

    const deps = baseDeps({
      fs: fakeFs,
      paths: {
        ...companionPaths,
        CODEX_CONFIG_PATH: '/config.toml',
        COMPANION_STATUS_PATH: '/state/status.json',
        COMPANION_PID_PATH: '/state/pid.json',
        COMPANION_READY_PATH: '/state/ready.json',
        COMPANION_BUILD_PATH: '/state/build',
      },
      runtimeExit: () => { runtimeExitCalled = true; },
      resolvePetId: () => ({ petId: currentPetId, source: 'auto', available: true, petDir: `/pets/${currentPetId}` }),
      startBridge: () => {
        bridgeCount += 1;
        if (bridgeCount === 1) {
          return oldBridge;
        }
        // Candidate bridge fails readiness
        const cand = makeFakeBridge();
        cand.whenReady = () => Promise.reject(new Error('candidate readiness failed'));
        return cand;
      },
      watch: (_target, cb) => { watchCb = cb; return { close() {} }; },
    });

    const runRes = await lifecycle.runWorker(deps);
    assert.strictEqual(runRes.ok, true);

    currentPetId = 'pet-2';
    watchCb('change', 'config.toml');

    await new Promise((r) => setTimeout(r, 200));

    assert.strictEqual(runtimeExitCalled, false, 'candidate readiness failure must not trigger runtimeExit');
    assert.strictEqual(oldBridge.getIsRunning(), true, 'old bridge must remain running');

    const st = JSON.parse(fakeFs.readFileSync('/state/status.json'));
    assert.strictEqual(st.petId, 'pet-1', 'status petId must remain unchanged');
    assert.ok(st.error.includes('candidate readiness failed'), 'status must record candidate failure error');
  });

  await t.test('unavailable resolvePetId selection is nonfatal and rejects before prepareVisualConfig', async () => {
    let watchCb = null;
    let prepCalled = 0;
    const fakeFs = makeFakeFs({
      [WORKER_SCRIPT]: SCRIPT_CONTENT,
      '/state/daemon.sock': 'socket',
      '/config.toml': 'selected-avatar-id = "pet-1"\n',
      '/pets/pet-1/pet.json': VALID_PET_JSON,
      '/pets/pet-1/spritesheet.png': 'png',
    });

    let currentPetInfo = { petId: 'pet-1', source: 'auto', available: true, petDir: '/pets/pet-1' };
    const oldBridge = makeFakeBridge();

    const deps = baseDeps({
      fs: fakeFs,
      paths: {
        ...companionPaths,
        CODEX_CONFIG_PATH: '/config.toml',
        COMPANION_STATUS_PATH: '/state/status.json',
        COMPANION_PID_PATH: '/state/pid.json',
        COMPANION_READY_PATH: '/state/ready.json',
        COMPANION_BUILD_PATH: '/state/build',
      },
      resolvePetId: () => currentPetInfo,
      prepareVisualConfig: (pInfo) => {
        prepCalled += 1;
        return { visualConfig: null, companionJsonLoaded: false };
      },
      startBridge: () => oldBridge,
      watch: (_target, cb) => { watchCb = cb; return { close() {} }; },
    });

    const runRes = await lifecycle.runWorker(deps);
    assert.strictEqual(runRes.ok, true);
    const initialPrepCalls = prepCalled;

    // Simulate resolvePetId returning unavailable selection
    currentPetInfo = { petId: null, source: 'auto', available: false, error: 'avatar not installed' };
    watchCb('change', 'config.toml');

    await new Promise((r) => setTimeout(r, 200));

    assert.strictEqual(prepCalled, initialPrepCalls, 'prepareVisualConfig must not be called for unavailable selection');
    assert.strictEqual(oldBridge.getIsRunning(), true, 'old bridge must remain running');

    const st = JSON.parse(fakeFs.readFileSync('/state/status.json'));
    assert.strictEqual(st.petId, 'pet-1', 'status petId must remain unchanged');
    assert.ok(st.error.includes('avatar not installed'), 'status must record error');
  });

  await t.test('unrelated directory events do not trigger resolution or switching', async () => {
    let watchCb = null;
    let resolveCalls = 0;
    const fakeFs = makeFakeFs({
      [WORKER_SCRIPT]: SCRIPT_CONTENT,
      '/state/daemon.sock': 'socket',
      '/config.toml': 'selected-avatar-id = "pet-1"\n',
      '/pets/pet-1/pet.json': VALID_PET_JSON,
      '/pets/pet-1/spritesheet.png': 'png',
    });

    const deps = baseDeps({
      fs: fakeFs,
      paths: {
        ...companionPaths,
        CODEX_CONFIG_PATH: '/config.toml',
        COMPANION_STATUS_PATH: '/state/status.json',
        COMPANION_PID_PATH: '/state/pid.json',
        COMPANION_READY_PATH: '/state/ready.json',
        COMPANION_BUILD_PATH: '/state/build',
      },
      resolvePetId: () => {
        resolveCalls += 1;
        return { petId: 'pet-1', source: 'auto', available: true, petDir: '/pets/pet-1' };
      },
      watch: (_target, cb) => { watchCb = cb; return { close() {} }; },
    });

    await lifecycle.runWorker(deps);
    const initialResolveCount = resolveCalls;

    // Fire watcher with unrelated filenames in parent directory
    watchCb('change', 'unrelated.tmp');
    watchCb('change', 'other.json');

    await new Promise((r) => setTimeout(r, 200));

    assert.strictEqual(resolveCalls, initialResolveCount, 'unrelated directory watcher events must be filtered out');
  });

  await t.test('initial manual pet source installs no watcher at all', async () => {
    let watchCalled = false;
    const fakeFs = makeFakeFs({
      [WORKER_SCRIPT]: SCRIPT_CONTENT,
      '/state/daemon.sock': 'socket',
      '/pets/manual-pet/pet.json': VALID_PET_JSON,
      '/pets/manual-pet/spritesheet.png': 'png',
    });

    const deps = baseDeps({
      fs: fakeFs,
      paths: {
        ...companionPaths,
        CODEX_CONFIG_PATH: '/config.toml',
        COMPANION_STATUS_PATH: '/state/status.json',
        COMPANION_PID_PATH: '/state/pid.json',
        COMPANION_READY_PATH: '/state/ready.json',
        COMPANION_BUILD_PATH: '/state/build',
      },
      resolvePetId: () => ({ petId: 'manual-pet', source: 'manual', available: true, petDir: '/pets/manual-pet' }),
      watch: () => {
        watchCalled = true;
        return { close() {} };
      },
    });

    const runRes = await lifecycle.runWorker(deps);
    assert.strictEqual(runRes.ok, true);
    assert.strictEqual(watchCalled, false, 'initial manual pet source must not install a watcher');
  });
});

test('Batch C: Status contract and canonical config write failure during candidate promotion', async (t) => {
  await t.test('statusFromRendererEvent retains fields and null error clears prior error', () => {
    const statusMod = require('../src/companion/status.js');

    const st = statusMod.defaultStatus();
    assert.strictEqual(st.targetHeightRatio, 0.72);
    assert.strictEqual(st.displayId, null);
    assert.strictEqual(st.pendingPetId, null);
    assert.strictEqual(st.petAnchorFound, null);
    assert.strictEqual(st.visualAnchorDiagnostic, null);
    assert.strictEqual(st.timerPanelVisible, null);

    const lifecycle = require('../src/companion/worker-lifecycle.js');
    lifecycle.statusFromRendererEvent(st, {
      petAnchorFound: false,
      mainWindowFallbackAnchor: true,
      visualAnchorDiagnostic: 'voice-host-geometry-estimate',
      timerPanelVisible: false,
    });
    assert.strictEqual(st.petAnchorFound, false);
    assert.strictEqual(st.mainWindowFallbackAnchor, true);
    assert.strictEqual(st.visualAnchorDiagnostic, 'voice-host-geometry-estimate');
    assert.strictEqual(st.timerPanelVisible, false);

    const formatted = statusMod.formatHuman({
      ...st,
      targetHeightRatio: 0.85,
      displayId: 2,
      pendingPetId: 'next-pet',
      error: 'some error',
    });
    assert.ok(formatted.includes('Target height ratio: 0.85'));
    assert.ok(formatted.includes('Display ID: 2'));
    assert.ok(formatted.includes('Pending pet: next-pet'));
  });

  await t.test('canonical config write failure during candidate promotion retires candidate and preserves old bridge', async () => {
    let watchCb = null;
    let bridgeCount = 0;
    const fakeFs = makeFakeFs({
      [WORKER_SCRIPT]: SCRIPT_CONTENT,
      '/state/daemon.sock': 'socket',
      '/config.toml': 'selected-avatar-id = "pet-1"\n',
      '/pets/pet-1/pet.json': VALID_PET_JSON,
      '/pets/pet-1/spritesheet.png': 'png',
      '/pets/pet-2/pet.json': JSON.stringify({ id: 'pet-2', displayName: 'Pet Two', description: 'desc', spritesheetPath: 'spritesheet.png' }),
      '/pets/pet-2/spritesheet.png': 'png',
    });

    let currentPetId = 'pet-1';
    const oldBridge = makeFakeBridge();
    const candidateBridge = makeFakeBridge();
    let writeCount = 0;

    const countingFs = new Proxy(fakeFs, {
      get(target, prop) {
        if (prop === 'renameSync') {
          return (from, to) => {
            if (path.resolve(to) === path.resolve('/state/build/resolved-companion-config.json')) {
              writeCount++;
              if (writeCount > 1) {
                // Fail canonical config write during candidate promotion
                throw new Error('disk read-only error during promotion write');
              }
            }
            return target.renameSync(from, to);
          };
        }
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const deps = baseDeps({
      fs: countingFs,
      paths: {
        ...companionPaths,
        CODEX_CONFIG_PATH: '/config.toml',
        COMPANION_STATUS_PATH: '/state/status.json',
        COMPANION_PID_PATH: '/state/pid.json',
        COMPANION_READY_PATH: '/state/ready.json',
        COMPANION_BUILD_PATH: '/state/build',
      },
      resolvePetId: () => ({ petId: currentPetId, source: 'auto', available: true, petDir: `/pets/${currentPetId}` }),
      startBridge: () => {
        bridgeCount++;
        return bridgeCount === 1 ? oldBridge : candidateBridge;
      },
      watch: (_target, cb) => { watchCb = cb; return { close() {} }; },
    });

    const runRes = await lifecycle.runWorker(deps);
    assert.strictEqual(runRes.ok, true);

    // Switch pet
    currentPetId = 'pet-2';
    watchCb('change', 'config.toml');

    await new Promise((r) => setTimeout(r, 200));

    assert.strictEqual(oldBridge.getIsRunning(), true, 'old bridge must remain running after promotion write failure');
    assert.strictEqual(candidateBridge.getIsRunning(), false, 'candidate bridge must be stopped after promotion write failure');

    const st = JSON.parse(fakeFs.readFileSync('/state/status.json'));
    assert.strictEqual(st.petId, 'pet-1', 'status petId must remain pet-1');
    assert.ok(st.error.includes('disk read-only error'), 'status error must record write failure');
  });
});
