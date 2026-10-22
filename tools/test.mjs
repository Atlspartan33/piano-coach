// node tools/test.mjs — checks the MIDI parser + song logic against the demo file.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { parseMidi } from '../midi.js';
import { buildSong, arrange, makePhrases, recognize } from '../song.js';

const bytes = readFileSync(new URL('../demo/ode-to-joy.mid', import.meta.url));
const parsed = parseMidi(bytes);
assert.equal(parsed.ppq, 480);
assert.equal(parsed.tracks.length, 3);
assert.deepEqual(parsed.keySig, { sf: 2, minor: false });

const song = buildSong(parsed, 'Ode');
assert.equal(song.handSource, 'tracks');
assert.equal(song.bpm, 100);
assert.equal(song.bars.length, 16);
assert.ok(Math.abs(song.bars[1].start - 2.4) < 1e-6, 'bar 2 starts at 2.4s at 100 bpm');
assert.equal(song.notes.filter(n => n.hand === 'R').length, 62);
assert.equal(song.notes.filter(n => n.hand === 'L').length, 64);

const names = song.slots.map(s => s.chord?.name).join(' ');
console.log('chords:', names);
assert.equal(song.slots[0].chord.name, 'D');
assert.equal(song.slots[1].chord.name, 'A');
const bar8 = song.slots.filter(s => s.bar === 7).map(s => s.chord.name[0]);
assert.deepEqual(bar8, ['A', 'D'], 'a mid-bar bass change splits the bar into two chords');

const easy = arrange(song, { lh: 'chords' });
const easyL = easy.filter(n => n.hand === 'L');
assert.ok(easyL.length < 64, 'simple chords has fewer LH notes than broken chords');
assert.deepEqual(easyL.filter(n => n.start === 0).map(n => n.midi), [50, 54, 57], 'D triad D3 F#3 A3');
const roots = arrange(song, { lh: 'roots' }).filter(n => n.hand === 'L');
assert.ok(roots.every((n, i, a) => i === 0 || n.start !== a[i - 1].start), 'roots = one note at a time');

const ph = makePhrases(song, 4);
assert.equal(ph.length, 4);
assert.equal(ph[1].bar0, 4);

// Single-track file: split at middle C.
const single = { ...parsed, tracks: [{ name: 'Piano', notes: parsed.tracks.flatMap(t => t.notes) }] };
const s2 = buildSong(single, 'one');
assert.equal(s2.handSource, 'split');
assert.ok(s2.notes.filter(n => n.hand === 'L').every(n => n.midi < 60));

// Major/minor from melody when LH is only root + fifth.
const lhW = new Map([[2, 1], [9, 1]]);
assert.equal(recognize(lhW, 2, new Map([[5, 1]])).q, 'm');
assert.equal(recognize(lhW, 2, new Map([[6, 1]])).q, '');
assert.equal(recognize(lhW, 2, new Map()).q, '5');

console.log('ok — all song tests pass');
