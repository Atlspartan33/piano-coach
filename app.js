import { parseMidi } from './midi.js';
import { buildSong, arrange, makePhrases, noteName, octaveOf, isBlack } from './song.js';
import { Synth, Sound } from './audio.js';
import { MidiIO } from './midiio.js';
import * as store from './store.js';

const $ = s => document.querySelector(s);
const SPEEDS = [0.5, 0.7, 0.85, 1];
const LEAD = 2.0;   // real seconds of falling notes before a phrase starts
const VIEW = 2.6;   // real seconds of notes visible above the line
const COL = {
  R: '#ffb547', L: '#5cc8ff', Rsoft: '#ffe2b3', Lsoft: '#c9ecff', Rring: '#a85a00', Lring: '#006aa3', ok: '#3ddc84', bad: '#ff6b6b',
  bg: '#121418', laneDark: '#0e1013', octave: '#232830', text: '#f2f2ee', muted: '#a6adb8', accent: '#c8ff3d',
};
const DISPLAY = '"Bahnschrift","Roboto Condensed","Arial Narrow",system-ui,sans-serif';
const BODY = 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
const pct = s => Math.round(s * 100) + '%';
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const MODES = {
  watch: ['Watch & listen', 'Both hands play by themselves, at your speed. Watch which keys light up, then switch to Wait.'],
  wait: ['Wait mode', 'The notes stop at the line until you press the right keys. No rushing, no wrong habits.'],
  play: ['Play along', "The song keeps moving. Hit each note as it reaches the line — this is the real-tempo test."],
};
const GUIDES = {
  full: '',
  fade: ' Notes fade out before the line, so your memory finishes the job.',
  memory: ' No notes shown — play from memory. Keys light up only if you stall.',
};
const LH_HELP = {
  roots: 'One note at a time — the chord’s root. Easiest.',
  chords: 'One three-note chord shape, held, each time the chord changes. Chord names shown.',
  written: 'Exactly what the arrangement plays.',
};

let prefs = store.loadPrefs();
let progress = store.loadProgress();
const savePrefs = () => store.savePrefs(prefs);

const synth = new Synth();
const io = new MidiIO({
  onNote: (on, m, v) => { if (sound.echo(m)) return; on ? userDown(m, v, 'piano') : userUp(m, 'piano'); },
  onPedal: () => pedal(),
  onChange: () => { renderMidi(); renderSpeeds(); },
});
const sound = new Sound(synth, io, () => prefs);

const S = {
  meta: null, song: null, notes: [], phrases: [], phrase: 0, range: null, inRange: [],
  targets: [], autos: [], groups: [], gi: 0, autoIdx: 0, autoActive: [], finishAt: 0,
  t: 0, state: 'idle', waitSince: 0, hint: false, hintGroup: -1,
  run: null, pressed: new Map(), restartTimer: 0, skipAsk: null, lo: 48, hi: 83,
};

/* ---------- song loading ---------- */
async function openSong(id) {
  try {
    let name, bytes;
    if (id === 'demo') {
      name = 'Ode to Joy (demo)';
      bytes = await (await fetch('demo/ode-to-joy.mid')).arrayBuffer();
    } else {
      const rec = await store.getSong(id);
      if (!rec) return openSong('demo');
      ({ name, bytes } = rec);
    }
    const song = buildSong(parseMidi(bytes), name);
    S.meta = { id, name };
    S.song = song;
    prefs.lastSong = id; savePrefs();
    S.phrase = prefs.phraseBySong[id] ?? 0;
    rebuild();
  } catch (e) {
    toast(e.message || "Couldn't open that song.", 'bad', 4000);
    if (id !== 'demo') openSong('demo');
  }
}

function rebuild() {
  stop();
  S.notes = arrange(S.song, prefs);
  S.phrases = makePhrases(S.song, prefs.phraseBars);
  if (S.phrase >= S.phrases.length) S.phrase = 0;
  keyRange();
  layout();
  prepare();
  renderAll();
  showIdleCard();
}

function keyRange() {
  let mn = Infinity, mx = -Infinity;
  for (const n of S.notes) { mn = Math.min(mn, n.midi); mx = Math.max(mx, n.midi); }
  let lo = mn - (mn % 12), hi = mx - (mx % 12) + 11;
  while (hi - lo + 1 < 36) { if (lo > 36) lo -= 12; if (hi - lo + 1 < 36) hi += 12; }
  S.lo = Math.max(24, lo); S.hi = Math.min(107, hi);
}

function currentRange() {
  if (S.phrase < 0) {
    const a = S.phrases[0], b = S.phrases.at(-1);
    return { start: a.start, end: b.end, bar0: a.bar0, bar1: b.bar1 };
  }
  const p = S.phrases[S.phrase];
  const from = prefs.chain && S.phrase > 0 ? S.phrases[S.phrase - 1] : p;
  return { start: from.start, end: p.end, bar0: from.bar0, bar1: p.bar1 };
}

