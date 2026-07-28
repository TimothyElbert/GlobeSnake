import { Vector3 } from 'three';
import { angleToArc, anyTangent, clamp, DEG, reorthonormalize, step, turn } from './sphere';
import { makeSample, TERRAIN_STAMINA_DRAIN, TERRAIN_TURN_INERTIA, Terrain, WorldData, type SurfaceSample } from './world';

/**
 * Trail policy.
 *
 * `growing` is classic Snake: the body is a fixed length that grows on capture
 * and the tail vacates behind you. `permanent` never releases a node — the path
 * you have drawn is a wall for the rest of the run.
 *
 * Both exist because the council was right that a short body on a continent-sized
 * globe never threatens you and the game decays into a quiz with a cursor — but
 * the fix that keeps this *Snake* is a small world plus aggressive growth, not
 * throwing out the tail rule. So Expedition and Tempest run `growing` with a
 * ~50-second equatorial lap and +10° of body per capture (by capture ten your
 * body spans a third of the planet), and Terra Incognita runs `permanent`, where
 * an indelible line is the entire point of the fiction.
 */
export type TrailMode = 'growing' | 'permanent';

export interface SnakeConfig {
  /** Degrees of arc per second at full health on flat plains. */
  baseSpeedDeg: number;
  /** Maximum steering authority, degrees per second. */
  turnRateDeg: number;
  /** Half-width of the lethal body, in degrees of arc. */
  collisionRadiusDeg: number;
  /** How much of the body immediately behind the head cannot kill you. */
  neckGapDeg: number;
  /** Distance between stored trail samples. Sets ribbon smoothness and cost. */
  nodeSpacingDeg: number;
  startBodyDeg: number;
  growthPerCaptureDeg: number;
  maxBodyDeg: number;
  boostMultiplier: number;
  brakeMultiplier: number;
  /** Seconds of continuous boost available from full. */
  boostCapacity: number;
  boostRecoveryPerSec: number;
  trailMode: TrailMode;
  capacity: number;
}

export const DEFAULT_SNAKE_CONFIG: SnakeConfig = {
  // A ~100 s equatorial lap. The council's instinct — make the world small so
  // the body is a real threat — was right, but the first cut at 50 s was too
  // fast for the *other* half of the game: a typical hop is 80° of arc, and at
  // 50 s per lap that is eleven seconds, which is not enough time to remember
  // where Montevideo is. Danger from the body is spatial, not temporal, so
  // halving the speed keeps every bit of the threat and buys back the thinking.
  baseSpeedDeg: 3.6,
  // Turn radius = speed / turnRate ≈ 1.5°, a bit over three body-widths. At the
  // original 220°/s the snake could turn a complete circle inside its own
  // width, which is both unkillable and looks broken.
  turnRateDeg: 135,
  // ~138 km across. Wide enough to read as a body from the chase camera —
  // at 0.42 it was a thread on screen — and still far inside the 1.5° turn
  // radius, so the snake never clips itself simply by cornering.
  collisionRadiusDeg: 0.62,
  neckGapDeg: 2.6,
  nodeSpacingDeg: 0.12,
  // Long enough to read as an animal from the chase camera. At 7° the snake
  // was barely six body-widths and looked like a lozenge, not a snake.
  startBodyDeg: 14,
  growthPerCaptureDeg: 10,
  maxBodyDeg: 320,
  boostMultiplier: 1.35,
  brakeMultiplier: 0.7,
  boostCapacity: 3.2,
  boostRecoveryPerSec: 0.42,
  trailMode: 'growing',
  capacity: 60000,
};

export interface SteerInput {
  /** -1 hard left … +1 hard right. */
  turn: number;
  boost: boolean;
  brake: boolean;
}

export interface WakeState {
  /** 0…1 draft charge. */
  charge: number;
  active: boolean;
  /** Index of the body node being drafted, or -1. */
  targetNode: number;
}

const _v = new Vector3();
const _w = new Vector3();
const _seg = new Vector3();
const _windDir = new Vector3();
const _windAxis = new Vector3();

/**
 * Uniform spatial hash over the unit sphere.
 *
 * Deliberately a 3D grid on the unit vector rather than lat/lon bins: lat/lon
 * cells collapse to slivers near the poles, so a lat/lon hash degenerates into
 * a linear scan exactly where Arctic play happens.
 */
class SphereHash {
  private readonly cells = new Map<number, number[]>();
  private readonly inv: number;

  constructor(cellSize: number) {
    this.inv = 1 / cellSize;
  }

  private key(x: number, y: number, z: number): number {
    const ix = Math.floor(x * this.inv) + 512;
    const iy = Math.floor(y * this.inv) + 512;
    const iz = Math.floor(z * this.inv) + 512;
    return (ix * 1024 + iy) * 1024 + iz;
  }

