import { Vector3 } from 'three';
import { angleToArc, fromLatLon, DEG, EARTH_RADIUS_KM } from '@core/sphere';
import type { Snake } from '@core/snake';
import type { WorldData } from '@core/world';

export type TargetKind = 'country' | 'capital' | 'city' | 'landmark' | 'feature' | 'flag' | 'outline';

export interface TargetImage {
  type: 'flag' | 'outline' | 'silhouette';
  iso2?: string;
  iso3?: string;
  id?: string;
}

export interface TargetRecord {
  id: string;
  tier: number;
  kind: TargetKind;
  name: string;
  prompt: string;
  lat: number;
  lon: number;
  radiusKm: number | null;
  countryIso3: string | null;
  blurb: string;
  image: TargetImage | null;
}

/** A target with its runtime-resolved position and capture rule. */
export interface LiveTarget extends TargetRecord {
  position: Vector3;
  /** Capture radius in radians, or 0 when capture is by country index. */
  captureRad: number;
  /** Country index that satisfies capture, or 0 when capture is by radius. */
  captureCountry: number;
}

/**
 * Default capture radii by tier, in kilometres.
 *
 * Generous on purpose. A radius that is too tight does not read as "difficult",
 * it reads as "the game cheated" — the player was standing on Big Ben and the
 * game disagreed. Obscure targets get *more* slack, not less: the hard part is
 * knowing where Kerguelen is, not threading a needle once you are there.
 */
const TIER_RADIUS_KM = [0, 0, 200, 150, 220, 320];

export type Deck = 'explorer' | 'standard' | 'expert';

export interface DeckRule {
  label: string;
  description: string;
  startTier: number;
  minTier: number;
  maxTier: number;
  /** Consecutive good finds needed before the deck promotes a tier. */
  promoteAfter: number;
  showBorders: boolean;
  growthMultiplier: number;
}

export const DECKS: Readonly<Record<Deck, DeckRule>> = {
  explorer: {
    label: 'Explorer',
    description: 'Countries, capitals and famous landmarks. Borders drawn, hints cheap.',
    startTier: 1, minTier: 1, maxTier: 3, promoteAfter: 3, showBorders: true, growthMultiplier: 0.75,
  },
  standard: {
    label: 'Standard',
    description: 'The full world, opening gently. Find things fast and it gets harder.',
    startTier: 1, minTier: 1, maxTier: 5, promoteAfter: 2, showBorders: false, growthMultiplier: 1,
  },
  expert: {
    label: 'Expert',
    description: 'Starts obscure and stays there. Every clue type, and a body that grows fast.',
    startTier: 3, minTier: 2, maxTier: 5, promoteAfter: 2, showBorders: false, growthMultiplier: 1.35,
  },
};

export class TargetPool {
  private readonly byTier = new Map<number, LiveTarget[]>();
  private readonly used = new Set<string>();
  readonly all: LiveTarget[] = [];

  constructor(records: TargetRecord[], world: WorldData) {
    for (const r of records) {
      const position = fromLatLon(r.lat, r.lon);
      let captureCountry = 0;
      let captureRad = 0;

      // Countries and flags are captured by *being in the country*, which is the
      // only rule that matches the player's intuition: no radius around a
      // representative point can mean "inside Chile" without also meaning
      // "somewhere in Argentina".
      if ((r.kind === 'country' || r.kind === 'flag' || r.kind === 'outline') && r.countryIso3) {
        captureCountry = world.countryByIso3(r.countryIso3)?.idx ?? 0;
      }
      if (captureCountry === 0) {
        const km = r.radiusKm ?? TIER_RADIUS_KM[Math.min(Math.max(r.tier, 1), 5)] ?? 200;
        captureRad = km / EARTH_RADIUS_KM;
      }

      const live: LiveTarget = { ...r, position, captureRad, captureCountry };
      this.all.push(live);
      const bucket = this.byTier.get(r.tier);
      if (bucket) bucket.push(live);
      else this.byTier.set(r.tier, [live]);
    }
  }

  tierCount(tier: number): number {
    return this.byTier.get(tier)?.length ?? 0;
  }

  resetUsed(): void {
    this.used.clear();
  }

  markUsed(id: string): void {
    this.used.add(id);
  }

