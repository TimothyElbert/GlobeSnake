import { Vector3 } from 'three';
import {
  DEG, EARTH_RADIUS_KM, angleBetween, anyTangent, bearingDeg, fromLatLon, step, tangentToward, turn,
} from '@core/sphere';
import { Snake, type SnakeConfig, type SteerInput } from '@core/snake';
import {
  SEA_LEVEL_CODE, TERRAIN_NAME, TERRAIN_SPEED, Terrain, WorldData, elevationMetres, isWater,
} from '@core/world';
import { mulberry32, todaySeed } from '@core/loop';
import { RouteGrid } from './par';
import { ShipFleet } from './ships';
import {
  DECKS, DifficultyDrift, TargetPool, isCaptured,
  type Deck, type LiveTarget, type TargetRecord,
} from './targets';
import {
  GROWTH_PER_CAPTURE_DEG, MAX_HINT_LEVEL, RECOGNITION_GRACE, SHIP_BOOST_REFILL, SHIP_BOOST_SECONDS,
  TIER_BASE, hintMultiplier, scoreCapture, streakMultiplier, type CaptureBreakdown,
} from './scoring';

/**
 * `tour` is the Grand Tour: twenty places named up front, visitable in any
 * order, on a trail that never releases. Knowing the whole list is the point —
 * it turns the game from "react to a prompt" into route planning, and the
 * permanent line means a lazy order walls you off from your own remaining
 * targets. Ranked on finishing time, not points.
 */
export type GameMode = 'endless' | 'daily' | 'relay' | 'tour';
/**
 * `ready` is the Grand Tour's study period: the list is on screen, the world is
 * on screen, and nothing is moving or being timed. Being ranked on speed while
 * reading twenty place names for the first time would measure reading, not
 * route planning.
 */
export type Phase = 'idle' | 'ready' | 'playing' | 'paused' | 'captured' | 'dead' | 'finished';

export interface SessionOptions {
  mode: GameMode;
  deck: Deck;
  snake?: Partial<SnakeConfig>;
  /** Daily mode: how many targets make a run. */
  dailyLength?: number;
  /** Relay mode: starting clock and the bonus each capture adds. */
  relaySeconds?: number;
  relayBonusSeconds?: number;
  /** Grand Tour: how many places are on the list. */
  tourLength?: number;
  seed?: number;
  /**
   * Where the hint ladder stops. Terra Incognita caps at 2 — bearing and range
   * only, no pin — which is how that variant earns its difficulty without
   * resorting to hiding the map.
   */
  maxHintLevel?: number;
  /** Terra Incognita: record how much of the globe the player uncovered. */
  trackExploration?: boolean;
}

export interface CaptureEvent {
  target: LiveTarget;
  breakdown: CaptureBreakdown;
  totalScore: number;
  index: number;
}

export interface SessionEvents {
  onTarget?: (t: LiveTarget, index: number, parSeconds: number) => void;
  onCapture?: (e: CaptureEvent) => void;
  onHint?: (level: number, costPoints: number) => void;
  onShip?: (position: Vector3, bonus: number) => void;
  onDeath?: () => void;
  onFinish?: () => void;
}

/** One row of the end-of-run report and the share card. */
export interface RunLogEntry {
  name: string;
  tier: number;
  seconds: number;
  parSeconds: number;
  hintLevel: number;
  points: number;
  lat: number;
  lon: number;
}

const _tmp = new Vector3();
const _dir = new Vector3();
const _jitter = new Vector3();
const _jitterDir = new Vector3();

/** Half-angle of the level-1 bearing wedge. */
export const WEDGE_HALF_ANGLE = Math.PI / 4;

/** Exploration grid: 1.4° cells, and how far the snake "sees" as it travels. */
const EXPLORE_CELL = 1.40625;
const EXPLORE_COLS = 256;
const EXPLORE_ROWS = 128;
const EXPLORE_RADIUS_DEG = 4.5;

export class Session {
  readonly snake: Snake;
  readonly ships: ShipFleet;
  readonly pool: TargetPool;
  readonly drift: DifficultyDrift;
  readonly routes: RouteGrid;
  readonly options: SessionOptions;

