const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');
const os = require('os');

const hasXcrun = (() => {
  try {
    execSync('which xcrun', { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
})();

function compileSwiftRenderer(binPath) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-test-comp-'));
  const mainLink = path.join(tempDir, 'renderer.swift');
  const swiftSrc1 = path.join(__dirname, '..', 'src', 'companion_renderer.swift');
  const swiftSrc2 = path.join(__dirname, '..', 'src', 'timer_panel.swift');
  const binDir = path.dirname(binPath);
  if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true });
  }
  try {
    fs.symlinkSync(swiftSrc1, mainLink);
  } catch (_) {
    try {
      fs.copyFileSync(swiftSrc1, mainLink);
    } catch (_) {}
  }
  try {
    execFileSync('/usr/bin/xcrun', ['swiftc', '-o', binPath, mainLink, swiftSrc2], { stdio: 'pipe' });
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {}
  }
}

function write1x1WhitePNG(filePath) {
  function crc32(buf) {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) { crc ^= buf[i]; for (let j = 0; j < 8; j++) { crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; } }
    return (crc ^ 0xffffffff) >>> 0;
  }
  function pngChunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const typeB = Buffer.from(type, 'ascii');
    const crcData = Buffer.concat([typeB, data]);
    const crcV = Buffer.alloc(4); crcV.writeUInt32BE(crc32(crcData));
    return Buffer.concat([len, typeB, data, crcV]);
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(5); raw[0] = 0; raw[1] = 255; raw[2] = 255; raw[3] = 255; raw[4] = 255;
  const compressed = require('zlib').deflateSync(raw);
  const idat = pngChunk('IDAT', compressed);
  const iend = pngChunk('IEND', Buffer.alloc(0));
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, Buffer.concat([sig, pngChunk('IHDR', ihdr), idat, iend]));
}

const GEOMETRIC_SPRITESHEET = path.join(__dirname, '..', 'examples', 'example-pet', 'spritesheet.png');

test('T020: Swift renderer test modes', async (t) => {
  if (!hasXcrun) {
    t.skip('xcrun not available');
    return;
  }
  const tempBin = path.join(os.tmpdir(), `companion-test-${Date.now()}`, 'companion_renderer');
  compileSwiftRenderer(tempBin);

  await t.test('--test-nearest verifies magnificationFilter', () => {
    const result = execFileSync(tempBin, ['--test-nearest'], { encoding: 'utf8' });
    assert.ok(result.includes('OK'));
  });

  await t.test('--test-transition-geometry outputs scale data', () => {
    const result = execFileSync(tempBin, ['--test-transition-geometry'], { encoding: 'utf8' });
    const data = JSON.parse(result.trim());
    assert.ok(Array.isArray(data));
    assert.ok(data.length > 0);
    assert.ok(data[0].scale >= 0);
    assert.ok(data[0].scale <= 1.05);
  });

  await t.test('--test-no-anchor returns hidden window', () => {
    const result = execFileSync(tempBin, ['--test-no-anchor'], { encoding: 'utf8' });
    assert.ok(result.includes('OK'));
  });

  await t.test('--test-multi-display position calculations', () => {
    const result = execFileSync(tempBin, ['--test-multi-display'], { encoding: 'utf8' });
    assert.ok(result.includes('OK'));
  });

  // Cleanup
  try { fs.rmSync(path.dirname(tempBin), { recursive: true, force: true }); } catch (_) {}
});

test('T020b: --test-imageio-validate with geometric spritesheet', async (t) => {
  if (!hasXcrun) {
    t.skip('xcrun not available');
    return;
  }
  const tempBin = path.join(os.tmpdir(), `companion-test-${Date.now()}`, 'companion_renderer');
  compileSwiftRenderer(tempBin);
  if (!fs.existsSync(GEOMETRIC_SPRITESHEET)) {
    try { fs.rmSync(path.dirname(tempBin), { recursive: true, force: true }); } catch (_) {}
    return;
  }

  await t.test('valid PNG passes imageio validation with JSON output', () => {
    const result = execFileSync(tempBin, ['--test-imageio-validate', GEOMETRIC_SPRITESHEET], { encoding: 'utf8' });
    const parsed = JSON.parse(result.trim());
    assert.strictEqual(parsed.valid, true);
    assert.ok(typeof parsed.width === 'number');
    assert.ok(typeof parsed.height === 'number');
    assert.ok(typeof parsed.hasAlpha === 'boolean');
  });

  try { fs.rmSync(path.dirname(tempBin), { recursive: true, force: true }); } catch (_) {}
});

