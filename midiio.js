// Web MIDI: hear the digital piano (USB "to Host" port) and optionally play notes through it.
export class MidiIO {
  constructor({ onNote, onPedal, onChange }) {
    Object.assign(this, { onNote, onPedal, onChange });
    this.supported = typeof navigator !== 'undefined' && !!navigator.requestMIDIAccess;
    this.access = null; this.inputs = []; this.outputs = []; this.error = null; this.pedal = false;
  }

  // Ask only after a tap, unless permission was already given (no surprise prompt on launch).
  async autoConnect() {
    if (!this.supported) return;
    try {
      const st = await navigator.permissions?.query({ name: 'midi' });
      if (st?.state === 'granted') await this.connect();
    } catch { /* permissions API without 'midi' — wait for the tap */ }
  }

  async connect() {
    if (!this.supported) return false;
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
      this.error = null;
      this.access.onstatechange = () => this.refresh();
      this.refresh();
      return true;
    } catch (e) {
      this.error = e;
      this.onChange?.();
      return false;
    }
  }

  refresh() {
    if (!this.access) return;
    this.inputs = [...this.access.inputs.values()].filter(i => i.state === 'connected');
    this.outputs = [...this.access.outputs.values()].filter(o => o.state === 'connected');
    for (const input of this.inputs) input.onmidimessage = e => this.handle(e.data);
    this.onChange?.();
  }

  handle([st, a, b]) {
    const hi = st & 0xf0;
    if (hi === 0x90 && b > 0) this.onNote?.(true, a, b);
    else if (hi === 0x80 || hi === 0x90) this.onNote?.(false, a, 0);
    else if (hi === 0xb0 && a === 64) {
      const down = b >= 64;
      if (down !== this.pedal) { this.pedal = down; if (down) this.onPedal?.(); }
    }
  }

  hasInput() { return this.inputs.length > 0; }
  hasOutput() { return this.outputs.length > 0; }
  name() { return this.inputs[0]?.name || this.outputs[0]?.name || ''; }

  send(on, m, vel = 80) {
    const out = this.outputs[0];
    if (out) out.send(on ? [0x90, m, vel] : [0x80, m, 0]);
  }
  allOff() { for (const o of this.outputs) o.send([0xb0, 123, 0]); }
}
