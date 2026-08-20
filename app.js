// App shell wiring for Tally: mode switching (TAP / SOUND / MOTION-stub),
// calibration flow, persistence. DOM-touching code only runs from initApp(),
// so this module can be imported under `node --test` to exercise the pure
// logic below without a browser.
import { fingerprint, calibrate, createDetector } from './detector.js';
import { applyBump, applyUndo } from './tally.js';

const STORAGE_KEY = 'tally-v1-state';
const MIN_EXAMPLES = 3;
const MAX_EXAMPLES = 5;

// Owner ruling 2026-08-19 ~18:40: accept after 3 examples, keep listening up
// to 5. Pure decision so the "Done" affordance and the auto-stop share one
// rule instead of drifting apart.
export function calibrationStep(count, doneClicked) {
  const canFinish = count >= MIN_EXAMPLES;
  const finished = count >= MAX_EXAMPLES || (doneClicked && canFinish);
  return { canFinish, finished };
}

// Owner report 2026-08-20: after recalibrating, "the mic doesn't pick
// anything up." Root cause: unlike v0 (which unconditionally re-ran
// initMic() — fresh getUserMedia + fresh AudioContext — at the top of every
// calibration), the shell acquires the mic once ever (`if (!audioCtx)`) and
// never rechecks it. A real device can suspend the AudioContext (background/
// lock) or end the track (OS reclaims the mic) with nothing to detect or
// repair it. Pure decisions so they're testable without a mic.
export function micNeedsReacquire(audioCtxState, trackState) {
  return !audioCtxState || audioCtxState === 'closed' || trackState === 'ended';
}
export function micNeedsResume(audioCtxState) {
  return audioCtxState === 'suspended';
}

function defaultState() {
  return {
    count: 0,
    history: [],
    mode: 'tap',
    settings: {
      sound: { sensitivity: 0.5, cooldownMs: 250, tick: false },
      tap: { tick: false },
    },
    calibration: null,
    noiseFloor: 0,
  };
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!saved || typeof saved !== 'object') return defaultState();
    const d = defaultState();
    return {
      ...d,
      ...saved,
      settings: { ...d.settings, ...(saved.settings || {}) },
    };
  } catch {
    return defaultState();
  }
}

