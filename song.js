// Turns a parsed MIDI file into a practice song: seconds-based notes split into hands,
// bars, chord names per half-bar, and easier left-hand arrangements. Pure — runs in Node too.

const SHARP = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const FLAT = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
export const noteName = (m, flats) => (flats ? FLAT : SHARP)[((m % 12) + 12) % 12];
export const octaveOf = m => Math.floor(m / 12) - 1;
export const isBlack = m => [1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);

function tempoMap(tempos, ppq) {
  const t = [...tempos].sort((a, b) => a.tick - b.tick);
  if (!t.length || t[0].tick > 0) t.unshift({ tick: 0, usPerQ: 500000 });
  const segs = [];
  let sec = 0;
  t.forEach((e, i) => {
    if (i > 0) sec += (e.tick - t[i - 1].tick) * t[i - 1].usPerQ / 1e6 / ppq;
    segs.push({ tick: e.tick, sec, spt: e.usPerQ / 1e6 / ppq });
  });
  return tick => {
    let s = segs[0];
    for (const g of segs) { if (g.tick <= tick) s = g; else break; }
    return s.sec + (tick - s.tick) * s.spt;
  };
}

function buildBars(timeSigs, ppq, lastTick) {
  const ts = [...timeSigs].filter(e => e.num > 0 && e.den > 0).sort((a, b) => a.tick - b.tick);
  if (!ts.length || ts[0].tick > 0) ts.unshift({ tick: 0, num: 4, den: 4 });
  const bars = [];
  let tick = 0, i = 0;
  while (tick <= lastTick && bars.length < 5000) {
    while (i + 1 < ts.length && ts[i + 1].tick <= tick) i++;
    const { num, den } = ts[i];
    const len = Math.round(ppq * 4 * num / den);
    bars.push({ tick, len, num, den });
    tick += len;
  }
  return bars;
}

// Decide which notes are right hand vs left hand: track names, then average pitch, then middle C.
function assignHands(notes, tracks) {
  const multiTrack = new Set(notes.map(n => n.track)).size > 1;
  const keyOf = multiTrack ? n => 't' + n.track : n => 'c' + n.ch;
  const keys = [...new Set(notes.map(keyOf))];
  const splitAtMiddleC = () => { for (const n of notes) n.hand = n.midi >= 60 ? 'R' : 'L'; return 'split'; };
  if (keys.length < 2) return splitAtMiddleC();

  const stats = keys.map(k => {
    const ns = notes.filter(n => keyOf(n) === k);
    return { k, avg: ns.reduce((s, n) => s + n.midi, 0) / ns.length, name: k[0] === 't' ? tracks[+k.slice(1)].name : '' };
  });
  const hand = new Map();
  for (const s of stats) {
    if (/left|\blh\b|bass/i.test(s.name)) hand.set(s.k, 'L');
    else if (/right|\brh\b|melody|treble/i.test(s.name)) hand.set(s.k, 'R');
  }
  if (stats.length === 2 && hand.size < 2) {
    const [hi, lo] = [...stats].sort((a, b) => b.avg - a.avg);
    if (!hand.has(hi.k)) hand.set(hi.k, hand.get(lo.k) === 'R' ? 'L' : 'R');
    if (!hand.has(lo.k)) hand.set(lo.k, hand.get(hi.k) === 'L' ? 'R' : 'L');
  } else {
    for (const s of stats) if (!hand.has(s.k)) hand.set(s.k, s.avg >= 60 ? 'R' : 'L');
  }
  if (new Set(hand.values()).size < 2) return splitAtMiddleC();
  for (const n of notes) n.hand = hand.get(keyOf(n));
  return 'tracks';
}

const QUALITIES = [['', [0, 4, 7]], ['m', [0, 3, 7]], ['dim', [0, 3, 6]], ['sus4', [0, 5, 7]], ['sus2', [0, 2, 7]], ['aug', [0, 4, 8]]];

// Name the chord in a span: left-hand pitches decide the chord; the melody breaks a tie
// between major and minor when the left hand only plays root + fifth.
export function recognize(lhWeights, bassPc, rhWeights) {
  const pcs = new Set(lhWeights.keys());
  if (!pcs.size) return null;
  let best = null;
  for (const r of pcs) {
    for (const [q, iv] of QUALITIES) {
      const tones = iv.map(i => (r + i) % 12);
      const have = tones.filter(t => pcs.has(t)).length;
      if (have < 3) continue;
      const extra = [...pcs].filter(p => !tones.includes(p)).length;
      const score = have * 10 - extra * 3 + (r === bassPc ? 6 : 0) + (q === '' || q === 'm' ? 2 : 0);
      if (!best || score > best.score) best = { score, root: r, q, tones, extra };
    }
  }
  if (best) return best;
  // No full triad in the left hand: root = bass, use the melody to pick major vs minor.
  const r = bassPc;
  const w = pc => (lhWeights.get(pc) || 0) + (rhWeights?.get(pc) || 0);
  const maj = w((r + 4) % 12), min = w((r + 3) % 12);
  if (maj > 0 || min > 0) {
    const q = maj >= min ? '' : 'm';
    return { root: r, q, tones: [r, (r + (q ? 3 : 4)) % 12, (r + 7) % 12], fromMelody: true };
  }
  return { root: r, q: '5', tones: [r, (r + 7) % 12] };
}

function weights(notes, start, end) {
  const w = new Map();
  for (const n of notes) {
    const ov = Math.min(n.endTick, end) - Math.max(n.startTick, start);
    if (ov > 0) w.set(n.midi % 12, (w.get(n.midi % 12) || 0) + ov);
  }
  return w;
}

