const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { sendDaemonCommand } = require('../parser.js');


const identity = require('./process-identity.js');
const companionPaths = require('./paths.js');
const statusMod = require('./status.js');
const { compileSwiftRenderer, startBridge } = require('./bridge.js');
const { createUltradianAdapter } = require('./ultradian-adapter.js');
const { parsePetManifest, validateAtlasDimensions } = require('./manifest-loader.js');
const {
  validateCompanionConfig,
  resolveClipFrames,
  getSafeRenderSettings,
} = require('./companion-config-loader.js');

const READY_TIMEOUT_MS = 30000;
const STOP_TIMEOUT_MS = 30000;
const POLL_INTERVAL_MS = 100;
const MAX_PET_MANIFEST_BYTES = 64 * 1024;
const MAX_COMPANION_CONFIG_BYTES = 1024 * 1024;
const MAX_USER_CONFIG_BYTES = 64 * 1024;

function readBoundedText(fsImpl, filePath, maxBytes, label) {
  if (typeof fsImpl.openSync === 'function' && typeof fsImpl.fstatSync === 'function'
      && typeof fsImpl.readSync === 'function' && typeof fsImpl.closeSync === 'function') {
    let fd;
    try {
      const noFollow = fsImpl.constants && fsImpl.constants.O_NOFOLLOW ? fsImpl.constants.O_NOFOLLOW : 0;
      fd = fsImpl.openSync(filePath, fsImpl.constants.O_RDONLY | noFollow);
      const stat = fsImpl.fstatSync(fd);
      if (!stat.isFile() || stat.size > maxBytes) {
        throw new Error(`${label} exceeds the ${maxBytes}-byte limit or is not a regular file`);
      }
      const chunks = [];
      const buffer = Buffer.alloc(Math.min(8192, maxBytes + 1));
      let total = 0;
      while (total <= maxBytes) {
        const length = Math.min(buffer.length, maxBytes + 1 - total);
        const bytesRead = fsImpl.readSync(fd, buffer, 0, length, null);
        if (bytesRead === 0) break;
        chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
        total += bytesRead;
      }
      if (total > maxBytes) {
        throw new Error(`${label} exceeds the ${maxBytes}-byte limit`);
      }
      return Buffer.concat(chunks, total).toString('utf8');
    } finally {
      if (fd !== undefined) fsImpl.closeSync(fd);
    }
  }

  if (typeof fsImpl.statSync === 'function') {
    const stat = fsImpl.statSync(filePath);
    if (!stat.isFile() || stat.size > maxBytes) {
      throw new Error(`${label} exceeds the ${maxBytes}-byte limit or is not a regular file`);
    }
  }
  const content = fsImpl.readFileSync(filePath, 'utf8');
  if (Buffer.byteLength(content, 'utf8') > maxBytes) {
    throw new Error(`${label} exceeds the ${maxBytes}-byte limit`);
  }
  return content;
}

function readBoundedJson(fsMod, p, maxBytes, label) {
  return JSON.parse(readBoundedText(fsMod, p, maxBytes, label));
}

function safeReadJson(fsMod, p, maxBytes = MAX_USER_CONFIG_BYTES) {
  try {
    return readBoundedJson(fsMod, p, maxBytes, path.basename(p));
  } catch (_) {
    return null;
  }
}

