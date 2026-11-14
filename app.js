/*
 * app.js — the booth: capture, flow, ink, sound, ticket, Lab, bots, fallback game.
 * Scoring lives in scoring.js, the hand check in shape.js, the bot drawers in synth.js.
 */
(() => {
  'use strict';
  const PW = 600, PH = 450;                       // logical pad size; all stored coordinates use it
  const TILT = -1.2 * Math.PI / 180;              // matches --tilt in style.css
  const TIMER_MS = 20000;
  const THINK_MIN = 1500, THINK_MAX = 2000;       // theatre only: analysis takes a few ms
  const $ = (id) => document.getElementById(id);
  const reduceMotion = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const rnd = (n) => Math.floor(Math.random() * n);
  const Sc = window.PalmScoring, Sh = window.PalmShape, Sy = window.PalmSynth;

  // ───────────── prompts ─────────────
  // expectedRaisedFingers: null skips finger counting. pose = which synthetic hand the bot demos draw.
  const PROMPTS = [
    { text: 'Draw a hand holding up exactly 3 fingers.', expectedRaisedFingers: 3, tolerance: 2, pose: 'three' },
    { text: 'Draw a hand making a peace sign.', expectedRaisedFingers: 2, tolerance: 2, pose: 'peace' },
    { text: 'Draw a hand waving hello.', expectedRaisedFingers: 5, tolerance: 3, pose: 'wave' },
    { text: 'Draw a thumbs-up.', expectedRaisedFingers: 1, tolerance: 2, pose: 'thumbsUp' },
    { text: 'Draw a rock-on hand (index and pinky up).', expectedRaisedFingers: 2, tolerance: 2, pose: 'rockOn' },
    { text: 'Draw a hand in a fist.', expectedRaisedFingers: 0, tolerance: 2, pose: 'fist' },
    { text: 'Draw a hand holding something small, like a grape.', expectedRaisedFingers: null, tolerance: 1, pose: 'wave' },
    { text: 'Draw a hand with 5 fingers spread wide.', expectedRaisedFingers: 5, tolerance: 3, pose: 'spread' },
    { text: 'Draw a hand pointing at the sky.', expectedRaisedFingers: 1, tolerance: 2, pose: 'point' },
    { text: 'Draw a hand with a rubber duck on it.', expectedRaisedFingers: null, tolerance: 1, pose: 'wave' },
    { text: 'Draw a hand reaching for the last biscuit.', expectedRaisedFingers: null, tolerance: 1, pose: 'spread' },
    { text: 'Draw a hand holding up 4 fingers, thumb tucked.', expectedRaisedFingers: 4, tolerance: 3, pose: 'spread' },
    { text: 'Draw a hand giving a very small, very polite salute.', expectedRaisedFingers: null, tolerance: 1, pose: 'peace' },
    { text: 'Draw a hand that has just been told a secret.', expectedRaisedFingers: null, tolerance: 1, pose: 'wave' },
  ];

  // ───────────── copy ─────────────
  const PASS_LINES = [
    'Your life line is wobbly. Reassuringly human.',
    'Five fingers, six opinions. Welcome in.',
    'I felt a hesitation before that thumb. Lovely. Very mammal.',
    'Smudged, hurried, slightly wrong. Perfect. In you go.',
    'That pinky has the confidence of someone who did not plan ahead.',
    'The ink has doubts. The ink is correct to have them. Admitted.',
    'You drew like someone with elbows. I approve of elbows.',
    'Tremor detected, mercy granted. Enjoy the pier.',
    'A shaky line and a tidy conscience. Step right through.',
  ];
  const FAIL_LINES = [
    'That was suspiciously smooth. Do robots practise?',
    'I see... nothing. Try drawing with your whole arm.',
    'Not a single hesitation. Even I hesitate, and I am a hand.',
    'Every sample landed on the beat. Hands do not keep time like that.',
    'Your line has no regrets. Suspicious.',
    'The palm says "human". The wrist says "script". I trust the wrist.',
    'Lovely shape, shame about the soul. One more go?',
  ];
  const SHAPE_LINES = [
    'I asked for a hand, not abstract expressionism.',
    'The spirits cannot read that. Outline a hand, no colouring in.',
    'That is a line. I read palms, not rulers.',
    'Bit shy with the ink. Use more of the pad.',
  ];
  const RETRY_LINES = [
    'Hmm. Half a signal. Draw me another and I will read the two together.',
    'The lines are cloudy. A second hand will clear it up. Different pose, same you.',
  ];
  const EMPTY_LINE = 'The pad is empty. I read palms, not air.';

  // ───────────── state ─────────────
  let state = 'landing';
  let strokes = [], cur = null, curId = null, padRect = null;
  let prompt = null, lastPromptIdx = -1;
  let pendingFirstDyn = null;      // dynamics score of a first "retry" attempt, averaged with the second
  let timerStart = 0, timerHandle = 0;
  let botRunning = false;
  let lab = null;                  // last analysis, for the Lab panel
  let lastFortune = -1, lastFail = -1;
  let pokes = 0;

  const pad = $('pad'), ink = $('ink'), fx = $('fx');
  const ictx = ink.getContext('2d'), fctx = fx.getContext('2d');

  // ───────────── sound + haptics ─────────────
  const snd = {
    on: false, ctx: null, lastScratch: 0,
    ensure() { if (!this.ctx) { const A = window.AudioContext || window.webkitAudioContext; if (A) this.ctx = new A(); } if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); return this.ctx; },
    noise(dur, freq, q, gain) {
      const c = this.ctx; if (!c) return;
      const n = Math.max(1, Math.floor(c.sampleRate * dur)), buf = c.createBuffer(1, n, c.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
      const src = c.createBufferSource(); src.buffer = buf;
      const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
      const g = c.createGain(); g.gain.value = gain;
      src.connect(f); f.connect(g); g.connect(c.destination); src.start();
    },
    tone(freq, t0, dur, gain, type) {
      const c = this.ctx; if (!c) return;
      const o = c.createOscillator(), g = c.createGain();
      o.type = type || 'sine'; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, c.currentTime + t0);
      g.gain.exponentialRampToValueAtTime(gain, c.currentTime + t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + t0 + dur);
      o.connect(g); g.connect(c.destination); o.start(c.currentTime + t0); o.stop(c.currentTime + t0 + dur + 0.05);
    },
    scratch(speed) { if (!this.on || !this.ensure()) return; const now = performance.now(); if (now - this.lastScratch < 55) return; this.lastScratch = now; this.noise(0.05, 2400 + Math.random() * 1800, 1.2, Math.min(0.09, 0.015 + speed * 0.03)); },
    thunk() { if (!this.on || !this.ensure()) return; this.tone(110, 0, 0.16, 0.5); this.tone(55, 0.02, 0.2, 0.5); this.noise(0.07, 700, 0.8, 0.25); },
    chime() { if (!this.on || !this.ensure()) return; this.tone(880, 0, 0.5, 0.18, 'triangle'); this.tone(1320, 0.12, 0.7, 0.16, 'triangle'); },
    buzz() { if (!this.on || !this.ensure()) return; this.tone(150, 0, 0.25, 0.2, 'sawtooth'); this.tone(120, 0.14, 0.3, 0.2, 'sawtooth'); },
    beep(f) { if (!this.ensure()) return; this.tone(f || 660, 0, 0.14, 0.2, 'square'); },   // used by the beat game even when sound is off
  };
  $('soundBtn').addEventListener('click', () => {
    snd.on = !snd.on; if (snd.on) snd.ensure();
    $('soundBtn').setAttribute('aria-pressed', snd.on); $('soundBtn').textContent = 'Sound: ' + (snd.on ? 'on' : 'off');
  });
  const haptic = (ms) => { try { if (navigator.vibrate) navigator.vibrate(ms || 8); } catch (e) { /* ignore */ } };

  // ───────────── canvas sizing and ink rendering ─────────────
  function resize() {
    const w = pad.clientWidth, h = pad.clientHeight, dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (!w || !h) return;
    for (const c of [ink, fx]) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); c.getContext('2d').setTransform(c.width / PW, 0, 0, c.height / PH, 0, 0); }
    redraw();
  }
  function redraw() {
    ictx.clearRect(0, 0, PW, PH); fctx.clearRect(0, 0, PW, PH);
    for (const s of strokes) {
      if (s.points.length === 1) dot(s.points[0]);
      for (let i = 1; i < s.points.length; i++) seg(s, i);
    }
  }
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  function curve(ctx, m0, c, m1, w, color, ox, oy) {
    ctx.beginPath(); ctx.moveTo(m0.x + ox, m0.y + oy); ctx.quadraticCurveTo(c.x + ox, c.y + oy, m1.x + ox, m1.y + oy);
    ctx.lineWidth = w; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = color; ctx.stroke();
  }
  function seg(s, i) {
    const P = s.points, a = P[i - 1], b = P[i];
    const m0 = i >= 2 ? mid(P[i - 2], a) : a, m1 = mid(a, b), w = b.w || 3.5;
    curve(fctx, m0, a, m1, w, '#ff3f8e', 2.8, 2.4);                       // pink second layer, misregistered
    curve(ictx, m0, a, m1, w + 1.8, 'rgba(31,63,208,.26)', 0, 0);          // wet edge
    curve(ictx, m0, a, m1, w, '#1f3fd0', 0, 0);
  }
  function dot(p) { const w = p.w || 3.5; fctx.fillStyle = '#ff3f8e'; fctx.beginPath(); fctx.arc(p.x + 2.8, p.y + 2.4, w / 2, 0, 7); fctx.fill(); ictx.fillStyle = '#1f3fd0'; ictx.beginPath(); ictx.arc(p.x, p.y, w / 2, 0, 7); ictx.fill(); }
  new ResizeObserver(resize).observe(pad);
  window.addEventListener('resize', resize);

  // ───────────── capture ─────────────
  function toPad(ev) {
    const cx = padRect.left + padRect.width / 2, cy = padRect.top + padRect.height / 2;
    const dx = ev.clientX - cx, dy = ev.clientY - cy, c = Math.cos(TILT), s = Math.sin(TILT);
    const lx = dx * c + dy * s, ly = -dx * s + dy * c;               // undo the pad's CSS tilt
    const W = pad.clientWidth, H = pad.clientHeight;
    return { x: Math.max(0, Math.min(PW, (lx + W / 2) * PW / W)), y: Math.max(0, Math.min(PH, (ly + H / 2) * PH / H)) };
  }
  function addPoint(ev, parent) {
    const q = toPad(ev), P = cur.points, prev = P[P.length - 1];
    let w;
    if (cur.pointerType === 'mouse') {          // slower = thicker, faster = thinner
      let v = 0; if (prev && ev.timeStamp > prev.t) v = Math.hypot(q.x - prev.x, q.y - prev.y) / (ev.timeStamp - prev.t);
      const target = Math.max(2.2, Math.min(6.4, 6.4 - v * 2.6));
      w = prev ? prev.w * 0.75 + target * 0.25 : 5;
    } else { const pr = ev.pressure > 0 ? ev.pressure : 0.5; w = 2.2 + pr * 4.6; if (prev) w = prev.w * 0.5 + w * 0.5; }
    if (ev.isTrusted === false || parent.isTrusted === false) cur.trusted = false;
    const p = { x: q.x, y: q.y, t: ev.timeStamp, pressure: ev.pressure, tiltX: ev.tiltX || 0, tiltY: ev.tiltY || 0, width: ev.width, height: ev.height, w };
    P.push(p);
    if (P.length === 1) dot(p); else seg(cur, P.length - 1);
    if (prev) snd.scratch(Math.hypot(p.x - prev.x, p.y - prev.y) / Math.max(1, p.t - prev.t));
  }
  ink.addEventListener('pointerdown', (e) => {
    if (state !== 'draw' || botRunning || (e.pointerType === 'mouse' && e.button !== 0) || cur) return;
    e.preventDefault();
    try { ink.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    padRect = pad.getBoundingClientRect();
    cur = { pointerType: e.pointerType || 'mouse', trusted: e.isTrusted !== false, points: [] }; curId = e.pointerId;
    strokes.push(cur); addPoint(e, e); haptic(8); updateButtons();
  });
  ink.addEventListener('pointermove', (e) => {
    if (!cur || e.pointerId !== curId) return;
    e.preventDefault();
    const list = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    for (const ce of (list.length ? list : [e])) addPoint(ce, e);
  });
  const endStroke = (e) => {
    if (!cur || e.pointerId !== curId) return;
    if (e.type === 'pointerup') addPoint(e, e);
    cur = null; curId = null; updateButtons();
  };
  ink.addEventListener('pointerup', endStroke); ink.addEventListener('pointercancel', endStroke);
  ink.addEventListener('contextmenu', (e) => e.preventDefault());

  function totalPoints() { return strokes.reduce((n, s) => n + s.points.length, 0); }
  function updateButtons() {
    const live = state === 'draw' && !botRunning;
    $('undoBtn').disabled = !(live && strokes.length); $('clearBtn').disabled = !(live && strokes.length);
    $('doneBtn').disabled = !(live && totalPoints() > 4);
  }
  $('undoBtn').addEventListener('click', () => { if (state !== 'draw') return; strokes.pop(); redraw(); updateButtons(); });
  $('clearBtn').addEventListener('click', () => {
    if (state !== 'draw' || !strokes.length) return;
    if (reduceMotion()) { strokes = []; redraw(); updateButtons(); return; }
    pad.classList.remove('crumple'); void pad.offsetWidth; pad.classList.add('crumple');
    setTimeout(() => { strokes = []; redraw(); updateButtons(); }, 220);
    setTimeout(() => pad.classList.remove('crumple'), 600);
  });
  $('hintToggle').addEventListener('change', (e) => $('hint').classList.toggle('off', !e.target.checked));

  // ───────────── mascot + bubble ─────────────
  const mascot = $('mascot');
  const setMascot = (s) => mascot.setAttribute('data-state', s);
  const say = (html, tag) => { $('bubble').innerHTML = html; $('bubbleTag').textContent = tag || 'Madame Eyeball says'; };
  mascot.addEventListener('click', () => {
    pokes++; mascot.classList.remove('poked'); void mascot.getBoundingClientRect(); mascot.classList.add('poked');
    if (pokes % 5 === 0) { say('Hey. Eyes up here. Draw, don’t poke.', 'Madame Eyeball, annoyed'); setMascot('smug'); setTimeout(() => { if (state !== 'thinking') setMascot(state === 'verdict' ? mascot.dataset.keep || 'idle' : 'idle'); }, 1800); }
  });
  const pick = (arr, lastKey) => { let i; do { i = rnd(arr.length); } while (arr.length > 1 && i === lastKey.v); lastKey.v = i; return arr[i]; };
  const lf = { v: -1 }, lfail = { v: -1 }, lsh = { v: -1 }, lre = { v: -1 };

  // ───────────── flow ─────────────
  function pickPrompt() {
    let i; do { i = rnd(PROMPTS.length); } while (i === lastPromptIdx);
    lastPromptIdx = i; return PROMPTS[i];
  }
  function startRound(keepStrokes) {
    clearTimeout(timerHandle);
    if (!keepStrokes) { strokes = []; cur = null; }
    prompt = pickPrompt();
    state = 'draw';
    $('ticketWrap').innerHTML = '';
    $('coinOverlay').classList.add('hidden'); $('thinkOverlay').classList.add('hidden');
    setMascot('idle'); mascot.dataset.keep = 'idle';
    const lead = pendingFirstDyn !== null ? 'Second sample, then. ' : '';
    say(`${lead}<span class="pose">${prompt.text.replace(/^Draw /, 'Draw ')}</span>`, pendingFirstDyn !== null ? 'One more try' : 'Madame Eyeball says');
    redraw(); updateButtons();
    timerStart = performance.now(); tickTimer();
    setTimeout(() => ink.focus && 0, 0);
  }
  function tickTimer() {
    const el = performance.now() - timerStart, frac = Math.min(1, el / TIMER_MS);
    $('ring').style.strokeDashoffset = (138.2 * frac).toFixed(1);
    $('tlabel').textContent = frac >= 1 ? 'Overtime. No penalty. Dawdle away.' : `${Math.ceil((TIMER_MS - el) / 1000)} s left, but nothing happens at zero`;
    if (state === 'draw') timerHandle = setTimeout(tickTimer, 250);
  }
  $('startBtn').addEventListener('click', () => { snd.ensure && snd.on && snd.ensure(); startRound(); });

  $('doneBtn').addEventListener('click', submit);
  function submit() {
    if (state !== 'draw') return;
    if (totalPoints() < 5) { say(EMPTY_LINE); return; }
    state = 'thinking'; clearTimeout(timerHandle); updateButtons();
    setMascot('thinking'); say('Hmm… the lines are swirling…', 'Madame Eyeball is thinking');
    $('thinkOverlay').classList.remove('hidden');
    snd.thunk();
    const delay = reduceMotion() ? 400 : THINK_MIN + Math.random() * (THINK_MAX - THINK_MIN);
    const t0 = performance.now();
    const result = evaluate();                       // the real work: a few milliseconds
    result.evalMs = performance.now() - t0;
    setTimeout(() => { $('thinkOverlay').classList.add('hidden'); showVerdict(result); }, delay);
  }

  function isPerfectCircle(ss) {
    const pts = []; ss.forEach((s) => s.points.forEach((p) => pts.push(p)));
    if (pts.length < 40) return false;
    const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length, cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
    const r = pts.map((p) => Math.hypot(p.x - cx, p.y - cy)), m = r.reduce((a, b) => a + b, 0) / r.length;
    const sd = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / r.length);
    const first = pts[0], last = pts[pts.length - 1];
    return m > 40 && sd / m < 0.045 && Math.hypot(first.x - last.x, first.y - last.y) < m * 0.35;
  }

  function evaluate() {
    const shape = Sh.check(strokes, prompt), dyn = Sc.analyze(strokes);
    const combinedScore = pendingFirstDyn !== null ? (pendingFirstDyn + dyn.score) / 2 : dyn.score;
    const band = Sc.bandOf(combinedScore);
    let kind, egg = null;
    if (isPerfectCircle(strokes)) { kind = 'shape'; egg = 'circle'; }
    else if (!shape.pass) kind = 'shape';
    else if (dyn.untrusted) kind = 'flag';
    else if (band === 'pass') kind = 'pass';
    else if (band === 'retry' && pendingFirstDyn === null) kind = 'retry';
    else kind = 'flag';
    if (kind === 'pass' && shape.estimatedFingers >= 6) egg = 'six';
    return { kind, egg, shape, dyn, combined: combinedScore, firstScore: pendingFirstDyn, prompt, strokes: JSON.parse(JSON.stringify(strokes)) };
  }

  function showVerdict(res, via) {
    state = 'verdict'; updateButtons();
    lab = res;
    const k = res.kind;
    let head, stamp, line, cls = '';
    if (k === 'pass') {
      stamp = 'HUMAN'; head = 'ADMIT ONE';
      line = res.egg === 'six' ? 'Six fingers! Either very special or very cursed. Admitted either way.' : pick(PASS_LINES, lf);
      setMascot('delighted'); mascot.dataset.keep = 'delighted'; pendingFirstDyn = null; snd.chime(); confetti();
    } else if (k === 'retry') {
      stamp = 'HMM'; head = 'ONE MORE TRY'; cls = 'bad'; line = pick(RETRY_LINES, lre);
      pendingFirstDyn = res.dyn.score; setMascot('idle'); mascot.dataset.keep = 'idle'; snd.buzz();
    } else if (k === 'shape') {
      stamp = 'NO HAND'; head = 'TRY AGAIN'; cls = 'bad';
      line = res.egg === 'circle' ? 'A perfect circle. Are you a compass? Lovely, but it is not a hand.' : pick(SHAPE_LINES, lsh);
      setMascot('idle'); mascot.dataset.keep = 'idle'; snd.buzz(); if (!reduceMotion()) { pad.classList.remove('shake'); void pad.offsetWidth; pad.classList.add('shake'); }
    } else {
      stamp = 'SUSPICIOUS'; head = 'TRY AGAIN'; cls = 'bad'; line = pick(FAIL_LINES, lfail);
      pendingFirstDyn = null; setMascot('smug'); mascot.dataset.keep = 'smug'; snd.buzz();
      if (res.dyn.untrusted) line = 'Those pointer events were typed by a script, not a hand. Cute.';
    }
    say(line, k === 'pass' ? 'The verdict' : 'Madame Eyeball sniffs');
    const meta = via ? via : `dynamics ${res.combined.toFixed(0)}/100${res.firstScore !== null ? ' (two samples averaged)' : ''} · shape ${res.shape.pass ? 'ok' : 'not a hand'} · ~${res.shape.estimatedFingers} fingers · analysed in ${res.evalMs ? res.evalMs.toFixed(0) : 0} ms`;
    const again = k === 'pass' ? 'Another palm?' : 'Different prompt, go again';
    $('ticketWrap').innerHTML = `<div class="ticket ${cls}" role="status" aria-label="Verdict: ${stamp}. ${head}. ${line}">
      <h2><span class="stampword">${stamp}${k === 'pass' ? ':' : ':'}</span> ${head}</h2>
      <p>${line}</p>
      <div class="meta">${meta}</div>
      <div class="actions"><button class="btn" id="againBtn" type="button">${again}</button>${res.dyn ? '<button class="linkbtn" id="peekBtn" type="button">Peek behind the curtain</button>' : ''}</div></div>`;
    $('againBtn').addEventListener('click', () => startRound(false));
    const pk = $('peekBtn'); if (pk) pk.addEventListener('click', openLab);
    $('againBtn').focus({ preventScroll: true });
    $('ticketWrap').scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'nearest' });
    renderLab();
  }

  // ───────────── confetti ─────────────
  function confetti() {
    if (reduceMotion()) return;
    const cv = $('confetti'), ctx = cv.getContext('2d'), dpr = Math.min(devicePixelRatio || 1, 2);
    cv.width = innerWidth * dpr; cv.height = innerHeight * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cols = ['#ff3f8e', '#1f3fd0', '#ffd23a', '#1c1a17'], bits = [];
    for (let i = 0; i < 110; i++) bits.push({ x: innerWidth * (0.2 + Math.random() * 0.6), y: innerHeight * 0.35, vx: (Math.random() - 0.5) * 9, vy: -Math.random() * 11 - 3, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.35, w: 7 + Math.random() * 12, h: 4 + Math.random() * 8, c: cols[rnd(cols.length)], torn: Math.random() < 0.5 });
    const t0 = performance.now();
    (function frame(now) {
      const el = now - t0; ctx.clearRect(0, 0, innerWidth, innerHeight);
      for (const b of bits) {
        b.vy += 0.32; b.vx *= 0.99; b.x += b.vx; b.y += b.vy; b.r += b.vr;
        ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.r); ctx.fillStyle = b.c; ctx.globalAlpha = Math.max(0, 1 - el / 2600);
        ctx.beginPath(); ctx.moveTo(-b.w / 2, -b.h / 2); ctx.lineTo(b.w / 2, -b.h / 2 + (b.torn ? 2 : 0)); ctx.lineTo(b.w / 2 - 2, b.h / 2); ctx.lineTo(-b.w / 2 + (b.torn ? 3 : 0), b.h / 2); ctx.fill(); ctx.restore();
      }
      if (el < 2700) requestAnimationFrame(frame); else ctx.clearRect(0, 0, innerWidth, innerHeight);
    })(t0);
  }

  // ───────────── Lab ─────────────
  const labEl = $('lab'); let labReturnFocus = null, replayRaf = 0;
  function openLab() {
    labReturnFocus = document.activeElement; labEl.classList.add('open'); labEl.setAttribute('aria-hidden', 'false'); $('labBackdrop').classList.remove('hidden');
    renderLab(); labEl.focus({ preventScroll: true });
  }
  function closeLab() { labEl.classList.remove('open'); labEl.setAttribute('aria-hidden', 'true'); $('labBackdrop').classList.add('hidden'); cancelAnimationFrame(replayRaf); if (labReturnFocus && labReturnFocus.focus) labReturnFocus.focus(); }
  $('labLink').addEventListener('click', openLab); $('labClose').addEventListener('click', closeLab); $('labBackdrop').addEventListener('click', closeLab);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (!$('fallback').classList.contains('hidden')) closeFallback(); else if (labEl.classList.contains('open')) closeLab(); } });

  function fitCanvas(cv, h) {
    const dpr = Math.min(devicePixelRatio || 1, 2), w = cv.clientWidth || 560;
    cv.width = w * dpr; cv.height = h * dpr; const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); return { c, w, h };
  }
  const INKC = ['#1f3fd0', '#ff3f8e', '#1c1a17', '#c98e00'];
  function drawStrokesOn(ctx, ss, upToVT) {
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ss.forEach((s, si) => {
      ctx.strokeStyle = INKC[si % INKC.length]; ctx.lineWidth = 3;
      ctx.beginPath(); let started = false;
      for (const p of s.points) { if (upToVT !== undefined && p.vt > upToVT) break; if (!started) { ctx.moveTo(p.x, p.y); started = true; } else ctx.lineTo(p.x, p.y); }
      ctx.stroke();
    });
  }
  function drawShapeOverlay(ctx, sh) {
    const d = sh.debug; if (!d) return;
    ctx.save(); ctx.lineWidth = 2.5; ctx.setLineDash([7, 6]); ctx.strokeStyle = '#ff3f8e';
    if (d.hull.length > 2) { ctx.beginPath(); d.hull.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); ctx.stroke(); }
    ctx.setLineDash([2, 5]); ctx.strokeStyle = '#1c1a17'; (d.chords || []).forEach(([a, b]) => { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); });
    ctx.setLineDash([]); ctx.strokeStyle = '#1c1a17'; ctx.lineWidth = 2;
    d.tips.forEach((t, i) => { ctx.fillStyle = '#ffd23a'; ctx.beginPath(); ctx.arc(t.x, t.y, 9, 0, 7); ctx.fill(); ctx.stroke(); ctx.fillStyle = '#1c1a17'; ctx.font = '700 12px IBM Plex Mono, monospace'; ctx.textAlign = 'center'; ctx.fillText(String(i + 1), t.x, t.y + 4); });
    if (d.wrist) { ctx.beginPath(); ctx.moveTo(d.wrist.x - 8, d.wrist.y - 8); ctx.lineTo(d.wrist.x + 8, d.wrist.y + 8); ctx.moveTo(d.wrist.x + 8, d.wrist.y - 8); ctx.lineTo(d.wrist.x - 8, d.wrist.y + 8); ctx.stroke(); }
    ctx.fillStyle = '#1f3fd0'; ctx.beginPath(); ctx.arc(d.centroid.x, d.centroid.y, 5, 0, 7); ctx.fill();
    ctx.restore();
  }
  function timeline(ss) { // virtual time: long pauses trimmed to 0.8 s so the replay never stalls
    let vt = 0, prevT = null;
    return ss.map((s) => ({ ...s, points: s.points.map((p) => { if (prevT !== null) vt += Math.min(Math.max(0, p.t - prevT), 800); prevT = p.t; return { ...p, vt }; }) }));
  }
  function renderReplayStatic() {
    if (!lab) return;
    const cv = $('replayCv'); cv.width = 1200; cv.height = 900; const c = cv.getContext('2d'); c.setTransform(2, 0, 0, 2, 0, 0);
    c.clearRect(0, 0, PW, PH); drawStrokesOn(c, timeline(lab.strokes));
    if ($('overlayToggle').checked) drawShapeOverlay(c, lab.shape);
  }
  function replay() {
    if (!lab) return; cancelAnimationFrame(replayRaf);
    const tl = timeline(lab.strokes), end = tl.length ? tl[tl.length - 1].points.slice(-1)[0].vt : 0, cv = $('replayCv'), c = cv.getContext('2d'), t0 = performance.now();
    (function f(now) {
      const vt = now - t0; c.setTransform(2, 0, 0, 2, 0, 0); c.clearRect(0, 0, PW, PH); drawStrokesOn(c, tl, vt);
      if (vt < end + 200) replayRaf = requestAnimationFrame(f); else renderReplayStatic();
    })(t0);
  }
  $('replayBtn').addEventListener('click', replay); $('overlayToggle').addEventListener('change', renderReplayStatic);

  function wobbleLine(c, pts, color, seed) {
    c.strokeStyle = color; c.lineWidth = 2.4; c.lineJoin = 'round'; c.beginPath();
    pts.forEach((p, i) => { const j = Math.sin(i * 1.7 + seed) * 0.8; i ? c.lineTo(p[0] + j, p[1] + j) : c.moveTo(p[0], p[1]); }); c.stroke();
  }
  function renderSpeed() {
    const { c, w, h } = fitCanvas($('speedCv'), 190), sp = lab.dyn.debug.speeds.filter((s) => s.length > 1);
    c.clearRect(0, 0, w, h); const L = 44, B = 26, T = 10, R = 10;
    c.strokeStyle = '#1c1a17'; c.lineWidth = 2; c.beginPath(); c.moveTo(L, T); c.lineTo(L, h - B); c.lineTo(w - R, h - B); c.stroke();
    c.font = '15px Gaegu, cursive'; c.fillStyle = '#1c1a17'; c.fillText('units/s', 2, 16); c.textAlign = 'right'; c.fillText('time →', w - R, h - 6); c.textAlign = 'left';
    if (!sp.length) { c.fillText('No speed data.', L + 10, h / 2); return; }
    const t0 = Math.min(...sp.map((s) => s[0].t)), t1 = Math.max(...sp.map((s) => s[s.length - 1].t));
    const vmax = Math.max(...sp.map((s) => Math.max(...s.map((p) => p.v)))) * 1.08 || 1;
    const X = (t) => L + ((t - t0) / Math.max(1, t1 - t0)) * (w - L - R), Y = (v) => h - B - (v / vmax) * (h - B - T);
    c.strokeStyle = 'rgba(28,26,23,.2)'; c.lineWidth = 1; c.font = '11px IBM Plex Mono, monospace';
    for (let i = 1; i <= 3; i++) { const v = (vmax * i) / 3; c.beginPath(); c.moveTo(L, Y(v)); c.lineTo(w - R, Y(v)); c.stroke(); c.fillText(Math.round(v), 6, Y(v) + 4); }
    sp.forEach((s, i) => wobbleLine(c, s.map((p) => [X(p.t), Y(p.v)]), INKC[i % INKC.length], i * 2));
    c.font = '15px Gaegu, cursive'; c.fillStyle = '#1c1a17'; c.fillText(`${sp.length} stroke${sp.length > 1 ? 's' : ''}, one colour each. Flat = machine. Hills = arm.`, L + 70, T + 14);
  }
  function renderScatter() {
    const { c, w, h } = fitCanvas($('curvCv'), 220), sc = lab.dyn.debug.scatter;
    c.clearRect(0, 0, w, h); const L = 44, B = 28, T = 10, R = 12;
    c.strokeStyle = '#1c1a17'; c.lineWidth = 2; c.beginPath(); c.moveTo(L, T); c.lineTo(L, h - B); c.lineTo(w - R, h - B); c.stroke();
    c.font = '15px Gaegu, cursive'; c.fillStyle = '#1c1a17'; c.fillText('log speed', 2, 16); c.textAlign = 'right'; c.fillText('log radius of curvature →', w - R, h - 6); c.textAlign = 'left';
    if (!sc.pts.length) { c.fillText('No curvature data.', L + 10, h / 2); $('curvNote').textContent = ''; return; }
    const xs = sc.pts.map((p) => p.x), ys = sc.pts.map((p) => p.y);
    const x0 = Math.min(...xs) - 0.1, x1 = Math.max(...xs) + 0.1, y0 = Math.min(...ys) - 0.2, y1 = Math.max(...ys) + 0.2;
    const X = (x) => L + ((x - x0) / (x1 - x0)) * (w - L - R), Y = (y) => h - B - ((y - y0) / (y1 - y0)) * (h - B - T);
    sc.pts.forEach((p, i) => { c.fillStyle = 'rgba(31,63,208,.55)'; c.beginPath(); c.arc(X(p.x) + Math.sin(i) * 0.5, Y(p.y), 3.2, 0, 7); c.fill(); });
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
    c.setLineDash([6, 5]); c.strokeStyle = '#1c1a17'; c.lineWidth = 1.8; c.beginPath(); c.moveTo(X(x0), Y(my + (x0 - mx) / 3)); c.lineTo(X(x1), Y(my + (x1 - mx) / 3)); c.stroke(); c.setLineDash([]);
    if (sc.fit) { c.strokeStyle = '#ff3f8e'; c.lineWidth = 3; c.beginPath(); c.moveTo(X(x0), Y(sc.fit.intercept + sc.fit.slope * x0)); c.lineTo(X(x1), Y(sc.fit.intercept + sc.fit.slope * x1)); c.stroke(); }
    $('curvNote').textContent = sc.fit ? `Pink = fitted line (slope ${sc.fit.slope.toFixed(2)}, R² ${sc.fit.r2.toFixed(2)}). Dashed = the two-thirds power law (slope 0.33). Humans slow down for tight curves, so the cloud tilts up to the right.` : 'Not enough curvy path for a fit.';
  }
  function renderLab() {
    $('labEmpty').classList.toggle('hidden', !!lab); $('labBody').classList.toggle('hidden', !lab);
    if (!lab || !labEl.classList.contains('open')) return;
    const sc = lab.combined, col = sc >= Sc.K.PASS_SCORE ? '#1f3fd0' : sc >= Sc.K.RETRY_SCORE ? '#c98e00' : '#ff3f8e';
    const len = Math.PI * 66, f = Math.max(0, Math.min(1, sc / 100));
    const ang = Math.PI * (1 - f), nx = 80 + Math.cos(ang) * 58, ny = 88 - Math.sin(ang) * 58;
    const tick = (v) => { const a = Math.PI * (1 - v / 100); return `<line x1="${80 + Math.cos(a) * 58}" y1="${88 - Math.sin(a) * 58}" x2="${80 + Math.cos(a) * 76}" y2="${88 - Math.sin(a) * 76}" stroke="#1c1a17" stroke-width="2.5"/>`; };
    $('dial').innerHTML = `<path d="M14 88 A66 66 0 0 1 146 88" fill="none" stroke="#e6d9b8" stroke-width="14" stroke-linecap="round"/><path d="M14 88 A66 66 0 0 1 146 88" fill="none" stroke="${col}" stroke-width="14" stroke-linecap="round" stroke-dasharray="${(len * f).toFixed(1)} ${len}"/>${tick(Sc.K.RETRY_SCORE)}${tick(Sc.K.PASS_SCORE)}<line x1="80" y1="88" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}" stroke="#1c1a17" stroke-width="3.5" stroke-linecap="round"/><circle cx="80" cy="88" r="6" fill="#1c1a17"/><text x="80" y="76" text-anchor="middle" font-family="Bagel Fat One, Impact, sans-serif" font-size="26" fill="#1c1a17">${sc.toFixed(0)}</text>`;
    const outcome = { pass: 'HUMAN: admitted', retry: 'one more try', shape: 'not recognised as a hand', flag: 'suspicious' }[lab.kind] || '';
    $('dialText').innerHTML = `<p><strong>Dynamics score ${sc.toFixed(1)} / 100</strong>${lab.firstScore !== null ? ` (average of two samples: ${lab.firstScore.toFixed(0)} and ${lab.dyn.score.toFixed(0)})` : ''}<br>Bands: ≥ ${Sc.K.PASS_SCORE} pass · ${Sc.K.RETRY_SCORE}–${Sc.K.PASS_SCORE} one more try · below ${Sc.K.RETRY_SCORE} flagged.<br>Final pass needs the shape check <em>and</em> the dynamics score.<br><strong>Outcome: ${outcome}.</strong>${lab.dyn.untrusted ? '<br>Score capped: script-dispatched events.' : ''}</p>`;
    const sh = lab.shape, d = sh.debug, ex = lab.prompt && lab.prompt.expectedRaisedFingers;
    $('shapeText').innerHTML = `<p><strong>${sh.pass ? 'Passes' : 'Fails'}</strong> the shape check · confidence ${sh.confidence.toFixed(2)}<br>Estimated fingers (protrusions minus wrist): <strong>${sh.estimatedFingers}</strong>${ex === null || ex === undefined ? ' · prompt does not count fingers' : ` · prompt expects ${ex} ± ${Math.max(lab.prompt.tolerance, 1)}`}<br>${d ? `ink length ${d.inkLen.toFixed(0)} u · ink/perimeter ${d.inkRatio.toFixed(2)} · overdraw ${d.overdraw.toFixed(2)} · density ${d.density.toFixed(2)} · sharp turns/100u ${d.turnsPer100.toFixed(1)} · hull solidity ${d.solidity.toFixed(2)} · outline ${d.filled ? 'closed' : 'open'}` : ''}${sh.reasons.length ? '<br>Why not: ' + sh.reasons.join(' ') : ''}<br>Analysis time: ${lab.evalMs ? lab.evalMs.toFixed(1) : '?'} ms (the 1.5 s pause is theatre).</p>`;
    renderReplayStatic(); renderSpeed(); renderScatter();
    const rows = lab.dyn.features.map((x) => `<tr><td><strong>${x.name}</strong></td><td>${x.value}</td><td><span class="tag ${x.status}">${{ humanLike: 'human-like', neutral: 'neutral', botLike: 'bot-like' }[x.status]}</span></td><td>${x.applicable ? x.weight : 'skipped'}</td><td>${x.reason}</td></tr>`).join('');
    $('featTable').innerHTML = `<tr><th>Feature</th><th>Measured</th><th>Tag</th><th>Weight</th><th>In plain English</th></tr>${rows}`;
  }

  $('exportBtn').addEventListener('click', async () => {
    const data = { app: 'palm-reader', version: 1, padUnits: { w: PW, h: PH }, prompt: lab ? lab.prompt : prompt, strokes: (lab ? lab.strokes : strokes).map((s) => ({ pointerType: s.pointerType, trusted: s.trusted, points: s.points.map(({ x, y, t, pressure, tiltX, tiltY, width, height }) => ({ x, y, t, pressure, tiltX, tiltY, width, height })) })), analysis: lab ? { score: lab.combined, kind: lab.kind, features: lab.dyn.features.map(({ id, value, score, status }) => ({ id, value, score, status })) } : null };
    const text = JSON.stringify(data, null, 1);
    const blob = new Blob([text], { type: 'application/json' }), a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'palm-strokes.json'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    let copied = false; try { await navigator.clipboard.writeText(text); copied = true; } catch (e) { /* ignore */ }
    $('exportMsg').textContent = `Saved palm-strokes.json${copied ? ' and copied it' : ''}. ${data.strokes.length} strokes.`;
  });

  // ───────────── Be the bot ─────────────
  document.querySelectorAll('[data-bot]').forEach((b) => b.addEventListener('click', () => runBot(b.dataset.bot)));
  function runBot(kind) {
    if (botRunning || state === 'thinking') return;
    closeLab();
    pendingFirstDyn = null;
    startRound(false);
    const rand = Sy.rng(Date.now() & 0xffff), p = prompt || PROMPTS[0];
    const [raised, thumb] = Sy.POSES[p.pose || 'wave']();
    let poly = Sy.handOutline(raised, thumb, rand, 0.4);
    poly = Sy.transform(poly, rand, 0.95 + rand() * 0.15, (rand() - 0.5) * 0.2, (rand() - 0.5) * 30, 0);
    const trusted = $('trustMask').checked;
    const bs = kind === 'a' ? Sy.botA(poly, { trusted }) : kind === 'b' ? Sy.botB(poly, { trusted }) : Sy.botC(poly, { trusted, rand });
    const names = { a: 'Straight lines at constant speed', b: 'Smooth spline at constant speed', c: 'Spline with random speed and jitter' };
    say(`Bot ${kind}: ${names[kind]}. Watch it draw…`, 'Demo bot at work');
    botRunning = true; updateButtons();
    const t0s = bs[0].points[0].t, start = performance.now(), queue = bs.map((s) => ({ s, i: 0 }));
    const live = [];
    (function step(now) {
      const el = now - start;
      for (const q of queue) {
        while (q.i < q.s.points.length && q.s.points[q.i].t - t0s <= el) {
          if (!q.live) { q.live = { pointerType: q.s.pointerType, trusted: q.s.trusted, points: [] }; strokes.push(q.live); }
          const pt = { ...q.s.points[q.i], w: 3.6 }; q.live.points.push(pt);
          if (q.live.points.length === 1) dot(pt); else seg(q.live, q.live.points.length - 1);
          q.i++;
        }
      }
      if (queue.every((q) => q.i >= q.s.points.length)) { botRunning = false; setTimeout(() => { updateButtons(); submit(); setTimeout(openLab, 2300); }, 500); } else requestAnimationFrame(step);
    })(start);
  }

  // ───────────── accessible alternative ─────────────
  const fb = $('fallback'); let fbReturn = null, beat = null;
  function openFallback() { fbReturn = document.activeElement; fb.classList.remove('hidden'); $('fbMsg').textContent = ''; showTab('beat'); $('tabBeat').focus(); }
  function closeFallback() { fb.classList.add('hidden'); beat = null; if (fbReturn && fbReturn.focus) fbReturn.focus(); }
  $('fallbackLink').addEventListener('click', openFallback); $('fbClose').addEventListener('click', closeFallback);
  fb.addEventListener('click', (e) => { if (e.target === fb) closeFallback(); });
  function showTab(t) {
    $('tabBeat').setAttribute('aria-selected', t === 'beat'); $('tabOdd').setAttribute('aria-selected', t === 'odd');
    $('beatGame').classList.toggle('hidden', t !== 'beat'); $('oddGame').classList.toggle('hidden', t !== 'odd'); $('fbMsg').textContent = '';
    if (t === 'odd') buildOdd();
  }
  $('tabBeat').addEventListener('click', () => showTab('beat')); $('tabOdd').addEventListener('click', () => showTab('odd'));

  function passFallback(how) {
    closeFallback(); startRoundQuiet();
    showVerdict({ kind: 'pass', egg: null, shape: { pass: true, estimatedFingers: 0, confidence: 1, reasons: [], debug: null }, dyn: { score: 0, features: [], debug: { speeds: [], scatter: { pts: [], fit: null } } }, combined: 0, firstScore: null, prompt: null, strokes: [], evalMs: 0 }, how);
    lab = null; renderLab();
  }
  function startRoundQuiet() { state = 'verdict'; $('coinOverlay').classList.add('hidden'); clearTimeout(timerHandle); }
  const lamps = [...document.querySelectorAll('#lamps .lamp')];
  $('beatPlay').addEventListener('click', () => {
    snd.ensure();
    const iv = [0, 1, 2].map(() => 380 + rnd(480)), at = [0, iv[0], iv[0] + iv[1], iv[0] + iv[1] + iv[2]];
    beat = { iv, taps: [], playing: true, trusted: true };
    $('beatTap').disabled = true; $('beatPlay').disabled = true; $('fbMsg').textContent = 'Listen…';
    at.forEach((t, i) => setTimeout(() => { lamps[i].classList.add('on'); snd.beep(520 + i * 90); setTimeout(() => lamps[i].classList.remove('on'), 200); }, 300 + t));
    setTimeout(() => { beat.playing = false; $('beatTap').disabled = false; $('beatTap').focus(); $('fbMsg').textContent = 'Your turn: tap four times.'; }, 300 + at[3] + 350);
  });
  function beatTap(ev) {
    if (!beat || beat.playing) return;
    if (ev.isTrusted === false) beat.trusted = false;
    beat.taps.push(ev.timeStamp); const i = beat.taps.length - 1; lamps[i % 4].classList.add('on'); setTimeout(() => lamps[i % 4].classList.remove('on'), 160); snd.beep(520 + i * 90);
    if (beat.taps.length < 4) { $('fbMsg').textContent = `${beat.taps.length} of 4…`; return; }
    const u = [1, 2, 3].map((k) => beat.taps[k] - beat.taps[k - 1]);
    const err = u.reduce((a, x, k) => a + Math.abs(x - beat.iv[k]) / beat.iv[k], 0) / 3;
    const ok = beat.trusted && err <= 0.45 && err >= 0.008;
    $('beatPlay').disabled = false; $('beatTap').disabled = true;
    const trusted = beat.trusted; beat = null;
    if (ok) passFallback(`passed the beat game (timing error ${(err * 100).toFixed(0)}%). No drawing was analysed, so this path is weaker.`);
    else $('fbMsg').textContent = !trusted ? 'Those taps were scripted. Nice try.' : err < 0.008 ? 'Frighteningly exact. Humans are a little off. Play it again.' : 'Off the beat. Press play and have another go.';
  }
  $('beatTap').addEventListener('click', beatTap);
  document.addEventListener('keydown', (e) => { if (e.code === 'Space' && !fb.classList.contains('hidden') && beat && !beat.playing && !$('beatGame').classList.contains('hidden')) { e.preventDefault(); beatTap(e); } });

  function handGlyph(n, seed) {
    let s = ''; const r = Sy.rng(seed);
    for (let i = 0; i < n; i++) { const x = 20 + i * (60 / Math.max(1, n - 1 || 1)) * (n > 1 ? 1 : 0) + (n === 1 ? 30 : 0), top = 14 + r() * 14, w = Math.min(15, 60 / n - 3); s += `<rect x="${(x - w / 2 + 10).toFixed(1)}" y="${top.toFixed(1)}" width="${w.toFixed(1)}" height="${(52 - top).toFixed(1)}" rx="${(w / 2).toFixed(1)}" fill="#fffdf4" stroke="#1c1a17" stroke-width="2.6"/>`; }
    return `<svg viewBox="0 0 100 90" aria-hidden="true"><path d="M20 90 L24 56 C24 48 76 48 78 56 L82 90 Z" fill="#fffdf4" stroke="#1c1a17" stroke-width="2.6" transform="rotate(${(r() * 6 - 3).toFixed(1)} 50 70)"/>${s}</svg>`;
  }
  function buildOdd() {
    const base = 3 + rnd(3), odd = base + (Math.random() < 0.5 ? -1 : 1), oddIdx = rnd(6), grid = $('oddGrid'); grid.innerHTML = '';
    for (let i = 0; i < 6; i++) {
      const n = i === oddIdx ? odd : base, b = document.createElement('button'); b.type = 'button';
      b.setAttribute('aria-label', `Picture ${i + 1} of 6: a hand with ${n} fingers`); b.innerHTML = handGlyph(n, 100 + i * 7 + rnd(50));
      const born = performance.now();
      b.addEventListener('click', (ev) => {
        const quick = performance.now() - born < 350;
        if (i === oddIdx && ev.isTrusted && !quick) passFallback('picked the odd hand out. No drawing was analysed, so this path is weaker.');
        else { $('fbMsg').textContent = ev.isTrusted ? (quick ? 'Too quick. Take a proper look.' : 'Not that one. A fresh set is up.') : 'Scripted click. Cute.'; buildOdd(); }
      });
      grid.appendChild(b);
    }
  }

  // ───────────── debug hooks (used by tests, handy in the console) ─────────────
  window.PalmApp = {
    getStrokes: () => strokes, getLab: () => lab, getState: () => state, getPrompt: () => prompt,
    setStrokes: (s) => { strokes = s; redraw(); updateButtons(); }, submit, startRound,
    analyze: () => ({ shape: Sh.check(strokes, prompt), dyn: Sc.analyze(strokes) }),
  };

  // initial paint
  setMascot('idle'); resize(); updateButtons();
  requestAnimationFrame(resize);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { resize(); });
})();