function chordFor(lh, rh, start, end) {
  const inSpan = lh.filter(n => n.startTick < end && n.endTick > start);
  if (!inSpan.length) return null;
  const bass = Math.min(...inSpan.map(n => n.midi));
  return recognize(weights(inSpan, start, end), bass % 12, weights(rh, start, end));
}

export function buildSong(parsed, name = 'Song') {
  const { ppq } = parsed;
  const toSec = tempoMap(parsed.tempos, ppq);
  const notes = [];
  parsed.tracks.forEach((tr, ti) => tr.notes.forEach(n => notes.push({ ...n, track: ti })));
  if (!notes.length) throw new Error('This MIDI file has no notes in it.');
  const handSource = assignHands(notes, parsed.tracks);
  for (const n of notes) { n.start = toSec(n.startTick); n.end = toSec(n.endTick); }
  notes.sort((a, b) => a.start - b.start || a.midi - b.midi);

  const lastTick = Math.max(...notes.map(n => n.endTick));
  const bars = buildBars(parsed.timeSigs, ppq, lastTick).map((b, i) => ({ ...b, i, start: toSec(b.tick), end: toSec(b.tick + b.len) }));
  const flats = parsed.keySig ? parsed.keySig.sf < 0 : false;

  // Chord per bar; split into halves only when each half is clearly its own full chord.
  const lh = notes.filter(n => n.hand === 'L'), rh = notes.filter(n => n.hand === 'R');
  const slots = [];
  for (const b of bars) {
    const whole = chordFor(lh, rh, b.tick, b.tick + b.len);
    const halves = b.num >= 4 && b.num % 2 === 0 || (b.num === 6 && b.den === 8);
    // A clean major/minor triad over the whole bar means broken chords — keep one chord.
    const clean = whole && (whole.q === '' || whole.q === 'm') && !whole.extra && !whole.fromMelody;
    if (halves && whole && !clean) {
      const mid = b.tick + b.len / 2;
      const c1 = chordFor(lh, rh, b.tick, mid), c2 = chordFor(lh, rh, mid, b.tick + b.len);
      if (c1 && c2 && (c1.root !== c2.root || c1.q !== c2.q)) {
        slots.push({ bar: b.i, tick: b.tick, endTick: mid, chord: c1 }, { bar: b.i, tick: mid, endTick: b.tick + b.len, chord: c2 });
        continue;
      }
    }
    slots.push({ bar: b.i, tick: b.tick, endTick: b.tick + b.len, chord: whole });
  }
  for (const s of slots) {
    s.start = toSec(s.tick); s.end = toSec(s.endTick);
    if (s.chord) s.chord.name = noteName(s.chord.root, flats) + s.chord.q;
  }
  const firstTempo = [...parsed.tempos].sort((a, b) => a.tick - b.tick)[0];
  return {
    name, notes, bars, slots, flats, handSource,
    bpm: Math.round(60e6 / (firstTempo?.usPerQ || 500000)),
    duration: Math.max(...notes.map(n => n.end)),
  };
}

// Pick a voicing for a chord: root in the G2–F♯3 range, close position, triad only.
export function voice(chord, style) {
  const root = 43 + ((chord.root - 43 % 12 + 12) % 12);
  if (style === 'roots') return [root];
  return chord.tones.map(pc => root + ((pc - chord.root + 12) % 12)).sort((a, b) => a - b);
}

// The notes actually practiced, given the right/left hand styles.
export function arrange(song, { lh = 'chords', rh = 'written' } = {}) {
  let R = song.notes.filter(n => n.hand === 'R').map(n => ({ ...n }));
  if (rh === 'top') {
    const keep = [];
    for (const n of R) {
      const prev = keep[keep.length - 1];
      if (prev && Math.abs(prev.start - n.start) < 0.03) { if (n.midi > prev.midi) keep[keep.length - 1] = n; }
      else keep.push(n);
    }
    R = keep;
  }
  let L;
  if (lh === 'written') {
    L = song.notes.filter(n => n.hand === 'L').map(n => ({ ...n }));
  } else {
    L = [];
    let prev = null;
    for (const s of song.slots) {
      if (!s.chord) { prev = null; continue; }
      if (prev && prev.name === s.chord.name && prev.bar === s.bar) { for (const n of prev.notes) n.end = s.end; continue; }
      const ns = voice(s.chord, lh).map((m, i) => ({ midi: m, vel: 80, start: s.start, end: s.end, hand: 'L', chordName: i === 0 ? s.chord.name : null }));
      L.push(...ns);
      prev = { name: s.chord.name, bar: s.bar, notes: ns };
    }
    for (const n of L) n.end = Math.max(n.start + 0.08, n.end - 0.05); // a breath before re-striking
  }
  const all = [...R, ...L].sort((a, b) => a.start - b.start || a.midi - b.midi);
  all.forEach((n, i) => { n.id = i; });
  return all;
}

// Phrases: groups of N bars from the bar holding the first note to the bar holding the last.
export function makePhrases(song, barsPer = 4) {
  const firstStart = song.notes[0].start;
  const lastStart = Math.max(...song.notes.map(n => n.start));
  const barAt = t => Math.max(0, song.bars.findLastIndex(b => b.start <= t + 1e-6));
  const first = barAt(firstStart), last = barAt(lastStart);
  const out = [];
  for (let b = first; b <= last; b += barsPer) {
    const e = Math.min(b + barsPer - 1, last);
    out.push({ i: out.length, bar0: b, bar1: e, start: song.bars[b].start, end: song.bars[e].end });
  }
  return out;
}