test('T020c: --test-crop extracts frames from geometric spritesheet', async (t) => {
  if (!hasXcrun) {
    t.skip('xcrun not available');
    return;
  }
  const tempBin = path.join(os.tmpdir(), `companion-test-${Date.now()}`, 'companion_renderer');
  compileSwiftRenderer(tempBin);
  if (!fs.existsSync(GEOMETRIC_SPRITESHEET)) {
    try { fs.rmSync(path.dirname(tempBin), { recursive: true, force: true }); } catch (_) {}
    return;
  }

  await t.test('crop extracts valid 192x208 cells', () => {
    const result = execFileSync(tempBin, ['--test-crop', GEOMETRIC_SPRITESHEET], { encoding: 'utf8' });
    assert.ok(result.includes('OK'));
  });

  try { fs.rmSync(path.dirname(tempBin), { recursive: true, force: true }); } catch (_) {}
});

test('T035: --test-frame-validate validates frame images', async (t) => {
  if (!hasXcrun) {
    t.skip('xcrun not available');
    return;
  }
  const tempBin = path.join(os.tmpdir(), `companion-test-${Date.now()}`, 'companion_renderer');
  compileSwiftRenderer(tempBin);
  if (!fs.existsSync(GEOMETRIC_SPRITESHEET)) {
    try { fs.rmSync(path.dirname(tempBin), { recursive: true, force: true }); } catch (_) {}
    return;
  }

  await t.test('valid PNG frame returns JSON with dimensions and alpha', () => {
    const result = execFileSync(tempBin, ['--test-frame-validate', GEOMETRIC_SPRITESHEET], { encoding: 'utf8' });
    const parsed = JSON.parse(result.trim());
    assert.strictEqual(parsed.valid, true);
    assert.ok(typeof parsed.width === 'number');
    assert.ok(typeof parsed.height === 'number');
    assert.ok(typeof parsed.hasAlpha === 'boolean');
  });

  await t.test('non-existent file returns valid: false', () => {
    const result = execFileSync(tempBin, ['--test-frame-validate', '/nonexistent/file.png'], { encoding: 'utf8' });
    const parsed = JSON.parse(result.trim());
    assert.strictEqual(parsed.valid, false);
  });

  try { fs.rmSync(path.dirname(tempBin), { recursive: true, force: true }); } catch (_) {}
});

test('T022: Transition geometry tests', async (t) => {
  if (!hasXcrun) {
    t.skip('xcrun not available');
    return;
  }
  const tempBin = path.join(os.tmpdir(), `companion-test-${Date.now()}`, 'companion_renderer');
  compileSwiftRenderer(tempBin);

  await t.test('scale interpolation: 0->1 in 600ms, 1->0 in 400ms', () => {
    const result = execFileSync(tempBin, ['--test-transition-geometry'], { encoding: 'utf8' });
    const data = JSON.parse(result.trim());
    // First 7 entries: entering (0 to 600ms)
    assert.strictEqual(data[0].scale, 0.0);
    assert.strictEqual(data[6].scale, 1.0);
    // Entry 8 (index 7): start of exiting
    assert.ok(data[7].scale <= 1.0);
    // Last entry: end of exiting
    assert.strictEqual(data[data.length - 1].scale, 0.0);
  });

  await t.test('scale interpolation partial interrupt behavior', () => {
    const result = execFileSync(tempBin, ['--test-transition-behavior'], { encoding: 'utf8' });
    const data = JSON.parse(result.trim());
    assert.ok(Array.isArray(data));
    const test2Result = data.find(d => d.test === 2 && d.phase === 3);
    assert.ok(test2Result, 'Test 2 phase 3 result not found');
    assert.strictEqual(test2Result.interrupt_correct, 1, 'Interrupt scale calculation incorrect');
  });

  try { fs.rmSync(path.dirname(tempBin), { recursive: true, force: true }); } catch (_) {}
});

