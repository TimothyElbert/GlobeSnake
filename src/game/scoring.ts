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

export const SPEED_MIN = 0.35;
export const SPEED_MAX = 1.6;
export const STREAK_STEP = 0.1;
export const STREAK_CAP = 1.5;

/** Seconds granted for recognising the prompt before the clock really bites. */
export const RECOGNITION_GRACE = 2.5;

export function speedMultiplier(actualSeconds: number, parSeconds: number): number {
  if (parSeconds <= 0) return 1;
  // Exponent tuned by watching a perfect-knowledge bot play: at 0.55 even
  // flawless routing only earned ×1.10, so the top half of the range was dead
  // and mastery paid almost nothing. At 0.8, knowing exactly where you are
  // going is worth ×1.4 — and a genuine miss still floors out rather than
  // zeroing, so nobody is taught to quit a bad round.
  const raw = Math.exp(0.8 * (1 - actualSeconds / parSeconds));
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, raw));
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
  const speed = speedMultiplier(actualSeconds, parSeconds);
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

/** Ships are a garnish, not a requirement: capped, flat, and never route-defining. */
export const SHIP_BONUS = 120;
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