  phase: Phase = 'idle';
  score = 0;
  streak = 0;
  bestStreak = 0;
  targetIndex = 0;
  elapsed = 0;

  /** Current target and its clock. */
  target: LiveTarget | null = null;
  targetElapsed = 0;
  parSeconds = 0;
  paidHintLevel = 0;
  autoHintShown = false;

  /** Relay mode clock. */
  clock = 0;
  /** Grand Tour: did the player actually finish the list? */
  tourCompleted = false;

  private readonly dailyPlan: LiveTarget[] = [];
  private readonly tourList: LiveTarget[] = [];
  private readonly tourFound = new Set<string>();
  private hintBearingOffset = 0;
  private readonly hintRingCentre = new Vector3(1, 0, 0);
  private readonly explored: Uint8Array | null;
  private exploredWeight = 0;
  private readonly exploredTotal: number;
  readonly log: RunLogEntry[] = [];
  /** Trail snapshot for the share card: [lat, lon, climate] triples. */
  readonly traceLat: number[] = [];
  readonly traceLon: number[] = [];
  readonly traceClimate: number[] = [];
  private traceAccum = 0;

  /** Set >0 after a capture: the world runs slow while the new prompt lands. */
  captureSlowdown = 0;
  shipBoost = 0;

  private rng: () => number;
  private events: SessionEvents = {};

  constructor(
    private readonly world: WorldData,
    records: TargetRecord[],
    options: SessionOptions,
  ) {
    this.options = {
      dailyLength: 10,
      relaySeconds: 120,
      relayBonusSeconds: 8,
      maxHintLevel: MAX_HINT_LEVEL,
      ...options,
    };
    this.rng = mulberry32(this.options.seed ?? (Math.random() * 2 ** 32) >>> 0);
    this.pool = new TargetPool(records, world);
    this.routes = new RouteGrid(world);
    this.drift = new DifficultyDrift(DECKS[this.options.deck]);
    this.snake = new Snake(world, this.options.snake);
    this.ships = new ShipFleet(world);

    if (this.options.trackExploration) {
      this.explored = new Uint8Array(EXPLORE_COLS * EXPLORE_ROWS);
      let total = 0;
      for (let row = 0; row < EXPLORE_ROWS; row++) {
        const rowLat = 90 - (row + 0.5) * EXPLORE_CELL;
        total += Math.max(0.05, Math.cos((rowLat * Math.PI) / 180)) * EXPLORE_COLS;
      }
      this.exploredTotal = total;
    } else {
      this.explored = null;
      this.exploredTotal = 0;
    }
  }

  setEvents(e: SessionEvents): void {
    this.events = e;
  }

  get deckRule() {
    return DECKS[this.options.deck];
  }

  get maxHint(): number {
    return this.options.maxHintLevel ?? MAX_HINT_LEVEL;
  }

  /** Visible hint level: paid hints, plus the free one the game gives away. */
  get hintLevel(): number {
    return Math.max(this.paidHintLevel, this.autoHintShown ? 1 : 0);
  }

  /**
   * The target's nominal worth: what it pays for an on-par, hint-free find.
   *
   * Hint prices are quoted against *this*, not against what the target is worth
   * right now. Pricing against the decaying live value would mean the longer
   * you flounder the cheaper help becomes — which rewards stalling and quietly
   * inverts the whole point of a hint economy.
   */
  get nominalValue(): number {
    if (!this.target) return 0;
    return Math.round(TIER_BASE[Math.min(Math.max(this.target.tier, 1), 5)] * streakMultiplier(this.streak));
  }

  /** What the *next* hint press would cost, in points. */
  get nextHintCost(): number {
    if (!this.target || this.paidHintLevel >= this.maxHint) return 0;
    const drop = hintMultiplier(this.paidHintLevel) - hintMultiplier(this.paidHintLevel + 1);
    return Math.round(this.nominalValue * drop);
  }

  /**
   * What this target is currently worth. Hint costs are quoted against the
   * target's *original* value, so stalling never makes a hint cheaper — you
   * cannot wait out the price.
   */
  projectedValue(hintLevel = this.paidHintLevel): number {
    if (!this.target) return 0;
    return scoreCapture(this.target.tier, this.targetElapsed, this.parSeconds, hintLevel, this.streak).total;
  }