test('T023: CGWindowList and timer freeze tests', async (t) => {
  if (!hasXcrun) {
    t.skip('xcrun not available');
    return;
  }
  const tempBin = path.join(os.tmpdir(), `companion-test-${Date.now()}`, 'companion_renderer');
  compileSwiftRenderer(tempBin);

  await t.test('--test-timer-freeze validates pause/resume cycle', () => {
    const result = execFileSync(tempBin, ['--test-timer-freeze'], { encoding: 'utf8' });
    assert.ok(result.includes('OK'));
  });

  try { fs.rmSync(path.dirname(tempBin), { recursive: true, force: true }); } catch (_) {}
});

test('Batch B: Fullscreen geometry, easing, interruption, and neutral fallback', async (t) => {
  if (!hasXcrun) {
    t.skip('xcrun not available');
    return;
  }
  const tempBin = path.join(os.tmpdir(), `companion-test-${Date.now()}`, 'companion_renderer');
  compileSwiftRenderer(tempBin);

  await t.test('--test-fullscreen-geometry verifies 72% height, aspect ratio, anchor first frame, centered final frame, backdrop opacity, wide and tall images', () => {
    const result = execFileSync(tempBin, ['--test-fullscreen-geometry'], { encoding: 'utf8' });
    const parsed = JSON.parse(result.trim());
    assert.ok(parsed.heightRatio >= 0.69 && parsed.heightRatio <= 0.75, `Expected height ratio near 0.72, got ${parsed.heightRatio}`);
    assert.ok(parsed.aspectRatio > 0, 'Aspect ratio must be positive');
    assert.strictEqual(parsed.anchorFirstFrame, true, 'Anchor first frame match failed');
    assert.strictEqual(parsed.centeredFinalFrame, true, 'Centered final frame failed');
    assert.ok(Math.abs(parsed.backdropOpacity - 0.32) < 0.001, 'Backdrop opacity at rest should be 0.32');
    assert.strictEqual(parsed.wideImageValid, true, 'Very wide image aspect containment failed');
    assert.strictEqual(parsed.tallImageValid, true, 'Very tall image aspect containment failed');
  });

  await t.test('--test-easing verifies bounded smooth easing with <= 4% overshoot', () => {
    const result = execFileSync(tempBin, ['--test-easing'], { encoding: 'utf8' });
    const parsed = JSON.parse(result.trim());
    assert.strictEqual(parsed.valid, true, 'Easing validation failed');
    assert.ok(parsed.maxOvershoot <= 1.04, `Max overshoot exceeded 4%: ${parsed.maxOvershoot}`);
    assert.strictEqual(parsed.finalValue, 1.0, 'Final value should settle to 1.0');
  });

  await t.test('--test-interruption-continuity verifies smooth exit from current rectangle and opacity', () => {
    const result = execFileSync(tempBin, ['--test-interruption-continuity'], { encoding: 'utf8' });
    const parsed = JSON.parse(result.trim());
    assert.strictEqual(parsed.continuityValid, true, 'Interruption continuity failed');
    assert.ok(parsed.rectDiff < 0.01, 'Rectangle jump detected on exit transition start');
    assert.ok(parsed.opacityDiff < 0.01, 'Opacity jump detected on exit transition start');
  });

  await t.test('--test-neutral-fallback verifies idle frame freeze during missing custom clips', () => {
    const result = execFileSync(tempBin, ['--test-neutral-fallback'], { encoding: 'utf8' });
    const parsed = JSON.parse(result.trim());
    assert.strictEqual(parsed.neutralFallbackValid, true, 'Neutral fallback behavior failed');
  });

  await t.test('--test-transient-anchor verifies overlay visible on transient loss, last anchor retained, main screen fallback when screen gone, hidden in small state', (st) => {
    // Skip this test in headless CI because it requires an interactive macOS screen.
    if (process.env.CI) {
      st.skip('Skipping transient anchor test on headless CI');
      return;
    }
    const result = execFileSync(tempBin, ['--test-transient-anchor'], { encoding: 'utf8' });
    const parsed = JSON.parse(result.trim());
    assert.strictEqual(parsed.valid, true, 'Transient anchor handling validation failed');
    assert.strictEqual(parsed.visibleOnTransientLoss, true, 'Overlay hidden during active state on transient anchor loss');
    assert.strictEqual(parsed.keptLastAnchor, true, 'Did not keep last valid anchor');
    assert.strictEqual(parsed.screenGoneFallback, true, 'Screen gone clamped fallback failed');
    assert.strictEqual(parsed.hiddenWhenSmall, true, 'State small should be hidden');
  });

  await t.test('--test-nonactivating-panel verifies panel cannot become key/main and uses non-focus-stealing ordering', () => {
    const result = execFileSync(tempBin, ['--test-nonactivating-panel'], { encoding: 'utf8' });
    const parsed = JSON.parse(result.trim());
    assert.strictEqual(parsed.valid, true, 'Nonactivating panel validation failed');
    assert.strictEqual(parsed.canBecomeKey, false, 'Panel canBecomeKey must be false');
    assert.strictEqual(parsed.canBecomeMain, false, 'Panel canBecomeMain must be false');
    assert.strictEqual(parsed.ignoresMouseEvents, true, 'Panel ignoresMouseEvents must be true');
    assert.strictEqual(parsed.isNonactivatingPanel, true, 'Panel styleMask must contain .nonactivatingPanel');
  });

  await t.test('--test-stable-aspect verifies rest custom clip precedence and stable target geometry across active cycle', () => {
    const result = execFileSync(tempBin, ['--test-stable-aspect'], { encoding: 'utf8' });
    const parsed = JSON.parse(result.trim());
    assert.strictEqual(parsed.valid, true, 'Stable aspect validation failed');
    assert.strictEqual(parsed.noJump, true, 'Target geometry jumped between enter and rest clips');
    assert.strictEqual(parsed.aspectIsRest, true, 'Rest clip aspect ratio precedence failed');
  });

  try { fs.rmSync(path.dirname(tempBin), { recursive: true, force: true }); } catch (_) {}
});

