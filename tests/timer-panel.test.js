const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const hasXcrun = (() => {
  try {
    require('child_process').execSync('which xcrun', { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
})();

function compileSwiftRenderer(binPath) {
  const swiftSrc1 = path.join(__dirname, '..', 'src', 'companion_renderer.swift');
  const swiftSrc2 = path.join(__dirname, '..', 'src', 'timer_panel.swift');
  const binDir = path.dirname(binPath);
  if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true });
  }
  try {
    execFileSync('/usr/bin/xcrun', ['swiftc', '-O', '-o', binPath, swiftSrc1, swiftSrc2], { stdio: 'pipe' });
  } catch (err) {
    throw new Error(`Failed to compile Swift renderer: ${err.message}`);
  }
}

test('T005/T006: Swift Timer Panel integration tests', async (t) => {
  if (!hasXcrun) {
    t.skip('xcrun not available');
    return;
  }

  const tempBinDir = path.join(os.tmpdir(), `companion-panel-test-${Date.now()}`);
  const tempBin = path.join(tempBinDir, 'companion_renderer');

  compileSwiftRenderer(tempBin);

  await t.test('--test-panel-geometry validates compact dial geometry', () => {
    const result = execFileSync(tempBin, ['--test-panel-geometry'], { encoding: 'utf8' });
    assert.ok(result.includes('COLLAPSED: effectView is hidden'), 'Collapsed effectView must be hidden');
    assert.ok(result.includes('COLLAPSED: panel is transparent'), 'Collapsed panel must be transparent');
    assert.ok(result.includes('EXPANDED: effectView is visible'), 'Expanded effectView must be visible');
    assert.ok(result.includes('EXPANDED: effectView excludes tomato region'), 'Expanded effectView must exclude tomato region');
    assert.ok(result.includes('EXPANDED: effectView covers all controls'), 'Expanded effectView must cover all controls');
    assert.ok(result.includes('OK: geometry valid'), `Output was: ${result}`);
  });

  await t.test('--test-panel-focus validates interactive controls', () => {
    const result = execFileSync(tempBin, ['--test-panel-focus'], { encoding: 'utf8' });
    assert.ok(result.includes('OK: interactive controls valid'), `Output was: ${result}`);
  });

  // Cleanup
  try { fs.rmSync(tempBinDir, { recursive: true, force: true }); } catch (_) {}
});

test('T007: bridge.js command/status envelope validation tests', async (t) => {
  const { startBridge } = require('../src/companion/bridge.js');
  
  await t.test('bridge strictly validates start command', () => {
    let errorCalled = null;
    let eventCalled = null;
    
    let dataCb = null;
    const mockChild = {
      stdin: { writable: true, write() {}, end() {} },
      stdout: {
        on(event, cb) {
          if (event === 'data') dataCb = cb;
        }
      },
      on() {},
      pid: 9999
    };
    
    let protocolErrorCalled = null;
    let commandCalled = null;
    
    const bridge = startBridge({
      binPath: '/tmp/fake-bin',
      spawn: () => mockChild,
      existsSync: () => true,
      onError: (err) => { errorCalled = err; },
      onEvent: (evt) => { eventCalled = evt; },
      onCommand: (cmd) => { commandCalled = cmd; },
      onProtocolError: (err) => { protocolErrorCalled = err; }
    });
    
    bridge.start();
    
    // 1. Send valid status
    errorCalled = null;
    eventCalled = null;
    protocolErrorCalled = null;
    commandCalled = null;
    dataCb(JSON.stringify({
      kind: 'status',
      panelReady: true,
      engineState: 'small',
      isPaused: false,
      activeClip: null,
      currentFrame: 0,
      fps: 8,
      anchorFound: false,
      windowVisible: false,
      error: null
    }) + '\n');
    assert.strictEqual(errorCalled, null);
    assert.strictEqual(protocolErrorCalled, null);
    assert.strictEqual(commandCalled, null);
    assert.strictEqual(eventCalled.kind, 'status');
    
    // 2. Send invalid command (missing intentionText for start)
    errorCalled = null;
    eventCalled = null;
    protocolErrorCalled = null;
    commandCalled = null;
    dataCb(JSON.stringify({
      kind: 'command',
      command: 'start',
      preset: 'flow',
      replace: false
    }) + '\n');
    assert.ok(protocolErrorCalled instanceof Error);
    assert.strictEqual(errorCalled, null);
    assert.strictEqual(eventCalled, null);
    assert.strictEqual(commandCalled, null);
    
    // 3. Send valid command
    errorCalled = null;
    eventCalled = null;
    protocolErrorCalled = null;
    commandCalled = null;
    dataCb(JSON.stringify({
      kind: 'command',
      command: 'start',
      preset: 'flow',
      intentionText: 'Create a verifiable result',
      replace: false
    }) + '\n');
    assert.strictEqual(errorCalled, null);
    assert.strictEqual(protocolErrorCalled, null);
    assert.strictEqual(eventCalled, null);
    assert.strictEqual(commandCalled.command, 'start');
    assert.strictEqual(commandCalled.intentionText, 'Create a verifiable result');
    
    // 4. Send unknown command
    errorCalled = null;
    eventCalled = null;
    protocolErrorCalled = null;
    commandCalled = null;
    dataCb(JSON.stringify({
      kind: 'command',
      command: 'unknown-cmd'
    }) + '\n');
    assert.ok(protocolErrorCalled instanceof Error);
    assert.strictEqual(errorCalled, null);
    assert.strictEqual(commandCalled, null);
  });
});
