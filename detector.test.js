import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprint, cosineDistance, calibrate, createDetector } from './detector.js';
import { applyBump, applyUndo } from './tally.js';

const N = 512; // spectrum length (linear magnitude, not dB)
const BASELINE_AMP = 0.001;

function baselineSpectrum() {
  return new Float64Array(N).fill(BASELINE_AMP);
}

// "tap" shape: broadband energy weighted toward low bins, decaying.
function tapSpectrum(amplitude = 1) {
  const s = new Float64Array(N);
  for (let i = 1; i < N; i++) s[i] = amplitude * Math.exp(-i / 60);
  return s;
}

// a clearly different shape: energy weighted toward high bins.
function clankSpectrum(amplitude = 1) {
  const s = new Float64Array(N);
  for (let i = 1; i < N; i++) s[i] = amplitude * Math.exp(-(N - i) / 60);
  return s;
}

// Feed `warmupFrames` baseline frames so the flux rolling buffer fills with
// near-zero values before any impulse arrives (mirrors real startup).
function warmUp(detector, count = 60, stepMs = 16) {
  let t = 0;
  for (let i = 0; i < count; i++) {
    detector.feed(baselineSpectrum(), t);
    t += stepMs;
  }
  return t;
}

function calibrateFromShape(spectrumFn, jitters = [1, 1.02, 0.98, 1.01, 0.99]) {
  const examples = jitters.map((j) => fingerprint(spectrumFn(j)));
  return calibrate(examples);
}

test('exact count: N well-spaced matching impulses produce exactly N events', () => {
  const { centroid, matchThreshold } = calibrateFromShape(tapSpectrum);
  const detector = createDetector({ centroid, matchThreshold, noiseFloor: 0, sensitivity: 0.5, refractoryMs: 120 });

  let t = warmUp(detector);
  let counted = 0;
  const spacingMs = 300; // well beyond the 120ms refractory
  const impulses = 5;

  for (let i = 0; i < impulses; i++) {
    detector.feed(baselineSpectrum(), t);
    t += 16;
    const result = detector.feed(tapSpectrum(1), t);
    if (result) counted++;
    t += 16;
    detector.feed(baselineSpectrum(), t);
    t += spacingMs;
  }

  assert.equal(counted, impulses);
});

test('refractory: two impulses closer than refractory period count once', () => {
  const { centroid, matchThreshold } = calibrateFromShape(tapSpectrum);
  const refractoryMs = 120;
  const detector = createDetector({ centroid, matchThreshold, noiseFloor: 0, sensitivity: 0.5, refractoryMs });

  let t = warmUp(detector);
  let counted = 0;

  detector.feed(baselineSpectrum(), t);
  t += 16;
  if (detector.feed(tapSpectrum(1), t)) counted++;
  t += 16;
  detector.feed(baselineSpectrum(), t);
  t += 40; // well inside the 120ms refractory window

  detector.feed(baselineSpectrum(), t);
  t += 16;
  if (detector.feed(tapSpectrum(1), t)) counted++;
  t += 16;
  detector.feed(baselineSpectrum(), t);

  assert.equal(counted, 1);
});

test('wrong sound rejected even with flux well above threshold', () => {
  const { centroid, matchThreshold } = calibrateFromShape(tapSpectrum);
  const detector = createDetector({ centroid, matchThreshold, noiseFloor: 0, sensitivity: 0.5, refractoryMs: 120 });

  let t = warmUp(detector);
  let counted = 0;
  const spacingMs = 300;

  for (let i = 0; i < 5; i++) {
    detector.feed(baselineSpectrum(), t);
    t += 16;
    const result = detector.feed(clankSpectrum(3), t); // loud, wrong shape
    if (result) counted++;
    t += 16;
    detector.feed(baselineSpectrum(), t);
    t += spacingMs;
  }

  assert.equal(counted, 0);
});