function defaultTempName(filePath) {
  return `${filePath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
}

function writeJsonAtomic(fsMod, filePath, obj, deps = {}) {
  const dir = path.dirname(filePath);
  if (!fsMod.existsSync(dir)) {
    fsMod.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const tmp = deps.tempName ? deps.tempName(filePath) : defaultTempName(filePath);
  try {
    if (typeof fsMod.chmodSync !== 'function') {
      throw new Error('chmodSync is required to secure companion state files');
    }
    fsMod.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fsMod.chmodSync(tmp, 0o600);
    fsMod.renameSync(tmp, filePath);
    fsMod.chmodSync(filePath, 0o600);
  } catch (err) {
    try { if (fsMod.existsSync(tmp)) fsMod.unlinkSync(tmp); } catch (_) {}
    throw err;
  }
}

function archiveStale(fsMod, pidPath, readyPath, deps = {}) {
  let pidExists;
  try {
    pidExists = fsMod.existsSync(pidPath);
  } catch (err) {
    return {
      ok: false,
      archivedPid: false,
      readinessRemoved: false,
      error: `failed to inspect stale PID identity at ${pidPath}: ${err.message}`,
    };
  }

  let archivePath = null;
  if (pidExists) {
    try {
      const archiveDir = path.join(path.dirname(pidPath), 'companion-stale-archive');
      if (!fsMod.existsSync(archiveDir)) {
        fsMod.mkdirSync(archiveDir, { recursive: true });
      }
      const stamp = deps.archiveName ? deps.archiveName() : String(deps.now ? deps.now() : Date.now());
      archivePath = path.join(archiveDir, `companion.pid.${stamp}.json`);
      fsMod.renameSync(pidPath, archivePath);
    } catch (err) {
      return {
        ok: false,
        archivedPid: false,
        readinessRemoved: false,
        error: `failed to archive stale PID identity at ${pidPath}: ${err.message}`,
      };
    }
  }

  let readinessRemoved = false;
  try {
    if (fsMod.existsSync(readyPath)) {
      fsMod.unlinkSync(readyPath);
      readinessRemoved = true;
    }
  } catch (err) {
    return {
      ok: false,
      archivedPid: pidExists,
      archivePath,
      readinessRemoved: false,
      error: `stale PID identity was archived but readiness cleanup failed at ${readyPath}: ${err.message}`,
    };
  }

  return {
    ok: true,
    archivedPid: pidExists,
    archivePath,
    readinessRemoved,
  };
}

function statusFromRendererEvent(status, ev) {
  if (ev.engineState) status.engineState = ev.engineState;
  if (ev.isPaused !== undefined) status.isPaused = ev.isPaused;
  if (ev.activeClip !== undefined) status.activeClip = ev.activeClip;
  if (ev.currentFrame !== undefined) status.currentFrame = ev.currentFrame;
  if (ev.fps !== undefined) status.fps = ev.fps;
  if (ev.anchorFound !== undefined) status.anchorFound = ev.anchorFound;
  if (ev.petAnchorFound !== undefined) status.petAnchorFound = ev.petAnchorFound;
  if (ev.mainWindowFallbackAnchor !== undefined) status.mainWindowFallbackAnchor = ev.mainWindowFallbackAnchor;
  if (ev.visualAnchorDiagnostic !== undefined) status.visualAnchorDiagnostic = ev.visualAnchorDiagnostic;
  if (ev.timerPanelVisible !== undefined) status.timerPanelVisible = ev.timerPanelVisible;
  if (ev.windowVisible !== undefined) status.windowVisible = ev.windowVisible;
  if (ev.targetHeightRatio !== undefined) status.targetHeightRatio = ev.targetHeightRatio;
  if (ev.displayId !== undefined) status.displayId = ev.displayId;
  if (ev.pendingPetId !== undefined) status.pendingPetId = ev.pendingPetId;
  if (ev.error !== undefined) status.error = ev.error;
  return status;
}

function statusFromAdapterEvent(status, payload) {
  if (payload.event === 'companion.activate') status.engineState = 'entering';
  else if (payload.event === 'companion.deactivate') status.engineState = 'exiting';
  else if (payload.event === 'companion.pause') status.engineState = 'resting';
  return status;
}

// Default visual-config preparation (Gate2 logic). Isolated behind DI so tests
// never need a real pet package or Swift renderer on disk.
function defaultPrepareVisualConfig(d, petInfo) {
  try {
    const petDir = petInfo.petDir;
    let userConfig = null;
    if (d.paths && d.paths.COMPANION_CONFIG_PATH && d.fs.existsSync(d.paths.COMPANION_CONFIG_PATH)) {
      try {
        userConfig = readBoundedJson(
          d.fs, d.paths.COMPANION_CONFIG_PATH, MAX_USER_CONFIG_BYTES, 'companion-config.json'
        );
      } catch (err) {
        return { failMsg: 'invalid companion-config.json: ' + err.message };
      }
    }
    const petJson = JSON.parse(readBoundedText(
      d.fs, path.join(petDir, 'pet.json'), MAX_PET_MANIFEST_BYTES, 'pet.json'
    ));
    const expectedPetId = (petInfo && petInfo.provider === 'builtin') ? petInfo.petId : undefined;
    const manifestResult = parsePetManifest(petDir, petJson, expectedPetId);
    if (!manifestResult.valid || !manifestResult.pet) {
      return { failMsg: 'invalid pet manifest: ' + (manifestResult.errors || []).join(', ') };
    }
    const petManifest = manifestResult.pet;
    const companionJsonPath = path.join(petDir, 'companion.json');
    let companionJson = null;
    let configResult = { valid: false, errors: [], clips: {}, render: {} };
    if (d.fs.existsSync(companionJsonPath)) {
      try {
        companionJson = JSON.parse(readBoundedText(
          d.fs, companionJsonPath, MAX_COMPANION_CONFIG_BYTES, 'companion.json'
        ));
        configResult = validateCompanionConfig(companionJson, petManifest.id, petDir);
      } catch (err) {
        return { failMsg: 'invalid companion.json: ' + err.message };
      }
    }
    if (companionJson && !configResult.valid) {
      return { failMsg: 'invalid companion.json: ' + configResult.errors.join(', ') };
    }

    const binPath = d.paths.COMPANION_BINARY;
    if (!d.fs.existsSync(binPath)) d.compileSwiftRenderer(binPath);

    let atlasRows = 9;
    try {
      const imageInfoStr = d.execFileSync(binPath, ['--test-imageio-validate', petManifest.spritesheetFullPath], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      });
      const imageInfo = JSON.parse(imageInfoStr.trim());
      if (!imageInfo.valid) {
        return { failMsg: 'invalid pet atlas: ' + (imageInfo.error || 'image validation failed') };
      }
      if (!imageInfo.hasAlpha) {
        return { failMsg: 'invalid pet atlas: spritesheet must have an alpha channel' };
      }
      const atlas = validateAtlasDimensions(imageInfo.width, imageInfo.height);
      if (!atlas.valid) {
        return { failMsg: 'invalid pet atlas: ' + atlas.errors.join(', ') };
      }
      atlasRows = atlas.rows;
    } catch (err) {
      return { failMsg: 'invalid pet atlas: ' + err.message };
    }

    const resolvedClips = resolveClipFrames(configResult, petManifest, atlasRows, petDir, binPath);
    const safeRender = getSafeRenderSettings(companionJson);

    let targetHeightRatio = safeRender.targetHeightRatio;
    let userRatioOverride = false;
    if (userConfig && userConfig.render && typeof userConfig.render.restHeightRatio === 'number' && Number.isFinite(userConfig.render.restHeightRatio) && userConfig.render.restHeightRatio >= 0.4 && userConfig.render.restHeightRatio <= 0.9) {
      targetHeightRatio = userConfig.render.restHeightRatio;
      userRatioOverride = true;
    } else if (userConfig && typeof userConfig.restHeightRatio === 'number' && Number.isFinite(userConfig.restHeightRatio) && userConfig.restHeightRatio >= 0.4 && userConfig.restHeightRatio <= 0.9) {
      targetHeightRatio = userConfig.restHeightRatio;
      userRatioOverride = true;
    } else if (userConfig && typeof userConfig.targetHeightRatio === 'number' && Number.isFinite(userConfig.targetHeightRatio) && userConfig.targetHeightRatio >= 0.4 && userConfig.targetHeightRatio <= 0.9) {
      targetHeightRatio = userConfig.targetHeightRatio;
      userRatioOverride = true;
    }

    const visualConfig = {
      petId: (petInfo && petInfo.provider === 'builtin' && petInfo.petId) ? petInfo.petId : petManifest.id,
      atlasPath: petManifest.spritesheetFullPath,
      smallWidth: safeRender.smallWidth,
      restWidth: safeRender.restWidth,
      targetHeightRatio,
      sizingMode: userRatioOverride ? 'restHeightRatio' : safeRender.sizingMode,
      interpolation: safeRender.interpolation,
      atlasRows,
      clips: resolvedClips,
    };
    return { visualConfig, companionJsonLoaded: !!companionJson && configResult.valid };
  } catch (err) {
    return { failMsg: 'pet preparation failed: ' + err.message };
  }
}

function identityDeps(d) {
  return { fs: d.fs, psExec: d.psExec, getuid: d.getuid };
}

// Hidden --worker entrypoint. Owns bridge, adapter, renderer lifecycle.
// Never writes renderer PID. Builds and atomically writes a structured PID
// identity, then atomically writes a readiness JSON tied to token + worker pid.
async function runWorker(deps) {
  const d = deps;
  if (!d.runtimeExit) d.runtimeExit = d.exit;
  const scriptPath = d.scriptPath;
  const token = d.readyToken;
  const statusPath = d.paths.COMPANION_STATUS_PATH;
  const pidPath = d.paths.COMPANION_PID_PATH;
  const readyPath = d.paths.COMPANION_READY_PATH;
  const workerPid = (typeof d.workerPid === 'number') ? d.workerPid : process.pid;

  let shuttingDown = false;
  let currentIdentity = null;
  let bridge = null;
  let currentBridgeCallbacks = null;
  let isSwitching = false;
  let adapter = null;
  let watcher = null;
  let debounceTimer = null;
  let pendingPetId = null;

  async function handleSwiftCommand(ev, activeBridge = bridge) {
    if (ev.command === 'setGoalVisibility') {
      try {
        const visible = ev.visible;
        const prefPath = d.paths.COMPANION_PANEL_PREF_PATH || path.join(d.paths.URD_STATE_DIR, 'panel-preferences.json');
        const dir = path.dirname(prefPath);
        if (!d.fs.existsSync(dir)) {
          d.fs.mkdirSync(dir, { recursive: true });
        }
        const tmp = `${prefPath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
        d.fs.writeFileSync(tmp, JSON.stringify({ goalVisible: visible }), { mode: 0o600 });
        d.fs.renameSync(tmp, prefPath);
        try {
          d.fs.chmodSync(prefPath, 0o600);
        } catch (_) {}

        if (activeBridge) {
          activeBridge.send({
            schemaVersion: 1,
            event: 'panel.preferences',
            goalVisible: visible
          });
        }
      } catch (err) {
        if (activeBridge) {
          activeBridge.send({
            schemaVersion: 1,
            event: 'timer.error',
            message: `Failed to save visibility preference: ${err.message}`
          });
        }
      }
      return;
    }

    const socketPath = d.socketPath;
    let cmdObj = null;
    if (ev.command === 'start') {
      cmdObj = {
        command: 'start',
        preset: ev.preset,
        intentionText: ev.intentionText,
        replace: ev.replace
      };
    } else if (ev.command === 'review') {
      cmdObj = {
        command: 'review',
        outcome: ev.outcome,
        text: ev.text
      };
    } else if (['pause', 'resume', 'stop'].includes(ev.command)) {
      cmdObj = {
        command: ev.command
      };
    }

    if (!cmdObj) return;

    try {
      const response = await d.sendDaemonCommand(socketPath, cmdObj);
      if (response && response.ok === false) {
        if (activeBridge) {
          activeBridge.send({
            schemaVersion: 1,
            event: 'timer.error',
            message: response.error || response.message || 'Daemon command failed'
          });
        }
      } else if (response && response.ok === true) {
        if (activeBridge && response.state) {
          activeBridge.send({
            schemaVersion: 2,
            event: 'timer.state',
            state: response.state
          });
        }
      }
    } catch (err) {
      if (activeBridge) {
        activeBridge.send({
          schemaVersion: 1,
          event: 'timer.error',
          message: err.message || 'Daemon command failed'
        });
      }
    }
  }


  function closeWatcher() {
    if (watcher) {
      try { watcher.close(); } catch (_) {}
      watcher = null;
    }
    if (debounceTimer) {
      if (typeof clearTimeout === 'function') clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  function writeReadiness(obj) {
    writeJsonAtomic(d.fs, readyPath, obj, d);
  }

  function failReadiness(errMsg, petInfo) {
    const st = statusMod.defaultStatus();
    if (petInfo) {
      st.petId = petInfo.petId;
      st.petSource = petInfo.source;
      st.petAvailable = petInfo.available;
      st.petProvider = petInfo.provider || null;
      st.cacheStatus = petInfo.cacheStatus || null;
    }
    st.error = errMsg;
    statusMod.writeIfChanged(statusPath, st, d.fs);
    writeReadiness({ ready: false, token, pid: workerPid, error: errMsg });
    return { ok: false, code: 1, error: errMsg };
  }

  function doOwnerCleanup() {
    if (!currentIdentity) return { ok: false, reason: 'no worker identity' };
    const cleaned = identity.ownerCleanup(currentIdentity, pidPath, {
      fs: d.fs,
      psExec: d.psExec,
      getuid: d.getuid,
      currentPid: workerPid,
    });
    if (cleaned.ok) {
      try {
        if (d.fs.existsSync(readyPath)) d.fs.unlinkSync(readyPath);
      } catch (_) {}
    }
    return cleaned;
  }

  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    closeWatcher();
    try { if (adapter) adapter.stop(); } catch (_) {}
    if (currentBridgeCallbacks) currentBridgeCallbacks.retired = true;
    try { if (bridge) bridge.stop(); } catch (_) {}
    doOwnerCleanup();
    d.runtimeExit(0);
  }

  function runtimeFail() {
    if (shuttingDown) return;
    shuttingDown = true;
    closeWatcher();
    try { if (adapter) adapter.stop(); } catch (_) {}
    if (currentBridgeCallbacks) currentBridgeCallbacks.retired = true;
    try { if (bridge) bridge.stop(); } catch (_) {}
    doOwnerCleanup();
    d.runtimeExit(1);
  }

  if (!d.fs.existsSync(d.socketPath)) {
    return failReadiness('daemon socket not found: ' + d.socketPath);
  }

  // A stale Unix socket survives an unclean daemon exit. Do not expose an
  // interactive panel until the daemon has answered a real status request.
  try {
    const daemonStatus = await d.sendDaemonCommand(d.socketPath, { command: 'status' });
    if (!daemonStatus || daemonStatus.ok !== true || !daemonStatus.state || typeof daemonStatus.state !== 'object') {
      return failReadiness('daemon status request returned an invalid response');
    }
  } catch (err) {
    return failReadiness('daemon status request failed: ' + (err.message || String(err)));
  }

  const petInfo = d.resolvePetId();
  if (!petInfo.available || petInfo.error) {
    return failReadiness(petInfo.error || 'pet not available', petInfo);
  }
  let visualConfig = null;
  let companionJsonLoaded = false;

  if (petInfo.available && petInfo.petDir) {
    const prep = d.prepareVisualConfig(petInfo);
    if (prep.failMsg) {
      return failReadiness(prep.failMsg, petInfo);
    }
    visualConfig = prep.visualConfig;
    companionJsonLoaded = prep.companionJsonLoaded;
  }

  const initStatus = statusMod.defaultStatus();
  initStatus.petId = petInfo.petId;
  initStatus.petSource = petInfo.source;
  initStatus.petAvailable = petInfo.available;
  initStatus.petProvider = petInfo.provider || null;
  initStatus.cacheStatus = petInfo.cacheStatus || null;
  if (petInfo.error) initStatus.error = petInfo.error;
  initStatus.companionJsonLoaded = !!companionJsonLoaded;
  if (visualConfig && visualConfig.targetHeightRatio !== undefined) {
    initStatus.targetHeightRatio = visualConfig.targetHeightRatio;
  }
  statusMod.writeIfChanged(statusPath, initStatus, d.fs);

  let resolvedConfigPath = '';
  if (d.paths && d.paths.COMPANION_BUILD_PATH) {
    resolvedConfigPath = path.join(d.paths.COMPANION_BUILD_PATH, 'resolved-companion-config.json');
    if (!d.fs.existsSync(d.paths.COMPANION_BUILD_PATH)) {
      d.fs.mkdirSync(d.paths.COMPANION_BUILD_PATH, { recursive: true });
    }
    writeJsonAtomic(d.fs, resolvedConfigPath, visualConfig, d);
  }

  async function applyPetSwitch(newPetInfo) {
    if (isSwitching) return false;
    isSwitching = true;
    try {
      if (!newPetInfo || !newPetInfo.available || newPetInfo.error) {
        const st = statusMod.readStatus(statusPath, d.fs);
        st.error = (newPetInfo && newPetInfo.error) || 'pet not available';
        st.pendingPetId = null;
        statusMod.writeIfChanged(statusPath, st, d.fs);
        pendingPetId = null;
        return false;
      }

      const prep = d.prepareVisualConfig(newPetInfo);
      if (prep.failMsg) {
        const st = statusMod.readStatus(statusPath, d.fs);
        st.error = prep.failMsg;
        st.pendingPetId = null;
        statusMod.writeIfChanged(statusPath, st, d.fs);
        pendingPetId = null;
        return false;
      }

      const candidateConfigPath = path.join(d.paths.COMPANION_BUILD_PATH, `candidate-companion-config.${Date.now()}.${Math.random().toString(36).substring(2, 8)}.json`);
      if (!d.fs.existsSync(d.paths.COMPANION_BUILD_PATH)) {
        d.fs.mkdirSync(d.paths.COMPANION_BUILD_PATH, { recursive: true });
      }
      writeJsonAtomic(d.fs, candidateConfigPath, prep.visualConfig, d);

      const candidateCallbacks = {
        promoted: false,
        retired: false,
        onEvent: (ev) => {
          if (candidateCallbacks.promoted && !candidateCallbacks.retired) {
            handleRendererEvent(ev);
          }
        },
        onError: (err) => {
          if (candidateCallbacks.promoted && !candidateCallbacks.retired) {
            handleRendererError(err);
          }
        },
        onExit: (code, signal) => {
          if (candidateCallbacks.promoted && !candidateCallbacks.retired) {
            handleRendererExit(code, signal);
          }
        },
      };

      let candidateBridge = null;
      try {
        candidateBridge = d.startBridge({
          binPath: d.paths.COMPANION_BINARY,
          extraArgs: ['--config', candidateConfigPath],
          onEvent: candidateCallbacks.onEvent,
          onError: candidateCallbacks.onError,
          onExit: candidateCallbacks.onExit,
          onCommand: (ev) => {
            if (candidateCallbacks.promoted && !candidateCallbacks.retired) {
              handleSwiftCommand(ev, candidateBridge).catch((err) => {
                if (candidateBridge) {
                  candidateBridge.send({
                    schemaVersion: 1,
                    event: 'timer.error',
                    message: err.message || 'Error processing Swift command'
                  });
                }
              });
            }
          },
          onProtocolError: (err) => {
            if (candidateCallbacks.promoted && !candidateCallbacks.retired) {
              if (candidateBridge) {
                candidateBridge.send({
                  schemaVersion: 1,
                  event: 'timer.error',
                  message: err.message || 'Protocol error'
                });
              }
            }
          }
        });
        candidateBridge.start();
        if (typeof candidateBridge.whenReady === 'function') {
          await candidateBridge.whenReady();
        }
      } catch (err) {
        candidateCallbacks.retired = true;
        try { if (candidateBridge) candidateBridge.stop(); } catch (_) {}
        try { if (d.fs.existsSync(candidateConfigPath)) d.fs.unlinkSync(candidateConfigPath); } catch (_) {}

        const st = statusMod.readStatus(statusPath, d.fs);
        st.error = err.message || 'candidate bridge readiness failed';
        st.pendingPetId = null;
        statusMod.writeIfChanged(statusPath, st, d.fs);
        pendingPetId = null;
        return false;
      }

      try {
        writeJsonAtomic(d.fs, resolvedConfigPath, prep.visualConfig, d);
      } catch (writeErr) {
        candidateCallbacks.retired = true;
        try { if (candidateBridge) candidateBridge.stop(); } catch (_) {}
        try { if (d.fs.existsSync(candidateConfigPath)) d.fs.unlinkSync(candidateConfigPath); } catch (_) {}

        const st = statusMod.readStatus(statusPath, d.fs);
        st.error = 'failed to update canonical config: ' + writeErr.message;
        st.pendingPetId = null;
        statusMod.writeIfChanged(statusPath, st, d.fs);
        pendingPetId = null;
        return false;
      }

      candidateCallbacks.promoted = true;
      const oldBridge = bridge;
      const oldCallbacks = currentBridgeCallbacks;

      bridge = candidateBridge;
      currentBridgeCallbacks = candidateCallbacks;

      try { if (d.fs.existsSync(candidateConfigPath)) d.fs.unlinkSync(candidateConfigPath); } catch (_) {}

      visualConfig = prep.visualConfig;
      companionJsonLoaded = prep.companionJsonLoaded;

      const st = statusMod.readStatus(statusPath, d.fs);
      st.petId = newPetInfo.petId;
      st.petSource = newPetInfo.source;
      st.petAvailable = newPetInfo.available;
      st.petProvider = newPetInfo.provider || null;
      st.cacheStatus = newPetInfo.cacheStatus || null;
      st.companionJsonLoaded = !!companionJsonLoaded;
      if (prep.visualConfig && prep.visualConfig.targetHeightRatio !== undefined) {
        st.targetHeightRatio = prep.visualConfig.targetHeightRatio;
      }
      st.pendingPetId = null;
      st.error = null;
      statusMod.writeIfChanged(statusPath, st, d.fs);
      pendingPetId = null;

      if (oldBridge) {
        if (oldCallbacks) {
          oldCallbacks.retired = true;
        }
        try { oldBridge.stop(); } catch (_) {}
      }

      return true;
    } finally {
      isSwitching = false;
    }
  }

  async function handlePetSelectionChange() {
    if (shuttingDown) return;
    const currentPetInfo = d.resolvePetId();
    if (currentPetInfo.source === 'manual') {
      return;
    }

    const st = statusMod.readStatus(statusPath, d.fs);
    if (st.petId === currentPetInfo.petId && !st.pendingPetId) {
      return;
    }

    if (!currentPetInfo.available || currentPetInfo.error) {
      st.error = currentPetInfo.error || 'pet not available';
      st.pendingPetId = null;
      statusMod.writeIfChanged(statusPath, st, d.fs);
      pendingPetId = null;
      return;
    }

    if (st.engineState === 'small') {
      await applyPetSwitch(currentPetInfo);
    } else {
      pendingPetId = currentPetInfo.petId;
      st.pendingPetId = pendingPetId;
      statusMod.writeIfChanged(statusPath, st, d.fs);
    }
  }

  function handleRendererEvent(ev) {
    const updated = statusFromRendererEvent(statusMod.readStatus(statusPath, d.fs), ev);
    statusMod.writeIfChanged(statusPath, updated, d.fs);
    if (ev.engineState === 'small' && pendingPetId) {
      const currentPetInfo = d.resolvePetId();
      applyPetSwitch(currentPetInfo).catch((err) => {
        const st = statusMod.readStatus(statusPath, d.fs);
        st.error = (err && err.message) || 'unexpected error during pet switch';
        st.pendingPetId = null;
        statusMod.writeIfChanged(statusPath, st, d.fs);
        pendingPetId = null;
      });
    }
  }

  function handleRendererError(err) {
    const updated = statusMod.readStatus(statusPath, d.fs);
    updated.error = err.message;
    statusMod.writeIfChanged(statusPath, updated, d.fs);
    runtimeFail();
  }

  function handleRendererExit(code, signal) {
    runtimeFail();
  }

  const initialCallbacks = {
    promoted: true,
    retired: false,
    onEvent: (ev) => {
      if (initialCallbacks.retired) return;
      handleRendererEvent(ev);
    },
    onError: (err) => {
      if (!initialCallbacks.retired) handleRendererError(err);
    },
    onExit: (code, signal) => {
      if (!initialCallbacks.retired) handleRendererExit(code, signal);
    },
  };
  currentBridgeCallbacks = initialCallbacks;

  bridge = d.startBridge({
    binPath: d.paths.COMPANION_BINARY,
    extraArgs: resolvedConfigPath ? ['--config', resolvedConfigPath] : [],
    onEvent: initialCallbacks.onEvent,
    onError: initialCallbacks.onError,
    onExit: initialCallbacks.onExit,
    onCommand: (ev) => {
      if (!initialCallbacks.retired) {
        handleSwiftCommand(ev, bridge).catch((err) => {
          if (bridge) {
            bridge.send({
              schemaVersion: 1,
              event: 'timer.error',
              message: err.message || 'Error processing Swift command'
            });
          }
        });
      }
    },
    onProtocolError: (err) => {
      if (!initialCallbacks.retired) {
        if (bridge) {
          bridge.send({
            schemaVersion: 1,
            event: 'timer.error',
            message: err.message || 'Protocol error'
          });
        }
      }
    }
  });

  try {
    bridge.start();
    if (typeof bridge.whenReady === 'function') {
      await bridge.whenReady();
    }

    try {
      const prefPath = d.paths.COMPANION_PANEL_PREF_PATH || path.join(d.paths.URD_STATE_DIR, 'panel-preferences.json');
      let goalVisible = true;
      if (d.fs.existsSync(prefPath)) {
        const raw = d.fs.readFileSync(prefPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.goalVisible === 'boolean') {
          goalVisible = parsed.goalVisible;
        }
      }
      bridge.send({
        schemaVersion: 1,
        event: 'panel.preferences',
        goalVisible: goalVisible
      });
    } catch (_) {}

    adapter = d.createUltradianAdapter({
      stateDir: d.paths.URD_STATE_DIR,
      socketPath: d.socketPath,
      onEvent: (payload) => {
        if (!bridge) return;
        bridge.send(payload);
        const updated = statusFromAdapterEvent(statusMod.readStatus(statusPath, d.fs), payload);
        statusMod.writeIfChanged(statusPath, updated, d.fs);
      },
      onError: (err) => {
        const updated = statusMod.readStatus(statusPath, d.fs);
        updated.error = err.message;
        statusMod.writeIfChanged(statusPath, updated, d.fs);
      },
      eventIdFactory: d.eventIdFactory,
    });
    adapter.start();

    const tomlPath = (d.paths && d.paths.CODEX_CONFIG_PATH) ? d.paths.CODEX_CONFIG_PATH : null;
    if (petInfo.source !== 'manual' && tomlPath) {
      const watchDir = path.dirname(tomlPath);
      const configBasename = path.basename(tomlPath);
      const watchTarget = d.fs.existsSync(watchDir) ? watchDir : (d.fs.existsSync(tomlPath) ? tomlPath : null);
      if (watchTarget) {
        try {
          const watchFn = d.watch || d.fs.watch;
          if (typeof watchFn === 'function') {
            watcher = watchFn.call(d.fs, watchTarget, (eventType, filename) => {
              if (filename && path.basename(filename) !== configBasename) {
                return;
              }
              if (debounceTimer && typeof clearTimeout === 'function') clearTimeout(debounceTimer);
              debounceTimer = setTimeout(() => {
                debounceTimer = null;
                handlePetSelectionChange().catch((err) => {
                  const st = statusMod.readStatus(statusPath, d.fs);
                  st.error = (err && err.message) || 'unexpected error during pet selection change';
                  st.pendingPetId = null;
                  statusMod.writeIfChanged(statusPath, st, d.fs);
                  pendingPetId = null;
                });
              }, 100);
              if (debounceTimer && typeof debounceTimer.unref === 'function') {
                debounceTimer.unref();
              }
            });
          }
        } catch (_) {}
      }
    }

    const workerArgv = [scriptPath, '--worker', '--ready-token', token];
    currentIdentity = identity.buildIdentity(
      { pid: workerPid, scriptPath, argv: workerArgv },
      identityDeps(d)
    );
    writeJsonAtomic(d.fs, pidPath, currentIdentity, d);

    const readyStatus = statusMod.readStatus(statusPath, d.fs);
    readyStatus.engineState = 'small';
    statusMod.writeIfChanged(statusPath, readyStatus, d.fs);

    writeReadiness({ ready: true, token, pid: workerPid });
  } catch (err) {
    closeWatcher();
    try { if (adapter) adapter.stop(); } catch (_) {}
    try { if (bridge) bridge.stop(); } catch (_) {}
    doOwnerCleanup();
    writeReadiness({ ready: false, token, pid: workerPid, error: err.message });
    return { ok: false, code: 1, error: err.message };
  }

  d.onSignal('SIGINT', () => shutdown());
  d.onSignal('SIGTERM', () => shutdown());
  return { ok: true, code: 0, pid: workerPid };
}