// Reset a run: which notes you play, which the app plays, and the wait-mode stops.
function prepare() {
  const r = S.range = currentRange();
  const hands = prefs.hands === 'both' ? ['R', 'L'] : [prefs.hands];
  const watch = prefs.mode === 'watch';
  S.inRange = S.notes.filter(n => n.start >= r.start - 0.005 && n.start < r.end - 0.005);
  for (const n of S.notes) { n.hit = false; n.missed = false; n.target = false; }
  S.targets = watch ? [] : S.inRange.filter(n => hands.includes(n.hand));
  for (const n of S.targets) n.target = true;
  S.autos = S.inRange.filter(n => !n.target && (watch || prefs.otherHand));
  S.groups = [];
  for (const n of S.targets) {
    const g = S.groups.at(-1);
    if (g && n.start - g.time < 0.04) { g.notes.push(n); g.need.add(n.midi); }
    else S.groups.push({ time: n.start, notes: [n], need: new Set([n.midi]) });
  }
  for (const g of S.groups) g.pitches = new Set(g.need);
  const lastEnd = S.inRange.length ? Math.max(...S.inRange.map(n => n.end)) : r.end;
  S.finishAt = Math.min(r.end, lastEnd) + 0.15;
  S.gi = 0; S.autoIdx = 0; S.autoActive = []; S.waitSince = 0; S.hint = false; S.hintGroup = -1;
  S.t = r.start - LEAD * prefs.speed;
  S.run = { wrong: 0, hints: 0 };
  S.state = 'idle';
}

/* ---------- transport ---------- */
function start() {
  synth.ensure();
  clearTimeout(S.restartTimer);
  if (S.state === 'playing') return pause();
  if (S.state === 'done') prepare();
  S.state = 'playing';
  hideCard();
  renderStart();
}
function pause() {
  S.state = 'paused';
  releaseAutos();
  renderStart();
  showIdleCard(true);
}
function stop() { clearTimeout(S.restartTimer); releaseAutos(); S.state = 'idle'; }
function restart() { stop(); prepare(); start(); }
function releaseAutos() { for (const n of S.autoActive) sound.noteOff(n.midi); S.autoActive = []; }
function pedal() {
  if (S.state === 'playing') return;
  const primary = $('#cardActions .primary');
  primary ? primary.click() : start();
}

function step(dt, now) {
  const sp = prefs.speed;
  let nt = S.t + dt * sp, frozenAt = null;
  if (prefs.mode === 'wait') {
    const g = S.groups[S.gi];
    if (g && nt >= g.time) {
      nt = Math.max(S.t, g.time); frozenAt = g.time;
      if (!S.waitSince) S.waitSince = now;
      const after = { full: 0, fade: 1200, memory: 2500 }[prefs.guide];
      S.hint = now - S.waitSince >= after;
      if (S.hint && prefs.guide === 'memory' && S.hintGroup !== S.gi) { S.hintGroup = S.gi; S.run.hints++; }
    } else { S.waitSince = 0; S.hint = false; }
  }
  // The other hand waits with you: nothing at the stop line sounds until you play it.
  const limit = frozenAt !== null ? frozenAt - 0.002 : nt;
  while (S.autoIdx < S.autos.length && S.autos[S.autoIdx].start <= limit) {
    const n = S.autos[S.autoIdx++];
    sound.noteOn(n.midi, n.vel || 80);
    S.autoActive.push(n);
  }
  S.autoActive = S.autoActive.filter(n => (n.end <= nt ? (sound.noteOff(n.midi), false) : true));
  if (prefs.mode === 'play') {
    const win = 0.3 * sp;
    for (const n of S.targets) if (!n.hit && !n.missed && nt > n.start + win) n.missed = true;
  }
  S.t = nt;
  if (nt >= S.finishAt && (prefs.mode !== 'wait' || S.gi >= S.groups.length)) finish();
}

function userDown(m, vel, src) {
  if (src === 'screen') { synth.ensure(); sound.noteOn(m, vel); }
  const p = { ok: null };
  S.pressed.set(m, p);
  if (S.state !== 'playing' || prefs.mode === 'watch') return;
  const sp = prefs.speed;
  if (prefs.mode === 'wait') {
    const g = S.groups[S.gi];
    if (!g) return;
    const early = 0.6 * sp;
    if (g.need.has(m) && S.t >= g.time - early) {
      g.need.delete(m);
      for (const n of g.notes) if (n.midi === m) n.hit = true;
      p.ok = true;
      if (!g.need.size) { S.gi++; S.waitSince = 0; S.hint = false; }
    } else if (!g.pitches.has(m) && S.t >= S.range.start - early) {
      S.run.wrong++; p.ok = false;
    }
  } else {
    const win = 0.3 * sp;
    let best = null;
    for (const n of S.targets) {
      if (n.start > S.t + win) break;
      if (n.hit || n.midi !== m || Math.abs(n.start - S.t) > win) continue;
      if (!best || Math.abs(n.start - S.t) < Math.abs(best.start - S.t)) best = n;
    }
    if (best) { best.hit = true; best.missed = false; p.ok = true; }
    else if (S.t >= S.range.start - win) { S.run.wrong++; p.ok = false; }
  }
}
function userUp(m, src) {
  S.pressed.delete(m);
  if (src === 'screen') sound.noteOff(m);
}