test('steady loud noise produces zero counts (flux stays near zero)', () => {
  const { centroid, matchThreshold } = calibrateFromShape(tapSpectrum);
  const detector = createDetector({ centroid, matchThreshold, noiseFloor: 0, sensitivity: 0.5, refractoryMs: 120 });

  const loudConstant = tapSpectrum(5); // loud, but never changes frame-to-frame
  let t = 0;
  let counted = 0;
  for (let i = 0; i < 200; i++) {
    const result = detector.feed(loudConstant, t);
    if (result) counted++;
    t += 16;
  }

  assert.equal(counted, 0);
});

test('a rejected sound does not blind the detector to a real tap shortly after', () => {
  const { centroid, matchThreshold } = calibrateFromShape(tapSpectrum);
  const detector = createDetector({ centroid, matchThreshold, noiseFloor: 0, sensitivity: 0.5, refractoryMs: 120 });

  let t = warmUp(detector);

  detector.feed(baselineSpectrum(), t);
  t += 16;
  const rejected = detector.feed(clankSpectrum(3), t); // loud, non-matching
  t += 16;
  detector.feed(baselineSpectrum(), t);
  t += 50; // shortly after, well inside what a naive refractory-on-rejection would have blocked

  detector.feed(baselineSpectrum(), t);
  t += 16;
  const counted = detector.feed(tapSpectrum(1), t); // the real tap

  assert.equal(rejected, null);
  assert.notEqual(counted, null);
});

test('calibrate clamps matchThreshold for a pathologically tight example set', () => {
  const examples = [1, 1, 1, 1, 1].map((j) => fingerprint(tapSpectrum(j)));
  const { matchThreshold } = calibrate(examples);
  assert.ok(matchThreshold >= 0.02, `threshold ${matchThreshold} should clamp to >= 0.02`);
  assert.ok(matchThreshold <= 0.5);
});

test('calibrate clamps matchThreshold for a pathologically scattered example set', () => {
  const examples = [
    fingerprint(tapSpectrum(1)),
    fingerprint(clankSpectrum(1)),
    fingerprint(tapSpectrum(3)),
    fingerprint(clankSpectrum(5)),
    fingerprint(tapSpectrum(0.2)),
  ];
  const { matchThreshold } = calibrate(examples);
  assert.ok(matchThreshold <= 0.5, `threshold ${matchThreshold} should clamp to <= 0.5`);
  assert.ok(matchThreshold >= 0.02);
});

test('fingerprint output is a unit-normalised 16-length vector', () => {
  const fp = fingerprint(tapSpectrum(2));
  assert.equal(fp.length, 16);
  let norm = 0;
  for (let i = 0; i < fp.length; i++) norm += fp[i] * fp[i];
  assert.ok(Math.abs(Math.sqrt(norm) - 1) < 1e-9);
});

test('loud room: high steady noise bed does not bury real taps (guards Math.max, not + noiseFloor)', () => {
  const { centroid, matchThreshold } = calibrateFromShape(tapSpectrum);
  // A noisy room calibrates a high noiseFloor. Rolling median of the flux
  // buffer already tracks the noise bed itself, so under the old
  // `median*mult + noiseFloor` formula the bar is charged twice and real
  // taps fall under it. Use a clank-shaped noise bed (wrong fingerprint) so
  // any accidental threshold crossing during warmup is rejected at the
  // fingerprint stage instead of falsely arming the refractory gate.
  const noiseFloor = 35; // ~0.6x a real tap's flux — comparable to the noise bed below
  const detector = createDetector({ centroid, matchThreshold, noiseFloor, sensitivity: 0.5, refractoryMs: 120 });

  // Warm up so the rolling median alone (median * multiplier ~= 35.7) is
  // already comparable to noiseFloor (35) — under the old additive formula
  // the combined bar (~71) exceeds a real tap's flux (~59); under the new
  // Math.max formula the bar stays ~36, well under it.
  let t = 0;
  for (let i = 0; i < 60; i++) {
    detector.feed(clankSpectrum(i % 2 === 0 ? 0.6 : 0), t);
    t += 16;
  }

  let counted = 0;
  const impulses = 5;
  for (let i = 0; i < impulses; i++) {
    detector.feed(baselineSpectrum(), t);
    t += 16;
    const result = detector.feed(tapSpectrum(1), t);
    if (result) counted++;
    t += 16;
    detector.feed(baselineSpectrum(), t);
    t += 300;
  }

  assert.equal(counted, impulses, `expected all ${impulses} taps counted, got ${counted}`);
});

