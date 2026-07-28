import { Terrain } from '@core/world';

/**
 * Procedural audio.
 *
 * Everything is synthesised in the browser: no files, no licences, nothing to
 * download, and — the actual reason — the ambient bed can be *driven by the
 * game state*. The drone retunes to the biome under the head, so crossing from
 * the Sahara into the Sahel is something you hear before you read it. A
 * licensed loop could never do that; it would just be wallpaper.
 *
 * Kept deliberately quiet and consonant. This is a game people will play while
 * thinking hard about where Djibouti is.
 */

/** A pentatonic scale, so nothing the game plays can ever clash with itself. */
const SCALE = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21];
const ROOT = 146.83; // D3

function noteHz(step: number): number {
  return ROOT * Math.pow(2, (SCALE[((step % SCALE.length) + SCALE.length) % SCALE.length] + 12 * Math.floor(step / SCALE.length)) / 12);
}

/** Biome → drone character: [filter Hz, detune cents, noise level, brightness]. */
const BIOME_TONE: Record<number, [number, number, number, number]> = {
  [Terrain.Ocean]: [420, 6, 0.055, 0.30],
  [Terrain.Shallow]: [560, 5, 0.045, 0.38],
  [Terrain.Coast]: [700, 4, 0.032, 0.48],
  [Terrain.Plains]: [820, 3, 0.012, 0.55],
  [Terrain.Forest]: [640, 9, 0.020, 0.44],
  [Terrain.Desert]: [1150, 2, 0.030, 0.68],
  [Terrain.Mountain]: [380, 14, 0.016, 0.26],
  [Terrain.Ice]: [1500, 1, 0.024, 0.80],
  [Terrain.River]: [900, 5, 0.028, 0.60],
  [Terrain.Lake]: [760, 4, 0.020, 0.50],
};

