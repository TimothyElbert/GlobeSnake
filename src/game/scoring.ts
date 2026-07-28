/**
 * Scoring.
 *
 * score = base(tier) × speed × hint × streak
 *
 * Three deliberate refusals, all of them things the first draft got wrong:
 *
 *  - The speed multiplier has a *floor*. Letting a slow find pay nothing teaches
 *    players to quit and restart instead of finishing, which is the worst habit
 *    a score system can install.
 *  - Hints are charged against this target's value, computed from its original
 *    value — never against banked score, and never cheaper for having stalled.
 *    Losing points you already earned feels like theft; forfeiting points you
 *    have not earned yet feels like a trade.
 *  - There is no route bonus. Par is already terrain-aware, so a good route
 *    shows up in the speed multiplier. Paying for it twice would make routing
 *    the only thing that matters.
 */

export const TIER_BASE = [0, 100, 160, 250, 380, 550] as const;
export const HINT_MULTIPLIER = [1.0, 0.85, 0.6, 0.25] as const;
export const MAX_HINT_LEVEL = 3;

export const SPEED_MAX = 1.5;
/** A target is worth nothing once this many multiples of par have elapsed. */
export const DECAY_PARS = 3;
export const STREAK_STEP = 0.1;
export const STREAK_CAP = 1.5;

/** Seconds granted for recognising the prompt before the clock really bites. */
export const RECOGNITION_GRACE = 2.5;

/**
 * How much of a target's value is left, purely as a function of elapsed time.
 *
 * Deliberately linear, and deliberately reaching exactly zero: this number is
 * shown ticking down on the HUD, and a curve that quietly flattens out at some
 * floor is a countdown that lies. The earlier version floored at ×0.35 to avoid
 * teaching players to quit a bad round — but that reasoning does not apply
 * here, because you cannot skip a target. The clock takes the points; finding
 * the place is still the only way forward. That is a cleaner bargain, and it is
 * legible at a glance.
 *
 * 1.5 at the instant it is set, exactly 1.0 at par, 0 at three times par.
 */
export function timeMultiplier(actualSeconds: number, parSeconds: number): number {
  if (parSeconds <= 0) return 1;
  const t = actualSeconds / parSeconds;
  return Math.max(0, Math.min(SPEED_MAX, SPEED_MAX * (1 - t / DECAY_PARS)));
}

export function streakMultiplier(streak: number): number {
  return Math.min(STREAK_CAP, 1 + STREAK_STEP * streak);
}

export function hintMultiplier(level: number): number {
  return HINT_MULTIPLIER[Math.min(level, MAX_HINT_LEVEL)];
}

export interface CaptureBreakdown {
  base: number;
  speed: number;
  hint: number;
  streak: number;
  total: number;
  actualSeconds: number;
  parSeconds: number;
  hintLevel: number;
  beatPar: boolean;
}

export function scoreCapture(
  tier: number,
  actualSeconds: number,
  parSeconds: number,
  hintLevel: number,
  streak: number,
): CaptureBreakdown {
  const base = TIER_BASE[Math.min(Math.max(tier, 1), 5)];
  const speed = timeMultiplier(actualSeconds, parSeconds);
  const hint = hintMultiplier(hintLevel);
  const st = streakMultiplier(streak);
  return {
    base,
    speed,
    hint,
    streak: st,
    total: Math.round(base * speed * hint * st),
    actualSeconds,
    parSeconds,
    hintLevel,
    beatPar: actualSeconds <= parSeconds,
  };
}

/**
 * Ships pay in fuel, not points.
 *
 * A score bonus put them in direct competition with the objective and made the
 * records table ambiguous — was that a good run or a lucky shipping lane? A
 * boost refill is a purely tactical prize: valuable when your stamina is empty
 * and the next target is a continent away, ignorable otherwise.
 */
export const SHIP_BOOST_REFILL = 0.55;
export const SHIP_BOOST_SECONDS = 1.6;

/** How much body a capture adds, in degrees of arc. */
export const GROWTH_PER_CAPTURE_DEG = 10;

export function formatScore(n: number): string {
  return n.toLocaleString('en-US');
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${r.toString().padStart(2, '0')}`;
}

export function formatDistance(km: number): string {
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${Math.round(km).toLocaleString('en-US')} km`;
}
