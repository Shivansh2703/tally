import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calibrationStep, micNeedsReacquire, micNeedsResume, isValidCalibration, noiseFloorFromRoom } from './app.js';
import { FINGERPRINT_DIM } from './detector.js';

// Owner ruling 2026-08-21: "lower the sensitivity min for tally. Make it min 5x the room."
test('noiseFloorFromRoom: the detection floor is 5x the measured room level', () => {
  assert.equal(noiseFloorFromRoom(10), 50);
  assert.equal(noiseFloorFromRoom(0), 0);
});

test('calibrationStep: fewer than 3 examples never finishes, Done not offered', () => {
  for (const n of [0, 1, 2]) {
    const step = calibrationStep(n, false);
    assert.equal(step.canFinish, false);
    assert.equal(step.finished, false);
    const stepDone = calibrationStep(n, true);
    assert.equal(stepDone.finished, false, 'Done click before 3 examples must not finish early');
  }
});

test('calibrationStep: 3rd example enables Done but does not auto-finish', () => {
  const step = calibrationStep(3, false);
  assert.equal(step.canFinish, true);
  assert.equal(step.finished, false);
});

test('calibrationStep: Done click at 3, 4 finishes on that click', () => {
  assert.equal(calibrationStep(3, true).finished, true);
  assert.equal(calibrationStep(4, true).finished, true);
});

test('calibrationStep: 5 examples always finishes, Done or not', () => {
  assert.equal(calibrationStep(5, false).finished, true);
  assert.equal(calibrationStep(5, true).finished, true);
});

// --- recalibration mic-liveness bug (owner report 2026-08-20) --------------

test('micNeedsReacquire: true with no context yet, a closed context, or an ended track', () => {
  assert.equal(micNeedsReacquire(undefined, undefined), true);
  assert.equal(micNeedsReacquire('closed', 'live'), true);
  assert.equal(micNeedsReacquire('running', 'ended'), true);
});

test('micNeedsReacquire: false when the context is alive (running or suspended) and the track is live', () => {
  assert.equal(micNeedsReacquire('running', 'live'), false);
  assert.equal(micNeedsReacquire('suspended', 'live'), false);
});

test('micNeedsResume: true only for a suspended context, not running or closed', () => {
  assert.equal(micNeedsResume('suspended'), true);
  assert.equal(micNeedsResume('running'), false);
  assert.equal(micNeedsResume('closed'), false);
});

// --- calibration shape guard (independent review, 2026-08-20) --------------
// The fingerprint dimension went 16 -> 48 (BANDS * FP_FRAMES) in the type-matching
// upgrade. A calibration saved under the old shape must be discarded on load, not
// fed into cosineDistance against mismatched-length vectors.

test('isValidCalibration: a stale 16-length centroid (pre-upgrade shape) is rejected', () => {
  assert.equal(isValidCalibration({ centroid: new Array(16).fill(0.1), matchThreshold: 0.12 }), false);
});

test('isValidCalibration: a current 48-length centroid, with or without negatives, is accepted', () => {
  const centroid = new Array(FINGERPRINT_DIM).fill(0.1);
  assert.equal(isValidCalibration({ centroid, matchThreshold: 0.12 }), true);
  assert.equal(
    isValidCalibration({ centroid, matchThreshold: 0.12, negatives: [new Array(FINGERPRINT_DIM).fill(0.2)] }),
    true
  );
});

test('isValidCalibration: malformed shapes are rejected, not thrown on', () => {
  const centroid = new Array(FINGERPRINT_DIM).fill(0.1);
  assert.equal(isValidCalibration(null), false);
  assert.equal(isValidCalibration({}), false);
  assert.equal(isValidCalibration({ matchThreshold: 0.12 }), false, 'missing centroid');
  assert.equal(isValidCalibration({ centroid: 'nope' }), false, 'centroid not an array');
  assert.equal(
    isValidCalibration({ centroid, negatives: [new Array(16).fill(0.2)] }),
    false,
    'negative with the old (16) dimension'
  );
  assert.equal(
    isValidCalibration({ centroid, negatives: 'nope' }),
    false,
    'negatives not an array'
  );
});