export class GameAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private droneGain: GainNode | null = null;
  private droneFilter: BiquadFilterNode | null = null;
  private droneOscs: OscillatorNode[] = [];
  private noiseGain: GainNode | null = null;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;

  private _muted = false;
  private started = false;

  get muted(): boolean {
    return this._muted;
  }

  /**
   * Browsers require a user gesture before audio. Called from the first click
   * or keypress; safe to call repeatedly.
   */
  async ensureStarted(): Promise<void> {
    if (this.started) {
      if (this.ctx?.state === 'suspended') await this.ctx.resume();
      return;
    }
    this.started = true;
    try {
      const Ctor: typeof AudioContext =
        window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctor();
      this.ctx = ctx;

      this.master = ctx.createGain();
      this.master.gain.value = this._muted ? 0 : 0.62;
      this.master.connect(ctx.destination);

      // --- ambient drone: three detuned saws through a lowpass --------------
      this.droneFilter = ctx.createBiquadFilter();
      this.droneFilter.type = 'lowpass';
      this.droneFilter.frequency.value = 700;
      this.droneFilter.Q.value = 1.4;

      this.droneGain = ctx.createGain();
      this.droneGain.gain.value = 0;
      this.droneFilter.connect(this.droneGain).connect(this.master);

      for (const [i, mult] of [1, 1.5, 2].entries()) {
        const osc = ctx.createOscillator();
        osc.type = i === 0 ? 'sawtooth' : 'triangle';
        osc.frequency.value = ROOT * 0.5 * mult;
        osc.detune.value = (i - 1) * 6;
        const g = ctx.createGain();
        g.gain.value = i === 0 ? 0.26 : 0.15;
        osc.connect(g).connect(this.droneFilter);
        osc.start();
        this.droneOscs.push(osc);
      }

      // --- wind / water noise bed -------------------------------------------
      const noise = ctx.createBufferSource();
      noise.buffer = this.makeNoiseBuffer(ctx, 4);
      noise.loop = true;
      const nf = ctx.createBiquadFilter();
      nf.type = 'bandpass';
      nf.frequency.value = 700;
      nf.Q.value = 0.7;
      this.noiseGain = ctx.createGain();
      this.noiseGain.gain.value = 0;
      noise.connect(nf).connect(this.noiseGain).connect(this.master);
      noise.start();

      // --- draft wind: rises with the wake meter ----------------------------
      const wind = ctx.createBufferSource();
      wind.buffer = this.makeNoiseBuffer(ctx, 3);
      wind.loop = true;
      this.windFilter = ctx.createBiquadFilter();
      this.windFilter.type = 'bandpass';
      this.windFilter.frequency.value = 900;
      this.windFilter.Q.value = 3.5;
      this.windGain = ctx.createGain();
      this.windGain.gain.value = 0;
      wind.connect(this.windFilter).connect(this.windGain).connect(this.master);
      wind.start();

      this.droneGain.gain.setTargetAtTime(0.16, ctx.currentTime, 1.6);
    } catch {
      // No audio context available (locked-down browser, no output device).
      // The game is entirely playable in silence; never let this throw.
      this.ctx = null;
    }
  }

  private makeNoiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    // Brown-ish noise: gentler than white, and it sits under the drone instead
    // of hissing over it.
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.2;
    }
    return buf;
  }

  setMuted(m: boolean): void {
    this._muted = m;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(m ? 0 : 0.62, this.ctx.currentTime, 0.08);
    }
  }

  toggleMute(): boolean {
    this.setMuted(!this._muted);
    return this._muted;
  }

  /** Called every frame: retune the world to the ground under the snake. */
  updateAmbience(terrain: Terrain, speedFactor: number, wake: number): void {
    if (!this.ctx || !this.droneFilter || !this.noiseGain || !this.windGain || !this.windFilter) return;
    const t = this.ctx.currentTime;
    const tone = BIOME_TONE[terrain] ?? BIOME_TONE[Terrain.Plains];

    this.droneFilter.frequency.setTargetAtTime(tone[0], t, 0.7);
    for (const [i, osc] of this.droneOscs.entries()) {
      osc.detune.setTargetAtTime((i - 1) * tone[1], t, 0.7);
    }
    this.noiseGain.gain.setTargetAtTime(tone[2] * (0.7 + speedFactor * 0.5), t, 0.5);

    this.windGain.gain.setTargetAtTime(wake * 0.13, t, 0.12);
    this.windFilter.frequency.setTargetAtTime(600 + wake * 1900, t, 0.12);
  }

  // --- one-shots ------------------------------------------------------------

  private blip(freq: number, when: number, dur: number, gain: number, type: OscillatorType = 'sine'): void {
    if (!this.ctx || !this.master) return;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, when);
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(gain, when + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    osc.connect(g).connect(this.master);
    osc.start(when);
    osc.stop(when + dur + 0.05);
  }

  /** Capture: a rising arpeggio whose length grows with the tier. */
  capture(tier: number, streak: number): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const notes = 2 + Math.min(3, tier);
    const base = 5 + Math.min(6, streak);
    for (let i = 0; i < notes; i++) {
      this.blip(noteHz(base + i * 2), t + i * 0.062, 0.34, 0.16, 'triangle');
      this.blip(noteHz(base + i * 2 + 7) * 2, t + i * 0.062, 0.18, 0.05, 'sine');
    }
  }

  hint(free: boolean): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.blip(noteHz(free ? 7 : 3), t, 0.22, 0.10, 'sine');
    this.blip(noteHz(free ? 9 : 1), t + 0.07, 0.26, 0.07, 'sine');
  }

  ship(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.blip(noteHz(2), t, 0.18, 0.11, 'square');
    this.blip(noteHz(6), t + 0.05, 0.24, 0.08, 'triangle');
  }

  death(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (let i = 0; i < 5; i++) {
      this.blip(noteHz(8 - i * 2) * 0.5, t + i * 0.10, 0.5, 0.15, 'sawtooth');
    }
    this.droneGain?.gain.setTargetAtTime(0.03, t, 0.5);
  }

  revive(): void {
    if (!this.ctx || !this.droneGain) return;
    this.droneGain.gain.setTargetAtTime(0.16, this.ctx.currentTime, 0.8);
  }

  /** Warning chirp when the head gets close to the body. Rate-limited. */
  private lastProximity = 0;
  proximity(intensity: number): void {
    if (!this.ctx || intensity < 0.55) return;
    const now = this.ctx.currentTime;
    if (now - this.lastProximity < 0.28 - intensity * 0.15) return;
    this.lastProximity = now;
    this.blip(880 + intensity * 500, now, 0.07, 0.035 * intensity, 'square');
  }

  dispose(): void {
    try {
      for (const o of this.droneOscs) o.stop();
      this.ctx?.close();
    } catch { /* already closed */ }
  }
}