  start(): void {
    this.score = 0;
    this.streak = 0;
    this.bestStreak = 0;
    this.targetIndex = 0;
    this.elapsed = 0;
    this.log.length = 0;
    this.traceLat.length = 0;
    this.traceLon.length = 0;
    this.traceClimate.length = 0;
    this.clock = this.options.relaySeconds ?? 120;
    this.tourCompleted = false;
    this.pool.resetUsed();
    this.drift.reset();
    this.ships.reset();
    this.captureSlowdown = 0;
    this.shipBoost = 0;
    if (this.explored) { this.explored.fill(0); this.exploredWeight = 0; }
    this.tourFound.clear();
    if (this.options.mode === 'daily') this.buildDailyPlan();
    if (this.options.mode === 'tour') this.buildTour();

    const spawn = this.findSpawn();
    this.snake.reset(spawn.position, spawn.heading);
    // The Grand Tour waits for the player to say go; everything else starts.
    this.phase = this.options.mode === 'tour' ? 'ready' : 'playing';
    this.nextTarget();
  }

  /** Leave the study period and start the clock. */
  beginPlay(): void {
    if (this.phase === 'ready') this.phase = 'playing';
  }

  /**
   * Spawn somewhere pleasant: on land, away from ice, and in the tropics-to-
   * temperate band. Waking up in the middle of the Southern Ocean with no
   * landmark in sight is a terrible first ten seconds.
   */
  private findSpawn(): { position: Vector3; heading: Vector3 } {
    for (let i = 0; i < 400; i++) {
      const lat = (this.rng() * 100 - 50);
      const lon = (this.rng() * 360 - 180);
      const p = fromLatLon(lat, lon);
      const t = this.world.terrainAt(p);
      if (isWater(t) || t === Terrain.Ice || t === Terrain.Mountain) continue;
      // Inside a named country, not on an unclaimed speck: the first thing the
      // HUD says is "You are in —", and it should say somewhere.
      if (this.world.countryAt(p) === 0) continue;
      const h = new Vector3();
      tangentToward(p, fromLatLon(lat + 10, lon), h);
      return { position: p, heading: h };
    }
    const p = fromLatLon(0, 20);
    return { position: p, heading: tangentToward(p, fromLatLon(10, 20)) };
  }

  /**
   * The daily gauntlet.
   *
   * "Everyone on Earth got these ten, in this order" has to be literally true
   * or the share card is a lie. So the daily plan is drawn up front from the
   * date seed alone, on a fixed tier ladder, with no reference to the player's
   * trail or performance — the adaptive difficulty and the trail-obstruction
   * bias that make free play interesting are exactly what would make a daily
   * diverge between two people.
   */
  private buildDailyPlan(): void {
    this.dailyPlan.length = 0;
    const ladder = [1, 1, 2, 2, 3, 3, 4, 4, 5, 5];
    const n = this.options.dailyLength ?? 10;
    const taken = new Set<string>();
    for (let i = 0; i < n; i++) {
      const tier = ladder[i % ladder.length];
      const t = this.pool.pickPure(tier, this.rng, taken);
      if (t) { taken.add(t.id); this.dailyPlan.push(t); }
    }
  }

  /** The Grand Tour list: a fixed spread of tiers, seeded, shown up front. */
  private buildTour(): void {
    this.tourList.length = 0;
    const n = this.options.tourLength ?? 20;
    const taken = new Set<string>();
    // Weighted toward the middle tiers: twenty places nobody has heard of is a
    // slog, and twenty countries is a lap of honour.
    const ladder = [1, 2, 2, 3, 3, 4];
    for (let i = 0; i < n; i++) {
      const t = this.pool.pickPure(ladder[i % ladder.length], this.rng, taken);
      if (t) { taken.add(t.id); this.tourList.push(t); }
    }
  }

  /** Remaining Grand Tour places, in the order they were listed. */
  get tourRemaining(): LiveTarget[] {
    return this.tourList.filter((t) => !this.tourFound.has(t.id));
  }

  get tourAll(): LiveTarget[] {
    return this.tourList;
  }