/* ---------- progress ---------- */
const rangeKey = () => (S.phrase < 0 ? 'all' : `p${prefs.phraseBars}:${S.phrase}${prefs.chain && S.phrase > 0 ? 'c' : ''}`);
const handsKey = () => `${prefs.hands}|${prefs.lh}|${prefs.rh}`;
function prog() {
  const s = progress[S.meta.id] ||= {};
  const r = s[rangeKey()] ||= {};
  return r[handsKey()] ||= { clean: {}, full: false, memorized: false };
}
function peekProg() { return progress[S.meta.id]?.[rangeKey()]?.[handsKey()] || { clean: {} }; }
function speedUnlocked(sp) {
  const i = SPEEDS.indexOf(sp);
  if (i <= 0 || !io.hasInput()) return true;
  const c = peekProg().clean;
  return (c[SPEEDS[i - 1]] || 0) >= 3 || SPEEDS.slice(i).some(s => (c[s] || 0) > 0);
}
function phraseStatus(i) {
  const keys = [`p${prefs.phraseBars}:${i}`, `p${prefs.phraseBars}:${i}c`];
  const recs = keys.flatMap(k => Object.entries(progress[S.meta.id]?.[k] || {}));
  const both = recs.filter(([hk]) => hk.startsWith('both|'));
  if (both.some(([, r]) => r.memorized)) return ['★', 'memorized'];
  if (both.some(([, r]) => r.full)) return ['●', 'both hands at full speed'];
  if (recs.some(([, r]) => Object.values(r.clean).some(c => c > 0))) return ['◐', 'in progress'];
  return ['', 'new'];
}

function finish() {
  releaseAutos();
  S.state = 'done';
  renderStart();
  if (prefs.mode === 'watch') {
    if (prefs.loop) S.restartTimer = setTimeout(restart, 700); else showIdleCard();
    return;
  }
  const total = S.targets.length, hits = S.targets.filter(n => n.hit).length;
  const { wrong, hints } = S.run;
  const misses = total - hits;
  const clean = total > 0 && misses === 0 && wrong <= 1 && hints === 0;
  const sp = prefs.speed, i = SPEEDS.indexOf(sp);
  let unlocked = null, nextGuide = null, memorizedNow = false;
  if (clean) {
    const pr = prog();
    pr.clean[sp] = (pr.clean[sp] || 0) + 1;
    if (sp === 1) pr.full = true;
    if (sp === 1 && prefs.guide === 'memory' && !pr.memorized) { pr.memorized = true; memorizedNow = true; }
    if (pr.clean[sp] === 3 && i < SPEEDS.length - 1 && io.hasInput()) unlocked = SPEEDS[i + 1];
    if (sp === 1 && pr.clean[sp] % 3 === 0 && prefs.guide !== 'memory') nextGuide = prefs.guide === 'full' ? 'fade' : 'memory';
    store.saveProgress(progress);
  }
  renderPhrases(); renderSpeeds();
  const count = peekProg().clean[sp] || 0;
  const tally = count >= 3 ? `${count} clean at ${pct(sp)}` : `${count}/3 clean at ${pct(sp)}`;
  const msg = clean ? `Clean run ✓ ${tally}`
    : prefs.mode === 'wait' ? `${wrong} wrong note${wrong === 1 ? '' : 's'}${hints ? ' · used a hint' : ''} — again`
    : `${hits}/${total} notes · ${wrong} wrong — again`;
  const next = S.phrase >= 0 && S.phrase < S.phrases.length - 1;
  if (memorizedNow) {
    return showCard({
      eyebrow: `Phrase ${S.phrase + 1}`, title: 'Memorized ★', body: 'Full speed, no notes on screen. That one is yours.',
      actions: [
        next && { label: `Phrase ${S.phrase + 2}`, primary: true, fn: () => pickPhrase(S.phrase + 1) },
        { label: 'Again', fn: restart, primary: !next },
      ],
    });
  }
  if (unlocked) {
    return showCard({
      eyebrow: 'Unlocked', title: `${pct(unlocked)} speed`, body: `Three clean runs at ${pct(sp)}. Step up, or stay for one more.`,
      actions: [{ label: `Go ${pct(unlocked)}`, primary: true, fn: () => { setPref('speed', unlocked); start(); } }, { label: `Again at ${pct(sp)}`, fn: restart }],
    });
  }
  if (nextGuide) {
    return showCard({
      eyebrow: 'Full speed, clean', title: nextGuide === 'fade' ? 'Now fade the notes' : 'Now from memory',
      body: nextGuide === 'fade' ? 'Notes will disappear before the line. Your hands remember more than you think.' : 'Hide the notes completely. Keys only light up if you stall.',
      actions: [{ label: nextGuide === 'fade' ? 'Fade notes' : 'Memory mode', primary: true, fn: () => { setPref('guide', nextGuide); start(); } }, { label: 'Again as is', fn: restart }],
    });
  }
  if (prefs.loop) {
    toast(msg, clean ? 'good' : 'bad', 1600);
    S.restartTimer = setTimeout(restart, 1700);
  } else {
    showCard({
      eyebrow: clean ? 'Nice' : 'Keep going', title: clean ? 'Clean run' : 'Again', body: msg,
      actions: [{ label: 'Again', primary: true, fn: restart }, next && { label: 'Next phrase', fn: () => pickPhrase(S.phrase + 1) }],
    });
  }
}

