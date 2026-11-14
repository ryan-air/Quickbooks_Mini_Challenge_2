# Palm Reader: a stroke-dynamics CAPTCHA in a fortune-teller booth

**Prove you're human by drawing a hand.** Draw the hand Madame Eyeball asks for. A lenient shape check confirms it is roughly a hand, and a stroke-dynamics analysis scores *how* you drew it (speed, rhythm, pauses, wobble, timing noise) to estimate whether a person or a script produced it. The verdict arrives as a palm reading.

## Run it

No build step. Serve the folder (or open `index.html` directly; fonts need a network, everything else is local):

```bash
python3 -m http.server 8765
```

Then open http://127.0.0.1:8765/. Tests need Node 18+ and no packages:

```bash
node test/run.js --verbose   # shape + dynamics on simulated humans and the two bots
node test/run.js --dist      # score distributions, handy when tuning
node test/smoke.js           # drives app.js against a stub DOM (catches runtime errors, not layout)
```

Watch a bot fail (Node 22+, Chrome or Edge, no packages):

```bash
node scripts/bot-b-attack.js             # opens Chrome and waits; draw your own hand, press Enter, then bot B attacks
node scripts/bot-b-attack.js --auto      # bot starts immediately, no waiting
node scripts/bot-b-attack.js --headless  # same attack, no window, report only
```

The script drives the real mouse through the Chrome DevTools Protocol, so the events are trusted and only the drawing dynamics can catch it. Bot B reads the ghost hand off the pad, smooths it into a spline, and traces it at constant speed with even 16 ms timing. If the booth asks for one more try, it draws again. It prints the verdict with every signal tagged bot-like or human-like, then opens the analysis panel.

## Files

| File | Job |
|---|---|
| `index.html`, `style.css` | Booth, riso look, "Prove you're human" verification bar, mascot SVG (4 states), Lab drawer |
| `app.js` | Capture (Pointer Events, `getCoalescedEvents`), ink rendering, per-round ghost hand, verification status, flow, sound, ticket, Lab, bot demos |
| `shape.js` | Lenient "is this a hand" check |
| `scoring.js` | Features, weights, thresholds (all in `K` / `WEIGHTS` at the top) |
| `synth.js` | Hand outlines for 14 poses (also used for the ghost guide), mirroring, and the two "Be the bot" drawers |
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

Everything is a named constant at the top of `scoring.js` (`K`, `WEIGHTS`) and `shape.js` (`S`). Workflow: read scores off the Lab panel for real people on real devices (see `test/humans/README.md`; no participant data is stored), then adjust. If you do rescore an export with `node test/run.js`, drop it into `test/humans/` temporarily and delete it afterwards. False rejections of humans are the worst failure, so lean generous. Bot feedback: `node test/run.js --dist` prints per-feature score percentiles for humans vs. bot (b).

## Adding prompts

Add an object to `PROMPTS` in `app.js`:

```js
{ text: 'Draw a hand holding a teacup.', expectedRaisedFingers: null, tolerance: 1, pose: 'wave' }
```

`expectedRaisedFingers: null` skips finger counting. `pose` picks the ghost-hand guide drawn on the pad and the outline the "Be the bot" demos trace (`three`, `peace`, `wave`, `thumbsUp`, `rockOn`, `fist`, `spread`, `point`, `four`, `pinky`, `shaka`, `gun`, `threeThumb`, `loveYou`). Each round the ghost is regenerated from the pose with random left/right mirroring, tilt, scale and finger-length jitter, so no two rounds show the same template. Prompts are chosen at random with no immediate repeat. Fortunes and fail lines are the `PASS_LINES` / `FAIL_LINES` / `SHAPE_LINES` / `RETRY_LINES` arrays.

## Test results

From `node test/run.js` (160 simulated humans across 14 poses, half of them left hands, 160 hands per bot, `isTrusted=true` for bots so only the dynamics are tested):

| Drawer | Shape ok | Mean score | Dynamics pass | One more try | Flagged | Top bot-like features |
|---|---|---|---|---|---|---|
| (a) polyline, constant speed | 100% | 37.6 | 0% | 0% | **100%** | timestamps, speed, tremor |
| (b) spline, constant speed | 100% | 38.9 | 0% | 6% | **94%** | timestamps, speed, tremor (66%) |
| simulated human | 100% | 80.7 | **98%** | 3% | 0% | curvature (28%), pacing (28%) |
| (b) with untrusted events | | capped at 30 | 0% | 0% | 100% | pointer realism |

Negative shape tests: scribbles, zigzags, lines, single dots and coils are rejected 20/20 each; a perfect circle is rejected for a 3-finger prompt.

In the browser, `analysis time` measured 9-13 ms per submission (shown in the Lab).

## Privacy

Stroke data stays in the browser tab and is never sent anywhere. The Lab's export is a local file download. The page requests typefaces from Google Fonts; that request carries no drawing data (self-host the fonts if even that is too much).

## Next steps

1. Server-side scoring with signed tokens, rate limits and replay hashing.
2. Collect real strokes from a spread of people and devices; retune thresholds against them.
3. A stronger shape model (a small on-device sketch classifier) behind the same `check()` interface.
4. Browser-automation tests (Playwright) for the full flow and the untrusted-event path.