function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function initApp() {
  const state = loadState();

  const $ = (id) => document.getElementById(id);
  const countEl = $('countDisplay');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function showScreen(id) {
    for (const el of document.querySelectorAll('.screen')) el.classList.remove('active');
    $(id).classList.add('active');
  }

  function persist() {
    saveState(state);
  }

  function render() {
    countEl.textContent = state.count;
    for (const btn of document.querySelectorAll('.mode-btn')) {
      btn.classList.toggle('active', btn.dataset.mode === state.mode);
    }
    $('soundControls').style.display = state.mode === 'sound' ? '' : 'none';
    $('tapHint').style.display = state.mode === 'tap' ? '' : 'none';
    $('tickToggle').checked = !!state.settings[state.mode]?.tick;
  }

  function pulse() {
    if (reduceMotion) return;
    countEl.classList.remove('pulse');
    // force reflow so the animation can retrigger on consecutive bumps
    void countEl.offsetWidth;
    countEl.classList.add('pulse');
  }

  function bump(delta) {
    const { count, applied } = applyBump(state.count, delta);
    state.count = count;
    if (applied !== 0) state.history.push(applied);
    persist();
    render();
    if (applied > 0) {
      pulse();
      if (navigator.vibrate) navigator.vibrate(30);
      // Haptic-only tick (no audio tone): a sound on count would feed back
      // into the mic in SOUND mode and self-trigger the detector, so audio
      // ticks are not offered at all rather than merely disabled — nothing
      // to enforce because nothing to leak. ponytail: haptic tick covers
      // the spec's "optional tick"; add an audio tick only if asked for one
      // that's not mic-adjacent (e.g. TAP-only).
      if (state.settings[state.mode]?.tick && navigator.vibrate) navigator.vibrate(15);
    }
  }

  $('btnMinus').onclick = () => bump(-1);
  $('btnPlus').onclick = () => bump(1);
  $('btnUndo').onclick = () => {
    const { count, history } = applyUndo(state.count, state.history);
    state.count = count;
    state.history = history;
    persist();
    render();
  };
  $('btnReset').onclick = () => {
    if (confirm('Reset the count to zero? This cannot be undone.')) {
      state.count = 0;
      state.history = [];
      persist();
      render();
    }
  };
  $('tickToggle').onchange = (e) => {
    state.settings[state.mode] = state.settings[state.mode] || {};
    state.settings[state.mode].tick = e.target.checked;
    persist();
  };

  // TAP mode: the whole readout area is the button, not just the digits.
  $('countDisplay-wrap').addEventListener('pointerdown', () => {
    if (state.mode === 'tap') bump(1);
  });

  // --- mode switching ------------------------------------------------------

  let stopSoundLoop = null;

  function setMode(mode) {
    if (stopSoundLoop) { stopSoundLoop(); stopSoundLoop = null; }
    state.mode = mode;
    persist();
    render();
    if (mode === 'sound') startSoundMode();
    if (mode === 'motion') showMotionStub();
    if (mode === 'tap') showScreen('screen-main');
  }

  for (const btn of document.querySelectorAll('.mode-btn')) {
    btn.onclick = () => setMode(btn.dataset.mode);
  }

  function showMotionStub() {
    showScreen('screen-motion-stub');
  }
  $('btnMotionBack').onclick = () => setMode('tap');

  // --- sound mode: mic plumbing --------------------------------------------

  let audioCtx, analyser, magBuf, micTrack;
  const dbBuf = new Float32Array(512);

  async function initMic() {
    if (micTrack) micTrack.stop();
    if (audioCtx && audioCtx.state !== 'closed') await audioCtx.close().catch(() => {});
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    micTrack = stream.getAudioTracks()[0];
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0;
    source.connect(analyser);
    magBuf = new Float64Array(analyser.frequencyBinCount);
  }

  // Called before every entry into SOUND mode and before every calibration
  // (including Recalibrate, which used to skip this check entirely — see
  // micNeedsReacquire/micNeedsResume above).
  async function ensureMicReady() {
    if (micNeedsReacquire(audioCtx?.state, micTrack?.readyState)) {
      await initMic();
    } else if (micNeedsResume(audioCtx.state)) {
      await audioCtx.resume();
    }
  }

  function readSpectrum() {
    analyser.getFloatFrequencyData(dbBuf);
    for (let i = 0; i < dbBuf.length; i++) magBuf[i] = 10 ** (dbBuf[i] / 20);
    return magBuf;
  }

  function fallbackToTap(message) {
    $('soundError').textContent = message;
    $('soundError').style.display = '';
    setMode('tap');
  }

  async function startSoundMode() {
    $('soundError').style.display = 'none';
    try {
      await ensureMicReady();
    } catch {
      fallbackToTap('Microphone access was denied or unavailable — using TAP mode instead.');
      return;
    }
    if (state.calibration) {
      runDetectionLoop();
    } else {
      showScreen('screen-calibrate-start');
    }
  }

  $('btnCalibrateStart').onclick = () => runCalibration();
  $('btnRecalibrate').onclick = () => runCalibration();

  async function runCalibration() {
    // Recalibrate is reachable straight from the counting screen, bypassing
    // setMode()'s loop teardown — stop any live detection loop first so it
    // doesn't keep bumping the count from a stale detector underneath the
    // calibration screens.
    if (stopSoundLoop) { stopSoundLoop(); stopSoundLoop = null; }
    try {
      await ensureMicReady();
    } catch {
      fallbackToTap('Microphone access was denied or unavailable — using TAP mode instead.');
      return;
    }

    // 1. noise floor (1.5s)
    showScreen('screen-noise');
    let noiseFluxSum = 0, noiseFrames = 0, prevFrame = null;
    const noiseStart = performance.now();
    await new Promise((resolve) => {
      function tick() {
        const elapsed = performance.now() - noiseStart;
        $('noiseCountdown').textContent = Math.max(0, Math.ceil((1500 - elapsed) / 1000));
        const spec = readSpectrum();
        if (prevFrame) {
          let flux = 0;
          for (let i = 0; i < spec.length; i++) flux += Math.max(0, spec[i] - prevFrame[i]);
          noiseFluxSum += flux;
          noiseFrames++;
        }
        prevFrame = Float64Array.from(spec);
        if (elapsed < 1500) requestAnimationFrame(tick);
        else resolve();
      }
      requestAnimationFrame(tick);
    });
    const noiseFloor = noiseFrames > 0 ? (noiseFluxSum / noiseFrames) * 1.5 : 0;

    // 2. tap 3-5 times
    showScreen('screen-tap');
    const dotsEl = $('tapDots');
    dotsEl.innerHTML = '';
    const dots = [];
    for (let i = 0; i < MAX_EXAMPLES; i++) {
      const d = document.createElement('div');
      d.className = 'dot';
      dotsEl.appendChild(d);
      dots.push(d);
    }
    $('btnCalDone').style.display = 'none';
    $('btnCalDone').disabled = true;

    const examples = [];
    let doneClicked = false;
    $('btnCalDone').onclick = () => { doneClicked = true; };
    const tapDetector = createDetector({ centroid: null, noiseFloor, sensitivity: 0.5, refractoryMs: 250 });
    await new Promise((resolve) => {
      function tick() {
        const spec = readSpectrum();
        const result = tapDetector.feed(spec, performance.now());
        if (result) {
          examples.push(fingerprint(spec));
          dots[examples.length - 1].classList.add('filled');
        }
        const step = calibrationStep(examples.length, doneClicked);
        if (step.canFinish) {
          $('btnCalDone').style.display = '';
          $('btnCalDone').disabled = false;
        }
        if (step.finished) { resolve(); return; }
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });

    // 3. consistency check
    const cal = calibrate(examples);
    showScreen('screen-check');
    const SPREAD_BOUND = 0.25;
    if (cal.spread > SPREAD_BOUND) {
      $('checkTitle').textContent = 'Your taps were inconsistent';
      $('checkDetail').textContent = `Spread ${cal.spread.toFixed(3)} is above what we trust (${SPREAD_BOUND}). Tap the same way each time — same spot, same force — and redo.`;
      $('btnCheckContinue').style.display = 'none';
      $('btnCheckRedo').style.display = '';
      await new Promise((resolve) => { $('btnCheckRedo').onclick = resolve; });
      return runCalibration();
    }
    $('checkTitle').textContent = 'Calibration looks consistent';
    $('checkDetail').textContent = `Spread ${cal.spread.toFixed(3)}, from ${examples.length} example${examples.length === 1 ? '' : 's'}.`;
    $('btnCheckRedo').style.display = 'none';
    $('btnCheckContinue').style.display = '';
    await new Promise((resolve) => { $('btnCheckContinue').onclick = resolve; });

    // 4. room check — listen 5s
    showScreen('screen-room');
    const roomDetector = createDetector({ centroid: cal.centroid, matchThreshold: cal.matchThreshold, noiseFloor, sensitivity: 0.5, refractoryMs: 120 });
    let roomMatches = 0;
    const roomStart = performance.now();
    await new Promise((resolve) => {
      function tick() {
        const elapsed = performance.now() - roomStart;
        $('roomCountdown').textContent = Math.max(0, Math.ceil((5000 - elapsed) / 1000));
        const spec = readSpectrum();
        if (roomDetector.feed(spec, performance.now())) roomMatches++;
        if (elapsed < 5000) requestAnimationFrame(tick);
        else resolve();
      }
      requestAnimationFrame(tick);
    });
    showScreen('screen-room-report');
    $('roomReport').textContent = roomMatches === 0
      ? 'Room is clear — nothing in the background sounded like your tap.'
      : `Heard ${roomMatches} sound${roomMatches === 1 ? '' : 's'} in your room that looked like your tap. This will over-count. Consider a quieter spot or recalibrating.`;
    await new Promise((resolve) => { $('btnRoomContinue').onclick = resolve; });

    state.calibration = cal;
    state.noiseFloor = noiseFloor;
    persist();
    runDetectionLoop();
  }

  function runDetectionLoop() {
    showScreen('screen-main');
    const cal = state.calibration;
    const soundSettings = state.settings.sound;
    const detector = createDetector({
      centroid: cal.centroid,
      matchThreshold: cal.matchThreshold,
      noiseFloor: state.noiseFloor,
      sensitivity: soundSettings.sensitivity,
      refractoryMs: soundSettings.cooldownMs,
    });
    $('sensitivitySlider').value = soundSettings.sensitivity;
    $('cooldownSlider').value = soundSettings.cooldownMs;
    $('sensitivitySlider').oninput = (e) => {
      soundSettings.sensitivity = parseFloat(e.target.value);
      detector.setSensitivity(soundSettings.sensitivity);
      persist();
    };
    $('cooldownSlider').oninput = (e) => {
      soundSettings.cooldownMs = parseInt(e.target.value, 10);
      detector.setRefractory(soundSettings.cooldownMs);
      persist();
    };

    let running = true;
    function loop() {
      if (!running) return;
      const spec = readSpectrum();
      if (detector.feed(spec, performance.now())) bump(1);
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
    stopSoundLoop = () => { running = false; };
  }

  // --- wake lock -------------------------------------------------------------

  let wakeLock = null;
  async function requestWakeLock() {
    try {
      if (!('wakeLock' in navigator)) return;
      wakeLock = await navigator.wakeLock.request('screen');
    } catch {
      // best-effort only; no wake lock is a degraded experience, not an error state
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') requestWakeLock();
  });
  requestWakeLock();

  // --- boot --------------------------------------------------------------

  render();
  if (state.mode === 'sound') startSoundMode();
  else if (state.mode === 'motion') showMotionStub();
  else showScreen('screen-main');
}
