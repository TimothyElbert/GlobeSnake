import { TIER_BASE, SPEED_MAX, STREAK_CAP } from './scoring';
import type { GameMode } from './session';
import type { Deck } from './targets';

/**
 * Personal records, stored locally.
 *
 * There is no server, so these are yours alone — which also means the only
 * thing that can corrupt them is a hand-edited localStorage. They still get
 * validated on the way in: a stored record that claims a million points from
 * three captures would sit at the top of your table forever and quietly ruin
 * the thing it exists to measure. The checks below are the same plausibility
 * rules a public board would need, kept here so that adding one later is a
 * matter of swapping the storage, not rewriting the trust model.
 */

export interface RunResult {
  variant: string;
  mode: GameMode;
  deck: Deck;
  /** UTC day key for daily and tour runs; empty otherwise. */
  day: string;
  score: number;
  found: number;
  /** Seconds elapsed. For the Grand Tour this is the ranking metric. */
  seconds: number;
  /** Grand Tour only: did they actually finish the list? */
  completed: boolean;
  /** Terra only: fraction of the globe uncovered, 0..1. */
  explored: number;
  hints: number;
  distanceKm: number;
}

export interface DailyRecord {
  firstScore: number;
  firstSeconds: number;
  firstFound: number;
  bestScore: number;
  bestSeconds: number;
  bestFound: number;
  /** Best completion time, for the Grand Tour. 0 = never completed. */
  bestCompletedSeconds: number;
  attempts: number;
}

export interface FreeRecord {
  bestScore: number;
  bestFound: number;
  bestExplored: number;
  bestSeconds: number;
  runs: number;
}

const PREFIX = 'globesnake:rec';

/**
 * The most a run could possibly be worth.
 *
 * Every capture is at most the top tier's base times the best time multiplier
 * times the streak cap; ships pay in boost now, so they add nothing. A little
 * headroom on top absorbs future tuning without rejecting honest runs.
 */
export function maxPlausibleScore(found: number): number {
  const perCapture = TIER_BASE[TIER_BASE.length - 1] * SPEED_MAX * STREAK_CAP;
  return Math.ceil(found * perCapture * 1.15) + 50;
}

/** Nobody finds a place in under a second, including the recognition grace. */
const MIN_SECONDS_PER_FIND = 1.0;

export function isPlausible(r: RunResult): boolean {
  if (!Number.isFinite(r.score) || !Number.isFinite(r.seconds) || !Number.isFinite(r.found)) return false;
  if (r.score < 0 || r.seconds < 0 || r.found < 0) return false;
  if (r.found > 500) return false;
  if (r.score > maxPlausibleScore(r.found)) return false;
  if (r.found > 0 && r.seconds < r.found * MIN_SECONDS_PER_FIND) return false;
  if (r.explored < 0 || r.explored > 1) return false;
  return true;
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch { return null; }
}

function write(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}

export function dayKey(date = new Date()): string {
  const m = `${date.getUTCMonth() + 1}`.padStart(2, '0');
  const d = `${date.getUTCDate()}`.padStart(2, '0');
  return `${date.getUTCFullYear()}-${m}-${d}`;
}

const dailyKey = (r: { variant: string; mode: GameMode; day: string }): string =>
  `${PREFIX}:d:${r.variant}:${r.mode}:${r.day}`;
const freeKey = (r: { variant: string; mode: GameMode; deck: Deck }): string =>
  `${PREFIX}:f:${r.variant}:${r.mode}:${r.deck}`;

export function getDaily(variant: string, mode: GameMode, day = dayKey()): DailyRecord | null {
  return read<DailyRecord>(dailyKey({ variant, mode, day }));
}

export function getFree(variant: string, mode: GameMode, deck: Deck): FreeRecord | null {
  return read<FreeRecord>(freeKey({ variant, mode, deck }));
}

export interface SubmitOutcome {
  rejected: boolean;
  newBestScore: boolean;
  newBestTime: boolean;
  isFirstToday: boolean;
}

/**
 * Record a finished run.
 *
 * Daily and Grand Tour keep *first* and *best* separately, because replaying a
 * daily until it goes well is a different achievement from getting it right
 * cold — and both are worth knowing.
 */
export function submit(r: RunResult): SubmitOutcome {
  const out: SubmitOutcome = {
    rejected: false, newBestScore: false, newBestTime: false, isFirstToday: false,
  };
  if (!isPlausible(r)) { out.rejected = true; return out; }

  if (r.mode === 'daily' || r.mode === 'tour') {
    const key = dailyKey(r);
    const prev = read<DailyRecord>(key);
    if (!prev) {
      out.isFirstToday = true;
      out.newBestScore = true;
      out.newBestTime = true;
      write(key, {
        firstScore: r.score, firstSeconds: r.seconds, firstFound: r.found,
        bestScore: r.score, bestSeconds: r.seconds, bestFound: r.found,
        bestCompletedSeconds: r.completed ? r.seconds : 0,
        attempts: 1,
      } satisfies DailyRecord);
      return out;
    }
    const next: DailyRecord = { ...prev, attempts: prev.attempts + 1 };
    if (r.score > prev.bestScore) { next.bestScore = r.score; out.newBestScore = true; }
    if (r.found > prev.bestFound) next.bestFound = r.found;
    // "Best time" only means anything among runs that got equally far.
    if (r.found >= prev.bestFound && (prev.bestSeconds === 0 || r.seconds < prev.bestSeconds)) {
      next.bestSeconds = r.seconds;
      out.newBestTime = true;
    }
    if (r.completed && (prev.bestCompletedSeconds === 0 || r.seconds < prev.bestCompletedSeconds)) {
      next.bestCompletedSeconds = r.seconds;
      out.newBestTime = true;
    }
    write(key, next);
    return out;
  }

  const key = freeKey(r);
  const prev = read<FreeRecord>(key) ?? {
    bestScore: 0, bestFound: 0, bestExplored: 0, bestSeconds: 0, runs: 0,
  };
  const next: FreeRecord = { ...prev, runs: prev.runs + 1 };
  if (r.score > prev.bestScore) { next.bestScore = r.score; out.newBestScore = true; }
  if (r.found > prev.bestFound) next.bestFound = r.found;
  if (r.explored > prev.bestExplored) next.bestExplored = r.explored;
  if (r.seconds > prev.bestSeconds) next.bestSeconds = r.seconds;
  write(key, next);
  return out;
}

/** Everything on record for one world, for the Records tab. */
export interface RecordsView {
  free: { mode: GameMode; deck: Deck; rec: FreeRecord }[];
  daily: { mode: GameMode; day: string; rec: DailyRecord }[];
}

export function collect(variant: string, decks: Deck[], days = 7): RecordsView {
  const free: RecordsView['free'] = [];
  for (const mode of ['endless', 'relay'] as GameMode[]) {
    for (const deck of decks) {
      const rec = getFree(variant, mode, deck);
      if (rec && rec.runs > 0) free.push({ mode, deck, rec });
    }
  }

  const daily: RecordsView['daily'] = [];
  const now = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    const day = dayKey(d);
    for (const mode of ['daily', 'tour'] as GameMode[]) {
      const rec = getDaily(variant, mode, day);
      if (rec) daily.push({ mode, day, rec });
    }
  }
  return { free, daily };
}