// `start` command. Launches a detached hidden --worker and waits bounded for
// atomic readiness tied to token + child pid. Idempotent when already verified.
async function startManager(deps) {
  const d = deps;
  const pidPath = d.paths.COMPANION_PID_PATH;
  const readyPath = d.paths.COMPANION_READY_PATH;

  if (d.fs.existsSync(pidPath)) {
    const existing = safeReadJson(d.fs, pidPath);
    if (existing === null) {
      return { started: false, error: 'existing PID file is malformed and not owned; refusing to start' };
    }
    const verification = identity.verifyIdentity(existing, identityDeps(d));
    if (verification.valid) {
      return { started: true, alreadyRunning: true, pid: existing.pid };
    }
    if (verification.reason.indexOf('dead:') === 0) {
      const archived = archiveStale(d.fs, pidPath, readyPath, d);
      if (!archived.ok) {
        return { started: false, error: 'failed to recover dead-stale worker: ' + archived.error };
      }
    } else {
      return { started: false, error: 'existing worker is unsafe (live mismatch); refusing to start: ' + verification.reason };
    }
  }

  const token = d.randomToken();
  let child;
  try {
    child = d.spawn(d.nodePath, [d.cliScript, '--worker', '--ready-token', token], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch (err) {
    return { started: false, error: 'failed to spawn worker: ' + err.message };
  }

  const deadline = d.now() + d.startTimeoutMs;
  while (d.now() < deadline) {
    const ready = safeReadJson(d.fs, readyPath);
    if (ready && ready.token === token && ready.pid === child.pid) {
      if (ready.ready === true) {
        const childIdentity = safeReadJson(d.fs, pidPath);
        if (childIdentity === null) {
          return { started: false, error: 'worker readiness reported success but PID identity is missing or malformed' };
        }
        const verification = identity.verifyIdentity(childIdentity, identityDeps(d));
        if (!verification.valid) {
          return { started: false, error: 'worker readiness reported success but PID identity is unsafe: ' + verification.reason };
        }
        if (childIdentity.pid !== child.pid) {
          return { started: false, error: `worker readiness PID mismatch: expected ${child.pid}, got ${childIdentity.pid}` };
        }
        return { started: true, pid: child.pid };
      }
      return { started: false, error: ready.error || 'worker reported failure during startup' };
    }
    await d.sleep(d.pollIntervalMs);
  }

  return { started: false, error: 'timeout waiting for worker readiness' };
}

// `stop` command. Reads JSON PID identity, fully verifies, then safeSignal
// SIGTERM. Does NOT unlink PID itself. Waits bounded for worker cleanup.
async function stopManager(deps) {
  const d = deps;
  const pidPath = d.paths.COMPANION_PID_PATH;
  const readyPath = d.paths.COMPANION_READY_PATH;

  if (!d.fs.existsSync(pidPath)) {
    return { stopped: true, alreadyStopped: true };
  }

  const existing = safeReadJson(d.fs, pidPath);
  if (existing === null) {
    return { stopped: false, error: 'malformed PID identity; refusing to stop' };
  }

  const verification = identity.verifyIdentity(existing, identityDeps(d));
  if (!verification.valid) {
    if (verification.reason.indexOf('dead:') === 0) {
      const archived = archiveStale(d.fs, pidPath, readyPath, d);
      if (!archived.ok) {
        return { stopped: false, cleanedStale: false, error: 'failed to clean dead-stale worker: ' + archived.error };
      }
      return { stopped: true, cleanedStale: true };
    }
    return { stopped: false, error: 'PID identity unsafe; refusing to stop: ' + verification.reason };
  }

  const sig = identity.safeSignal(existing, 'SIGTERM', {
    fs: d.fs,
    psExec: d.psExec,
    getuid: d.getuid,
    kill: d.kill,
  });
  if (!sig.ok) {
    return { stopped: false, error: 'failed to signal worker: ' + sig.reason };
  }

  const deadline = d.now() + d.stopTimeoutMs;
  while (d.now() < deadline) {
    if (!d.fs.existsSync(pidPath)) {
      return { stopped: true };
    }
    await d.sleep(d.pollIntervalMs);
  }
  return { stopped: false, error: 'timeout waiting for worker to exit' };
}

// `status` command. Verifies JSON identity and reports last semantic status.
function statusManager(deps) {
  const d = deps;
  const pidPath = d.paths.COMPANION_PID_PATH;
  const statusPath = d.paths.COMPANION_STATUS_PATH;

  if (!d.fs.existsSync(pidPath)) {
    const st = statusMod.defaultStatus();
    st.engineState = 'stopped';
    return { ok: true, semantic: 'stopped', status: st };
  }

  const existing = safeReadJson(d.fs, pidPath);
  if (existing === null) {
    const st = statusMod.defaultStatus();
    st.engineState = 'stopped';
    st.error = 'malformed PID identity';
    return { ok: false, semantic: 'identity-error', status: st, error: st.error };
  }

  const verification = identity.verifyIdentity(existing, identityDeps(d));
  if (!verification.valid) {
    const st = statusMod.defaultStatus();
    st.engineState = 'stopped';
    st.error = verification.reason;
    return { ok: false, semantic: 'identity-error', status: st, error: verification.reason };
  }

  const st = statusMod.readStatus(statusPath, d.fs);
  return { ok: true, semantic: 'running', status: st, identity: existing };
}

function createDeps(overrides = {}) {
  const deps = {
    fs,
    paths: companionPaths,
    socketPath: path.join(companionPaths.URD_STATE_DIR, 'daemon.sock'),
    cliScript: path.resolve(process.argv[1] || __filename),
    scriptPath: path.resolve(process.argv[1] || __filename),
    readyToken: crypto.randomBytes(16).toString('hex'),
    nodePath: process.execPath,
    spawn: (cmd, args, opts) => spawn(cmd, args, opts),
    execFileSync,
    psExec: undefined,
    getuid: undefined,
    randomToken: () => crypto.randomBytes(16).toString('hex'),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    exit: (code) => process.exit(code),
    runtimeExit: (code) => process.exit(code),
    onSignal: (sig, cb) => { process.on(sig, cb); },
    resolvePetId: require('./manifest-loader.js').resolvePetId,
    compileSwiftRenderer,
    prepareVisualConfig: (petInfo) => defaultPrepareVisualConfig(deps, petInfo),
    startBridge,
    createUltradianAdapter,
    sendDaemonCommand,
    kill: undefined,
    startTimeoutMs: READY_TIMEOUT_MS,
    stopTimeoutMs: STOP_TIMEOUT_MS,
    pollIntervalMs: POLL_INTERVAL_MS,
  };
  return Object.assign(deps, overrides);
}

module.exports = {
  runWorker,
  startManager,
  stopManager,
  statusManager,
  createDeps,
  statusFromRendererEvent,
  writeJsonAtomic,
  safeReadJson,
  readBoundedText,
  readBoundedJson,
  MAX_USER_CONFIG_BYTES,
  archiveStale,
  defaultPrepareVisualConfig,
};