/* ---------- prefs + UI ---------- */
function parseVal(key, v) {
  if (key === 'speed' || key === 'phraseBars') return +v;
  if (key === 'otherHand') return v === 'true';
  return v;
}
function choose(key, v) {
  if (key === 'speed' && !speedUnlocked(v) && S.skipAsk !== v) {
    S.skipAsk = v;
    const prev = SPEEDS[SPEEDS.indexOf(v) - 1];
    toast(`3 clean runs at ${pct(prev)} unlock ${pct(v)} (${peekProg().clean[prev] || 0}/3). Tap again to skip ahead.`, 'bad', 3800);
    return;
  }
  S.skipAsk = null;
  setPref(key, v);
}
function setPref(key, v) {
  prefs[key] = v; savePrefs();
  if (key === 'phraseBars') S.phrase = 0;
  if (['lh', 'rh', 'phraseBars'].includes(key)) return rebuild();
  stop(); prepare(); renderAll(); showIdleCard();
}
function pickPhrase(i) {
  S.phrase = i;
  prefs.phraseBySong[S.meta.id] = i; savePrefs();
  stop(); prepare(); renderAll(); showIdleCard();
}

function renderSegs() {
  document.querySelectorAll('.seg[data-pref]').forEach(seg => {
    const key = seg.dataset.pref;
    seg.querySelectorAll('button[data-v]').forEach(b => b.setAttribute('aria-checked', String(parseVal(key, b.dataset.v) === prefs[key])));
  });
  $('#lhHelp').textContent = LH_HELP[prefs.lh];
}
function renderSpeeds() {
  if (!S.meta) return;
  $('#speedSeg').querySelectorAll('button').forEach(b => {
    const locked = !speedUnlocked(+b.dataset.v);
    b.classList.toggle('locked', locked);
    b.setAttribute('aria-label', `${b.textContent}${locked ? ', locked' : ''}`);
  });
}
function renderPhrases() {
  const list = $('#phraseList');
  list.textContent = '';
  const mk = (label, sub, aria, i, cls = '') => {
    const b = document.createElement('button');
    b.className = 'ph ' + cls;
    b.setAttribute('aria-pressed', String(S.phrase === i));
    b.setAttribute('aria-label', aria);
    b.innerHTML = `<span class="n">${label}</span><span class="s" aria-hidden="true">${sub}</span>`;
    b.onclick = () => pickPhrase(i);
    list.append(b);
    return b;
  };
  S.phrases.forEach((p, i) => {
    const [glyph, text] = phraseStatus(i);
    mk(i + 1, glyph, `Phrase ${i + 1}, bars ${p.bar0 + 1} to ${p.bar1 + 1}, ${text}`, i);
  });
  mk('All', '', 'Whole song', -1, 'all');
  list.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  $('#prevPh').disabled = S.phrase <= 0;
  $('#nextPh').disabled = S.phrase < 0 || S.phrase >= S.phrases.length - 1;
}
function renderMidi() {
  const chip = $('#midiChip'), text = $('#midiText');
  let state = 'off', label = 'Connect piano';
  if (!io.supported) label = 'No MIDI in this browser';
  else if (io.error) label = 'Allow MIDI to connect';
  else if (io.access && !io.hasInput()) { state = 'wait'; label = 'Plug in the piano (USB)'; }
  else if (io.hasInput()) { state = 'on'; label = 'Piano connected'; }
  chip.dataset.state = state;
  text.textContent = label;
}
function renderStart() {
  $('#startBtn').textContent = S.state === 'playing' ? 'Pause' : S.state === 'paused' ? 'Resume' : 'Start';
}
function renderAll() {
  if (!S.meta) return;
  $('#songName').textContent = S.meta.name;
  $('#loopT').setAttribute('aria-pressed', String(prefs.loop));
  $('#chainT').setAttribute('aria-pressed', String(prefs.chain));
  $('#chainT').disabled = S.phrase <= 0;
  renderSegs(); renderSpeeds(); renderPhrases(); renderMidi(); renderStart();
}

