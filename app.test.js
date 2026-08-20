import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calibrationStep } from './app.js';

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