test('T004 midpoint: --test-midpoint validates midpoint enter→rest flow and activate cancels auto-exit', async (t) => {
  if (!hasXcrun) {
    t.skip('xcrun not available');
    return;
  }
  const tempBin = path.join(os.tmpdir(), `companion-test-${Date.now()}`, 'companion_renderer');
  compileSwiftRenderer(tempBin);

  try {
    const result = execFileSync(tempBin, ['--test-midpoint'], { encoding: 'utf8' });
    const parsed = JSON.parse(result.trim());
    assert.strictEqual(parsed.valid, true, 'Midpoint test validation failed');
    assert.strictEqual(parsed.enteredEntering, true, 'Should enter entering state on midpoint event');
    assert.strictEqual(parsed.enteredResting, true, 'Should enter resting with isLooping=true after enter completes');
    assert.strictEqual(parsed.isMidpoint, true, 'isMidpoint flag should be set');
    assert.strictEqual(parsed.afterEnterIsLooping, true, 'isLooping should be true during midpoint rest');
    assert.strictEqual(parsed.afterEnterFrame, 0, 'Frame should be 0 during midpoint rest');
    assert.strictEqual(parsed.cancelValid, true, 'companion.activate during midpoint resting should cancel auto-exit and loop');
    assert.strictEqual(parsed.afterCancelIsMidpoint, false, 'isMidpoint should be cleared after companion.activate');
    assert.strictEqual(parsed.afterCancelFrame, 0, 'Frame should stay 0 after cancel');
  } finally {
    try { fs.rmSync(path.dirname(tempBin), { recursive: true, force: true }); } catch (_) {}
  }
});

test('T004 activate takeover: --test-activate-takeover validates normal activate enters resting loop', async (t) => {
  if (!hasXcrun) {
    t.skip('xcrun not available');
    return;
  }
  const tempBin = path.join(os.tmpdir(), `companion-test-${Date.now()}`, 'companion_renderer');
  compileSwiftRenderer(tempBin);

  try {
    const result = execFileSync(tempBin, ['--test-activate-takeover'], { encoding: 'utf8' });
    const parsed = JSON.parse(result.trim());
    assert.strictEqual(parsed.valid, true, 'Activate takeover test validation failed');
    assert.strictEqual(parsed.enteredEntering, true, 'Should enter entering state on companion.activate');
    assert.strictEqual(parsed.enteredResting, true, 'Should enter resting with isLooping=true after enter completes');
    assert.strictEqual(parsed.isTakeover, true, 'isTakeover flag should be set');
    assert.strictEqual(parsed.afterEnterIsLooping, true, 'isLooping should be true during takeover rest');
    assert.strictEqual(parsed.afterEnterFrame, 0, 'Frame should be 0 during takeover rest');
  } finally {
    try { fs.rmSync(path.dirname(tempBin), { recursive: true, force: true }); } catch (_) {}
  }
});

