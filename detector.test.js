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

// Same instantaneous SHAPE as a tap, but it keeps ringing instead of dying. This is the
// sound the owner's ruling is about: single-frame matching cannot tell it from a tap at
// all (their onset frames are byte-identical), only the decay separates them.
function ringingImpostorFrames(amplitude = 1) {
  return [
    tapSpectrum(amplitude), tapSpectrum(amplitude * 0.9), tapSpectrum(amplitude * 0.8),
    baselineSpectrum(), baselineSpectrum(), baselineSpectrum(), baselineSpectrum(),
  ];
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

// The detector now judges an onset by how it DECAYS, so it holds the onset and settles
// a few frames later. Two consequences every test below has to respect:
//   1. the event does not come back from the feed() that saw the impulse — count the
//      return value of EVERY feed, not just that one.
//   2. calibration examples must come off the detector itself. Hand-building them with
//      the single-frame fingerprint() produces a 16-dim centroid that a 48-dim live
//      fingerprint cannot be compared against.

// One impulse plus the quiet frames it decays into: what a single tap looks like.
function impulseFrames(spectrumFn, amp) {
  return [spectrumFn(amp), baselineSpectrum(), baselineSpectrum(), baselineSpectrum(), baselineSpectrum()];
}

// Feed a whole impulse group, returning how many events came back across all of it.
function feedImpulse(detector, spectrumFn, amp, startMs, stepMs = 16) {
  let counted = 0;
  let t = startMs;
  for (const spec of impulseFrames(spectrumFn, amp)) {
    if (detector.feed(spec, t)) counted++;
    t += stepMs;
  }
  return { counted, t };
}

function calibrateFromShape(spectrumFn, jitters = [1, 1.02, 0.98, 1.01, 0.99]) {
  const capture = createDetector({ centroid: null, noiseFloor: 0, sensitivity: 0.5, refractoryMs: 120 });
  let t = warmUp(capture);
  const examples = [];
  for (const j of jitters) {
    for (const spec of impulseFrames(spectrumFn, j)) {
      const ev = capture.feed(spec, t);
      if (ev) examples.push(ev.fingerprint);
      t += 16;
    }
    t += 300;
  }
  assert.equal(examples.length, jitters.length, 'calibration capture should see every impulse');
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
    const r = feedImpulse(detector, tapSpectrum, 1, t);
    counted += r.counted;
    t = r.t + spacingMs;
  }

  assert.equal(counted, impulses);
});

test('refractory: two impulses closer than refractory period count once', () => {
  const { centroid, matchThreshold } = calibrateFromShape(tapSpectrum);
  const refractoryMs = 120;
  const detector = createDetector({ centroid, matchThreshold, noiseFloor: 0, sensitivity: 0.5, refractoryMs });

  let t = warmUp(detector);
  let counted = 0;

  const first = feedImpulse(detector, tapSpectrum, 1, t);
  counted += first.counted;
  t = first.t + 20; // second impulse lands well inside the 120ms refractory window

  const second = feedImpulse(detector, tapSpectrum, 1, t);
  counted += second.counted;

  assert.equal(counted, 1);
});

