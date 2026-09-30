const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function defaultStatus() {
  return {
    engineState: 'small',
    isPaused: false,
    petId: null,
    petSource: 'auto',
    petAvailable: false,
    petProvider: null,
    cacheStatus: null,
    companionJsonLoaded: false,
    activeClip: null,
    currentFrame: 0,
    fps: 8,
    anchorFound: false,
    petAnchorFound: null,
    mainWindowFallbackAnchor: null,
    visualAnchorDiagnostic: null,
    timerPanelVisible: null,
    windowVisible: false,
    targetHeightRatio: 0.72,
    displayId: null,
    pendingPetId: null,
    error: null,
  };
}

function readStatus(statusPath, fsMod) {
  const fsM = fsMod || fs;
  try {
    if (fsM.existsSync(statusPath)) {
      const raw = fsM.readFileSync(statusPath, 'utf8');
      const parsed = JSON.parse(raw);
      return { ...defaultStatus(), ...parsed };
    }
  } catch (_) {}
  return defaultStatus();
}

function writeStatus(statusPath, status, fsMod) {
  const fsM = fsMod || fs;
  const dir = path.dirname(statusPath);
  if (!fsM.existsSync(dir)) {
    fsM.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const tmp = `${statusPath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  fsM.writeFileSync(tmp, JSON.stringify(status, null, 2) + '\n', { mode: 0o600 });
  if (typeof fsM.chmodSync === 'function') fsM.chmodSync(tmp, 0o600);
  fsM.renameSync(tmp, statusPath);
  if (typeof fsM.chmodSync === 'function') fsM.chmodSync(statusPath, 0o600);
}

function writeIfChanged(statusPath, status, fsMod) {
  const fsM = fsMod || fs;
  const serialized = JSON.stringify(status, null, 2) + '\n';
  let existing = null;
  try {
    existing = fsM.readFileSync(statusPath, 'utf8');
  } catch (_) {}
  if (existing === serialized) {
    return false;
  }
  writeStatus(statusPath, status, fsMod);
  return true;
}

function formatHuman(status) {
  const lines = [];
  lines.push(`Engine state: ${status.engineState}`);
  lines.push(`Paused: ${status.isPaused}`);
  lines.push(`Pet: ${status.petId || '(none)'} (source: ${status.petSource})`);
  lines.push(`Pet available: ${status.petAvailable}`);
  if (status.petProvider) {
    lines.push(`Pet provider: ${status.petProvider}`);
  }
  if (status.cacheStatus) {
    lines.push(`Cache status: ${status.cacheStatus}`);
  }
  lines.push(`Companion JSON: ${status.companionJsonLoaded}`);
  lines.push(`Active clip: ${status.activeClip || '(none)'}`);
  lines.push(`Frame: ${status.currentFrame} @ ${status.fps} fps`);
  lines.push(`Anchor found: ${status.anchorFound}`);
  if (status.petAnchorFound !== null && status.petAnchorFound !== undefined) {
    lines.push(`Pet anchor found: ${status.petAnchorFound}`);
  }
  if (status.mainWindowFallbackAnchor !== null && status.mainWindowFallbackAnchor !== undefined) {
    lines.push(`Main-window fallback anchor: ${status.mainWindowFallbackAnchor}`);
  }
  if (status.visualAnchorDiagnostic) {
    lines.push(`Visual anchor diagnostic: ${status.visualAnchorDiagnostic}`);
  }
  if (status.timerPanelVisible !== null && status.timerPanelVisible !== undefined) {
    lines.push(`Timer panel visible: ${status.timerPanelVisible}`);
  }
  lines.push(`Window visible: ${status.windowVisible}`);
  if (status.targetHeightRatio !== undefined && status.targetHeightRatio !== null) {
    lines.push(`Target height ratio: ${status.targetHeightRatio}`);
  }
  if (status.displayId) {
    lines.push(`Display ID: ${status.displayId}`);
  }
  if (status.pendingPetId) {
    lines.push(`Pending pet: ${status.pendingPetId}`);
  }
  if (status.error) {
    lines.push(`Error: ${status.error}`);
  }
  return lines.join('\n');
}

module.exports = { defaultStatus, readStatus, writeStatus, writeIfChanged, formatHuman };