test('T004 takeover atlas preference: config-loaded atlas + custom clips prove takeover uses atlas', async (t) => {
  if (!hasXcrun) {
    t.skip('xcrun not available');
    return;
  }
  if (!fs.existsSync(GEOMETRIC_SPRITESHEET)) {
    t.skip('geometric spritesheet not available');
    return;
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takeover-atlas-'));
  try {
    const customClipPath = path.join(tempDir, 'custom-clip.png');
    write1x1WhitePNG(customClipPath);

    const config = {
      petId: 'rocky',
      atlasPath: GEOMETRIC_SPRITESHEET,
      clips: {
        rest: {
          frames: [customClipPath],
          fps: 8,
          loop: true,
        },
      },
    };
    const configPath = path.join(tempDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(config));

    const tempBin = path.join(tempDir, 'companion_renderer');
    compileSwiftRenderer(tempBin);

    const result = execFileSync(tempBin, ['--config', configPath, '--test-takeover-atlas-preference'], { encoding: 'utf8' });
    const parsed = JSON.parse(result.trim());
    assert.strictEqual(parsed.valid, true, 'Takeover atlas preference test failed');
    assert.strictEqual(parsed.usingAtlasCell, true, 'Entering render should use atlas cell (192x208), not custom clip');
    assert.strictEqual(parsed.restUsingAtlasCell, true, 'Resting render should use atlas cell (192x208), not custom clip');
    assert.strictEqual(parsed.holdTimerRunning, true, 'Hold timer should run during calm resting takeover');
    assert.strictEqual(parsed.animationTimerRunning, false, 'Animation timer should not run during calm resting takeover');
    assert.strictEqual(parsed.atlasLoaded, true, 'Atlas must be loaded');
    assert.strictEqual(parsed.customClipSet, true, 'Custom clip must be present');
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  }
});

test('G3B Swift deterministic status sequence emits semantic NDJSON only', async (t) => {
  if (!hasXcrun) {
    t.skip('xcrun not available');
    return;
  }
  const tempBin = path.join(os.tmpdir(), `companion-test-${Date.now()}`, 'companion_renderer');
  compileSwiftRenderer(tempBin);

  try {
    const result = execFileSync(tempBin, ['--test-status-sequence'], { encoding: 'utf8' });
    const lines = result.trim().split('\n').filter(Boolean);
    const events = lines.map((line) => JSON.parse(line));
    const expectedFields = [
      'activeClip',
      'anchorFound',
      'currentFrame',
      'displayId',
      'engineState',
      'error',
      'fps',
      'isPaused',
      'mainWindowFallbackAnchor',
      'petAnchorFound',
      'visualAnchorDiagnostic',
      'targetHeightRatio',
      'timerPanelVisible',
      'windowVisible',
      'kind',
      'panelReady',
    ].sort();

    assert.deepStrictEqual(events.map((event) => event.engineState), [
      'small',
      'entering',
      'resting',
      'resting',
      'resting',
      'exiting',
      'small',
    ]);
    assert.strictEqual(events.length, 7, 'must not emit per-frame status lines');
    for (const event of events) {
      assert.deepStrictEqual(Object.keys(event).sort(), expectedFields);
    }
    assert.strictEqual(events[0].anchorFound, true);
    assert.strictEqual(events[0].petAnchorFound, false);
    assert.strictEqual(events[0].mainWindowFallbackAnchor, true);
    assert.strictEqual(events[0].visualAnchorDiagnostic, 'main-window-only');
    assert.strictEqual(events[0].timerPanelVisible, false);
    assert.strictEqual(events[0].windowVisible, false);
    for (const event of events.slice(1, 6)) {
      assert.strictEqual(event.windowVisible, true);
    }
    assert.strictEqual(events[6].windowVisible, false);
    const pause = events[3];
    const resume = events[4];
    assert.strictEqual(pause.isPaused, true);
    assert.strictEqual(pause.windowVisible, true);
    assert.strictEqual(pause.activeClip, 'rest');
    assert.strictEqual(resume.isPaused, false);
    assert.strictEqual(resume.currentFrame, 0);
  } finally {
    try { fs.rmSync(path.dirname(tempBin), { recursive: true, force: true }); } catch (_) {}
  }
});

test('T010: Native and geometry-estimated pet anchors control timer panel eligibility', async (t) => {
  if (!hasXcrun) {
    t.skip('xcrun not available');
    return;
  }
  const tempBin = path.join(os.tmpdir(), `companion-test-${Date.now()}`, 'companion_renderer');
  compileSwiftRenderer(tempBin);

  try {
    const result = execFileSync(tempBin, ['--test-trusted-pet-anchor'], { encoding: 'utf8' });
    const parsed = JSON.parse(result.trim());
    assert.strictEqual(parsed.valid, true, 'Trusted pet anchor test failed');
    assert.strictEqual(parsed.trustedPetCase, true, 'Layer-3 408x400 Codex pet must be trusted and make timer panel eligible');
    assert.strictEqual(parsed.voicePetHostCase, true, 'Supported voice-host geometry should estimate an anchor and show the timer panel');
    assert.strictEqual(parsed.mainWindowOnlyCase, true, 'Main window alone must anchor engine but keep timer panel hidden');
    assert.strictEqual(parsed.noAnchorCase, true, 'No trusted anchor must hide timer panel');
  } finally {
    try { fs.rmSync(path.dirname(tempBin), { recursive: true, force: true }); } catch (_) {}
  }
});

test('Calm-idle progression: --test-idle-progression validates Rocky profile, 3s hold, exact [0,1,0] burst, fallback, midpoint, pause/resume, and exit', async (t) => {
  if (!hasXcrun) {
    t.skip('xcrun not available');
    return;
  }
  const tempBin = path.join(os.tmpdir(), `companion-test-${Date.now()}`, 'companion_renderer');
  compileSwiftRenderer(tempBin);

  try {
    const result = execFileSync(tempBin, ['--test-idle-progression'], { encoding: 'utf8' });
    const parsed = JSON.parse(result.trim());
    assert.strictEqual(parsed.valid, true, 'Idle progression validation failed');
    assert.strictEqual(parsed.rockyProfileValid, true, 'Rocky profile resolution failed');
    assert.strictEqual(parsed.stableHoldTimerValid, true, 'Stable hold timer / no animation timer failed');
    assert.strictEqual(parsed.blinkBurstValid, true, 'Blink burst [0,1,0] sequence failed');
    assert.strictEqual(parsed.burstShutdownValid, true, 'Burst shutdown / return to base failed');
    assert.strictEqual(parsed.unknownPetStaticValid, true, 'Unknown pet static fallback failed');
    assert.strictEqual(parsed.midpointStaticValid, true, 'Midpoint static before auto-exit failed');
    assert.strictEqual(parsed.pauseCancelValid, true, 'Pause cancellation / freeze failed');
    assert.strictEqual(parsed.resumeHoldValid, true, 'Resume base + fresh hold failed');
    assert.strictEqual(parsed.exitCleanupValid, true, 'Exit base + timer cleanup failed');
  } finally {
    try { fs.rmSync(path.dirname(tempBin), { recursive: true, force: true }); } catch (_) {}
  }
});

test('Runtime config includes petId property', async (t) => {
  if (!hasXcrun) {
    t.skip('xcrun not available');
    return;
  }
  const tempBin = path.join(os.tmpdir(), `companion-test-${Date.now()}`, 'companion_renderer');
  compileSwiftRenderer(tempBin);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-config-test-'));
  try {
    const configPath = path.join(tempDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ petId: 'rocky', smallWidth: 84, restWidth: 360 }));
    const result = execFileSync(tempBin, ['--config', configPath, '--test-runtime-config'], { encoding: 'utf8' });
    const parsed = JSON.parse(result.trim());
    assert.strictEqual(parsed.petId, 'rocky');
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(path.dirname(tempBin), { recursive: true, force: true }); } catch (_) {}
  }
});

