import { Vector3 } from 'three';
import { EARTH_RADIUS_KM, angleBetween, fromLatLon } from '@core/sphere';
import { TERRAIN_SPEED, WorldData, elevationMetres, SEA_LEVEL_CODE, type Terrain } from '@core/world';

/**
 * Terrain-aware par times.
 *
 * Scoring against raw elapsed time is broken: whether a target is 2,000 km away
 * across plains or 2,000 km away over the Himalayas decides your score before
 * you touch a key, so spawn geometry beats skill. Par is therefore the cost of
 * the *best route the terrain allows*, found with A* over a coarse grid, and
 * your multiplier measures you against that instead of against a stopwatch.
 *
 * A happy side effect: because par already prices routing, no separate "good
 * route" bonus is needed. A second term would just pay twice for one decision.
 */

const GRID_DEG = 2;
const COLS = 360 / GRID_DEG;   // 180
const ROWS = 180 / GRID_DEG;   // 90
const CELLS = COLS * ROWS;
const MAX_SPEED = 1.18;        // fastest terrain (river); keeps the heuristic admissible

/** Minimal binary heap keyed by f-score. Avoids a dependency and any allocation. */
class MinHeap {
  private readonly ids = new Int32Array(CELLS + 1);
  private readonly keys = new Float64Array(CELLS + 1);
  private size = 0;

  clear(): void { this.size = 0; }
  get empty(): boolean { return this.size === 0; }

  push(id: number, key: number): void {
    let i = ++this.size;
    this.ids[i] = id;
    this.keys[i] = key;
    while (i > 1) {
      const p = i >> 1;
      if (this.keys[p] <= this.keys[i]) break;
      this.swap(p, i);
      i = p;
    }
  }

  pop(): number {
    const top = this.ids[1];
    this.ids[1] = this.ids[this.size];
    this.keys[1] = this.keys[this.size];
    this.size--;
    let i = 1;
    for (;;) {
      const l = i << 1;
      const r = l + 1;
      let m = i;
      if (l <= this.size && this.keys[l] < this.keys[m]) m = l;
      if (r <= this.size && this.keys[r] < this.keys[m]) m = r;
      if (m === i) break;
      this.swap(m, i);
      i = m;
    }
    return top;
  }

  private swap(a: number, b: number): void {
    const ti = this.ids[a]; this.ids[a] = this.ids[b]; this.ids[b] = ti;
    const tk = this.keys[a]; this.keys[a] = this.keys[b]; this.keys[b] = tk;
  }
}

export class RouteGrid {
  /** Speed multiplier per cell, sampled from the baked world. */
  private readonly speed = new Float32Array(CELLS);
  private readonly centres: Float32Array = new Float32Array(CELLS * 3);
  private readonly g = new Float64Array(CELLS);
  private readonly visited = new Int32Array(CELLS);
  private readonly heap = new MinHeap();
  private epoch = 0;
  private readonly scratch = new Vector3();

  constructor(world: WorldData) {
    const sample = { elevation: 0, climate: 0, terrain: 0 as Terrain, country: 0 };
    const v = new Vector3();
    for (let r = 0; r < ROWS; r++) {
      const lat = 90 - (r + 0.5) * GRID_DEG;
      for (let c = 0; c < COLS; c++) {
        const lon = -180 + (c + 0.5) * GRID_DEG;
        const i = r * COLS + c;
        fromLatLon(lat, lon, v);
        this.centres[i * 3] = v.x;
        this.centres[i * 3 + 1] = v.y;
        this.centres[i * 3 + 2] = v.z;
        world.sampleLatLon(lat, lon, sample);
        let s = TERRAIN_SPEED[sample.terrain] ?? 1;
        if (sample.elevation > SEA_LEVEL_CODE) {
          const km = elevationMetres(sample.elevation) / 1000;
          s *= 1 - Math.min(km * 0.028, 0.2);
        }
        this.speed[i] = s;
      }
    }
  }

  private cellOf(p: Vector3): number {
    const lat = Math.asin(Math.max(-1, Math.min(1, p.y))) * (180 / Math.PI);
    const lon = Math.atan2(-p.z, p.x) * (180 / Math.PI);
    let r = Math.floor((90 - lat) / GRID_DEG);
    let c = Math.floor((lon + 180) / GRID_DEG);
    if (r < 0) r = 0; else if (r >= ROWS) r = ROWS - 1;
    c = ((c % COLS) + COLS) % COLS;
    return r * COLS + c;
  }

  private centre(i: number, out: Vector3): Vector3 {
    return out.set(this.centres[i * 3], this.centres[i * 3 + 1], this.centres[i * 3 + 2]);
  }

  private arcBetween(a: number, b: number): number {
    const ax = this.centres[a * 3], ay = this.centres[a * 3 + 1], az = this.centres[a * 3 + 2];
    const bx = this.centres[b * 3], by = this.centres[b * 3 + 1], bz = this.centres[b * 3 + 2];
    const dot = Math.max(-1, Math.min(1, ax * bx + ay * by + az * bz));
    return Math.acos(dot);
  }

  /**
   * Travel time in "degrees of arc at nominal speed" from `from` to `to`,
   * following the cheapest terrain-weighted route. Multiply by the snake's
   * degrees-per-second to get seconds.
   */
  routeCostDeg(from: Vector3, to: Vector3): number {
    const start = this.cellOf(from);
    const goal = this.cellOf(to);
    if (start === goal) return angleBetween(from, to) * (180 / Math.PI);

    const stamp = ++this.epoch;
    this.heap.clear();
    this.g.fill(Infinity);
    this.g[start] = 0;
    this.centre(goal, this.scratch);
    this.heap.push(start, this.heuristic(start, goal));

    let guard = 0;
    while (!this.heap.empty) {
      const cur = this.heap.pop();
      if (this.visited[cur] === stamp) continue;
      this.visited[cur] = stamp;
      if (cur === goal) break;
      if (++guard > CELLS * 4) break;

      const r = (cur / COLS) | 0;
      const c = cur % COLS;
      for (let dr = -1; dr <= 1; dr++) {
        const nr = r + dr;
        if (nr < 0 || nr >= ROWS) continue;
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nc = ((c + dc) % COLS + COLS) % COLS;
          const n = nr * COLS + nc;
          if (this.visited[n] === stamp) continue;
          // Cost of entering the neighbour: arc length divided by its speed.
          // Averaging the two cells' speeds would let a snake "half cross" a
          // mountain wall; charging the destination is both simpler and stricter.
          const cost = this.arcBetween(cur, n) / this.speed[n];
          const ng = this.g[cur] + cost;
          if (ng < this.g[n]) {
            this.g[n] = ng;
            this.heap.push(n, ng + this.heuristic(n, goal));
          }
        }
      }
    }

    const cost = this.g[goal];
    if (!isFinite(cost)) return angleBetween(from, to) * (180 / Math.PI);
    return cost * (180 / Math.PI);
  }

  private heuristic(from: number, goal: number): number {
    return this.arcBetween(from, goal) / MAX_SPEED;
  }

  /** Straight-line surface distance, for the HUD and hint rings. */
  static directKm(a: Vector3, b: Vector3): number {
    return angleBetween(a, b) * EARTH_RADIUS_KM;
  }
}