  isTourFound(id: string): boolean {
    return this.tourFound.has(id);
  }

  /** Whichever unfound place is nearest — what the hint system aims at. */
  private nearestTourTarget(): LiveTarget | null {
    let best: LiveTarget | null = null;
    let bestDot = -2;
    for (const t of this.tourList) {
      if (this.tourFound.has(t.id)) continue;
      const d = this.snake.position.dot(t.position);
      if (d > bestDot) { bestDot = d; best = t; }
    }
    return best;
  }

  private nextTarget(): void {
    if (this.options.mode === 'tour') {
      // Every remaining place is live at once; the "target" is only the nearest
      // one, so hints and the bearing wedge have something to point at.
      const t = this.nearestTourTarget();
      if (!t) { this.finish(); return; }
      this.target = t;
      this.targetElapsed = 0;
      this.paidHintLevel = 0;
      this.autoHintShown = false;
      this.rollHintJitter(t);
      this.parSeconds = this.routes.routeCostDeg(this.snake.position, t.position)
        / this.snake.cfg.baseSpeedDeg + RECOGNITION_GRACE;
      this.events.onTarget?.(t, this.targetIndex, this.tourList.length);
      return;
    }

    const t = this.options.mode === 'daily'
      ? this.dailyPlan[this.targetIndex] ?? null
      : this.pool.pick(this.drift.tier, this.snake, this.rng);
    if (!t) { this.finish(); return; }
    this.target = t;
    this.targetElapsed = 0;
    this.paidHintLevel = 0;
    this.autoHintShown = false;
    this.rollHintJitter(t);

    // Par is the terrain-aware best route, not the straight line: 2,000 km over
    // the Himalayas is not the same problem as 2,000 km over the steppe, and
    // scoring both the same would make spawn geometry beat skill.
    const costDeg = this.routes.routeCostDeg(this.snake.position, t.position);
    this.parSeconds = costDeg / this.snake.cfg.baseSpeedDeg + RECOGNITION_GRACE;

    this.events.onTarget?.(t, this.targetIndex, this.parSeconds);
  }

  /** Advance the paid hint ladder. Returns the new level. */
  requestHint(): number {
    if (this.phase !== 'playing' || !this.target) return this.paidHintLevel;
    if (this.paidHintLevel >= this.maxHint) return this.paidHintLevel;
    const cost = this.nextHintCost;
    this.paidHintLevel++;
    this.events.onHint?.(this.paidHintLevel, cost);
    return this.paidHintLevel;
  }

  pause(): void {
    if (this.phase === 'playing') this.phase = 'paused';
    else if (this.phase === 'paused') this.phase = 'playing';
  }

  private finish(): void {
    this.phase = 'finished';
    this.events.onFinish?.();
  }

