/*
 * scoring.js — stroke-dynamics analysis for the Palm Reader CAPTCHA.
 *
 * Input:  strokes = [{ pointerType, trusted, points: [{x,y,t,pressure,tiltX,tiltY,width,height}] }]
 *         x/y are in "pad units" (the pad is always 600 x 450 logical units, whatever the screen size),
 *         t is event.timeStamp in milliseconds.
 * Output: { score 0..100, band, features:[{id,name,value,score,status,reason,weight,applicable}], debug }
 *
 * Every feature is a small hand-written function that maps a measurement to a 0..1
 * "human-likeness" number. No black boxes: read the code, change the numbers.
 *
 * ALL TUNABLE THRESHOLDS LIVE IN `K` BELOW.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PalmScoring = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ───────────────────────── tunable constants ─────────────────────────
  const K = {
    PASS_SCORE: 65,            // >= this passes (together with the shape check)
    RETRY_SCORE: 45,           // >= this and < PASS_SCORE: "one more try"; below: flagged
    HUMAN_AT: 0.65,            // feature score >= this is tagged humanLike
    BOT_AT: 0.35,              // feature score <= this is tagged botLike
    NEUTRAL_SCORE: 0.6,        // what a feature returns when there is not enough data
    UNTRUSTED_CAP: 30,         // total score ceiling if any event had isTrusted === false

    SPEED_WINDOW_MS: 24,       // speeds are measured over windows at least this long (tames quantisation)
    SPEED_CV_LO: 0.08, SPEED_CV_HI: 0.35,        // speed coefficient of variation: <=LO bot-like, >=HI human-like
    SPEED_ENDS_LO: 0.05, SPEED_ENDS_HI: 0.40,    // how much slower stroke ends are than the peak (0..1)

    TS_CV_LO: 0.005, TS_CV_HI: 0.15,             // timestamp delta coefficient of variation
    TS_MODAL_BOT: 0.90,        // share of identical deltas that screams "synthetic"
    TS_MIN_MEAN_DT: 4,         // below this mean delta (>=250 Hz devices) regularity says nothing
    TS_FRAME_LOCK: [14, 18.5], // integer-ms deltas averaging in here are just vsync-locked browsers

    TREMOR_AMP_LO: 0.08, TREMOR_AMP_HI: 0.35,    // lower-quartile |second difference| in pad units
    TREMOR_RHO_OK: 7, TREMOR_RHO_BAD: 13,        // single-scale (white) noise ratio; see tremor()
    TREMOR_Q: 0.25,            // lower quartile of |d2| is used so curvy stretches do not hide white noise
    TREMOR_MIN_STEP: 0.8,

    CURV_MIN_SPACING: 12,       // subsample the path to at least this spacing before taking curvature
    CURV_MIN_POINTS: 15, CURV_MIN_LOGR_SD: 0.35,
    CURV_R_MIN: 3, CURV_R_MAX: 500,
    CURV_SLOPE_IDEAL: 1 / 3,   // two-thirds power law: v ∝ R^(1/3)
    CURV_R2_FULL: 0.25,        // R² at which the fit counts as fully human-like

    PAUSE_MS: 150,             // a gap this long between two events inside one stroke is a pause
    PAUSE_NONE_LONG_MS: 6000,  // a drawing this long with zero pauses/lifts looks scripted
    PAUSE_UNIFORM_CV: 0.05,

    MIN_DRAW_MS: 1500,         // faster than this is implausible for a hand
    OK_DRAW_MS: 3500,

    PRESSURE_PEN_SD_LO: 0.005, PRESSURE_PEN_SD_HI: 0.05,
    MIN_SAMPLE_RATE_HZ: 8,
  };

  const WEIGHTS = {
    timestamps: 15, speed: 15, tremor: 15, curvature: 25, pauses: 10,
    structure: 5, pressure: 5, pointer: 10, pacing: 5,
  };

  // ───────────────────────── small helpers ─────────────────────────
  const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
  const ramp = (x, lo, hi) => clamp((x - lo) / (hi - lo));
  const sum = (a) => a.reduce((s, v) => s + v, 0);
  const mean = (a) => (a.length ? sum(a) / a.length : 0);
  const std = (a) => {
    if (a.length < 2) return 0;
    const m = mean(a);
    return Math.sqrt(sum(a.map((v) => (v - m) * (v - m))) / a.length);
  };
  const quantile = (a, q) => {
    if (!a.length) return 0;
    const s = a.slice().sort((x, y) => x - y);
    const i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
    return s[lo] + (s[hi] - s[lo]) * (i - lo);
  };
  const median = (a) => quantile(a, 0.5);
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const f2 = (x) => (Number.isFinite(x) ? (Math.round(x * 100) / 100).toString() : '–');

  function prep(strokes) {
    return (strokes || [])
      .filter((s) => s && s.points && s.points.length > 1)
      .map((s) => {
        const pts = [];
        let last = -Infinity;
        for (const p of s.points) if (p.t > last) { pts.push(p); last = p.t; }
        let len = 0;
        for (let i = 1; i < pts.length; i++) len += dist(pts[i - 1], pts[i]);
        return { pointerType: s.pointerType || '', trusted: s.trusted !== false, pts, len, raw: s.points };
      })
      .filter((s) => s.pts.length > 2);
  }

  // speed measured over windows >= minDt ms: [{x,y,t,v}] with v in pad units per second
  function windowed(pts, minDt) {
    const out = [];
    let a = pts[0], path = 0, prev = pts[0];
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i];
      path += dist(prev, p); prev = p;
      if (p.t - a.t >= minDt) {
        out.push({ x: p.x, y: p.y, t: (p.t + a.t) / 2, v: (path / (p.t - a.t)) * 1000 });
        a = p; path = 0;
      }
    }
    return out;
  }
  const smooth3 = (v) => v.map((x, i) => (v[Math.max(0, i - 1)] + x + v[Math.min(v.length - 1, i + 1)]) / 3);

  function feature(id, name, score, value, reason, extra) {
    score = clamp(score);
    return Object.assign({
      id, name, score, value,
      status: score >= K.HUMAN_AT ? 'humanLike' : score <= K.BOT_AT ? 'botLike' : 'neutral',
      reason, weight: WEIGHTS[id], applicable: true,
    }, extra || {});
  }
  const insufficient = (id, name, why) => feature(id, name, K.NEUTRAL_SCORE, 'n/a', why);

  // ───────────────────────── 1. timestamp irregularity ─────────────────────────
  function fTimestamps(ss) {
    const d = [];
    let allInt = true;
    for (const s of ss) for (let i = 1; i < s.pts.length; i++) {
      const dt = s.pts[i].t - s.pts[i - 1].t;
      if (dt > 0 && dt <= 100) d.push(dt);
      if (Math.abs(s.pts[i].t - Math.round(s.pts[i].t)) > 1e-6) allInt = false;
    }
    if (d.length < 12) return insufficient('timestamps', 'Timestamp rhythm', 'Too few samples to judge.');
    const m = mean(d), cv = std(d) / m;
    const counts = new Map();
    for (const x of d) { const k = Math.round(x * 100); counts.set(k, (counts.get(k) || 0) + 1); }
    const modal = Math.max(...counts.values()) / d.length;
    const value = `cv ${f2(cv)}, mean ${f2(m)} ms, ${Math.round(modal * 100)}% identical`;
    if (m >= K.TS_MIN_MEAN_DT && modal >= K.TS_MODAL_BOT)
      return feature('timestamps', 'Timestamp rhythm', 0.05, value,
        `${Math.round(modal * 100)}% of the sample gaps are exactly ${f2(mode(counts) / 100)} ms. Real hands are never that tidy.`);
    if (allInt && m >= K.TS_FRAME_LOCK[0] && m <= K.TS_FRAME_LOCK[1])
      return feature('timestamps', 'Timestamp rhythm', K.NEUTRAL_SCORE, value,
        'Whole-millisecond, frame-locked timestamps (common in Safari/Firefox). Not informative either way.');
    if (m < K.TS_MIN_MEAN_DT)
      return feature('timestamps', 'Timestamp rhythm', K.NEUTRAL_SCORE, value, 'High-rate device; gap regularity is not informative.');
    const s = ramp(cv, K.TS_CV_LO, K.TS_CV_HI);
    return feature('timestamps', 'Timestamp rhythm', s, value,
      s >= K.HUMAN_AT ? 'Sample gaps wander the way real input hardware does.'
        : s <= K.BOT_AT ? 'Sample gaps are suspiciously even.' : 'Sample gaps are fairly regular; inconclusive.');
  }
  function mode(counts) { let b = 0, bk = 0; counts.forEach((v, k) => { if (v > b) { b = v; bk = k; } }); return bk; }

  // ───────────────────────── 2. speed profile ─────────────────────────
  function fSpeed(ss, debug) {
    let wsum = 0, ssum = 0, cvAcc = 0, endAcc = 0;
    for (const s of ss) {
      const ws = windowed(s.pts, K.SPEED_WINDOW_MS);
      debug.speeds.push(ws.map((p) => ({ t: p.t, v: p.v })));
      if (ws.length < 8) continue;
      const v = smooth3(ws.map((p) => p.v));
      const p90 = quantile(v, 0.9), m = mean(v);
      if (!(m > 0)) continue;
      const cv = std(v) / m;
      const k = Math.max(2, Math.round(v.length * 0.1));
      const endRatio = (mean(v.slice(0, k)) + mean(v.slice(-k))) / 2 / p90;
      const sc = 0.6 * ramp(cv, K.SPEED_CV_LO, K.SPEED_CV_HI) + 0.4 * ramp(1 - endRatio, K.SPEED_ENDS_LO, K.SPEED_ENDS_HI);
      ssum += sc * s.len; wsum += s.len; cvAcc += cv * s.len; endAcc += endRatio * s.len;
    }
    if (!wsum) return insufficient('speed', 'Speed profile', 'Strokes too short to read a speed profile.');
    const sc = ssum / wsum, cv = cvAcc / wsum, er = endAcc / wsum;
    return feature('speed', 'Speed profile', sc, `speed cv ${f2(cv)}, ends at ${Math.round(er * 100)}% of peak`,
      sc >= K.HUMAN_AT ? 'Strokes speed up and slow down, easing in and out like an arm does.'
        : sc <= K.BOT_AT ? 'Speed is flat or ignores the start/end ease-in. Machines like constant speed.'
          : 'Some speed variation, but not very bell-shaped.');
  }

  // ───────────────────────── 3. micro-tremor / jerk ─────────────────────────
  // d2(k) = p[i+k] - 2p[i] + p[i-k]. On a smooth curve |d2(k)| grows like k², on white
  // noise it is the same at every k. Ratio rho = 16*q25(d2(1)) / q25(d2(4)):
  //   ~1  → perfectly smooth path   ~16 → pure single-scale noise   humans land in between.
  function medD2(ss, k) {
    const mags = [];
    for (const s of ss) {
      const p = s.pts;
      for (let i = k; i < p.length - k; i++) {
        if (dist(p[i - k], p[i]) < K.TREMOR_MIN_STEP || dist(p[i], p[i + k]) < K.TREMOR_MIN_STEP) continue;
        mags.push(Math.hypot(p[i + k].x - 2 * p[i].x + p[i - k].x, p[i + k].y - 2 * p[i].y + p[i - k].y));
      }
    }
    return mags.length >= 15 ? quantile(mags, K.TREMOR_Q) : null;
  }
  function fTremor(ss) {
    const m1 = medD2(ss, 1), m4 = medD2(ss, 4);
    if (m1 === null || m4 === null) return insufficient('tremor', 'Micro-tremor', 'Not enough moving samples.');
    const rho = (16 * m1) / Math.max(m4, 1e-6);
    const ampS = ramp(m1, K.TREMOR_AMP_LO, K.TREMOR_AMP_HI);
    const scaleS = ampS < 0.2 ? 1 : 1 - ramp(rho, K.TREMOR_RHO_OK, K.TREMOR_RHO_BAD);
    const sc = ampS * scaleS;
    const value = `wobble ${f2(m1)} u, scale ratio ${f2(rho)}`;
    return feature('tremor', 'Micro-tremor', sc, value,
      ampS <= K.BOT_AT ? 'The path is eerily clean. No involuntary wobble at all.'
        : scaleS <= K.BOT_AT ? 'There is wobble, but it is the same size at every scale: white noise, not a hand.'
          : 'Small, multi-scale wobble in the path. Reassuringly shaky.');
  }

  // ───────────────────────── 4. speed–curvature (two-thirds power law) ─────────────────────────
  function fCurvature(ss, debug) {
    const X = [], Y = [];
    for (const s of ss) {
      const sub = [s.pts[0]];
      for (const p of s.pts) if (dist(p, sub[sub.length - 1]) >= K.CURV_MIN_SPACING) sub.push(p);
      for (let i = 1; i < sub.length - 1; i++) {
        const a = sub[i - 1], b = sub[i], c = sub[i + 1];
        const ab = dist(a, b), bc = dist(b, c), ac = dist(a, c);
        const cross = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
        const dt = c.t - a.t;
        if (dt <= 0 || ab * bc * ac === 0) continue;
        const kappa = (2 * cross) / (ab * bc * ac);
        const R = clamp(kappa > 1e-9 ? 1 / kappa : K.CURV_R_MAX, K.CURV_R_MIN, K.CURV_R_MAX);
        const v = ((ab + bc) / dt) * 1000;
        if (v <= 0) continue;
        X.push(Math.log(R)); Y.push(Math.log(v));
      }
    }
    debug.scatter = { pts: X.map((x, i) => ({ x, y: Y[i] })), fit: null };
    if (X.length < K.CURV_MIN_POINTS || std(X) < K.CURV_MIN_LOGR_SD)
      return insufficient('curvature', 'Speed vs. curvature', 'Not enough curvy path to test the two-thirds power law.');
    const mx = mean(X), my = mean(Y);
    let sxx = 0, sxy = 0, syy = 0;
    for (let i = 0; i < X.length; i++) { sxx += (X[i] - mx) ** 2; sxy += (X[i] - mx) * (Y[i] - my); syy += (Y[i] - my) ** 2; }
    const slope = sxy / sxx, icpt = my - slope * mx, r2 = syy > 0 ? (sxy * sxy) / (sxx * syy) : 0;
    debug.scatter.fit = { slope, intercept: icpt, r2 };
    const s1 = clamp(1 - Math.abs(slope - K.CURV_SLOPE_IDEAL) / K.CURV_SLOPE_IDEAL);
    const s2 = ramp(r2, 0, K.CURV_R2_FULL);
    const sc = 0.5 * s1 + 0.5 * s2;
    return feature('curvature', 'Speed vs. curvature', sc, `slope ${f2(slope)} (human ≈ 0.33), R² ${f2(r2)}`,
      sc >= K.HUMAN_AT ? 'Slows for tight curves and speeds up on straights, as arms do (two-thirds power law).'
        : sc <= K.BOT_AT ? 'Speed has nothing to do with how tight the curve is. A hand would have slowed down at the corners.'
          : 'Weak link between speed and curvature; inconclusive.');
  }

  // ───────────────────────── 5. pauses and hesitation ─────────────────────────
  function fPauses(ss, tspan) {
    const durs = [];
    let inStroke = 0, lifts = 0;
    for (const s of ss) for (let i = 1; i < s.pts.length; i++) {
      const dt = s.pts[i].t - s.pts[i - 1].t;
      if (dt >= K.PAUSE_MS) { inStroke++; durs.push(dt); }
    }
    for (let i = 1; i < ss.length; i++) {
      const g = ss[i].pts[0].t - ss[i - 1].pts[ss[i - 1].pts.length - 1].t;
      if (g > 0) { lifts++; durs.push(g); }
    }
    const n = inStroke + lifts;
    const value = `${inStroke} mid-stroke pauses, ${lifts} lift-offs over ${f2(tspan / 1000)} s`;
    let sc, why;
    if (n === 0) {
      if (tspan >= K.PAUSE_NONE_LONG_MS) { sc = 0.15; why = 'Several seconds of drawing without one hesitation or lift. Humans stop to think.'; }
      else if (tspan >= 3500) { sc = 0.5; why = 'No hesitations in a fairly long drawing; slightly unusual.'; }
      else { sc = 0.65; why = 'A quick drawing with no pauses; plausible.'; }
    } else if (n >= 3 && std(durs) / mean(durs) < K.PAUSE_UNIFORM_CV) {
      sc = 0.1; why = 'The pauses are all the same length. Humans are not metronomes.';
    } else { sc = n >= 2 ? 1 : 0.85; why = 'Natural hesitations and lift-offs of uneven length.'; }
    return feature('pauses', 'Pauses & hesitation', sc, value, why);
  }

  // ───────────────────────── 6. stroke structure ─────────────────────────
  function fStructure(ss) {
    const n = ss.length;
    let backtracks = 0;
    for (const s of ss) {
      const r = [s.pts[0]];
      for (const p of s.pts) if (dist(p, r[r.length - 1]) >= 5) r.push(p);
      for (let i = 1; i < r.length - 1; i++) {
        const ax = r[i].x - r[i - 1].x, ay = r[i].y - r[i - 1].y, bx = r[i + 1].x - r[i].x, by = r[i + 1].y - r[i].y;
        const cos = (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by) || 1);
        if (cos < -0.77 && Math.hypot(ax, ay) < 15 && Math.hypot(bx, by) < 15) backtracks++;
      }
    }
    let sc = n === 1 ? 0.7 : n <= 12 ? 1 : 0.5;
    sc = clamp(sc + (backtracks > 0 ? 0.1 : 0));
    return feature('structure', 'Stroke structure', sc, `${n} stroke${n === 1 ? '' : 's'}, ${backtracks} small corrections`,
      n === 1 ? 'One single stroke: possible, just a bit tidy.' : n > 12 ? 'A lot of tiny strokes; scribbly.' : 'A believable number of pen lifts.');
  }

  // ───────────────────────── 7. pressure and contact ─────────────────────────
  function fPressure(ss) {
    const pen = [], touch = [], touchSize = [];
    for (const s of ss) for (const p of s.raw) {
      if (s.pointerType === 'pen' && typeof p.pressure === 'number') pen.push(p.pressure);
      if (s.pointerType === 'touch') {
        if (typeof p.pressure === 'number') touch.push(p.pressure);
        if (typeof p.width === 'number') touchSize.push(p.width + (p.height || 0));
      }
    }
    if (pen.length < 8 && touch.length < 8) {
      return feature('pressure', 'Pressure & contact', K.NEUTRAL_SCORE, 'n/a (mouse)',
        'Mice report no pressure. Ignored, and the weights are renormalised so you are not penalised.', { applicable: false });
    }
    const scores = [], notes = [];
    if (pen.length >= 8) {
      const sd = std(pen), allHalf = pen.every((x) => x === 0.5 || x === 0);
      scores.push(allHalf || sd < K.PRESSURE_PEN_SD_LO ? 0.15 : ramp(sd, K.PRESSURE_PEN_SD_LO, K.PRESSURE_PEN_SD_HI));
      notes.push(`pen pressure sd ${f2(sd)}`);
    }
    if (touch.length >= 8) {
      const sd = std(touch), sz = std(touchSize);
      scores.push(sd < 0.005 && sz < 0.2 ? 0.55 : 1);   // many touchscreens report constant force; only weakly informative
      notes.push(`touch force sd ${f2(sd)}, contact-size sd ${f2(sz)}`);
    }
    const sc = mean(scores);
    return feature('pressure', 'Pressure & contact', sc, notes.join('; '),
      sc >= K.HUMAN_AT ? 'Pressure / contact size varies like a real finger or pen.'
        : sc <= K.BOT_AT ? 'Pen pressure is frozen at one value on a device that should vary.' : 'Flat force reading, but many screens do that.');
  }

  // ───────────────────────── 8. pointer realism ─────────────────────────
  function fPointer(ss) {
    let untrusted = 0, total = 0;
    const ds = [];
    const types = new Set();
    for (const s of ss) {
      total++; if (!s.trusted) untrusted++;
      types.add(s.pointerType || 'unknown');
      for (let i = 1; i < s.pts.length; i++) { const dt = s.pts[i].t - s.pts[i - 1].t; if (dt > 0 && dt < 100) ds.push(dt); }
    }
    const rate = ds.length ? 1000 / median(ds) : 0;
    const known = [...types].every((t) => t === 'mouse' || t === 'pen' || t === 'touch');
    const value = `${[...types].join('/')}, ${untrusted ? untrusted + ' untrusted' : 'all trusted'}, ~${Math.round(rate)} Hz`;
    let sc = 1, why = 'Events came from the browser itself at a believable sample rate.';
    if (untrusted) { sc = 0; why = 'Events were dispatched by a script (isTrusted = false). Instant bot tell. (Does not catch OS-level automation.)'; }
    else if (!known) { sc = 0.5; why = 'Unrecognised pointer type.'; }
    else if (rate < K.MIN_SAMPLE_RATE_HZ) { sc = 0.35; why = 'Sample rate is implausibly low for real hardware.'; }
    return feature('pointer', 'Pointer realism', sc, value, why, { hardFail: untrusted > 0 });
  }

  // ───────────────────────── 9. total time and pacing ─────────────────────────
  function fPacing(ss, tspan) {
    let sc = ramp(tspan, K.MIN_DRAW_MS, K.OK_DRAW_MS), why = 'A human-scale amount of time.';
    if (ss.length >= 3) {
      const d = ss.map((s) => s.pts[s.pts.length - 1].t - s.pts[0].t);
      if (std(d) / mean(d) < 0.03) { sc = Math.min(sc, 0.2); why = 'Every stroke took exactly the same time.'; }
    }
    if (sc <= K.BOT_AT && tspan < K.MIN_DRAW_MS) why = 'A whole hand in under 1.5 seconds? Show-off.';
    return feature('pacing', 'Total time & pacing', sc, `${f2(tspan / 1000)} s`, why);
  }

  // ───────────────────────── combine ─────────────────────────
  function analyze(strokes) {
    const ss = prep(strokes);
    const debug = { speeds: [], scatter: { pts: [], fit: null } };
    if (!ss.length) return { score: 0, band: 'flag', features: [], debug, untrusted: false };
    const t0 = Math.min(...ss.map((s) => s.pts[0].t)), t1 = Math.max(...ss.map((s) => s.pts[s.pts.length - 1].t));
    const tspan = t1 - t0;
    const features = [
      fTimestamps(ss), fSpeed(ss, debug), fTremor(ss), fCurvature(ss, debug), fPauses(ss, tspan),
      fStructure(ss), fPressure(ss), fPointer(ss), fPacing(ss, tspan),
    ];
    const used = features.filter((f) => f.applicable);
    const wTotal = sum(used.map((f) => f.weight));
    let score = (100 * sum(used.map((f) => f.weight * f.score))) / wTotal;
    const untrusted = features.some((f) => f.hardFail);
    if (untrusted) score = Math.min(score, K.UNTRUSTED_CAP);
    return { score, band: bandOf(score), features, debug, untrusted, effectiveWeightTotal: wTotal };
  }
  const bandOf = (s) => (s >= K.PASS_SCORE ? 'pass' : s >= K.RETRY_SCORE ? 'retry' : 'flag');
  // second attempt is averaged with the first
  const combine = (a, b) => { const s = (a + b) / 2; return { score: s, band: bandOf(s) }; };

  return { analyze, combine, bandOf, K, WEIGHTS, helpers: { windowed, prep, dist } };
});
