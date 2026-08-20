# Tally

Counts by listening. You calibrate it on a sound — a tap on the bench next to the device — and
it counts every time it hears that sound again. Built for bench and warehouse work where your
hands are busy and pressing a button per unit is the problem.

## Run it

```
python3 -m http.server 8000
```

Then open **http://localhost:8000**.

Opening `index.html` by double-clicking will **not** work. Microphones need a secure context, so
the page has to come from `localhost` or `https://` — a `file://` page gets no microphone.

For the same reason, loading it on a phone from another machine over plain `http://` gets no
microphone either. The hosted copy solves that; the section below is for testing changes on a
phone before they're published.

## Running it on your phone

A phone can't use the microphone over plain `http://` — browsers only hand out the mic on
`https://` or `localhost`. So serve it over https:

```
python3 serve-https.py
```

It prints two URLs. Open the `https://<your-mac-ip>:8443` one on the phone, on the same wifi.

Safari will warn about the certificate, because it's self-signed. Tap **Show Details** →
**visit this website**. If the mic still won't work after that, install the certificate properly:
AirDrop `~/.tally-devcert/cert.pem` to the phone, then **Settings → General → VPN & Device
Management** to install the profile, then **Settings → General → About → Certificate Trust
Settings** and switch it on. That second path is the reliable one; the first often suffices.

The cert and its private key live in `~/.tally-devcert`, outside this folder on purpose — a
plain directory server hands out everything it can see, and the key isn't something to put on
the wifi.

None of this publishes anything. It's your machine on your own network.

## Using it

1. **Silence, 1.5 seconds** — it measures the room.
2. **Tap 3 to 5 times** — same spot, same force. A dot fills per tap. Three is enough; it keeps
   listening up to five. Got a wrong sound in — a cough, a dropped tool? **Start over** wipes
   the taps and lets you redo them without leaving the screen.
3. **Consistency check** — if your taps were scattered it says so and offers a redo, rather than
   letting you find out later from a wrong count.
4. **Room check, 5 seconds** — **don't tap during this one.** It listens to your room, reports how
   many ambient sounds looked like your tap, and keeps the ones that didn't as things to ignore.
   That second part is why staying quiet here matters: it's how the app learns your room's
   background noises. If the "looked like your tap" number isn't zero, it will over-count here.
   Believe it.
5. **Count.** Big number. It flashes each time it hears you.

The sensitivity slider stays available. Five taps can't see a whole room — expect to tune it.

**What the sliders actually do.** *Sensitivity* only controls the "was that a sound at all?"
bar — how far above the room's background a sound must jump before the app even considers it.
It never touches the matching: every candidate still has to sound like your calibrated tap.
Missing quiet taps → raise it. Over-counting → lower it. *Cooldown* is the minimum gap between
two counts, so one tap ringing off the bench can't score twice — and it caps your speed (at
250 ms you can't count faster than 4 per second). Working faster than it counts → lower it.
Each slider shows its current value and what it means.

**Music.** On iPhone, opening the microphone normally pauses whatever you're listening to,
because iOS treats it like a phone call — and with AirPods connected it can also silently
switch recording to the AirPods' own microphone, which is on your head instead of at the
bench. The app now asks iOS for the one session type that permits recording, and tries to
re-acquire the phone's built-in mic when it's been handed a headset one. Honestly: iOS has
historically ignored both requests from web pages, so whether your music survives — and which
mic is actually used — can only be confirmed on the phone itself. The debug capture records
the mic's name so you can check rather than guess. If music still pauses, that's the
platform's ceiling, not a setting you missed.

Undo, manual ±, and reset are there because an uncorrectable count is a count nobody trusts. The
tally survives a page reload.

## How it decides

It isn't listening for "loud". It learns what your sound *is*, and part of what a sound is, is how
it dies away — a knuckle on a bench is gone in a few thousandths of a second, a dropped box rings
on. In a single instant those two look almost identical, which is why the app looks at three
consecutive slices of the sound instead of one. It also keeps whatever it heard during the room
check as examples of what *not* to count.

The cost: a count lands about a tenth of a second after the sound, because it has to hear the
decay before it can decide.

## How well does it work

Measured against synthesized audio — 30 sharp taps a second apart over three noise beds with dull
impact sounds mixed in as distractors, repeated over five independent noise draws per room, 320
taps in total:

| room | missed | false positives |
|---|---|---|
| quiet | 0 | 0 |
| moderate noise, 10 distractors | 1 | 0 |
| loud, 15 distractors | 8 | 6 |

**In a loud room it still over-counts.** It's better than it was — in a moderately noisy room real
taps and impact noise now separate cleanly — but at the top of the noise range they still blur
together in some rooms. That's what the room check is for: it tells you before you trust it.

These numbers come from synthetic audio, not a real shop floor. **Nobody has run this against a
real microphone in a real warehouse.** And the test is kinder to the app than a real bench will
be: those synthetic taps and thuds differ mainly in how fast they fade, which is exactly what the
app looks at. On a harder test where the background noise is *sharp* as well as long — so only
the fade tells them apart — it over-counts badly (40 false positives over the same 110 taps, and
the older version of the app was better on that axis). Treat the table as a rough guide, not a
promise, and treat the room check's warning as the real signal.

If you want to help fix that: turn on **Debug capture** in the sound controls, count for a while,
press **Export**, and keep the file. It records what the app saw for every sound it counted *and*
every sound it rejected, which is what turns "it miscounted" into something fixable.

## Tests

```
npm test
```

Node's built-in runner, no framework and no dependencies — `npm test` prints the count. `detector.js` and `tally.js`
are pure — no DOM, no Web Audio, no clock — which is what lets the whole thing be tested without
a microphone.

`tools/` holds dev-only instruments (also zero-dependency): a synthesizer that builds test rooms,
a harness that scores the real detector against known ground truth, and a driver that boots the
real page in Chrome and feeds it a test room. `node tools/harness.mjs` prints the table above.

## Files

| file | what it is |
|---|---|
| `index.html` | the app: markup, styles, UI |
| `app.js` | shell — modes, mic wiring, calibration flow, persistence, debug capture |
| `detector.js` | pure detection — spectral flux, adaptive threshold, refractory gate, fingerprint match |
| `tally.js` | pure count arithmetic (bump/undo, clamped at zero) |
| `detector.test.js`, `app.test.js` | all tests |
| `tools/` | dev-only measurement instruments, not part of the app |

Zero dependencies, no build step, no network. That's deliberate and it's a standing constraint —
see `CLAUDE.md` for the design constants that are load-bearing and why.
