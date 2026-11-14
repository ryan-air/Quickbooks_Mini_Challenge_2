# Palm Reader: a stroke-dynamics CAPTCHA in a fortune-teller booth

Draw the hand Madame Eyeball asks for. A lenient shape check confirms it is roughly a hand, and a stroke-dynamics analysis scores *how* you drew it (speed, rhythm, pauses, wobble, timing noise) to estimate whether a person or a script produced it. The verdict arrives as a palm reading.

**This is a prototype and a demonstration, not a lock.** Scoring runs in your browser, so anyone who edits the page can skip it, and an attacker who records real human strokes and replays them with variation can get past it. Details in [Honest security notes](#honest-security-notes).

## Run it

No build step. Serve the folder (or open `index.html` directly; fonts need a network, everything else is local):

```bash
python3 -m http.server 8765
```

Then open http://127.0.0.1:8765/. Tests need Node 18+ and no packages:

```bash
node test/run.js --verbose   # shape + dynamics on simulated humans and the three bots
node test/run.js --dist      # score distributions, handy when tuning
node test/smoke.js           # drives app.js against a stub DOM (catches runtime errors, not layout)
```

## Files

| File | Job |
|---|---|
| `index.html`, `style.css` | Booth, riso look, mascot SVG (4 states), Lab drawer, fallback modal |
| `app.js` | Capture (Pointer Events, `getCoalescedEvents`), ink rendering, flow, sound, ticket, Lab, bot demos, fallback games |
| `shape.js` | Lenient "is this a hand" check |
| `scoring.js` | Features, weights, thresholds (all in `K` / `WEIGHTS` at the top) |
| `synth.js` | Synthetic hands and the three "Be the bot" drawers |
| `test/run.js`, `test/smoke.js` | Node tests |

Stroke data model: `strokes = [{ pointerType, trusted, points: [{x, y, t, pressure, tiltX, tiltY, width, height}] }]`. Coordinates are in fixed **pad units** (600 x 450) regardless of screen size, so thresholds do not depend on the device. `t` is `event.timeStamp` in ms.

## How it works

### Shape check (`shape.js`)
Built to reject empty submissions, single lines and scribbles, and to be generous about bad hands.
1. **Effort:** at least 40 samples, ink length, bounding box at least 8% of the pad.
2. **Not a line:** PCA spread of all points.
3. **Not a scribble:** ink length vs. bounding-box perimeter, overdraw (cells re-traversed), ink density, sharp turns per length.
4. **Protrusions:** the ink is rasterised, open outlines are closed with "chords" between free stroke ends, the silhouette is filled by flood fill (thin ink first, thickened only if the outline leaks), and peaks in the radius-vs-angle profile around the centroid are counted. The peak facing away from the others is dropped as the wrist. This replaces classic convexity defects with something simpler that behaves the same way; the convex hull is still computed and drawn in the Lab.
5. **Prompt match:** estimated fingers must be within `max(tolerance, 1)` of the prompt's expectation. Prompts with `expectedRaisedFingers: null` skip counting. Five-finger prompts use tolerance 3 because crowded fingers merge and the count runs low.

Finger counting is crude. It is a plausibility filter, not recognition.

### Dynamics (`scoring.js`)
Nine features, each a transparent hand-written function returning a 0-1 human-likeness, a label, and a plain-English reason (shown in the Lab):

| Feature | Weight | Idea |
|---|---|---|
| Timestamp rhythm | 15 | Constant sample gaps are synthetic. Frame-locked integer-ms timestamps and 250 Hz+ devices are treated as uninformative so real browsers are not punished |
| Speed profile | 15 | Human strokes ease in and out and vary in speed; flat speed is a tell |
| Micro-tremor | 15 | Real paths wobble at several scales. The ratio of second differences at lag 1 vs. lag 4 separates "too clean" (smooth) and "single-scale white noise" (naive jitter) from hands |
| Speed vs. curvature | 25 | Two-thirds power law: slope of log speed vs. log radius near 1/3. Reported with R² |
| Pauses | 10 | Hesitations and lift-offs of uneven length look human; long drawings with none, or metronomic pauses, look scripted |
| Stroke structure | 5 | Plausible number of lifts, small corrections |
| Pressure & contact | 5 | Pen/touch only. **Skipped for mouse and the weights renormalised**, so mouse users are not penalised |
| Pointer realism | 10 | `isTrusted === false` caps the total at 30 (catches in-page dispatch only, not OS-level automation) |
| Pacing | 5 | A whole hand in under 1.5 s is implausible |

Bands: **65+ pass**, **45-65 one more try** (the second sample is averaged with the first), **below 45 flagged**. A final pass needs both the shape check and the dynamics score.

## Tuning

Everything is a named constant at the top of `scoring.js` (`K`, `WEIGHTS`) and `shape.js` (`S`). Workflow: read scores off the Lab panel for real people on real devices (see `test/humans/README.md`; no participant data is stored), then adjust. If you do rescore an export with `node test/run.js`, drop it into `test/humans/` temporarily and delete it afterwards. False rejections of humans are the worst failure, so lean generous. Bot feedback: `node test/run.js --dist` prints per-feature score percentiles for humans vs. bot (c).

## Adding prompts

Add an object to `PROMPTS` in `app.js`:

```js
{ text: 'Draw a hand holding a teacup.', expectedRaisedFingers: null, tolerance: 1, pose: 'wave' }
```

`expectedRaisedFingers: null` skips finger counting. `pose` is only used by the "Be the bot" demos (`three`, `peace`, `wave`, `thumbsUp`, `rockOn`, `fist`, `spread`, `point`). Prompts are chosen at random with no immediate repeat. Fortunes and fail lines are the `PASS_LINES` / `FAIL_LINES` / `SHAPE_LINES` / `RETRY_LINES` arrays.

## Accessibility

Everything is keyboard reachable with themed focus rings. Verdicts and prompts are real DOM text in live regions. `prefers-reduced-motion` disables the wobble filter, mascot animation, shake, crumple and confetti. Sound is off by default. One theme ships rather than two mediocre ones.

**"I can't draw right now"** opens two short alternatives: *Tap the beat* (echo a random four-tap rhythm, scored on relative timing error, rejecting scripted and frighteningly exact taps) and *Odd one out*. These are **weaker than the drawing path** (screen-reader labels necessarily reveal the answer to the odd-one-out, and a script that reads them solves it) and the UI says so. They exist so nobody is locked out.

## Test results

From `node test/run.js` (160 simulated humans, 160 hands per bot, `isTrusted=true` for bots so only the dynamics are tested):

| Drawer | Shape ok | Mean score | Dynamics pass | One more try | Flagged | Top bot-like features |
|---|---|---|---|---|---|---|
| (a) polyline, constant speed | 100% | 37.7 | 0% | 0% | **100%** | timestamps, speed, tremor |
| (b) spline, constant speed | 100% | 38.4 | 0% | 6% | **94%** | timestamps, speed, tremor (68%) |
| (c) spline, random speed + Gaussian jitter | 100% | 69.7 | **84%** | 16% | 0% | curvature (99%), tremor (9%) |
| simulated human | 100% | 81.8 | **98%** | 2% | 0% | curvature (20%) |
| (c) with untrusted events | | capped at 30 | 0% | 0% | 100% | pointer realism |

Negative shape tests: scribbles, zigzags, lines, single dots and coils are rejected 20/20 each; a perfect circle is rejected for a 3-finger prompt.

In the browser, `analysis time` measured 9-13 ms per submission (shown in the Lab).

### Read this before trusting those numbers
- **The "humans" are simulated.** They come from a motion model (bell-shaped sub-movements, correlated tremor, timing jitter, pauses, lift-offs, and a speed-curvature coupling *that I put in*). They show the features *can* separate scripts from plausible motion, not that real people behave this way. Nobody drew these. The 95% human-pass target is **not yet verified on real people**.
- Bot **(c) mostly gets through** (84% pass, 16% asked for one more try, 0% flagged). That is the expected outcome, not a bug: its timing and speed look human, only its white-noise wobble and the speed-curvature relation give it away, and a bot with correlated noise and power-law speed would pass too. A recorded human replay would pass.
- I weighted speed-curvature heavily (25) to give (c) a fighting chance; that costs ~2% of simulated humans a "one more try". Real-device noise may move this either way.
- Not done yet: testing on real Safari, Firefox, iOS, Android, Apple Pencil or a stylus; a 60 fps measurement on a phone; Playwright/Puppeteer runs with synthetic events (the `isTrusted` path is exercised in the Lab via the "pretend events are trusted" checkbox and in Node, not via a real automation run); collecting at least five real people's strokes.

## Honest security notes

- **Client-side scoring can be bypassed** by anyone who edits the page. A real deployment sends raw stroke data to a server, scores it there, rate-limits attempts, and issues a signed token.
- **Replay attacks:** store hashes of recently accepted stroke sets and reject near-duplicates; vary prompts per session so a fixed template fails.
- **Combine with other signals** (device sensors, behavioural history, proof-of-work) rather than relying on drawing alone.
- **Generative models** trained on human sketch data can produce plausible stroke sequences. Treat this as one layer, not a wall.
- `isTrusted` only catches naive in-page event dispatch, not OS-level automation.

## Privacy

Stroke data stays in the browser tab and is never sent anywhere. The Lab's export is a local file download. The page requests typefaces from Google Fonts; that request carries no drawing data (self-host the fonts if even that is too much).

## Next steps

1. Server-side scoring with signed tokens, rate limits and replay hashing.
2. Collect real strokes from a spread of people and devices; retune thresholds against them.
3. A stronger shape model (a small on-device sketch classifier) behind the same `check()` interface.
4. Browser-automation tests (Playwright) for the full flow and the untrusted-event path.