test('wrong sound rejected even with flux well above threshold', () => {
  const { centroid, matchThreshold } = calibrateFromShape(tapSpectrum);
  const detector = createDetector({ centroid, matchThreshold, noiseFloor: 0, sensitivity: 0.5, refractoryMs: 120 });

  let t = warmUp(detector);
  let counted = 0;
  const spacingMs = 300;

  for (let i = 0; i < 5; i++) {
    const r = feedImpulse(detector, clankSpectrum, 3, t); // loud, wrong shape
    counted += r.counted;
    t = r.t + spacingMs;
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
  // A long refractory, so that if a REJECTED sound wrongly armed it, the real tap that
  // follows would be swallowed and this test fails. That is the whole point of it.
  const refractoryMs = 300;
  const detector = createDetector({ centroid, matchThreshold, noiseFloor: 0, sensitivity: 0.5, refractoryMs });

  let t = warmUp(detector);

  const junk = feedImpulse(detector, clankSpectrum, 3, t); // loud, non-matching
  t = junk.t + 40; // past the decision window, still far inside the 300ms refractory

  const real = feedImpulse(detector, tapSpectrum, 1, t); // the real tap

  assert.equal(junk.counted, 0, 'the non-matching sound must not count');
  assert.equal(real.counted, 1, 'a rejected sound must not arm the refractory against a real tap');
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
    const r = feedImpulse(detector, tapSpectrum, 1, t);
    counted += r.counted;
    t = r.t + 300;
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
      const r = feedImpulse(detector, tapSpectrum, 1, t);
      counted += r.counted;
      t = r.t + spacingMs;
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

// --- listening to the TYPE of noise, not just its level --------------------
// Owner ruling 2026-08-20: "It needs to listen to the type of noise". These fail if the
// fingerprint ever goes back to a single frame.

// Drive an arbitrary frame sequence through a detector and return every event it yielded.
function feedFrames(detector, frames, startMs = 0, stepMs = 16) {
  const events = [];
  let t = startMs;
  for (const spec of frames) {
    const ev = detector.feed(spec, t);
    if (ev) events.push(ev);
    t += stepMs;
  }
  return { events, t };
}

function captureFingerprint(frames) {
  const capture = createDetector({ centroid: null, noiseFloor: 0, sensitivity: 0.5, refractoryMs: 120 });
  const t = warmUp(capture);
  const { events } = feedFrames(capture, frames, t);
  assert.ok(events.length > 0, 'expected the capture detector to see an onset');
  return events[0].fingerprint;
}

const padded = (...frames) => [
  ...frames, baselineSpectrum(), baselineSpectrum(), baselineSpectrum(),
  baselineSpectrum(), baselineSpectrum(), baselineSpectrum(),
];

test('a sound that is identical for one frame but rings on instead of dying is rejected', () => {
  // The premise, asserted rather than assumed: to a single-frame fingerprint these two
  // sounds are the SAME sound. Nothing about the onset moment separates them.
  assert.ok(
    cosineDistance(fingerprint(tapSpectrum(1)), fingerprint(ringingImpostorFrames(1)[0])) < 1e-12,
    'the impostor must be indistinguishable from a tap in a single frame, or this test proves nothing',
  );

  const { centroid, matchThreshold } = calibrateFromShape(tapSpectrum);
  const detector = createDetector({ centroid, matchThreshold, noiseFloor: 0, sensitivity: 0.5, refractoryMs: 120 });
  let t = warmUp(detector);

  const real = feedFrames(detector, padded(tapSpectrum(1)), t);
  t = real.t + 300;
  const impostor = feedFrames(detector, ringingImpostorFrames(1), t);

  assert.equal(real.events.length, 1, 'the real tap must still count');
  assert.equal(impostor.events.length, 0, 'the ringing impostor must not count');
});

test('onset alignment: a tap peaking one frame late fingerprints the same as one on the boundary', () => {
  // Load-bearing. The analyser hop never lines up with the onset the same way twice; without
  // aligning to the loudest frame the multi-frame fingerprint scatters so badly it scores
  // WORSE than the single-frame one it replaces.
  // The lead frame is deliberately loud enough NOT to trip the restart rule — otherwise
  // the restart re-anchors the onset for us and this test passes without alignment
  // existing at all. (It did, until the negative control caught it.)
  const onBoundary = captureFingerprint(padded(tapSpectrum(1)));
  const oneFrameLate = captureFingerprint(padded(tapSpectrum(0.5), tapSpectrum(1)));
  const { matchThreshold } = calibrateFromShape(tapSpectrum);
  const d = cosineDistance(onBoundary, oneFrameLate);
  assert.ok(d < matchThreshold, `misaligned tap should still match (distance ${d}, threshold ${matchThreshold})`);
});

// --- negative examples: what the room told us to ignore ---------------------

test('a stored negative rejects a sound that would otherwise have counted', () => {
  const { centroid, matchThreshold } = calibrateFromShape(tapSpectrum);
  const mildRing = padded(tapSpectrum(1), tapSpectrum(0.4));
  const mildRingFp = captureFingerprint(mildRing);

  // Without negatives it counts — it is inside the match threshold.
  const permissive = createDetector({ centroid, matchThreshold, noiseFloor: 0, sensitivity: 0.5, refractoryMs: 120 });
  let t = warmUp(permissive);
  assert.equal(feedFrames(permissive, mildRing, t).events.length, 1, 'precondition: this sound counts when nothing says to ignore it');

  // Told to ignore it, it stops counting — and real taps still do.
  const informed = createDetector({
    centroid, matchThreshold, negatives: [mildRingFp], noiseFloor: 0, sensitivity: 0.5, refractoryMs: 120,
  });
  t = warmUp(informed);
  const ignored = feedFrames(informed, mildRing, t);
  const real = feedFrames(informed, padded(tapSpectrum(1)), ignored.t + 300);
  assert.equal(ignored.events.length, 0, 'a sound nearer a negative than the target must not count');
  assert.equal(real.events.length, 1, 'the calibrated tap must still count');
});

test('a candidate negative that looks like the calibrated sound is discarded, not stored', () => {
  // The failure this prevents: the worker taps during the room check, that tap is stored as
  // a thing to ignore, and the app then ignores every tap. Counting stops dead.
  const examples = [1, 1.02, 0.98, 1.01, 0.99].map((j) => captureFingerprint(padded(tapSpectrum(j))));
  const poison = captureFingerprint(padded(tapSpectrum(1)));
  const genuine = captureFingerprint(padded(tapSpectrum(1), tapSpectrum(0.9), tapSpectrum(0.8)));

  const cal = calibrate(examples, [poison, genuine]);
  assert.equal(cal.negatives.length, 1, 'exactly one of the two candidates should survive');
  assert.ok(
    cosineDistance(cal.negatives[0], genuine) < 1e-9,
    'the survivor must be the genuinely different sound, not the tap',
  );

  // ...and counting still works with that calibration.
  const detector = createDetector({
    centroid: cal.centroid, matchThreshold: cal.matchThreshold, negatives: cal.negatives,
    noiseFloor: 0, sensitivity: 0.5, refractoryMs: 120,
  });
  const t = warmUp(detector);
  assert.equal(feedFrames(detector, padded(tapSpectrum(1)), t).events.length, 1, 'taps must still count');
});

test('every onset the detector JUDGES is reported through onEvent, counted or not — this is what feeds the room check and the debug capture', () => {
  const { centroid, matchThreshold } = calibrateFromShape(tapSpectrum);
  const seen = [];
  const detector = createDetector({
    centroid, matchThreshold, noiseFloor: 0, sensitivity: 0.5, refractoryMs: 120,
    onEvent: (ev) => seen.push(ev),
  });
  let t = warmUp(detector);
  t = feedFrames(detector, padded(tapSpectrum(1)), t).t + 300;
  feedFrames(detector, padded(clankSpectrum(3)), t);

  assert.equal(seen.length, 2, 'both the counted tap and the rejected clank should surface');
  assert.deepEqual(seen.map((e) => e.matched), [true, false]);
  assert.ok(seen.every((e) => e.fingerprint && e.frames?.length), 'each event carries the evidence needed to re-score it offline');
});

// --- what the deferred decision does at the edges ---------------------------
// The decision lands a few frames after the onset. These lock down what happens to an
// onset that is still in flight when something interrupts it. Found by review, not by me.

test('a superseded onset is NOT reported as a negative — that is how the app would learn to ignore taps', () => {
  // When a much louder sound arrives inside the decision window the detector restarts on
  // it and drops the earlier onset. That dropped onset must stay silent: it was never
  // judged, it is only a leading edge, and the room check turns every unmatched onEvent
  // into a sound to IGNORE. Reporting it would let a fragment of a real tap become a
  // negative example, and the app would then reject real taps.
  const { centroid, matchThreshold } = calibrateFromShape(tapSpectrum);
  const seen = [];
  const detector = createDetector({
    centroid, matchThreshold, noiseFloor: 0, sensitivity: 0.5, refractoryMs: 120,
    onEvent: (ev) => seen.push(ev),
  });
  let t = warmUp(detector);

  // a quiet onset, then a far louder one one frame later, inside the decision window
  detector.feed(tapSpectrum(0.25), t); t += 16;
  const { events } = feedFrames(detector, padded(tapSpectrum(2)), t);

  assert.equal(seen.length, 1, 'only the judged onset may be reported');
  assert.equal(events.length, 1, 'the louder sound is the one that counts');
  assert.ok(seen[0].matched, 'and it counted');
});

test('flush settles an onset left in flight, so a mode switch cannot silently eat a tap', () => {
  const { centroid, matchThreshold } = calibrateFromShape(tapSpectrum);
  const detector = createDetector({ centroid, matchThreshold, noiseFloor: 0, sensitivity: 0.5, refractoryMs: 120 });
  let t = warmUp(detector);

  // A tap and part of its decay, then the caller stops feeding — mode switch, recalibrate,
  // teardown. Without flush() this tap is dropped and never counted at all.
  const onsetT = t;
  assert.equal(detector.feed(tapSpectrum(1), t), null, 'the decision is deferred, so nothing yet');
  t += 16;
  detector.feed(baselineSpectrum(), t); t += 16;
  detector.feed(baselineSpectrum(), t);

  const flushed = detector.flush();
  assert.notEqual(flushed, null, 'the in-flight tap must still be judged');
  assert.equal(flushed.t, onsetT, 'and it carries its original onset time, not the flush time');
  assert.equal(detector.flush(), null, 'flushing again is a safe no-op');
});

test('an onset with only one frame settles as a REJECT, never a spurious count', () => {
  // Reachable whenever frames stop or stall: a phone throttling requestAnimationFrame, a
  // backgrounded tab, or a flush the instant after an onset. With one frame there is no
  // decay to read, so fingerprintFrames pads by repeating it and the flat signature fails
  // to match. That is the SAFE direction — this app would rather miss than over-count —
  // and it is reported through onEvent, so the debug capture can show it happening.
  const { centroid, matchThreshold } = calibrateFromShape(tapSpectrum);
  const seen = [];
  const detector = createDetector({
    centroid, matchThreshold, noiseFloor: 0, sensitivity: 0.5, refractoryMs: 120,
    onEvent: (ev) => seen.push(ev),
  });
  const t = warmUp(detector);

  detector.feed(tapSpectrum(1), t);
  const flushed = detector.flush();

  assert.equal(flushed, null, 'a one-frame onset must not count');
  assert.equal(seen.length, 1, 'but it must still be reported, or the capture cannot explain the miss');
  assert.equal(seen[0].matched, false);
  assert.equal(seen[0].frames.length, 1);
});

test('cosineDistance throws on a length mismatch instead of returning NaN or a plausible wrong number', () => {
  // The bug this guards: a 48-value fingerprint compared against a 16-value centroid used
  // to return NaN, and NaN <= threshold is false, so the app counted NOTHING, silently.
  // With the arguments the other way round it truncated and returned a small, believable
  // distance — which would OVER-count, the failure this app most needs to avoid.
  const short = fingerprint(tapSpectrum(1));
  const long = captureFingerprint(padded(tapSpectrum(1)));
  assert.equal(short.length, 16);
  assert.equal(long.length, 48);
  assert.throws(() => cosineDistance(long, short), /length mismatch/);
  assert.throws(() => cosineDistance(short, long), /length mismatch/);
});

test('strictness scales the calibrated matchThreshold: a sound just under it matches at 0, is rejected at 0.5', () => {
  // Owner ruling 2026-08-21: "tighten it and add it as a slider." Build a probe whose
  // distance from the centroid is known (measured with an always-match detector), then
  // pick a matchThreshold that puts it inside the (0.75x, 1.0x] window strictness carves
  // out — matches with today's behaviour (strictness 0, 1.0x), rejected at the new 0.5
  // default (0.75x).
  const { centroid } = calibrateFromShape(tapSpectrum);

  let measuredDistance = null;
  const probe = createDetector({
    centroid, matchThreshold: 2, noiseFloor: 0, sensitivity: 0.5, refractoryMs: 0,
    onEvent: (ev) => { measuredDistance = ev.distance; },
  });
  let t = warmUp(probe);
  feedImpulse(probe, clankSpectrum, 1, t);
  assert.ok(measuredDistance > 0, 'probe must have measured a real distance');

  // threshold chosen so measuredDistance sits at ~0.85x of it: inside (0.75x, 1.0x].
  const matchThreshold = measuredDistance / 0.85;

  const loose = createDetector({ centroid, matchThreshold, strictness: 0, noiseFloor: 0, sensitivity: 0.5, refractoryMs: 0 });
  t = warmUp(loose);
  const { counted: countedLoose } = feedImpulse(loose, clankSpectrum, 1, t);
  assert.equal(countedLoose, 1, 'strictness 0 keeps today’s tolerance — this must still match');

  const tight = createDetector({ centroid, matchThreshold, strictness: 0.5, noiseFloor: 0, sensitivity: 0.5, refractoryMs: 0 });
  t = warmUp(tight);
  const { counted: countedTight } = feedImpulse(tight, clankSpectrum, 1, t);
  assert.equal(countedTight, 0, 'strictness 0.5 tightens the tolerance to 0.75x — this must now be rejected');
});

test('setStrictness updates tolerance live, same as setSensitivity updates the bar live', () => {
  const { centroid } = calibrateFromShape(tapSpectrum);
  let measuredDistance = null;
  const probe = createDetector({
    centroid, matchThreshold: 2, noiseFloor: 0, sensitivity: 0.5, refractoryMs: 0,
    onEvent: (ev) => { measuredDistance = ev.distance; },
  });
  let t = warmUp(probe);
  feedImpulse(probe, clankSpectrum, 1, t);
  const matchThreshold = measuredDistance / 0.85;

  const detector = createDetector({ centroid, matchThreshold, strictness: 0, noiseFloor: 0, sensitivity: 0.5, refractoryMs: 0 });
  t = warmUp(detector);
  const before = feedImpulse(detector, clankSpectrum, 1, t);
  assert.equal(before.counted, 1, 'still loose before the call');

  detector.setStrictness(0.5);
  t = before.t + 300;
  const after = feedImpulse(detector, clankSpectrum, 1, t);
  assert.equal(after.counted, 0, 'tightened after setStrictness(0.5)');
});
