import {
  BoxGeometry, BufferGeometry, Color, InstancedMesh, Matrix4, MeshBasicMaterial, Object3D, Vector3,
} from 'three';
import { DEG, anyTangent, step, turn } from '@core/sphere';
import { Terrain, WorldData, isWater } from '@core/world';

/**
 * Shipping.
 *
 * Cargo and naval traffic crosses the oceans; swallow one for a flat bonus and
 * a short surge. Deliberately a garnish: the bonus is capped, it never scales
 * with tier, and ships are never placed on the route to the current target.
 * If chasing ships were ever the optimal play, the game would quietly stop
 * being about geography.
 *
 * They also do real work for legibility — a moving object with a wake gives the
 * ocean a sense of scale and speed that an empty blue field never can.
 */

const SHIP_SPEED_DEG = 0.55;
const SPAWN_MIN_DEG = 12;
const SPAWN_MAX_DEG = 46;
const DESPAWN_DEG = 70;
export const SHIP_CATCH_DEG = 1.1;

interface Ship {
  pos: Vector3;
  dir: Vector3;
  alive: boolean;
  hue: number;
  wobble: number;
}

const _probe = new Vector3();
const _probeDir = new Vector3();
const _mat = new Matrix4();
const _bin = new Vector3();

export class ShipFleet {
  readonly group = new Object3D();
  private readonly ships: Ship[] = [];
  private readonly hulls: InstancedMesh;
  private readonly wakes: InstancedMesh;
  private readonly colour = new Color();

  constructor(private readonly world: WorldData, count = 14) {
    // A blunt little hull: at the scale ships appear on screen, silhouette is
    // all that survives, and a distinct silhouette is exactly what keeps them
    // from being mistaken for a target pin.
    const hull: BufferGeometry = new BoxGeometry(0.010, 0.0022, 0.0038);
    hull.translate(0, 0.0011, 0);
    this.hulls = new InstancedMesh(hull, new MeshBasicMaterial({ vertexColors: true }), count);
    this.hulls.frustumCulled = false;
    this.hulls.renderOrder = 3;

    const wake = new BoxGeometry(0.030, 0.0004, 0.0060);
    wake.translate(-0.020, 0, 0);
    const wakeMat = new MeshBasicMaterial({ color: 0xdff2ff, transparent: true, opacity: 0.34 });
    this.wakes = new InstancedMesh(wake, wakeMat, count);
    this.wakes.frustumCulled = false;
    this.wakes.renderOrder = 2;

    this.group.add(this.wakes, this.hulls);

    for (let i = 0; i < count; i++) {
      this.ships.push({ pos: new Vector3(1, 0, 0), dir: new Vector3(0, 1, 0), alive: false, hue: 0, wobble: 0 });
    }
  }

  reset(): void {
    for (const s of this.ships) s.alive = false;
  }

  /** Try to place a ship on open water at a sensible distance from the player. */
  private spawn(ship: Ship, head: Vector3, rng: () => number): void {
    for (let attempt = 0; attempt < 24; attempt++) {
      const arc = (SPAWN_MIN_DEG + rng() * (SPAWN_MAX_DEG - SPAWN_MIN_DEG)) * DEG;
      _probe.copy(head);
      anyTangent(_probe, _probeDir);
      turn(_probe, _probeDir, rng() * Math.PI * 2);
      step(_probe, _probeDir, arc);

      if (this.world.terrainAt(_probe) !== Terrain.Ocean) continue;
      // Reject spots too near land, or the ship beaches within seconds.
      let clear = true;
      const check = _probe.clone();
      const dir = _probeDir.clone();
      for (let k = 0; k < 4; k++) {
        step(check, dir, 2 * DEG);
        if (!isWater(this.world.terrainAt(check))) { clear = false; break; }
      }
      if (!clear) continue;

      ship.pos.copy(_probe);
      ship.dir.copy(_probeDir);
      ship.alive = true;
      ship.hue = rng();
      ship.wobble = rng() * Math.PI * 2;
      return;
    }
  }

  update(dt: number, head: Vector3, rng: () => number, time: number): void {
    for (const ship of this.ships) {
      if (!ship.alive) {
        if (rng() < dt * 0.5) this.spawn(ship, head, rng);
        continue;
      }

      // Look ahead; steer away from any coastline before reaching it.
      _probe.copy(ship.pos);
      _probeDir.copy(ship.dir);
      step(_probe, _probeDir, 2.2 * DEG);
      if (!isWater(this.world.terrainAt(_probe))) {
        turn(ship.pos, ship.dir, (rng() > 0.5 ? 1 : -1) * 1.1 * dt * 60 * DEG);
      } else {
        // Gentle meander so lanes are not dead straight.
        turn(ship.pos, ship.dir, Math.sin(time * 0.4 + ship.wobble) * 6 * DEG * dt);
      }

      step(ship.pos, ship.dir, SHIP_SPEED_DEG * DEG * dt);
      ship.pos.normalize();
      ship.dir.addScaledVector(ship.pos, -ship.dir.dot(ship.pos)).normalize();

      const away = Math.acos(Math.max(-1, Math.min(1, ship.pos.dot(head)))) / DEG;
      if (away > DESPAWN_DEG || !isWater(this.world.terrainAt(ship.pos))) ship.alive = false;
    }

    this.writeInstances();
  }

  private writeInstances(): void {
    let n = 0;
    for (const ship of this.ships) {
      if (!ship.alive) continue;
      _bin.copy(ship.pos).cross(ship.dir).normalize();
      _mat.makeBasis(ship.dir, ship.pos, _bin);
      _mat.setPosition(
        ship.pos.x * 1.0018,
        ship.pos.y * 1.0018,
        ship.pos.z * 1.0018,
      );
      this.hulls.setMatrixAt(n, _mat);
      this.wakes.setMatrixAt(n, _mat);
      // Cargo reds and naval greys, biased toward the former.
      this.colour.setHSL(ship.hue < 0.7 ? 0.02 + ship.hue * 0.12 : 0.58, ship.hue < 0.7 ? 0.62 : 0.10, 0.55);
      this.hulls.setColorAt(n, this.colour);
      n++;
    }
    this.hulls.count = n;
    this.wakes.count = n;
    this.hulls.instanceMatrix.needsUpdate = true;
    this.wakes.instanceMatrix.needsUpdate = true;
    if (this.hulls.instanceColor) this.hulls.instanceColor.needsUpdate = true;
  }

  /** Returns the position of a ship the head just swallowed, or null. */
  consumeAt(head: Vector3): Vector3 | null {
    const limit = SHIP_CATCH_DEG * DEG;
    for (const ship of this.ships) {
      if (!ship.alive) continue;
      if (Math.acos(Math.max(-1, Math.min(1, ship.pos.dot(head)))) < limit) {
        ship.alive = false;
        return ship.pos.clone();
      }
    }
    return null;
  }

  /** Live ship positions, for the minimap. */
  forEachAlive(fn: (p: Vector3) => void): void {
    for (const s of this.ships) if (s.alive) fn(s.pos);
  }

  dispose(): void {
    this.hulls.geometry.dispose();
    (this.hulls.material as MeshBasicMaterial).dispose();
    this.wakes.geometry.dispose();
    (this.wakes.material as MeshBasicMaterial).dispose();
  }
}