  /**
   * Choose the next target.
   *
   * The key move is the obstruction score: among a random sample of eligible
   * targets, prefer the one whose direct route passes closest to the body you
   * have already laid down. That is what turns a growing tail from a passive
   * punishment into level design — the game keeps handing you journeys that go
   * *through* your own history, so "over the Andes, around, or through the gap
   * I left near Quito" becomes a real question instead of a slogan.
   */
  pick(tier: number, snake: Snake, rng: () => number, sampleSize = 14): LiveTarget | null {
    const candidates: LiveTarget[] = [];
    // Widen the tier search until something unused turns up, so a long run
    // never dead-ends on an exhausted tier.
    for (let spread = 0; spread <= 4 && candidates.length === 0; spread++) {
      for (const t of [tier - spread, tier + spread]) {
        const bucket = this.byTier.get(t);
        if (!bucket) continue;
        for (const c of bucket) if (!this.used.has(c.id)) candidates.push(c);
        if (spread === 0) break;
      }
    }
    if (candidates.length === 0) {
      this.used.clear();
      for (const c of this.byTier.get(tier) ?? this.all) candidates.push(c);
    }
    if (candidates.length === 0) return null;

    let best: LiveTarget | null = null;
    let bestScore = -Infinity;
    const n = Math.min(sampleSize, candidates.length);
    for (let i = 0; i < n; i++) {
      const cand = candidates[(rng() * candidates.length) | 0];
      if (!cand) continue;
      const score = this.routeInterest(snake, cand);
      if (score > bestScore) { bestScore = score; best = cand; }
    }
    if (best) this.used.add(best.id);
    return best;
  }

  /**
   * Seed-only pick, with no reference to the snake. Used by the Daily Run,
   * where the whole point is that two players get identical target lists.
   */
  pickPure(tier: number, rng: () => number, taken: Set<string>): LiveTarget | null {
    for (let spread = 0; spread <= 4; spread++) {
      for (const t of spread === 0 ? [tier] : [tier - spread, tier + spread]) {
        const bucket = this.byTier.get(t);
        if (!bucket) continue;
        const free = bucket.filter((c) => !taken.has(c.id));
        if (free.length) return free[(rng() * free.length) | 0] ?? null;
      }
    }
    return null;
  }

  /**
   * How interesting the journey to `t` is. Rewards routes that thread the
   * existing body, and penalises targets that are trivially close or on the
   * exact far side of the planet (which is just a long straight drive).
   */
  private routeInterest(snake: Snake, t: LiveTarget): number {
    const head = snake.position;
    const arc = Math.acos(Math.max(-1, Math.min(1, head.dot(t.position))));
    const arcDeg = arc / DEG;

    // Sweet spot ~40–120° of arc: far enough to be a journey, near enough to
    // stay a decision rather than a commute.
    let score = 1 - Math.abs(arcDeg - 78) / 110;

    const first = snake.firstBodyNode;
    const count = snake.nodeCount;
    if (count - first > 40) {
      const stride = Math.max(1, Math.floor((count - first) / 220));
      let obstruction = 0;
      for (let i = first + 1; i < count - 1; i += stride) {
        snake.nodeAt(i, _tmpA);
        // Distance from this body sample to the great circle we would fly.
        const d = angleToArc(_tmpA, head, t.position);
        if (d < 6 * DEG) obstruction += 1 - d / (6 * DEG);
      }
      score += Math.min(1.2, obstruction / 12);
    }

    return score;
  }
}

const _tmpA = new Vector3();

/**
 * Adaptive difficulty inside a chosen deck.
 *
 * The deck is the player's decision — nobody gets silently labelled a beginner —
 * but within it the game listens: two clean, fast finds and it reaches deeper;
 * a timeout or a fully-hinted find and it eases off. An expert is at tier 5 by
 * the sixth target while a novice never leaves the capitals, from the same code.
 */
export class DifficultyDrift {
  tier: number;
  private good = 0;

  constructor(private readonly rule: DeckRule) {
    this.tier = rule.startTier;
  }

  record(beatPar: boolean, hintLevel: number, timedOut: boolean): void {
    if (timedOut || hintLevel >= 3) {
      this.good = 0;
      this.tier = Math.max(this.rule.minTier, this.tier - 1);
      return;
    }
    if (beatPar && hintLevel === 0) {
      if (++this.good >= this.rule.promoteAfter) {
        this.good = 0;
        this.tier = Math.min(this.rule.maxTier, this.tier + 1);
      }
    } else if (!beatPar) {
      this.good = 0;
    }
  }

  reset(): void {
    this.tier = this.rule.startTier;
    this.good = 0;
  }
}

/** Is the head inside this target? */
export function isCaptured(target: LiveTarget, head: Vector3, world: WorldData): boolean {
  if (target.captureCountry > 0) return world.countryAt(head) === target.captureCountry;
  return Math.acos(Math.max(-1, Math.min(1, head.dot(target.position)))) <= target.captureRad;
}
