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
microphone either. Running it on a phone at a real bench needs a device-trusted certificate or
proper hosting. Not decided yet.

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

1. **Silence, 2 seconds** — it measures the room.
2. **Tap 5 times** — same spot, same force. A dot fills per tap.
3. **Consistency check** — if your taps were scattered it says so and offers a redo, rather than
   letting you find out later from a wrong count.
4. **Room check, 5 seconds** — it listens to your room and reports how many ambient sounds looked
   like your tap. If that number isn't zero, it will over-count here. Believe it.
5. **Count.** Big number. It flashes each time it hears you. Set a target if you have one.

The sensitivity slider stays available. Five taps can't see a whole room — expect to tune it.

Undo, manual ±, and reset are there because an uncorrectable count is a count nobody trusts. The
tally survives a page reload.

## How well does it work

Measured against synthesized audio — 30 sharp taps a second apart over three noise beds, with
dull impact sounds mixed in as distractors:

| room | missed | false positives |
|---|---|---|
| quiet | 0 of 25 | 0 |
| moderate noise, 10 distractors | 0 of 27 | 2 |
| loud, 15 distractors | 2 of 27 | 6 |

**In a loud room it over-counts, and that is a limit of the approach rather than a tuning
problem.** The distance between a real tap and an impact noise genuinely overlaps once the noise
bed is high. That's what the room check is for — it tells you before you trust it.

These numbers come from synthetic audio, not a real shop floor. Nobody has run this against a
real microphone in a real warehouse. Treat the table as a floor on what to expect, not a promise.

## Tests

```
npm test
```

17 tests, Node's built-in runner, no framework and no dependencies. `detector.js` and `tally.js`
are pure — no DOM, no Web Audio, no clock — which is what lets the whole thing be tested without
a microphone.

## Files

| file | what it is |
|---|---|
| `index.html` | the app: markup, styles, mic wiring, UI |
| `detector.js` | pure detection — spectral flux, adaptive threshold, refractory gate, fingerprint match |
| `tally.js` | pure count arithmetic (bump/undo, clamped at zero) |
| `detector.test.js` | all tests for both |

Zero dependencies, no build step, no network. That's deliberate.