// --- slider scales + mic routing (2026-08-20 second batch) ------------------

import { sensitivityLabel, cooldownLabel, pickBuiltInMic } from './app.js';

test('sensitivityLabel renders the percentage and the real flux multiplier', () => {
  assert.equal(sensitivityLabel(0.5), '50% · bar 2.0× room');
  assert.equal(sensitivityLabel(0), '0% · bar 3.5× room');
  assert.equal(sensitivityLabel(1), '100% · bar 0.5× room');
});

test('cooldownLabel renders ms and the counting-rate ceiling it implies', () => {
  assert.equal(cooldownLabel(250), '250 ms · max 4/s');
  assert.equal(cooldownLabel(80), '80 ms · max 12.5/s');
  assert.equal(cooldownLabel(600), '600 ms · max 1.7/s');
});

test('pickBuiltInMic: Bluetooth grant with a built-in available -> picks the built-in', () => {
  const devices = [
    { kind: 'audioinput', label: 'AirPods Pro', deviceId: 'bt-1' },
    { kind: 'audioinput', label: 'iPhone Microphone', deviceId: 'builtin-1' },
    { kind: 'videoinput', label: 'Built-in Camera', deviceId: 'cam-1' },
  ];
  assert.equal(pickBuiltInMic('AirPods Pro', devices), 'builtin-1');
});

test('pickBuiltInMic: leaves a built-in or wired grant alone', () => {
  const devices = [
    { kind: 'audioinput', label: 'iPhone Microphone', deviceId: 'builtin-1' },
    { kind: 'audioinput', label: 'AirPods Pro', deviceId: 'bt-1' },
  ];
  assert.equal(pickBuiltInMic('iPhone Microphone', devices), null);
  assert.equal(pickBuiltInMic('External USB Mic', devices), null);
});

test('pickBuiltInMic: Bluetooth grant but no built-in to switch to -> keep what we have', () => {
  const devices = [{ kind: 'audioinput', label: 'AirPods Pro', deviceId: 'bt-1' }];
  assert.equal(pickBuiltInMic('AirPods Pro', devices), null);
  // permission not yet granted: labels come back empty — must not switch blindly
  assert.equal(pickBuiltInMic('AirPods Pro', [{ kind: 'audioinput', label: '', deviceId: 'x' }]), null);
});

// --- start-over vs the deferred decision (review-found race) ----------------

import { discardCapture } from './app.js';
import { createDetector } from './detector.js';

test('discardCapture: an onset in flight at the click cannot become example #1 of the new set', () => {
  const N = 512;
  const base = () => new Float64Array(N).fill(0.001);
  const clank = () => { const s = new Float64Array(N); for (let i = 1; i < N; i++) s[i] = 3 * Math.exp(-(N - i) / 60); return s; };
  const detector = createDetector({ centroid: null, noiseFloor: 0, sensitivity: 0.5, refractoryMs: 250 });
  let t = 0;
  for (let i = 0; i < 60; i++) { detector.feed(base(), t); t += 16; }

  const examples = [];
  // the button-press sound: an onset the detector is still judging when the click lands
  assert.equal(detector.feed(clank(), t), null, 'decision is deferred, nothing settled yet');
  t += 16;

  discardCapture(detector, examples); // the Start-over handler

  // keep feeding — without the flush inside discardCapture, the pending onset settles
  // here and pushes into the freshly-emptied array
  for (let i = 0; i < 10; i++) {
    const ev = detector.feed(base(), t);
    if (ev) examples.push(ev.fingerprint);
    t += 16;
  }
  assert.equal(examples.length, 0, 'the discarded onset must not leak into the new set');
});