  /** Fixed-timestep update. Returns the steering actually applied. */
  update(dt: number, input: SteerInput): void {
    if (this.phase !== 'playing' && this.phase !== 'captured') return;

    this.elapsed += dt;

    // Post-capture beat: a quarter-speed second and a bit while the next prompt
    // arrives, so reading the new target is never a fight with the controls.
    if (this.captureSlowdown > 0) {
      this.captureSlowdown = Math.max(0, this.captureSlowdown - dt);
      this.snake.speedScale = 0.25 + 0.75 * (1 - this.captureSlowdown / 1.25);
      if (this.captureSlowdown === 0) this.phase = 'playing';
    } else {
      this.snake.speedScale = 1;
    }

    if (this.shipBoost > 0) {
      this.shipBoost = Math.max(0, this.shipBoost - dt);
      this.snake.speedScale *= 1.25;
    }

    this.snake.update(dt, input);

    if (!this.snake.alive) {
      this.phase = 'dead';
      this.events.onDeath?.();
      return;
    }

    this.recordTrace(dt);
    this.ships.update(dt, this.snake.position, this.rng, this.elapsed);

    const caught = this.ships.consumeAt(this.snake.position);
    if (caught) {
      // Fuel, not points. As a score bonus a ship competed with the actual
      // objective and muddied the leaderboard; as a boost refill it is purely a
      // tactical prize — worth detouring for when you are empty and heading
      // somewhere far, worth ignoring when you are not.
      const before = this.snake.boostStamina;
      this.snake.boostStamina = Math.min(
        this.snake.cfg.boostCapacity,
        before + this.snake.cfg.boostCapacity * SHIP_BOOST_REFILL,
      );
      this.shipBoost = SHIP_BOOST_SECONDS;
      this.events.onShip?.(caught, this.snake.boostStamina - before);
    }

    if (this.options.mode === 'relay') {
      this.clock -= dt;
      if (this.clock <= 0) { this.clock = 0; this.finish(); return; }
    }

    if (!this.target || this.phase !== 'playing') return;
    this.targetElapsed += dt;

    // On the Grand Tour every unfound place is live, so check them all — and
    // keep the nearest one nominated so the hint has something to aim at.
    if (this.options.mode === 'tour') {
      for (const t of this.tourList) {
        if (this.tourFound.has(t.id)) continue;
        if (isCaptured(t, this.snake.position, this.world)) { this.target = t; this.capture(); return; }
      }
      const near = this.nearestTourTarget();
      if (near && near !== this.target && this.paidHintLevel === 0) {
        this.target = near;
        this.parSeconds = this.routes.routeCostDeg(this.snake.position, near.position)
          / this.snake.cfg.baseSpeedDeg + RECOGNITION_GRACE;
        this.events.onTarget?.(near, this.targetIndex, this.tourList.length);
      }
      return;
    }

    // The promise that you can never get stuck. At twice par the free hint
    // arrives on its own and costs nothing — the escape hatch must not require
    // the player to admit defeat and press a button for it.
    if (!this.autoHintShown && this.paidHintLevel === 0 && this.targetElapsed > this.parSeconds * 2) {
      this.autoHintShown = true;
      this.events.onHint?.(1, 0);
    }

    if (isCaptured(this.target, this.snake.position, this.world)) this.capture();
  }

  /**
   * Mark the ground around the snake as seen.
   *
   * Terra Incognita hides the world until you have been there, so "how much of
   * the planet did you actually uncover" is a real achievement and a separate
   * axis from score — you can post a huge score by shuttling between two known
   * places, and that is a different run from one that crossed an ocean to look.
   *
   * Cells are cos-weighted, or an equirectangular grid would score a lap of
   * Antarctica as most of the world.
   */
  private markExplored(): void {
    const grid = this.explored;
    if (!grid) return;
    const p = this.snake.position;
    const lat = Math.asin(Math.max(-1, Math.min(1, p.y))) * (180 / Math.PI);
    const lon = Math.atan2(-p.z, p.x) * (180 / Math.PI);
    const r = EXPLORE_RADIUS_DEG;

    const rowSpan = Math.ceil(r / EXPLORE_CELL);
    const centreRow = Math.floor((90 - lat) / EXPLORE_CELL);
    for (let dr = -rowSpan; dr <= rowSpan; dr++) {
      const row = centreRow + dr;
      if (row < 0 || row >= EXPLORE_ROWS) continue;
      const rowLat = 90 - (row + 0.5) * EXPLORE_CELL;
      const dLat = Math.abs(rowLat - lat);
      if (dLat > r) continue;
      // Half-width of the disc at this latitude, widened by 1/cos(lat).
      const half = Math.sqrt(Math.max(0, r * r - dLat * dLat));
      const cos = Math.max(0.05, Math.cos((rowLat * Math.PI) / 180));
      const lonHalf = Math.min(180, half / cos);
      const colSpan = Math.ceil(lonHalf / EXPLORE_CELL);
      const centreCol = Math.floor((lon + 180) / EXPLORE_CELL);
      for (let dc = -colSpan; dc <= colSpan; dc++) {
        const col = ((centreCol + dc) % EXPLORE_COLS + EXPLORE_COLS) % EXPLORE_COLS;
        const i = row * EXPLORE_COLS + col;
        if (grid[i]) continue;
        grid[i] = 1;
        this.exploredWeight += cos;
      }
    }
  }

  /** Fraction of the globe's surface uncovered, 0..1. */
  get exploredFraction(): number {
    return this.exploredTotal > 0 ? this.exploredWeight / this.exploredTotal : 0;
  }

