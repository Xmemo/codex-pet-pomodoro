const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { sendDaemonCommand } = require('../parser.js');
const { nextEyeRest, eyeRestDue } = require('./eye-rest.js');

function createUltradianAdapter(options = {}) {
  const {
    stateDir,
    debounceDelay = 100,
    onEvent = () => {},
    onError = () => {},
  } = options;

  let debounceTimer = null;
  let fsWatcher = null;
  let lastSemanticKey = '';
  let isShutdown = false;
  let eventSequence = 0;
  let lastMidpointNotified = null;
  let eyeRestTimer = null;
  let scheduledEyeRestKey = null;
  let latestState = null;
  const nowSeconds = options.nowSeconds || (() => Date.now() / 1000);

  function scheduleEyeRest(state) {
    const key = `${state.cycle_id}:${state.status}:${state.phase}:${state.deadline}`;
    if (eyeRestTimer && key === scheduledEyeRestKey) return;
    clearTimeout(eyeRestTimer);
    eyeRestTimer = null;
    const candidate = nextEyeRest(state, nowSeconds());
    if (!candidate || isShutdown) return;
    scheduledEyeRestKey = key;
    eyeRestTimer = setTimeout(async () => {
      eyeRestTimer = null;
      latestState = null;
      await queryAndEmit();
      if (!isShutdown && eyeRestDue(candidate, latestState, nowSeconds())) {
        onEvent({ schemaVersion: 1, event: 'companion.midpoint',
          eventId: nextEventId(), reason: 'eye-rest',
          deadline: latestState.deadline });
      }
    }, Math.max(1, Math.ceil((candidate.at - nowSeconds()) * 1000)));
    eyeRestTimer.unref?.();
  }

  const nextEventId = options.eventIdFactory || (() => {
    eventSequence += 1;
    return `evt-${eventSequence}-${crypto.randomBytes(8).toString('hex')}`;
  });

  function daemonStatusToEvent(status, phase) {
    if (status === 'running' && phase === 'work') {
      return { event: 'companion.deactivate', reason: 'Timer entered work phase' };
    }
    if (status === 'running' && phase === 'rest') {
      return { event: 'companion.activate', reason: 'Timer entered rest phase' };
    }
    if (status === 'paused' && phase === 'rest') {
      return { event: 'companion.pause', reason: 'Timer paused during rest' };
    }
    if (status === 'idle' || status === 'stopped') {
      return { event: 'companion.deactivate', reason: `Timer is ${status}` };
    }
    if (status === 'completed') {
      return { event: 'companion.deactivate', reason: 'Timer completed' };
    }
    return null;
  }

  function semanticKey(state) {
    return `${state.status}:${state.phase}`;
  }

  let lastSemanticStateKey = '';

  function semanticStateKey(state) {
    if (!state) return '';
    return [
      state.schema_version,
      state.cycle_id,
      state.preset,
      state.status,
      state.phase,
      state.deadline,
      state.remaining_seconds,
      state.intention_text,
      state.midpoint_notified,
      state.review_pending,
      state.last_error
    ].map(v => v === undefined || v === null ? '' : String(v)).join(':');
  }

  async function queryAndEmit() {
    if (isShutdown) return;
    try {
      const response = await sendDaemonCommand(options.socketPath || path.join(stateDir, 'daemon.sock'), { command: 'status' });
      if (!response || !response.state) return;
      latestState = response.state;
      scheduleEyeRest(response.state);

      const stateKey = semanticStateKey(response.state);
      if (stateKey !== lastSemanticStateKey) {
        lastSemanticStateKey = stateKey;
        onEvent({
          schemaVersion: 2,
          event: 'timer.state',
          state: response.state
        });
      }

      const midpointVal = response.state.midpoint_notified === true;
      if (response.state.status === 'running' && response.state.phase === 'work') {
        if (lastMidpointNotified === false && midpointVal === true) {
          onEvent({
            schemaVersion: 1,
            event: 'companion.midpoint',
            eventId: nextEventId(),
            reason: 'Midpoint reached during work phase',
            deadline: response.state.deadline || null,
          });
        }
      }
      lastMidpointNotified = midpointVal;

      const key = semanticKey(response.state);
      if (key === lastSemanticKey) return;
      lastSemanticKey = key;

      const evt = daemonStatusToEvent(response.state.status, response.state.phase);
      if (evt) {
        const payload = {
          schemaVersion: 1,
          event: evt.event,
          eventId: nextEventId(),
          reason: evt.reason,
          deadline: response.state.deadline || null,
        };
        onEvent(payload);
      }
    } catch (err) {
      onError(err);
    }
  }

  function handleFsEvent(eventType, filename) {
    if (filename && filename !== 'state.json') return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      queryAndEmit();
    }, debounceDelay);
  }

  function start() {
    if (fs.existsSync(stateDir)) {
      try {
        fsWatcher = fs.watch(stateDir, handleFsEvent);
        fsWatcher.on('error', (err) => {
          onError(err);
        });
      } catch (err) {
        onError(err);
      }
    }
    queryAndEmit();
  }

  function stop() {
    isShutdown = true;
    clearTimeout(eyeRestTimer);
    eyeRestTimer = null;
    if (fsWatcher) {
      try { fsWatcher.close(); } catch (_) {}
      fsWatcher = null;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  function triggerImmediate() {
    return queryAndEmit();
  }

  return {
    start,
    stop,
    triggerImmediate,
    daemonStatusToEvent,
  };
}

module.exports = {
  createUltradianAdapter,
};
