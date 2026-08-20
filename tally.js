// Pure count/undo logic, no DOM. The applied delta (not the requested one) is
// what gets recorded, so clamping at zero can never desync from history.

export function applyBump(count, delta) {
  const next = Math.max(0, count + delta);
  return { count: next, applied: next - count };
}

export function applyUndo(count, history) {
  if (history.length === 0) return { count, history };
  const last = history[history.length - 1];
  return { count: Math.max(0, count - last), history: history.slice(0, -1) };
}