  private recordTrace(dt: number): void {
    // ~4 samples/second is plenty for a share-card polyline and keeps a
    // fifteen-minute run under 4,000 points.
    this.traceAccum += dt;
    if (this.traceAccum < 0.25) return;
    this.traceAccum = 0;
    this.markExplored();
    const p = this.snake.position;
    this.traceLat.push(Math.asin(Math.max(-1, Math.min(1, p.y))) * (180 / Math.PI));
    this.traceLon.push(Math.atan2(-p.z, p.x) * (180 / Math.PI));
    this.traceClimate.push(this.snake.surface.climate);
  }

  private capture(): void {
    const t = this.target!;
    const breakdown = scoreCapture(
      t.tier, this.targetElapsed, this.parSeconds, this.paidHintLevel, this.streak,
    );
    this.score += breakdown.total;

    if (this.paidHintLevel === 0) {
      this.streak++;
      this.bestStreak = Math.max(this.bestStreak, this.streak);
    } else if (this.paidHintLevel >= 2) {
      this.streak = 0;
    }

    this.log.push({
      name: t.name,
      tier: t.tier,
      seconds: this.targetElapsed,
      parSeconds: this.parSeconds,
      hintLevel: this.paidHintLevel,
      points: breakdown.total,
      lat: t.lat,
      lon: t.lon,
    });

    this.snake.grow(GROWTH_PER_CAPTURE_DEG * this.deckRule.growthMultiplier);
    this.drift.record(breakdown.beatPar, this.paidHintLevel, false);
    this.pool.markUsed(t.id);

    if (this.options.mode === 'relay') {
      this.clock += this.options.relayBonusSeconds ?? 8;
    }

    this.events.onCapture?.({
      target: t, breakdown, totalScore: this.score, index: this.targetIndex,
    });

    this.targetIndex++;
    this.captureSlowdown = 1.25;
    this.phase = 'captured';

    if (this.options.mode === 'daily' && this.targetIndex >= (this.options.dailyLength ?? 10)) {
      this.target = null;
      this.finish();
      return;
    }
    if (this.options.mode === 'tour') {
      this.tourFound.add(t.id);
      if (this.tourFound.size >= this.tourList.length) {
        this.target = null;
        this.tourCompleted = true;
        this.finish();
        return;
      }
    }
    this.nextTarget();
  }

  // --- readouts for the HUD -------------------------------------------------

  /** Free, always on: the game's quiet geography teacher. */
  get locationName(): string {
    return this.world.countryNameAt(this.snake.position);
  }

  /**
   * A breakdown of why the snake is going the speed it is.
   *
   * The terrain model was the least legible thing in the game: you would grind
   * to a crawl in the Andes with nothing on screen saying why, and the whole
   * point of terrain is that it is a decision you make on purpose. Elevation
   * relief shows it geographically; this shows it numerically.
   */
  speedReadout(): { total: number; parts: { label: string; factor: number }[] } {
    const parts: { label: string; factor: number }[] = [];
    const t = this.snake.surface.terrain;
    const base = TERRAIN_SPEED[t] ?? 1;
    parts.push({ label: TERRAIN_NAME[t], factor: base });

    const code = this.snake.surface.elevation;
    if (code > SEA_LEVEL_CODE) {
      const km = elevationMetres(code) / 1000;
      const alt = 1 - Math.min(km * 0.028, 0.2);
      if (alt < 0.995) parts.push({ label: `${Math.round(km * 1000)} m up`, factor: alt });
    }
    if (this.snake.wake.active) parts.push({ label: 'Drafting', factor: 1.3 });
    if (this.shipBoost > 0) parts.push({ label: 'Ship surge', factor: 1.25 });
    if (this.captureSlowdown > 0) parts.push({ label: 'Found it', factor: this.snake.speedScale });

    const wind = this.snake.wind.length();
    if (wind > 0.05) {
      // Signed: a following wind helps, a headwind is a tax, and the player
      // needs to know which one they are in without guessing.
      const along = this.snake.wind.dot(this.snake.heading) / this.snake.cfg.baseSpeedDeg;
      parts.push({ label: along >= 0 ? 'Tailwind' : 'Headwind', factor: 1 + along });
    }

    let total = 1;
    for (const p of parts) total *= p.factor;
    return { total, parts };
  }