  insert(x: number, y: number, z: number, id: number): void {
    const k = this.key(x, y, z);
    const bucket = this.cells.get(k);
    if (bucket) bucket.push(id);
    else this.cells.set(k, [id]);
  }

  /** Visit every id in the 27 cells around the point. */
  forEachNear(x: number, y: number, z: number, fn: (id: number) => void): void {
    const bx = Math.floor(x * this.inv) + 512;
    const by = Math.floor(y * this.inv) + 512;
    const bz = Math.floor(z * this.inv) + 512;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = this.cells.get(((bx + dx) * 1024 + (by + dy)) * 1024 + (bz + dz));
          if (bucket) for (let i = 0; i < bucket.length; i++) fn(bucket[i]);
        }
      }
    }
  }

  /** Drop ids below `minId`. Called rarely; keeps buckets from growing forever. */
  prune(minId: number): void {
    for (const [k, bucket] of this.cells) {
      let w = 0;
      for (let i = 0; i < bucket.length; i++) {
        if (bucket[i] >= minId) bucket[w++] = bucket[i];
      }
      if (w === 0) this.cells.delete(k);
      else bucket.length = w;
    }
  }

  clear(): void {
    this.cells.clear();
  }
}

export class Snake {
  readonly cfg: SnakeConfig;
  readonly position = new Vector3(1, 0, 0);
  readonly heading = new Vector3(0, 1, 0);

  /** Trail node positions, xyz triples, indexed 0..writeIndex-1 (never wraps). */
  private readonly nodes: Float32Array;
  /** Climate class at the moment each node was laid down — the body's memory. */
  private readonly nodeClimate: Uint8Array;
  private writeIndex = 0;
  private tailIndex = 0;
  private readonly hash: SphereHash;
  private lastPrune = 0;

  bodyLengthDeg: number;
  alive = true;
  /** Seconds since spawn during which collision is disabled. */
  spawnGrace = 1.2;
  boostStamina: number;
  speedScale = 1;         // external multiplier (post-capture slow-mo, wind, etc.)
  distanceTravelledKm = 0;

  readonly wake: WakeState = { charge: 0, active: false, targetNode: -1 };
  readonly surface: SurfaceSample = makeSample();

  private turnVelocity = 0;   // degrees/sec, smoothed for the ice-inertia model
  private sinceNode = 0;      // arc travelled since the last node was written

  constructor(private readonly world: WorldData, cfg: Partial<SnakeConfig> = {}) {
    this.cfg = { ...DEFAULT_SNAKE_CONFIG, ...cfg };
    this.nodes = new Float32Array(this.cfg.capacity * 3);
    this.nodeClimate = new Uint8Array(this.cfg.capacity);
    this.bodyLengthDeg = this.cfg.startBodyDeg;
    this.boostStamina = this.cfg.boostCapacity;
    // Cell a little larger than the collision diameter so a query never has to
    // look past the immediate 3×3×3 neighbourhood.
    this.hash = new SphereHash(Math.max(this.cfg.collisionRadiusDeg * DEG * 3, 0.01));
  }

  reset(position: Vector3, heading?: Vector3): void {
    this.position.copy(position).normalize();
    if (heading) this.heading.copy(heading);
    else anyTangent(this.position, this.heading);
    reorthonormalize(this.position, this.heading);

    this.writeIndex = 0;
    this.tailIndex = 0;
    this.lastPrune = 0;
    this.sinceNode = 0;
    this.turnVelocity = 0;
    this.hash.clear();
    this.bodyLengthDeg = this.cfg.startBodyDeg;
    this.boostStamina = this.cfg.boostCapacity;
    this.speedScale = 1;
    this.alive = true;
    this.spawnGrace = 1.2;
    this.distanceTravelledKm = 0;
    this.wake.charge = 0;
    this.wake.active = false;
    this.wake.targetNode = -1;
    this.pushNode();
  }

  get nodeCount(): number {
    return this.writeIndex;
  }

  get firstBodyNode(): number {
    return this.tailIndex;
  }

  /** Copy node `i`'s position into `out`. */
  nodeAt(i: number, out: Vector3): Vector3 {
    const o = i * 3;
    return out.set(this.nodes[o], this.nodes[o + 1], this.nodes[o + 2]);
  }

  climateAtNode(i: number): number {
    return this.nodeClimate[i];
  }

  grow(deg: number): void {
    this.bodyLengthDeg = Math.min(this.bodyLengthDeg + deg, this.cfg.maxBodyDeg);
  }