test('Missing or unknown petId proves no hold, burst, or animation timer', async (t) => {
  if (!hasXcrun) {
    t.skip('xcrun not available');
    return;
  }
  const tempBin = path.join(os.tmpdir(), `companion-test-${Date.now()}`, 'companion_renderer');
  compileSwiftRenderer(tempBin);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'missing-pet-test-'));
  try {
    const configPathMissing = path.join(tempDir, 'config_missing.json');
    fs.writeFileSync(configPathMissing, JSON.stringify({ smallWidth: 84, restWidth: 360 }));
    const resultMissing = execFileSync(tempBin, ['--config', configPathMissing, '--test-runtime-config'], { encoding: 'utf8' });
    const parsedMissing = JSON.parse(resultMissing.trim());
    assert.strictEqual(parsedMissing.petId, '', 'Missing petId in config must default to empty string');

    const resultProgression = execFileSync(tempBin, ['--config', configPathMissing, '--test-idle-progression'], { encoding: 'utf8' });
    const parsedProgression = JSON.parse(resultProgression.trim());
    assert.strictEqual(parsedProgression.missingPetStaticValid, true, 'Missing petId must produce static state without timers');
    assert.strictEqual(parsedProgression.unknownPetStaticValid, true, 'Unknown petId must produce static state without timers');
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(path.dirname(tempBin), { recursive: true, force: true }); } catch (_) {}
  }
});

