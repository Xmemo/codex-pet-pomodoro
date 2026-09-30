const test = require('node:test');
const assert = require('node:assert/strict');
const { nextEyeRest, eyeRestDue } = require('../src/companion/eye-rest');

const state = { cycle_id: 'one', preset: 'flow', phase: 'work', status: 'running', deadline: 3000 };
test('adapter emits one eye cue via the real local socket without state-file writes', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const net = require('node:net');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eye-rest-'));
  const socketPath = path.join(root, 'daemon.sock');
  const clockStart = Date.now();
  const events = [];
  const server = net.createServer(socket => socket.once('data', () => {
    socket.end(JSON.stringify({ state }) + '\n');
  }));
  await new Promise(resolve => server.listen(socketPath, resolve));
  const { createUltradianAdapter } = require('../src/companion/ultradian-adapter');
  const adapter = createUltradianAdapter({ stateDir: root, socketPath,
    nowSeconds: () => 1199.8 + (Date.now() - clockStart) / 1000,
    onEvent: event => events.push(event) });
  try {
    await adapter.triggerImmediate();
    await new Promise(resolve => setTimeout(resolve, 350));
    await adapter.triggerImmediate();
    const eye = events.filter(event => event.reason === 'eye-rest');
    assert.equal(eye.length, 1);
    const { serializeEvent } = require('../src/companion/bridge');
    assert.equal(JSON.parse(serializeEvent(eye[0])).reason, 'eye-rest');
    assert.equal(fs.existsSync(path.join(root, 'state.json')), false);
  } finally {
    adapter.stop();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('eye rest uses 20-minute boundaries for all focus presets', () => {
  for (const [preset, duration, boundaries] of [
    ['start', 1500, [1200]], ['flow', 3000, [1200, 2400]],
    ['deep', 5400, [1200, 2400, 3600, 4800]],
  ]) {
    const s = { ...state, preset, deadline: duration };
    let now = 0;
    for (const at of boundaries) {
      assert.equal(nextEyeRest(s, now).at, at);
      now = at;
    }
    assert.equal(nextEyeRest(s, now), null);
  }
});
test('pause/rest/stopped do not schedule; resume preserves focus elapsed', () => {
  assert.equal(nextEyeRest({ ...state, status: 'paused' }, 600), null);
  assert.equal(nextEyeRest({ ...state, phase: 'rest' }, 600), null);
  assert.equal(nextEyeRest({ ...state, status: 'stopped' }, 600), null);
  assert.equal(nextEyeRest({ ...state, deadline: 3600 }, 1200).at, 1800);
});
test('reconnect skips elapsed reminders; sleep, replacement and rest suppress stale callbacks', () => {
  assert.equal(nextEyeRest(state, 1300).at, 2400);
  const due = nextEyeRest(state, 0);
  assert.equal(eyeRestDue(due, state, 1200), true);
  assert.equal(eyeRestDue(due, state, 1199), false);
  assert.equal(eyeRestDue(due, state, 1300), false);
  assert.equal(eyeRestDue(due, { ...state, cycle_id: 'two' }, 1200), false);
  assert.equal(eyeRestDue(due, { ...state, status: 'paused' }, 1200), false);
  assert.equal(eyeRestDue(due, { ...state, phase: 'rest' }, 1200), false);
  assert.equal(eyeRestDue(due, null, 1200), false);
});
