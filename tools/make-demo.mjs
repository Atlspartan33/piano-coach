// Writes demo/ode-to-joy.mid — Beethoven (public domain), two hands in D major, 100 bpm.
// Right hand = melody; left hand = a broken-chord pattern so "Simple chords" has something to simplify.
import { writeFileSync, mkdirSync } from 'node:fs';

const PPQ = 480;
const A = [66, 66, 67, 69], B = [69, 67, 66, 64], C = [62, 62, 64, 66];
const q = ms => ms.map(m => [m, 1]);
const melody = [
  ...q(A), ...q(B), ...q(C), [66, 1.5], [64, 0.5], [64, 2],
  ...q(A), ...q(B), ...q(C), [64, 1.5], [62, 0.5], [62, 2],
  ...q([64, 64, 66, 62]), [64, 1], [66, 0.5], [67, 0.5], [66, 1], [62, 1],
  [64, 1], [66, 0.5], [67, 0.5], [66, 1], [64, 1], [62, 1], [64, 1], [57, 2],
  ...q(A), ...q(B), ...q(C), [64, 1.5], [62, 0.5], [62, 2],
];
const D = [50, 57, 54, 57], Am = [45, 52, 49, 52], AD = [45, 52, 50, 57];
const bars = [D, Am, D, Am, D, Am, D, AD, Am, D, Am, Am, D, Am, D, AD];

function vlq(n) { const b = [n & 0x7f]; while ((n >>= 7)) b.unshift((n & 0x7f) | 0x80); return b; }
const u32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const chunk = (id, data) => [...[...id].map(c => c.charCodeAt(0)), ...u32(data.length), ...data];
const text = (type, s) => [0xff, type, ...vlq(s.length), ...[...s].map(c => c.charCodeAt(0))];

function track(name, notes, extra = []) {
  const ev = [{ tick: 0, order: 0, data: text(0x03, name) }, ...extra];
  for (const [m, start, dur] of notes) {
    ev.push({ tick: Math.round(start * PPQ), order: 2, data: [0x90, m, 84] });
    ev.push({ tick: Math.round((start + dur) * PPQ) - 10, order: 1, data: [0x80, m, 0] });
  }
  ev.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const out = [];
  let last = 0;
  for (const e of ev) { out.push(...vlq(e.tick - last), ...e.data); last = e.tick; }
  out.push(0, 0xff, 0x2f, 0);
  return chunk('MTrk', out);
}

let beat = 0;
const rh = melody.map(([m, d]) => { const n = [m, beat, d]; beat += d; return n; });
const lh = bars.flatMap((pat, bi) => pat.map((m, i) => [m, bi * 4 + i, 1]));
const meta = [
  { tick: 0, order: 0, data: [0xff, 0x51, 3, ...u32(Math.round(60e6 / 100)).slice(1)] },
  { tick: 0, order: 0, data: [0xff, 0x58, 4, 4, 2, 24, 8] },
  { tick: 0, order: 0, data: [0xff, 0x59, 2, 2, 0] },
];
const file = [
  ...chunk('MThd', [0, 1, 0, 3, (PPQ >> 8) & 255, PPQ & 255]),
  ...track('Tempo', [], meta),
  ...track('Right Hand', rh),
  ...track('Left Hand', lh),
];
mkdirSync(new URL('../demo/', import.meta.url), { recursive: true });
writeFileSync(new URL('../demo/ode-to-joy.mid', import.meta.url), Buffer.from(file));
console.log(`demo/ode-to-joy.mid: ${rh.length} RH notes, ${lh.length} LH notes, ${beat / 4} bars`);
