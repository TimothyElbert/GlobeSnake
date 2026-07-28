import { Terrain } from '@core/world';

/**
 * The score.
 *
 * Everything is synthesised in the browser — no files, no licences, nothing to
 * download — but the first version mistook that for permission to be a drone,
 * and a single sustained chord for twenty minutes is not music, it is tinnitus.
 * This version is actually a piece: a slow chord progression in D Dorian, a
 * breathing pad, a bass that moves with the harmony, and a sparse bell motif
 * that only sometimes plays. The biome under the snake bends the filter and the
 * voicing rather than being the whole idea.
 *
 * The reason it is synthesised rather than a licensed loop is that it can be
 * *driven*: crossing from the Sahara into the Sahel opens the filter and warms
 * the chord before you have read a word of the HUD. A recording cannot do that,
 * and a recording of this length would also be a multi-megabyte download on a
 * page that currently ships none.
 */

/**
 * D Dorian, four chords, each held for a long bar.
 *
 * Dorian rather than natural minor because the raised sixth keeps it from
 * sounding mournful — this is a game about looking at the Earth, and it wants
 * to feel open rather than sad. Semitone offsets from the root.
 */
const PROGRESSION: number[][] = [
  [0, 7, 12, 16],   // Dm9-ish, open fifth on top
  [-2, 5, 10, 14],  // C
  [3, 10, 15, 19],  // F
  [-4, 7, 12, 15],  // Bb∆ over the same fifth
];

const ROOT = 73.42; // D2
const BAR_SECONDS = 11;

/** Pentatonic degrees for the bell motif, in semitones from the root. */
const MOTIF = [0, 3, 5, 7, 10, 12, 15, 17, 19, 22];

/**
 * Biome → tone. [filter Hz, pad detune cents, air level, motif likelihood].
 *
 * Deserts are bright and dry, mountains dark and wide, ice glassy and sparse,
 * ocean soft with more air in it.
 */
const BIOME_TONE: Record<number, [number, number, number, number]> = {
  [Terrain.Ocean]: [620, 7, 0.055, 0.35],
  [Terrain.Shallow]: [780, 6, 0.045, 0.4],
  [Terrain.Coast]: [950, 5, 0.032, 0.5],
  [Terrain.Plains]: [1150, 4, 0.014, 0.55],
  [Terrain.Forest]: [860, 9, 0.022, 0.6],
  [Terrain.Desert]: [1600, 3, 0.030, 0.3],
  [Terrain.Mountain]: [520, 14, 0.018, 0.7],
  [Terrain.Ice]: [2000, 2, 0.026, 0.8],
  [Terrain.River]: [1250, 5, 0.028, 0.6],
  [Terrain.Lake]: [1050, 4, 0.020, 0.5],
};

function semis(n: number): number {
  return ROOT * Math.pow(2, n / 12);
}

/**
 * What the music does.
 *
 * `score` is the generative piece described above. `drone` is the original
 * sustained pad — kept because it is genuinely better for concentrating, which
 * is half of what this game asks of you. `off` leaves the sound effects alone.
 */
export type MusicStyle = 'score' | 'drone' | 'off';