  private pushNode(): void {
    if (this.writeIndex >= this.cfg.capacity) {
      // In `permanent` mode nothing is ever retired, so compacting would free
      // nothing and loop forever. Stop recording instead: the run is already
      // longer than the buffer was ever meant to hold, and dropping new samples
      // is far better than a hang.
      if (this.tailIndex === 0) return;
      // Otherwise retire the oldest nodes; in `growing` mode they are far
      // outside the body anyway.
      this.compact();
    }
    const o = this.writeIndex * 3;
    this.nodes[o] = this.position.x;
    this.nodes[o + 1] = this.position.y;
    this.nodes[o + 2] = this.position.z;
    this.nodeClimate[this.writeIndex] = this.surface.climate;
    this.hash.insert(this.position.x, this.position.y, this.position.z, this.writeIndex);
    this.writeIndex++;
  }

  private compact(): void {
    const keep = this.writeIndex - this.tailIndex;
    this.nodes.copyWithin(0, this.tailIndex * 3, this.writeIndex * 3);
    this.nodeClimate.copyWithin(0, this.tailIndex, this.writeIndex);
    this.hash.clear();
    for (let i = 0; i < keep; i++) {
      const o = i * 3;
      this.hash.insert(this.nodes[o], this.nodes[o + 1], this.nodes[o + 2], i);
    }
    this.writeIndex = keep;
    this.tailIndex = 0;
    this.lastPrune = 0;
  }

  /** One fixed simulation tick. `dt` is always the same value; see GameLoop. */
  update(dt: number, input: SteerInput): void {
    if (!this.alive) return;

    this.world.sample(this.position, this.surface);
    const terrain = this.surface.terrain;

    // --- steering -----------------------------------------------------------
    // Ice does not take away input authority (that reads as a broken control);
    // it adds momentum, so the commanded turn arrives late and leaves late.
    const commanded = clamp(input.turn, -1, 1) * this.cfg.turnRateDeg;
    const inertia = TERRAIN_TURN_INERTIA[terrain] ?? 0.05;
    const blend = 1 - Math.exp(-dt / Math.max(inertia, 1e-3));
    this.turnVelocity += (commanded - this.turnVelocity) * blend;

    // --- throttle -----------------------------------------------------------
    let speedMul = this.world.speedAt(this.position) * this.speedScale;
    let boosting = false;
    if (input.boost && this.boostStamina > 0) {
      boosting = true;
      speedMul *= this.cfg.boostMultiplier;
      this.boostStamina = Math.max(0, this.boostStamina - dt * (TERRAIN_STAMINA_DRAIN[terrain] ?? 1));
    } else if (input.brake) {
      speedMul *= this.cfg.brakeMultiplier;
    }
    if (!boosting) {
      this.boostStamina = Math.min(this.cfg.boostCapacity, this.boostStamina + dt * this.cfg.boostRecoveryPerSec);
    }

    // Boost widens the turning circle and braking tightens it, so speed is a
    // real trade rather than a free win.
    let turnScale = 1;
    if (boosting) turnScale = 0.8;
    else if (input.brake) turnScale = 1.15;

    if (this.wake.active) speedMul *= 1.3;

    // --- integrate ----------------------------------------------------------
    turn(this.position, this.heading, this.turnVelocity * turnScale * DEG * dt);
    const arc = this.cfg.baseSpeedDeg * speedMul * DEG * dt;
    step(this.position, this.heading, arc);
    this.applyWind(dt);
    reorthonormalize(this.position, this.heading);
    this.distanceTravelledKm += arc * 6371;

    // --- trail --------------------------------------------------------------
    this.sinceNode += arc;
    const spacing = this.cfg.nodeSpacingDeg * DEG;
    if (this.sinceNode >= spacing) {
      this.sinceNode -= spacing;
      this.world.sample(this.position, this.surface);
      this.pushNode();
    }

    if (this.cfg.trailMode === 'growing') {
      const bodyNodes = Math.max(2, Math.ceil(this.bodyLengthDeg / this.cfg.nodeSpacingDeg));
      this.tailIndex = Math.max(0, this.writeIndex - bodyNodes);
      if (this.tailIndex - this.lastPrune > 512) {
        this.hash.prune(this.tailIndex);
        this.lastPrune = this.tailIndex;
      }
    }

    if (this.spawnGrace > 0) this.spawnGrace -= dt;

    this.updateWake(dt);
    if (this.spawnGrace <= 0 && this.checkSelfCollision()) this.alive = false;
  }

  /**
   * External advection — wind and ocean current, used by Tempest.
   *
   * Set `wind` to a tangent vector at the head whose magnitude is degrees of
   * arc per second. The snake is *carried* rather than steered: position moves,
   * heading is parallel-transported, and the player keeps full input authority
   * throughout. That distinction is the whole reason weather is allowed to
   * exist in this game — being pushed somewhere you did not choose is a
   * navigation problem, but being turned against your input is a broken control.
   */
  readonly wind = new Vector3(0, 0, 0);

