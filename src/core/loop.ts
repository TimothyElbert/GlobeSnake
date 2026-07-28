/**
 * Fixed-timestep game loop.
 *
 * Collision and speed must not depend on frame rate. A 30 fps laptop and a
 * 144 Hz desktop have to agree on whether you clipped your own tail, and a
 * variable dt lets a long frame teleport the head straight through the body.
 * So the simulation always advances in identical 1/120 s slices and the
 * renderer interpolates between the last two states.
 */
export class GameLoop {
  readonly stepSeconds: number;
  private accumulator = 0;
  private lastTime = 0;
  private rafId = 0;
  private running = false;

  /** Fraction of a step between the previous and current sim state, 0..1. */
  alpha = 0;
  /** Smoothed frames per second, for the perf readout and quality fallback. */
  fps = 60;

  constructor(
    private readonly onFixed: (dt: number) => void,
    private readonly onRender: (alpha: number, frameDt: number) => void,
    stepHz = 120,
  ) {
    this.stepSeconds = 1 / stepHz;
  }

  /** Draw one frame outside the rAF schedule. Used by the dev capture hook. */
  renderFrame(alpha: number, frameDt: number): void {
    this.onRender(alpha, frameDt);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.accumulator = 0;
    this.rafId = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  private tick = (now: number): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.tick);

    let frameDt = (now - this.lastTime) / 1000;
    this.lastTime = now;

    // A tab returning from the background reports an enormous delta. Clamping
    // it means the player resumes where they left off instead of discovering
    // that the snake spent the last four minutes driving into Kazakhstan.
    if (frameDt > 0.25) frameDt = 0.25;
    if (frameDt > 0) this.fps += (1 / frameDt - this.fps) * 0.05;

    this.accumulator += frameDt;
    let steps = 0;
    while (this.accumulator >= this.stepSeconds) {
      this.onFixed(this.stepSeconds);
      this.accumulator -= this.stepSeconds;
      // Never spiral: if we cannot keep up, drop the backlog rather than
      // making every subsequent frame worse.
      if (++steps > 8) { this.accumulator = 0; break; }
    }

    this.alpha = this.accumulator / this.stepSeconds;
    this.onRender(this.alpha, frameDt);
  };
}

/** Deterministic PRNG. Used for daily seeds so every player gets the same run. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** YYYYMMDD in UTC — the daily seed, identical for everyone on the planet. */
export function todaySeed(date = new Date()): number {
  return (
    date.getUTCFullYear() * 10000 +
    (date.getUTCMonth() + 1) * 100 +
    date.getUTCDate()
  );
}

export function dailyNumber(date = new Date()): number {
  const epoch = Date.UTC(2026, 0, 1);
  const day = Math.floor((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - epoch) / 86400000);
  return day + 1;
}