  get distanceToTargetKm(): number {
    if (!this.target) return 0;
    return angleBetween(this.snake.position, this.target.position) * EARTH_RADIUS_KM;
  }

  get bearingToTarget(): number {
    if (!this.target) return 0;
    return bearingDeg(this.snake.position, this.target.position);
  }

  /**
   * Bearing for the hint wedge — deliberately *not* the true bearing.
   *
   * A 90° cone drawn straight at the answer puts the answer on its centreline,
   * so the wedge stops being "somewhere over there" and becomes an arrow. The
   * cone is swung by a fixed offset drawn once per target, so the target is
   * reliably inside it but never at its middle. Fixed rather than per-frame,
   * because a wedge that wobbled would average out to the truth in seconds.
   */
  targetTangent(out = _dir): Vector3 {
    if (!this.target) return out.set(0, 1, 0);
    tangentToward(this.snake.position, this.target.position, out);
    turn(this.snake.position, out, this.hintBearingOffset);
    return out;
  }

  /**
   * Centre of the level-2 search circle — offset from the target for the same
   * reason. A circle centred on the answer is a bullseye, and at 1,500 km it
   * was a smaller bullseye than most countries.
   */
  get searchCentre(): Vector3 {
    return this.target ? this.hintRingCentre : this.snake.position;
  }

  /** Draw this target's hint offsets. Called once, when the target is set. */
  private rollHintJitter(t: LiveTarget): void {
    // Magnitude is drawn away from zero, not uniformly across it. A uniform
    // offset still lands near-centred a good fraction of the time, and one
    // near-centred cone teaches the player to read the centreline as the
    // answer — which then makes every *later* cone more useful than intended.
    const sign = this.rng() < 0.5 ? -1 : 1;
    this.hintBearingOffset = sign * (0.4 + this.rng() * 0.55) * WEDGE_HALF_ANGLE * 0.68;

    _jitter.copy(t.position);
    anyTangent(_jitter, _jitterDir);
    turn(_jitter, _jitterDir, this.rng() * Math.PI * 2);
    // Far enough off-centre to matter, close enough that the target stays
    // comfortably inside the drawn circle.
    step(_jitter, _jitterDir, this.searchRadiusRad * (0.42 + this.rng() * 0.3));
    this.hintRingCentre.copy(_jitter).normalize();
  }

  /**
   * Coarse range for hint level 1, as a phrase.
   *
   * This used to be an annulus painted on the globe, which for a nearby target
   * collapsed into a bright donut around the snake and was indistinguishable
   * from the bearing cone it sat inside. Words carry the same information
   * without competing with the one overlay that has a direction in it — and
   * they stay deliberately coarse, because this hint narrows the search rather
   * than solving it.
   */
  distanceBandLabel(): string {
    if (!this.target) return '';
    const a = angleBetween(this.snake.position, this.target.position);
    if (a < 25 * DEG) return 'within 2,800 km';
    if (a < 60 * DEG) return '2,800 – 6,700 km away';
    if (a < 110 * DEG) return '6,700 – 12,200 km away';
    return 'over 12,200 km away — the far side';
  }

  /** Hint level 2's search circle: 1,500 km around the truth. */
  get searchRadiusRad(): number {
    return 1500 / EARTH_RADIUS_KM;
  }

  get relayRemaining(): number {
    return this.options.mode === 'relay' ? this.clock : 0;
  }

  get dailyTotal(): number {
    return this.options.dailyLength ?? 10;
  }

  /**
   * Country index the hint should highlight, or 0.
   *
   * Level 3 only. Lighting up the whole country at level 2 *was* the answer for
   * a country target, which made the middle rung of the ladder strictly better
   * value than the top one.
   */
  get highlightCountry(): number {
    if (!this.target || this.hintLevel < 3) return 0;
    return this.target.captureCountry;
  }

  headPosition(): Vector3 {
    return _tmp.copy(this.snake.position);
  }
}

export function dailySeedFor(date = new Date()): number {
  return todaySeed(date);
}