  private applyWind(dt: number): void {
    if (this.wind.lengthSq() < 1e-14) return;
    _windDir.copy(this.wind).addScaledVector(this.position, -this.wind.dot(this.position));
    const mag = _windDir.length();
    if (mag < 1e-9) return;
    _windDir.divideScalar(mag);
    const theta = mag * DEG * dt;
    // Rotate about the axis perpendicular to both, carrying the heading with
    // the frame so the snake does not appear to crab sideways.
    _windAxis.copy(this.position).cross(_windDir).normalize();
    this.position.applyAxisAngle(_windAxis, theta);
    this.heading.applyAxisAngle(_windAxis, theta);
  }

  /**
   * Wake-riding: draft your own body for speed.
   *
   * This only works as a mechanic because the body is long enough to be a
   * hazard — the same growth that threatens you becomes the thing you surf.
   * Sit between 1.5 and 4 collision radii off a non-neck segment, aligned with
   * the direction that segment was laid down, and the meter charges.
   */
  private updateWake(dt: number): void {
    const rad = this.cfg.collisionRadiusDeg * DEG;
    const near = rad * 1.5;
    const far = rad * 4;
    const skip = Math.ceil(this.cfg.neckGapDeg / this.cfg.nodeSpacingDeg);
    const newest = this.writeIndex - 1 - skip;

    let best = -1;
    let bestAngle = Infinity;
    if (newest > this.tailIndex + 2) {
      const px = this.position.x, py = this.position.y, pz = this.position.z;
      const tail = this.tailIndex;
      this.hash.forEachNear(px, py, pz, (id) => {
        if (id > newest || id < tail + 1) return;
        const o = id * 3;
        const dot = px * this.nodes[o] + py * this.nodes[o + 1] + pz * this.nodes[o + 2];
        const a = Math.acos(clamp(dot, -1, 1));
        if (a < bestAngle) { bestAngle = a; best = id; }
      });
    }

    let aligned = false;
    if (best > 0 && bestAngle >= near && bestAngle <= far) {
      // Direction the body was travelling when it laid this node down.
      this.nodeAt(best, _v);
      this.nodeAt(best - 1, _w);
      _seg.copy(_v).sub(_w).normalize();
      aligned = _seg.dot(this.heading) > 0.8;
    }

    if (aligned) {
      this.wake.charge = Math.min(1, this.wake.charge + dt / 0.4);
      this.wake.targetNode = best;
    } else {
      this.wake.charge = Math.max(0, this.wake.charge - dt / 0.25);
      if (this.wake.charge === 0) this.wake.targetNode = -1;
    }
    this.wake.active = this.wake.charge >= 1;
  }

  /**
   * Segment-wise, not node-wise. Testing only the stored samples lets a boosting
   * head slip between two of them and pass clean through the body — rare, but
   * unforgettable when it decides a run.
   */
  private checkSelfCollision(): boolean {
    const rad = this.cfg.collisionRadiusDeg * DEG;
    const skip = Math.ceil(this.cfg.neckGapDeg / this.cfg.nodeSpacingDeg);
    const newest = this.writeIndex - 1 - skip;
    if (newest <= this.tailIndex + 1) return false;

    const px = this.position.x, py = this.position.y, pz = this.position.z;
    const tail = this.tailIndex;
    let hit = false;

    this.hash.forEachNear(px, py, pz, (id) => {
      if (hit || id > newest || id <= tail) return;
      this.nodeAt(id, _v);
      this.nodeAt(id - 1, _w);
      if (angleToArc(this.position, _w, _v) < rad) hit = true;
    });

    return hit;
  }

  /** Nearest approach to the body, for the HUD proximity warning. */
  proximityDeg(): number {
    const skip = Math.ceil(this.cfg.neckGapDeg / this.cfg.nodeSpacingDeg);
    const newest = this.writeIndex - 1 - skip;
    if (newest <= this.tailIndex + 1) return Infinity;
    let best = Infinity;
    const px = this.position.x, py = this.position.y, pz = this.position.z;
    const tail = this.tailIndex;
    this.hash.forEachNear(px, py, pz, (id) => {
      if (id > newest || id <= tail) return;
      const o = id * 3;
      const dot = px * this.nodes[o] + py * this.nodes[o + 1] + pz * this.nodes[o + 2];
      const a = Math.acos(clamp(dot, -1, 1));
      if (a < best) best = a;
    });
    return best / DEG;
  }

  /** Raw node buffer, for the ribbon builder. Read-only by convention. */
  get rawNodes(): Float32Array {
    return this.nodes;
  }

  get terrain(): Terrain {
    return this.surface.terrain;
  }
}
