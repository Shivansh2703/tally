import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calibrationStep, micNeedsReacquire, micNeedsResume, isValidCalibration } from './app.js';
import { FINGERPRINT_DIM } from './detector.js';

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