test('014 Visual pet template matching: --test-visual-match validates in-memory anchor detection', async (t) => {
  if (!hasXcrun) {
    t.skip('xcrun not available');
    return;
  }
  const tempBin = path.join(os.tmpdir(), `companion-test-${Date.now()}`, 'companion_renderer');
  compileSwiftRenderer(tempBin);

  try {
    const result = execFileSync(tempBin, ['--test-visual-match'], { encoding: 'utf8' });
    const parsed = JSON.parse(result.trim());
    assert.strictEqual(parsed.valid, true, 'Visual match test suite failed');
    assert.strictEqual(parsed.positiveMatch.matched, true, 'Positive match must locate pet');
    assert.strictEqual(parsed.positiveMatch.correct, true, 'Positive match coordinates must be correct');
    assert.strictEqual(parsed.positiveMatch.x, parsed.positiveMatch.expectedX, 'Matched X must match injected X');
    assert.strictEqual(parsed.positiveMatch.y, parsed.positiveMatch.expectedY, 'Matched Y must match injected Y');
    assert.ok(parsed.positiveMatch.confidence >= 0.85, 'Positive match confidence must be high');
    assert.strictEqual(parsed.noMatch.rejected, true, 'Low confidence / no-match frame must be rejected');
    assert.strictEqual(parsed.boundsContainment.withinBounds, true, 'Matched rect must be strictly within host bounds');
    assert.strictEqual(parsed.boundsContainment.smallerHostRejected, true, 'Host smaller than template must be safely rejected');
    assert.strictEqual(parsed.boundsContainment.edgeBoundaryMatched, true, 'Edge boundary match at (0, 0) must be accurate');
  } finally {
    try { fs.rmSync(path.dirname(tempBin), { recursive: true, force: true }); } catch (_) {}
  }
});

test('014 Voice pet anchor estimates position from host geometry without Screen Recording', async (t) => {
  if (!hasXcrun) {
    t.skip('xcrun not available');
    return;
  }
  const tempBin = path.join(os.tmpdir(), `companion-test-${Date.now()}`, 'companion_renderer');
  compileSwiftRenderer(tempBin);

  try {
    const result = execFileSync(tempBin, ['--test-voice-geometry-anchor'], { encoding: 'utf8' });
    const parsed = JSON.parse(result.trim());
    assert.strictEqual(parsed.valid, true, 'Voice host geometry anchor test failed');
    assert.strictEqual(parsed.geometryEstimated, true, 'The pet position should follow the host geometry estimate');
    assert.strictEqual(parsed.panelVisible, true, 'The timer panel should follow an eligible voice host');
    assert.strictEqual(parsed.wideHostRestored, true, 'The smoothed anchor should follow a different host size');
    assert.strictEqual(parsed.hiddenWhenHostMissing, true, 'The panel should hide when no pet host exists');
  } finally {
    try { fs.rmSync(path.dirname(tempBin), { recursive: true, force: true }); } catch (_) {}
  }
});
