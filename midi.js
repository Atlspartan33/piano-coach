// Dependency-free Standard MIDI File parser.
// Returns { ppq, tracks: [{ name, notes: [{ midi, vel, ch, startTick, endTick }] }], tempos, timeSigs, keySig }
export function parseMidi(buf) {
  const d = new DataView(buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  let p = 0;
  const str = n => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(d.getUint8(p + i)); p += n; return s; };
  const u32 = () => { const v = d.getUint32(p); p += 4; return v; };
  const u16 = () => { const v = d.getUint16(p); p += 2; return v; };
  const vlq = () => { let v = 0, b; do { b = d.getUint8(p++); v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; };

  if (d.byteLength < 14 || str(4) !== 'MThd') throw new Error("That file isn't a MIDI file (.mid).");
  const hlen = u32(); u16(); const ntr = u16(); const div = u16();
  p = 8 + hlen;
  if (div & 0x8000) throw new Error('This MIDI file uses SMPTE timing, which isn\'t supported.');

  const tempos = [], timeSigs = [], tracks = [];
  let keySig = null;
  for (let t = 0; t < ntr && p + 8 <= d.byteLength; t++) {
    const id = str(4), len = u32(), end = Math.min(p + len, d.byteLength);
    if (id !== 'MTrk') { p = end; continue; }
    let tick = 0, status = 0, name = '';
    const open = new Map(), notes = [];
    while (p < end) {
      tick += vlq();
      const b = d.getUint8(p);
      if (b & 0x80) { status = b; p++; }
      else if (!status) throw new Error('This MIDI file looks damaged.');
      if (status === 0xff) {
        const type = d.getUint8(p++), l = vlq(), s = p;
        if (type === 0x51 && l >= 3) tempos.push({ tick, usPerQ: (d.getUint8(s) << 16) | (d.getUint8(s + 1) << 8) | d.getUint8(s + 2) });
        else if (type === 0x58 && l >= 2) timeSigs.push({ tick, num: d.getUint8(s), den: 1 << d.getUint8(s + 1) });
        else if (type === 0x59 && l >= 2 && !keySig) keySig = { sf: d.getInt8(s), minor: d.getUint8(s + 1) === 1 };
        else if (type === 0x03 && !name) for (let i = 0; i < l; i++) name += String.fromCharCode(d.getUint8(s + i));
        p = s + l;
        status = 0; // meta events cancel running status
        if (type === 0x2f) break;
        continue;
      }
      if (status === 0xf0 || status === 0xf7) { p += vlq(); status = 0; continue; }
      const hi = status & 0xf0, ch = status & 0x0f;
      const a = d.getUint8(p++);
      const v = (hi === 0xc0 || hi === 0xd0) ? 0 : d.getUint8(p++);
      const key = ch * 128 + a;
      if (hi === 0x90 && v > 0) {
        if (!open.has(key)) open.set(key, []);
        open.get(key).push({ midi: a, vel: v, ch, startTick: tick });
      } else if (hi === 0x80 || hi === 0x90) {
        const n = open.get(key)?.shift();
        if (n) { n.endTick = Math.max(tick, n.startTick + 1); notes.push(n); }
      }
    }
    for (const stack of open.values()) for (const n of stack) { n.endTick = Math.max(tick, n.startTick + 1); notes.push(n); }
    p = end;
    tracks.push({ name: name.trim(), notes });
  }
  return { ppq: div, tracks, tempos, timeSigs, keySig };
}
