# Checking against real people (without keeping their data)

Goal: verify the 95% human-pass target on real people and devices, then retune. **No participant data is stored.** Nothing here is saved to the repo, a server or a shared drive.

## Principles
- The app never saves or sends strokes. The Lab's **Export stroke JSON** button only runs when someone clicks it, and only downloads to their own machine.
- Do not commit, upload or archive exported files. Keep any export in a temporary location and delete it after scoring.
- Keep only aggregate results (pass counts per device, which features misfired). No strokes, names or recordings.

## Who and what
- 8 to 12 people who did not build this, with a mix of ages and drawing confidence, each with their say on taking part.
- Devices: desktop Chrome with a mouse, Safari on a Mac trackpad, Firefox, an iPhone, an Android phone, and a stylus if available.
- Each person does 5 drawings across different prompts, including one sloppy and one fast.

## How (no storage)
1. Serve the folder locally (`python3 -m http.server 8765`) and let each person draw.
2. Read the result straight off the Lab panel: dynamics score, band, shape result, and which features were bot-like. Write down only those numbers, not the strokes.
3. If you need to rescore with `node test/run.js`, drop an export in this folder temporarily, run it, then delete the file. The folder is git-ignored by convention; check before committing.

## Decide
- Target: 95% or more reach a final pass (a "one more try" that then passes counts, but note it).
- If a device class fails, loosen that feature's constants in `scoring.js` before touching weights. Likely culprits: timestamp rhythm on frame-locked browsers, tremor on touch, speed-curvature on trackpads.
- Re-run the bot table afterwards and report any change in how often bots (a) and (b) are flagged.
