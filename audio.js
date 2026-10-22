// Sound: a small Web Audio piano for the tablet, or real notes sent to the piano over USB-MIDI.
export class Synth {
  constructor() { this.ctx = null; this.voices = new Map(); }

  ensure() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -14; comp.ratio.value = 4;
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.55;
      this.master.connect(comp).connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  noteOn(midi, vel = 90) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const f = 440 * 2 ** ((midi - 69) / 12);
    const peak = 0.06 + (vel / 127) * 0.22;
    const decay = 0.5 + Math.max(0, 96 - midi) / 30; // low notes ring longer
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.006);
    g.gain.setTargetAtTime(0, t + 0.02, decay);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(Math.min(f * 9, 14000), t);
    lp.frequency.setTargetAtTime(Math.max(f * 2.2, 500), t, 0.35);
    const oscs = [['triangle', 1, 1], ['sine', 2, 0.35], ['sine', 1.003, 0.4]].map(([type, mul, amp]) => {
      const o = ctx.createOscillator(), a = ctx.createGain();
      o.type = type; o.frequency.value = f * mul; a.gain.value = amp;
      o.connect(a).connect(lp);
      o.start(t);
      return o;
    });
    lp.connect(g).connect(this.master);
    const v = { g, oscs };
    oscs[0].stop(t + decay * 6 + 0.5); oscs[1].stop(t + decay * 6 + 0.5); oscs[2].stop(t + decay * 6 + 0.5);
    if (!this.voices.has(midi)) this.voices.set(midi, []);
    this.voices.get(midi).push(v);
  }

  noteOff(midi) {
    const v = this.voices.get(midi)?.shift();
    if (!v || !this.ctx) return;
    const t = this.ctx.currentTime;
    if (v.g.gain.cancelAndHoldAtTime) v.g.gain.cancelAndHoldAtTime(t); else v.g.gain.cancelScheduledValues(t);
    v.g.gain.setTargetAtTime(0, t, 0.07);
    for (const o of v.oscs) try { o.stop(t + 0.5); } catch { /* already stopped */ }
  }

  allOff() { for (const m of [...this.voices.keys()]) while (this.voices.get(m)?.length) this.noteOff(m); }
}

// One place that decides where app-played notes sound: the piano (USB) or the tablet.
export class Sound {
  constructor(synth, midiIO, prefs) { this.synth = synth; this.io = midiIO; this.prefs = prefs; this.on = new Map(); this.sent = new Map(); }
  usePiano() { return this.prefs().sound === 'piano' && this.io.hasOutput(); }
  noteOn(m, vel = 80) {
    const dest = this.usePiano() ? 'piano' : 'tablet';
    this.on.set(m, (this.on.get(m) || []).concat(dest));
    if (dest === 'piano') { this.sent.set(m, performance.now()); this.io.send(true, m, vel); } else this.synth.noteOn(m, vel);
  }
  // If a piano echoes our own notes back over USB, don't mistake them for the player's.
  echo(m) { return performance.now() - (this.sent.get(m) ?? -1e9) < 40; }
  noteOff(m) {
    const dest = this.on.get(m)?.shift();
    if (dest === 'piano') this.io.send(false, m); else if (dest === 'tablet') this.synth.noteOff(m);
  }
  allOff() { this.on.clear(); this.synth.allOff(); this.io.allOff(); }
}
