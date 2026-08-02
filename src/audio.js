// Fully procedural WebAudio: no samples. Layered synthesis for gunshots,
// engine, skids, ambience.
export class AudioSystem {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.engineNodes = null;
  }

  ensure() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.55;
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.ratio.value = 6;
    this.master.connect(comp).connect(this.ctx.destination);
    this._wind();
  }

  _noiseBuffer(seconds = 1) {
    const len = this.ctx.sampleRate * seconds;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  _burst({ dur = 0.2, freq = 800, q = 1, gain = 0.5, type = 'lowpass', decay = 30, delay = 0 }) {
    const t = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer(dur + 0.05);
    const f = this.ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t); src.stop(t + dur + 0.05);
  }

  _tone({ freq = 440, dur = 0.1, gain = 0.2, type = 'sine', slide = 0, delay = 0 }) {
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  // ------------------------------------------------ weapons
  gunshot() {
    if (!this.ctx) return;
    this._burst({ dur: 0.05, freq: 3200, q: 0.7, gain: 0.7, type: 'highpass' }); // crack
    this._burst({ dur: 0.16, freq: 480, q: 1.2, gain: 0.9 });                     // body
    this._tone({ freq: 110, dur: 0.12, gain: 0.5, type: 'triangle', slide: -70 }); // thump
    this._burst({ dur: 0.45, freq: 900, q: 0.4, gain: 0.12, delay: 0.03 });       // tail
  }

  enemyShot(dist) {
    if (!this.ctx) return;
    const att = Math.max(0.06, 0.5 - dist * 0.005);
    this._burst({ dur: 0.09, freq: 1400, q: 1, gain: att });
    this._burst({ dur: 0.3, freq: 500, q: 0.6, gain: att * 0.5, delay: 0.02 });
  }

  dryFire() { if (this.ctx) this._tone({ freq: 1900, dur: 0.03, gain: 0.18, type: 'square' }); }

  reload() {
    if (!this.ctx) return;
    this._tone({ freq: 900, dur: 0.04, gain: 0.2, type: 'square', delay: 0.1 });
    this._burst({ dur: 0.05, freq: 2400, gain: 0.15, type: 'highpass', delay: 0.55 });
    this._tone({ freq: 700, dur: 0.05, gain: 0.25, type: 'square', delay: 1.35 });
    this._tone({ freq: 1200, dur: 0.04, gain: 0.22, type: 'square', delay: 1.75 });
  }

  impact(flesh) {
    if (!this.ctx) return;
    if (flesh) this._burst({ dur: 0.08, freq: 300, gain: 0.25 });
    else this._burst({ dur: 0.06, freq: 2600, q: 2, gain: 0.14, type: 'bandpass' });
  }

  hitmarker() { if (this.ctx) this._tone({ freq: 2600, dur: 0.035, gain: 0.16, type: 'square' }); }
  killConfirm() {
    if (!this.ctx) return;
    this._tone({ freq: 1400, dur: 0.05, gain: 0.2, type: 'square' });
    this._tone({ freq: 2100, dur: 0.07, gain: 0.2, type: 'square', delay: 0.06 });
  }

  playerHurt() {
    if (!this.ctx) return;
    this._burst({ dur: 0.15, freq: 250, gain: 0.4 });
    this._tone({ freq: 90, dur: 0.2, gain: 0.4, type: 'triangle', slide: -30 });
  }

  enemyDeath() { if (this.ctx) this._burst({ dur: 0.25, freq: 350, gain: 0.2 }); }
  alert() { if (this.ctx) this._tone({ freq: 620, dur: 0.09, gain: 0.1, type: 'square', slide: 140 }); }

  footstep() {
    if (!this.ctx) return;
    this._burst({ dur: 0.05, freq: 300 + Math.random() * 150, gain: 0.07 });
  }

  carDoor() {
    if (!this.ctx) return;
    this._burst({ dur: 0.05, freq: 500, gain: 0.3 });
    this._tone({ freq: 160, dur: 0.09, gain: 0.3, type: 'triangle', slide: -60, delay: 0.02 });
  }

  crash(speed) {
    if (!this.ctx) return;
    const g = Math.min(0.7, speed * 0.02);
    this._burst({ dur: 0.3, freq: 700, gain: g });
    this._tone({ freq: 90, dur: 0.25, gain: g, type: 'triangle', slide: -50 });
  }

  // ------------------------------------------------ engine loop
  startEngine() {
    if (!this.ctx || this.engineNodes) return;
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(this.master);
    const mk = (type, mult, gain) => {
      const o = ctx.createOscillator();
      o.type = type;
      const g = ctx.createGain();
      g.gain.value = gain;
      o.connect(g).connect(out);
      o.start();
      return { o, mult };
    };
    const oscs = [
      mk('sawtooth', 1, 0.30),
      mk('sawtooth', 0.5, 0.22),
      mk('square', 1.5, 0.08),
      mk('sawtooth', 3, 0.05),
    ];
    // intake noise
    const n = ctx.createBufferSource();
    n.buffer = this._noiseBuffer(2); n.loop = true;
    const nf = ctx.createBiquadFilter();
    nf.type = 'bandpass'; nf.frequency.value = 900; nf.Q.value = 0.6;
    const ng = ctx.createGain(); ng.gain.value = 0.10;
    n.connect(nf).connect(ng).connect(out);
    n.start();
    this.engineNodes = { out, oscs, nf };
  }

  setEngine(rpm, throttle, on) {
    if (!this.engineNodes || !this.ctx) return;
    const t = this.ctx.currentTime;
    const base = 28 + (rpm / 7400) * 118;   // firing frequency feel
    for (const { o, mult } of this.engineNodes.oscs) {
      o.frequency.setTargetAtTime(base * mult, t, 0.03);
    }
    this.engineNodes.nf.frequency.setTargetAtTime(500 + throttle * 1400, t, 0.05);
    const vol = on ? 0.16 + throttle * 0.22 + (rpm / 7400) * 0.10 : 0;
    this.engineNodes.out.gain.setTargetAtTime(vol, t, 0.08);
  }

  skid(intensity) {
    if (!this.ctx) return;
    if (!this._skidNode) {
      const n = this.ctx.createBufferSource();
      n.buffer = this._noiseBuffer(2); n.loop = true;
      const f = this.ctx.createBiquadFilter();
      f.type = 'bandpass'; f.frequency.value = 1100; f.Q.value = 1.4;
      const g = this.ctx.createGain(); g.gain.value = 0;
      n.connect(f).connect(g).connect(this.master);
      n.start();
      this._skidNode = g;
    }
    this._skidNode.gain.setTargetAtTime(Math.min(0.3, intensity), this.ctx.currentTime, 0.06);
  }

  // ------------------------------------------------ ambience
  _wind() {
    const ctx = this.ctx;
    const n = ctx.createBufferSource();
    n.buffer = this._noiseBuffer(4); n.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 420; f.Q.value = 0.3;
    const g = ctx.createGain(); g.gain.value = 0.045;
    n.connect(f).connect(g).connect(this.master);
    n.start();
    // slow gusts
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lg = ctx.createGain(); lg.gain.value = 0.02;
    lfo.connect(lg).connect(g.gain);
    lfo.start();
  }
}