test('calibrate keeps matchThreshold ceiling at 0.15 for a pathologically scattered set', () => {
  const examples = [
    fingerprint(tapSpectrum(1)),
    fingerprint(clankSpectrum(1)),
    fingerprint(tapSpectrum(3)),
    fingerprint(clankSpectrum(5)),
    fingerprint(tapSpectrum(0.2)),
  ];
  const { matchThreshold } = calibrate(examples);
  assert.ok(matchThreshold <= 0.15, `threshold ${matchThreshold} should clamp to <= 0.15`);
});

test('centroid-less detector counts matching impulses on flux+refractory alone', () => {
  const detector = createDetector({ centroid: null, noiseFloor: 0, sensitivity: 0.5, refractoryMs: 120 });

  let t = warmUp(detector);
  let counted = 0;
  const spacingMs = 300;
  const impulses = 5;

  assert.doesNotThrow(() => {
    for (let i = 0; i < impulses; i++) {
      detector.feed(baselineSpectrum(), t);
      t += 16;
      const result = detector.feed(tapSpectrum(1), t);
      if (result) counted++;
      t += 16;
      detector.feed(baselineSpectrum(), t);
      t += spacingMs;
    }
  });

  assert.equal(counted, impulses);
});

test('cosineDistance is clamped to [0, 2]', () => {
  const a = fingerprint(tapSpectrum(1));
  assert.equal(cosineDistance(a, a) < 1e-9, true);
  const b = fingerprint(clankSpectrum(1));
  const d = cosineDistance(a, b);
  assert.ok(d >= 0 && d <= 2);
});

// --- tally.js: bump/undo, clamped at zero ----------------------------------

test('applyBump clamps at zero and records nothing when clamped', () => {
  const { count, applied } = applyBump(0, -1);
  assert.equal(count, 0);
  assert.equal(applied, 0);
});

test('reviewer repro: bump -1 at 0 then undo must stay at 0, not rise to 1', () => {
  let count = 0;
  let history = [];
  const b = applyBump(count, -1);
  count = b.count;
  if (b.applied !== 0) history.push(b.applied);
  const u = applyUndo(count, history);
  assert.equal(u.count, 0);
});

test('normal increment then undo returns to the prior count', () => {
  const b = applyBump(5, 1);
  assert.equal(b.count, 6);
  const history = [b.applied];
  const u = applyUndo(b.count, history);
  assert.equal(u.count, 5);
  assert.deepEqual(u.history, []);
});

test('undo with empty history is a safe no-op', () => {
  const u = applyUndo(3, []);
  assert.equal(u.count, 3);
  assert.deepEqual(u.history, []);
});

test('mixed sequence of bumps and undos ends where hand-calculation says', () => {
  let count = 0;
  let history = [];
  const push = (delta) => {
    const r = applyBump(count, delta);
    count = r.count;
    if (r.applied !== 0) history.push(r.applied);
  };
  push(1);   // 1, applied 1
  push(1);   // 2, applied 1
  push(-1);  // 1, applied -1
  push(-1);  // 0, applied -1
  push(-5);  // 0, clamped, applied 0, not recorded
  push(1);   // 1, applied 1
  ({ count, history } = applyUndo(count, history)); // undo the +1 -> 0
  ({ count, history } = applyUndo(count, history)); // undo the -1 -> 1
  assert.equal(count, 1);
  assert.deepEqual(history, [1, 1, -1]);
});