export class GameAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private scoreBus: GainNode | null = null;
  private droneBus: GainNode | null = null;
  private droneOscs: OscillatorNode[] = [];
  private sfxBus: GainNode | null = null;
  private style: MusicStyle = 'score';

  private padFilter: BiquadFilterNode | null = null;
  private droneFilter: BiquadFilterNode | null = null;
  private padGain: GainNode | null = null;
  private airGain: GainNode | null = null;
  private airFilter: BiquadFilterNode | null = null;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;

  private _muted = false;
  private started = false;
  private volume = 0.5;

  private bar = 0;
  private nextBarAt = 0;
  private tone: [number, number, number, number] = BIOME_TONE[Terrain.Plains];

  get muted(): boolean {
    return this._muted;
  }

  /** Browsers need a gesture before audio. Safe to call repeatedly. */
  async ensureStarted(): Promise<void> {
    if (this.started) {
      if (this.ctx?.state === 'suspended') await this.ctx.resume();
      return;
    }
    this.started = true;
    try {
      const Ctor: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctor();
      this.ctx = ctx;

      this.master = ctx.createGain();
      this.master.gain.value = this._muted ? 0 : this.volume;
      this.master.connect(ctx.destination);

      // Two buses so a capture stinger can duck the music without fighting it.
      this.musicBus = ctx.createGain();
      this.musicBus.gain.value = 1;
      this.musicBus.connect(this.master);

      this.sfxBus = ctx.createGain();
      this.sfxBus.gain.value = 1;
      this.sfxBus.connect(this.master);

      // Two music sources, crossfaded, so the choice can change mid-run.
      this.scoreBus = ctx.createGain();
      this.scoreBus.gain.value = this.style === 'score' ? 1 : 0;
      this.scoreBus.connect(this.musicBus);

      this.droneBus = ctx.createGain();
      this.droneBus.gain.value = this.style === 'drone' ? 1 : 0;
      this.droneBus.connect(this.musicBus);

      this.padFilter = ctx.createBiquadFilter();
      this.padFilter.type = 'lowpass';
      this.padFilter.frequency.value = 900;
      this.padFilter.Q.value = 0.8;
      this.padGain = ctx.createGain();
      this.padGain.gain.value = 0.0;
      this.padFilter.connect(this.padGain).connect(this.scoreBus);
      this.padGain.gain.setTargetAtTime(0.22, ctx.currentTime, 2.5);

      // The original drone: three detuned voices held forever, coloured only by
      // the biome filter. Always running, silent unless selected.
      const droneFilter = ctx.createBiquadFilter();
      droneFilter.type = 'lowpass';
      droneFilter.frequency.value = 700;
      droneFilter.Q.value = 1.4;
      droneFilter.connect(this.droneBus);
      this.droneFilter = droneFilter;
      for (const [i, mult] of [1, 1.5, 2].entries()) {
        const osc = ctx.createOscillator();
        osc.type = i === 0 ? 'sawtooth' : 'triangle';
        osc.frequency.value = ROOT * mult;
        osc.detune.value = (i - 1) * 6;
        const g = ctx.createGain();
        g.gain.value = (i === 0 ? 0.20 : 0.11);
        osc.connect(g).connect(droneFilter);
        osc.start();
        this.droneOscs.push(osc);
      }

      // Air: a soft band of noise that sits under everything and gives the
      // silence a texture, so the gaps between chords are not dead.
      const air = ctx.createBufferSource();
      air.buffer = this.noiseBuffer(ctx, 5);
      air.loop = true;
      this.airFilter = ctx.createBiquadFilter();
      this.airFilter.type = 'bandpass';
      this.airFilter.frequency.value = 700;
      this.airFilter.Q.value = 0.55;
      this.airGain = ctx.createGain();
      this.airGain.gain.value = 0;
      air.connect(this.airFilter).connect(this.airGain).connect(this.musicBus);
      air.start();

      // Draft wind, on the SFX bus so it is unmistakably a game sound.
      const wind = ctx.createBufferSource();
      wind.buffer = this.noiseBuffer(ctx, 3);
      wind.loop = true;
      this.windFilter = ctx.createBiquadFilter();
      this.windFilter.type = 'bandpass';
      this.windFilter.frequency.value = 900;
      this.windFilter.Q.value = 3.5;
      this.windGain = ctx.createGain();
      this.windGain.gain.value = 0;
      wind.connect(this.windFilter).connect(this.windGain).connect(this.sfxBus);
      wind.start();

      this.nextBarAt = ctx.currentTime + 0.4;
    } catch {
      // No audio device, or a locked-down browser. The game is fully playable
      // in silence; this must never throw.
      this.ctx = null;
    }
  }

  private noiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.2;
    }
    return buf;
  }

  // --- transport ------------------------------------------------------------

  /**
   * Schedule the next chord if it is due. Called every frame; does nothing
   * almost every time.
   */
  private advance(): void {
    const ctx = this.ctx;
    if (!ctx || !this.padFilter || !this.musicBus) return;
    if (ctx.currentTime < this.nextBarAt) return;

    const at = this.nextBarAt;
    const chord = PROGRESSION[this.bar % PROGRESSION.length];
    this.bar++;
    this.nextBarAt = at + BAR_SECONDS;

    // Pad: one slow swell per chord tone, detuned in pairs so it breathes.
    for (const [i, step] of chord.entries()) {
      for (const detune of [-this.tone[1], this.tone[1]]) {
        this.voice(semis(step + 12), at, BAR_SECONDS * 1.15, 0.055 / (1 + i * 0.25), 'triangle', detune);
      }
    }
    // Bass: the root, low and simple.
    this.voice(semis(chord[0]), at, BAR_SECONDS * 1.1, 0.10, 'sine', 0);

    // Motif: sometimes, and never on the downbeat, so it feels played rather
    // than sequenced.
    if (Math.random() < this.tone[3]) {
      const n = MOTIF[(Math.random() * MOTIF.length) | 0];
      const when = at + BAR_SECONDS * (0.25 + Math.random() * 0.5);
      this.bell(semis(n + 24), when, 0.045);
      if (Math.random() < 0.4) {
        const m = MOTIF[(Math.random() * MOTIF.length) | 0];
        this.bell(semis(m + 24), when + 0.55 + Math.random() * 0.4, 0.03);
      }
    }
  }

  /** A long, soft, filtered swell — the pad's building block. */
  private voice(
    freq: number, at: number, dur: number, gain: number,
    type: OscillatorType, detune: number,
  ): void {
    const ctx = this.ctx;
    if (!ctx || !this.padFilter) return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    osc.detune.value = detune;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + dur * 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(g).connect(this.padFilter);
    osc.start(at);
    osc.stop(at + dur + 0.1);
  }

  /** A struck, decaying tone. Two partials is enough to read as a bell. */
  private bell(freq: number, at: number, gain: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.musicBus) return;
    for (const [mult, amp, dur] of [[1, 1, 3.4], [2.76, 0.28, 2.0]] as const) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq * mult;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(gain * amp, at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      osc.connect(g).connect(this.musicBus);
      osc.start(at);
      osc.stop(at + dur + 0.1);
    }
  }

  // --- mixer ----------------------------------------------------------------

  setMuted(m: boolean): void {
    this._muted = m;
    if (this.master && this.ctx) {
      // cancelScheduledValues first: without it a stinger's duck automation,
      // scheduled on the same param, can ramp the master back up after a mute
      // and un-mute the game on its own.
      const t = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setValueAtTime(this.master.gain.value, t);
      this.master.gain.linearRampToValueAtTime(m ? 0 : this.volume, t + 0.12);
    }
    try { localStorage.setItem('globesnake:pref:muted', JSON.stringify(m)); } catch { /* ignore */ }
  }

  toggleMute(): boolean {
    this.setMuted(!this._muted);
    return this._muted;
  }

  /** Restore saved preferences before the context exists. */
  loadPreference(): void {
    try {
      const raw = localStorage.getItem('globesnake:pref:muted');
      if (raw !== null) this._muted = JSON.parse(raw) === true;
      const m = localStorage.getItem('globesnake:pref:music');
      if (m !== null) {
        const parsed = JSON.parse(m);
        if (parsed === 'score' || parsed === 'drone' || parsed === 'off') this.style = parsed;
      }
    } catch { /* ignore */ }
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (!this._muted) this.setMuted(false);
  }

  get musicStyle(): MusicStyle {
    return this.style;
  }

  setMusicStyle(style: MusicStyle): void {
    this.style = style;
    try { localStorage.setItem('globesnake:pref:music', JSON.stringify(style)); } catch { /* ignore */ }
    if (!this.ctx || !this.scoreBus || !this.droneBus) return;
    const t = this.ctx.currentTime;
    this.scoreBus.gain.setTargetAtTime(style === 'score' ? 1 : 0, t, 0.5);
    this.droneBus.gain.setTargetAtTime(style === 'drone' ? 1 : 0, t, 0.5);
  }

  /** Called every frame: run the transport and bend the tone to the ground. */
  updateAmbience(terrain: Terrain, speedFactor: number, wake: number): void {
    if (!this.ctx || !this.padFilter || !this.airGain || !this.windGain || !this.windFilter) return;
    const t = this.ctx.currentTime;
    const target = BIOME_TONE[terrain] ?? BIOME_TONE[Terrain.Plains];
    // Ease toward the new biome so a coastline is a transition, not a cut.
    for (let i = 0; i < 4; i++) this.tone[i] += (target[i] - this.tone[i]) * 0.02;

    this.padFilter.frequency.setTargetAtTime(this.tone[0], t, 0.9);
    this.droneFilter?.frequency.setTargetAtTime(this.tone[0] * 0.62, t, 0.9);
    for (const [i, osc] of this.droneOscs.entries()) {
      osc.detune.setTargetAtTime((i - 1) * this.tone[1], t, 0.9);
    }
    this.airGain.gain.setTargetAtTime(this.tone[2] * (0.7 + speedFactor * 0.4), t, 0.6);
    this.airFilter?.frequency.setTargetAtTime(400 + this.tone[0] * 0.5, t, 0.9);

    this.windGain.gain.setTargetAtTime(wake * 0.11, t, 0.12);
    this.windFilter.frequency.setTargetAtTime(600 + wake * 1900, t, 0.12);

    // The drone has no transport; only the score needs a clock.
    if (this.style === 'score') this.advance();
  }

  // --- one-shots ------------------------------------------------------------

  private blip(freq: number, when: number, dur: number, gain: number, type: OscillatorType = 'sine'): void {
    if (!this.ctx || !this.sfxBus) return;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, when);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(gain, when + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    osc.connect(g).connect(this.sfxBus);
    osc.start(when);
    osc.stop(when + dur + 0.05);
  }

  /** Duck the music briefly so a stinger lands. */
  private duck(seconds: number): void {
    if (!this.ctx || !this.musicBus) return;
    const t = this.ctx.currentTime;
    this.musicBus.gain.cancelScheduledValues(t);
    this.musicBus.gain.setValueAtTime(this.musicBus.gain.value, t);
    this.musicBus.gain.linearRampToValueAtTime(0.45, t + 0.06);
    this.musicBus.gain.linearRampToValueAtTime(1, t + seconds);
  }

  capture(tier: number, streak: number): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.duck(1.6);
    const notes = 3 + Math.min(3, tier);
    const base = Math.min(6, streak);
    for (let i = 0; i < notes; i++) {
      const n = MOTIF[(base + i) % MOTIF.length] + 24 + Math.floor((base + i) / MOTIF.length) * 12;
      this.bell(semis(n), t + i * 0.075, 0.06);
    }
  }

  hint(free: boolean): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.blip(semis(free ? 15 : 10) * 2, t, 0.22, 0.05, 'sine');
    this.blip(semis(free ? 19 : 7) * 2, t + 0.07, 0.26, 0.035, 'sine');
  }

  ship(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.blip(semis(7) * 2, t, 0.16, 0.045, 'triangle');
    this.blip(semis(12) * 2, t + 0.06, 0.24, 0.04, 'triangle');
  }

  death(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.duck(2.6);
    for (let i = 0; i < 4; i++) {
      this.blip(semis(10 - i * 3), t + i * 0.12, 0.6, 0.09, 'sawtooth');
    }
    this.padGain?.gain.setTargetAtTime(0.05, t, 0.6);
  }

  revive(): void {
    if (!this.ctx || !this.padGain) return;
    this.padGain.gain.setTargetAtTime(0.22, this.ctx.currentTime, 1.2);
  }

  private lastProximity = 0;
  proximity(intensity: number): void {
    if (!this.ctx || intensity < 0.55) return;
    const now = this.ctx.currentTime;
    if (now - this.lastProximity < 0.3 - intensity * 0.15) return;
    this.lastProximity = now;
    this.blip(760 + intensity * 420, now, 0.06, 0.03 * intensity, 'square');
  }

  dispose(): void {
    try { this.ctx?.close(); } catch { /* already closed */ }
  }
}
