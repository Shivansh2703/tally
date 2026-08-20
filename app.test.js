import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calibrationStep, micNeedsReacquire, micNeedsResume } from './app.js';

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