function showIdleCard(paused = false) {
  if (!S.meta) return;
  const r = S.range;
  const where = S.phrase < 0 ? 'Whole song'
    : prefs.chain && S.phrase > 0 ? `Phrases ${S.phrase}–${S.phrase + 1} chained` : `Phrase ${S.phrase + 1} of ${S.phrases.length}`;
  const [title, text] = MODES[prefs.mode];
  const hands = { R: 'Right hand', L: 'Left hand', both: 'Both hands' }[prefs.hands];
  const count = peekProg().clean[prefs.speed] || 0;
  const meta = prefs.mode === 'watch' ? `${pct(prefs.speed)} speed`
    : `${hands} · ${pct(prefs.speed)} · clean runs here: ${count}/3`;
  let body = text + (prefs.mode === 'watch' ? '' : GUIDES[prefs.guide]);
  if (prefs.mode !== 'watch' && !io.hasInput()) body += ' Connect the piano so the app can hear you — or tap the keys on screen.';
  const tip = io.hasInput() ? ' Tip: tap the sustain pedal to start.' : '';
  const legend = S.phrases.some((_, i) => phraseStatus(i)[0]) ? ' · Phrases: ◐ practising, ● full speed, ★ memorized' : '';
  showCard({ eyebrow: `${where} · bars ${r.bar0 + 1}–${r.bar1 + 1}`, title: paused ? 'Paused' : title, body, meta: meta + tip + legend });
}
function showCard({ eyebrow = '', title = '', body = '', meta = '', actions = [] }) {
  $('#cardEyebrow').textContent = eyebrow;
  $('#cardTitle').textContent = title;
  $('#cardBody').textContent = body;
  $('#cardMeta').textContent = meta;
  const box = $('#cardActions');
  box.textContent = '';
  for (const a of actions.filter(Boolean)) {
    const b = document.createElement('button');
    b.className = a.primary ? 'primary' : 'ghost';
    b.textContent = a.label;
    b.onclick = () => { hideCard(); a.fn(); };
    box.append(b);
  }
  // One primary action at a time: when the card offers its own, the footer Start steps back.
  $('#startBtn').classList.toggle('demoted', !!box.childElementCount);
  $('#card').hidden = false;
}
function hideCard() { $('#card').hidden = true; $('#startBtn').classList.remove('demoted'); }
let toastT;
function toast(msg, kind = '', ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show ${kind}`;
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.className = 'toast'; }, ms);
}

/* ---------- drawing ---------- */
const cv = $('#cv'), ctx = cv.getContext('2d');
const G = { W: 0, H: 0, dpr: 1, laneH: 0, kbH: 0, keys: new Map() };
function layout() {
  const rect = cv.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  Object.assign(G, { W: rect.width, H: rect.height, dpr });
  cv.width = Math.round(rect.width * dpr); cv.height = Math.round(rect.height * dpr);
  G.kbH = Math.round(clamp(G.H * 0.27, 96, 180));
  G.laneH = G.H - G.kbH;
  const whites = [];
  for (let m = S.lo; m <= S.hi; m++) if (!isBlack(m)) whites.push(m);
  const ww = G.W / whites.length, bw = ww * 0.62;
  G.keys.clear();
  whites.forEach((m, i) => G.keys.set(m, { x: i * ww, w: ww, black: false }));
  for (let m = S.lo; m <= S.hi; m++) if (isBlack(m)) G.keys.set(m, { x: G.keys.get(m - 1).x + ww - bw / 2, w: bw, black: true });
  G.ww = ww;
}
function rr(x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
}

function draw(now) {
  const { W, H, laneH, dpr } = G;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = COL.bg;
  ctx.fillRect(0, 0, W, H);
  if (!S.song || !W) return;
  const sp = prefs.speed, t = S.t;
  const pps = laneH / (VIEW * sp);
  const y = time => laneH - (time - t) * pps;
  const tTop = t + VIEW * sp;

  for (const [m, k] of G.keys) {
    if (k.black) { ctx.fillStyle = COL.laneDark; ctx.fillRect(k.x, 0, k.w, laneH); }
    else if (m % 12 === 0) { ctx.fillStyle = COL.octave; ctx.fillRect(Math.round(k.x), 0, 1, laneH); }
  }
  ctx.font = `600 12px ${BODY}`;
  ctx.textAlign = 'right';
  for (const b of S.song.bars) {
    if (b.start < t - 0.2 || b.start > tTop) continue;
    const yy = Math.round(y(b.start));
    const inR = b.start >= S.range.start - 1e-3 && b.start <= S.range.end + 1e-3;
    ctx.fillStyle = inR ? '#3a404b' : '#22262d';
    ctx.fillRect(0, yy, W, 1);
    if (inR) { ctx.fillStyle = COL.muted; ctx.fillText(`bar ${b.i + 1}`, W - 8, yy - 5); }
  }

  const guide = prefs.mode === 'watch' ? 'full' : prefs.guide;
  if (guide !== 'memory') {
    for (const n of S.inRange) {
      if (n.end < t - 0.05 || n.start > tTop) continue;
      const k = G.keys.get(n.midi);
      if (!k) continue;
      const yb = y(n.start), yt = Math.max(-8, y(n.end));
      const mine = n.target || prefs.mode === 'watch';
      let alpha = mine ? 1 : 0.38;
      if (guide === 'fade' && n.target) alpha *= clamp(((laneH - yb) / laneH - 0.18) / 0.35, 0, 1);
      if (alpha <= 0.02) continue;
      ctx.globalAlpha = alpha;
      const pad = k.black ? 1 : 3, x = k.x + pad, w = k.w - pad * 2, h = Math.max(8, yb - yt);
      rr(x, yb - h, w, h, Math.min(6, w / 3));
      ctx.fillStyle = n.missed ? '#4a3434' : COL[n.hand];
      ctx.fill();
      if (n.hit) { ctx.lineWidth = 3; ctx.strokeStyle = '#ffffff'; ctx.stroke(); }
      else if (n.missed) { ctx.lineWidth = 2; ctx.strokeStyle = COL.bad; ctx.stroke(); }
      if (h >= 20 && w >= 11) {
        ctx.fillStyle = n.missed ? '#ffc2c2' : '#14161c';
        ctx.font = `800 ${Math.round(clamp(w * 0.5, 10, 15))}px ${DISPLAY}`;
        ctx.textAlign = 'center';
        ctx.fillText(noteName(n.midi, S.song.flats), x + w / 2, yb - 6);
      }
      if (n.chordName && yb > 0) {
        ctx.font = `800 15px ${DISPLAY}`;
        const tw = ctx.measureText(n.chordName).width + 14;
        let px = x - tw - 6;
        if (px < 2) px = x;
        rr(px, yb - 26, tw, 22, 11);
        ctx.fillStyle = '#0b2230'; ctx.fill();
        ctx.lineWidth = 1.5; ctx.strokeStyle = COL.L; ctx.stroke();
        ctx.fillStyle = COL.Lsoft; ctx.textAlign = 'center';
        ctx.fillText(n.chordName, px + tw / 2, yb - 10);
      }
      ctx.globalAlpha = 1;
    }
  } else if (S.state !== 'playing') {
    ctx.fillStyle = COL.muted; ctx.textAlign = 'center'; ctx.font = `700 15px ${BODY}`;
    ctx.fillText('Memory mode — notes are hidden', W / 2, laneH - 24);
  }

  ctx.fillStyle = 'rgba(242,242,238,.4)';
  ctx.fillRect(0, laneH - 2, W, 2);
  if (guide !== 'memory') drawChordBanner(t);
  const frac = clamp((t - S.range.start) / (S.range.end - S.range.start), 0, 1);
  ctx.fillStyle = COL.accent;
  ctx.fillRect(0, 0, W * frac, 4);
  drawKeyboard(now);
}

function drawChordBanner(t) {
  const at = Math.max(t, S.range.start);
  const slots = S.song.slots;
  const i = slots.findIndex(s => s.start <= at + 1e-3 && at < s.end);
  if (i < 0 || !slots[i].chord) return;
  const now = slots[i].chord.name;
  const nextSlot = slots.slice(i + 1).find(s => s.chord && s.chord.name !== now && s.start < S.range.end);
  ctx.textAlign = 'left';
  ctx.font = `700 11px ${BODY}`;
  const label = 'CHORD';
  ctx.font = `800 40px ${DISPLAY}`;
  const w1 = ctx.measureText(now).width;
  ctx.font = `700 15px ${BODY}`;
  const nextText = nextSlot ? `next ${nextSlot.chord.name}` : '';
  const w2 = ctx.measureText(nextText).width;
  const bw = Math.max(w1, w2, 50) + 28;
  rr(12, 14, bw, nextText ? 92 : 72, 14);
  ctx.fillStyle = 'rgba(18,20,24,.82)'; ctx.fill();
  ctx.fillStyle = COL.muted; ctx.font = `700 11px ${BODY}`; ctx.fillText(label, 26, 34);
  ctx.fillStyle = COL.L; ctx.font = `800 40px ${DISPLAY}`; ctx.fillText(now, 26, 72);
  if (nextText) { ctx.fillStyle = COL.muted; ctx.font = `700 15px ${BODY}`; ctx.fillText(nextText, 26, 94); }
}

function keyStates(now) {
  const map = new Map();
  if (S.state === 'playing' && prefs.mode === 'wait' && S.hint) {
    const g = S.groups[S.gi];
    if (g) for (const n of g.notes) if (g.need.has(n.midi)) map.set(n.midi, { fill: COL[n.hand + 'soft'], hand: n.hand, pulse: true });
  }
  if (prefs.guide === 'full' || prefs.mode === 'watch') {
    for (const n of S.targets) if (n.start <= S.t && S.t < n.end && !map.has(n.midi)) map.set(n.midi, { fill: COL[n.hand + 'soft'], hand: n.hand });
  }
  for (const n of S.autoActive) map.set(n.midi, { fill: COL[n.hand], hand: n.hand });
  for (const [m, p] of S.pressed) map.set(m, { fill: p.ok === true ? COL.ok : p.ok === false ? COL.bad : '#c7cfdb', mark: p.ok === false ? '✕' : p.ok ? '✓' : '' });
  return map;
}

function drawKeyboard(now) {
  const { laneH: top, kbH } = G;
  const lit = keyStates(now);
  const pulse = 0.5 + 0.5 * Math.sin(now / 160);
  ctx.textAlign = 'center';
  for (const [m, k] of G.keys) {
    if (k.black) continue;
    const st = lit.get(m);
    rr(k.x + 1, top + 1, k.w - 2, kbH - 3, [0, 0, 6, 6]);
    ctx.fillStyle = st?.fill || '#f4f1ea';
    ctx.fill();
    // Pale fills alone barely differ from an unlit key, so every lit white key gets a dark ring.
    if (st?.hand) {
      rr(k.x + 3, top + 3, k.w - 6, kbH - 7, [0, 0, 5, 5]);
      ctx.lineWidth = st.pulse ? 3 + 2 * pulse : 4;
      ctx.strokeStyle = COL[st.hand + 'ring'];
      ctx.stroke();
    }
    const fs = Math.round(clamp(k.w * 0.42, 9, 16));
    ctx.font = `800 ${fs}px ${DISPLAY}`;
    ctx.fillStyle = st ? '#14161c' : '#3c414a';
    ctx.fillText(noteName(m, S.song.flats) + (m % 12 === 0 ? octaveOf(m) : ''), k.x + k.w / 2, top + kbH - 10);
    if (m === 60) { ctx.beginPath(); ctx.arc(k.x + k.w / 2, top + kbH - 14 - fs - 4, 3, 0, Math.PI * 2); ctx.fillStyle = '#3c414a'; ctx.fill(); }
    if (st?.mark) { ctx.font = `800 ${fs + 4}px ${BODY}`; ctx.fillStyle = '#14161c'; ctx.fillText(st.mark, k.x + k.w / 2, top + kbH * 0.72); }
  }
  for (const [m, k] of G.keys) {
    if (!k.black) continue;
    const st = lit.get(m), bh = kbH * 0.62;
    rr(k.x, top, k.w, bh, [0, 0, 4, 4]);
    ctx.fillStyle = st?.fill || '#1d2026';
    ctx.fill();
    if (st?.pulse) { ctx.lineWidth = 2 + 3 * pulse; ctx.strokeStyle = COL[st.hand]; ctx.stroke(); }
    if (k.w >= 15) {
      ctx.font = `700 ${Math.round(clamp(k.w * 0.4, 8, 12))}px ${DISPLAY}`;
      ctx.fillStyle = st ? '#14161c' : '#b5bcc6';
      ctx.fillText(noteName(m, S.song.flats), k.x + k.w / 2, top + bh - 8);
    }
    if (st?.mark) { ctx.font = `800 13px ${BODY}`; ctx.fillStyle = '#14161c'; ctx.fillText(st.mark, k.x + k.w / 2, top + bh * 0.45); }
  }
  ctx.fillStyle = '#000';
  ctx.fillRect(0, top, G.W, 2);
}

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (S.state === 'playing') step(dt, now);
  draw(now);
  requestAnimationFrame(frame);
}

/* ---------- input ---------- */
const pointers = new Map();
function keyAt(x, yPos) {
  if (yPos < G.laneH) return null;
  const yy = yPos - G.laneH;
  if (yy < G.kbH * 0.62) for (const [m, k] of G.keys) if (k.black && x >= k.x && x < k.x + k.w) return m;
  for (const [m, k] of G.keys) if (!k.black && x >= k.x && x < k.x + k.w) return m;
  return null;
}
cv.addEventListener('pointerdown', e => {
  const m = keyAt(e.offsetX, e.offsetY);
  if (m == null) { start(); return; } // tap the falling-notes area to start/pause
  cv.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, m);
  userDown(m, 90, 'screen');
});
cv.addEventListener('pointermove', e => {
  if (!pointers.has(e.pointerId)) return;
  const m = keyAt(e.offsetX, e.offsetY), old = pointers.get(e.pointerId);
  if (m != null && m !== old) { userUp(old, 'screen'); pointers.set(e.pointerId, m); userDown(m, 90, 'screen'); }
});
const lift = e => { const m = pointers.get(e.pointerId); if (m == null) return; pointers.delete(e.pointerId); userUp(m, 'screen'); };
cv.addEventListener('pointerup', lift);
cv.addEventListener('pointercancel', lift);

document.querySelectorAll('.seg[data-pref]').forEach(seg => seg.addEventListener('click', e => {
  const b = e.target.closest('button[data-v]');
  if (b) choose(seg.dataset.pref, parseVal(seg.dataset.pref, b.dataset.v));
}));
$('#startBtn').onclick = () => start();
$('#restartBtn').onclick = () => restart();
$('#prevPh').onclick = () => S.phrase > 0 && pickPhrase(S.phrase - 1);
$('#nextPh').onclick = () => S.phrase < S.phrases.length - 1 && pickPhrase(S.phrase + 1);
$('#loopT').onclick = () => { prefs.loop = !prefs.loop; savePrefs(); renderAll(); };
$('#chainT').onclick = () => { prefs.chain = !prefs.chain; savePrefs(); stop(); prepare(); renderAll(); showIdleCard(); };
$('#midiChip').onclick = async () => {
  if (!io.supported) return toast('This browser can’t talk to a piano. Use Chrome on Android or a computer.', 'bad', 4500);
  if (!io.access || io.error) {
    const ok = await io.connect();
    if (!ok) return toast('MIDI permission was blocked. Allow it in the site settings, then tap again.', 'bad', 4500);
  }
  if (!io.hasInput()) toast('Plug the piano’s USB “to Host” port into the tablet with a USB-B to USB-C cable.', '', 5000);
  else toast(`Hearing ${io.name()}`, 'good');
  if (S.state !== 'playing') showIdleCard();
};
document.addEventListener('keydown', e => {
  if (e.target.closest('dialog, button')) return;
  if (e.code === 'Space') { e.preventDefault(); start(); }
});
document.addEventListener('visibilitychange', () => { if (document.hidden && S.state === 'playing') pause(); });
new ResizeObserver(() => layout()).observe($('#stage'));

/* ---------- sheets ---------- */
document.querySelectorAll('dialog').forEach(d => {
  d.addEventListener('click', e => { if (e.target === d || e.target.closest('[data-close]')) d.close(); });
});
$('#settingsBtn').onclick = () => { if (S.state === 'playing') pause(); renderSegs(); $('#settings').showModal(); };
$('#songBtn').onclick = () => { if (S.state === 'playing') pause(); openLibrary(); };

async function openLibrary() {
  const list = $('#songList');
  const songs = [{ id: 'demo', name: 'Ode to Joy (demo)', sub: 'Built-in · Beethoven · for trying things out' },
    ...(await store.listSongs().catch(() => [])).map(s => ({ ...s, sub: `Added ${new Date(s.addedAt).toLocaleDateString()}` }))];
  list.textContent = '';
  for (const s of songs) {
    const li = document.createElement('li');
    const pick = document.createElement('button');
    pick.className = 'song-pick';
    if (S.meta?.id === s.id) pick.setAttribute('aria-current', 'true');
    pick.innerHTML = '<span class="t"></span><span class="sub"></span>';
    pick.querySelector('.t').textContent = s.name;
    pick.querySelector('.sub').textContent = s.sub;
    pick.onclick = () => { $('#library').close(); openSong(s.id); };
    li.append(pick);
    if (s.id !== 'demo') {
      const del = document.createElement('button');
      del.className = 'ghost';
      del.textContent = 'Delete';
      del.setAttribute('aria-label', `Delete ${s.name}`);
      del.onclick = async () => {
        if (del.dataset.armed !== '1') { del.dataset.armed = '1'; del.textContent = 'Sure?'; del.classList.add('danger'); return; }
        await store.deleteSong(s.id);
        if (S.meta?.id === s.id) openSong('demo');
        openLibrary();
      };
      li.append(del);
    }
    list.append(li);
  }
  if (!$('#library').open) $('#library').showModal();
}

$('#fileIn').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const bytes = await file.arrayBuffer();
    const name = file.name.replace(/\.(mid|midi)$/i, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() || 'My song';
    const song = buildSong(parseMidi(bytes), name);
    const id = 's' + Date.now();
    await store.putSong({ id, name, bytes, addedAt: Date.now() });
    $('#library').close();
    await openSong(id);
    toast(`Added “${name}” — ${makePhrases(song, prefs.phraseBars).length} phrases, ${song.bpm} bpm`, 'good', 3500);
  } catch (err) {
    toast(err.message || "Couldn't read that file.", 'bad', 4500);
  }
});

$('#resetBtn').onclick = e => {
  const b = e.currentTarget;
  if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Tap again to erase this song’s progress'; b.classList.add('danger'); return; }
  delete progress[S.meta.id];
  store.saveProgress(progress);
  b.dataset.armed = ''; b.textContent = 'Reset progress for this song'; b.classList.remove('danger');
  renderAll();
  toast('Progress reset');
};
$('#settings').addEventListener('close', () => {
  const b = $('#resetBtn');
  b.dataset.armed = ''; b.textContent = 'Reset progress for this song'; b.classList.remove('danger');
});

/* ---------- boot ---------- */
window.__pc = { S, prefs: () => prefs, down: m => userDown(m, 90, 'piano'), up: m => userUp(m, 'piano'), io };
layout();
requestAnimationFrame(frame);
openSong(prefs.lastSong || 'demo');
io.autoConnect();
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
