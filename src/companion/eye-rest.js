const WORK_SECONDS = { start: 1500, flow: 3000, deep: 5400 };
const INTERVAL_SECONDS = 1200;

// Deadlines already exclude paused time. Reconnection skips elapsed boundaries.
function nextEyeRest(state, now) {
  const duration = WORK_SECONDS[state?.preset];
  if (!duration || state.status !== 'running' || state.phase !== 'work' ||
      !Number.isFinite(state.deadline) || !state.cycle_id) return null;
  const elapsed = duration - (state.deadline - now);
  const boundary = (Math.floor(Math.max(0, elapsed) / INTERVAL_SECONDS) + 1) * INTERVAL_SECONDS;
  if (boundary >= duration) return null;
  return { cycleId: state.cycle_id, deadline: state.deadline,
    at: state.deadline - duration + boundary };
}

function eyeRestDue(candidate, state, now) {
  return !!candidate && state?.status === 'running' && state.phase === 'work' &&
    state.cycle_id === candidate.cycleId && state.deadline === candidate.deadline &&
    now >= candidate.at && now - candidate.at < 5 && now < state.deadline;
}

module.exports = { nextEyeRest, eyeRestDue };
