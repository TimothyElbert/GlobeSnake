import { PerspectiveCamera, Vector3 } from 'three';
import { clamp, damp, slerpPoint, step } from '@core/sphere';

/**
 * The chase camera.
 *
 * Both council members put camera disorientation in their top three failure
 * modes, and the fixes are all subtractive:
 *
 *  - **Roll is always exactly zero.** The up vector is the surface normal under
 *    the head, so the horizon never tilts. Rolling into turns looks great in a
 *    trailer and makes people put the laptop down after ninety seconds.
 *  - **Everything is critically damped** with a ~0.25 s time constant, and the
 *    camera never swings on its own — no cinematic flourishes during play.
 *  - **Fixed field of view.** Speed is communicated by the ground rushing past
 *    and by the boost bar, not by lurching the lens.
 *  - **It sits high enough to see roughly a third of the planet.** The game is
 *    a geography test *and* a dodging test at the same time; a low, dramatic
 *    camera makes both impossible at once.
 */

export interface ChaseCameraOptions {
  /** Angular distance the camera trails behind the head, in radians. */
  followAngle?: number;
  /** Height above the surface, in globe radii. */
  height?: number;
  /** How far ahead of the head the camera looks, in radians. */
  lookAhead?: number;
  tau?: number;
}

const _desired = new Vector3();
const _tmpP = new Vector3();
const _tmpH = new Vector3();
const _up = new Vector3();
const _look = new Vector3();
const _aim = new Vector3();

export class ChaseCamera {
  readonly camera: PerspectiveCamera;

  /** Smoothed anchor: the point on the sphere the camera hovers over. */
  private readonly anchor = new Vector3(1, 0, 0);
  private readonly lookTarget = new Vector3(1, 0, 0);
  private readonly smoothUp = new Vector3(0, 1, 0);

  private followAngle: number;
  private height: number;
  private lookAhead: number;
  private readonly tau: number;

  /**
   * 0 = closest, 1 = widest.
   *
   * The range is deliberately large: at 1 the camera sits far enough out to see
   * most of a hemisphere, which is what you want when the question is "right,
   * where *is* Kyrgyzstan" rather than "am I about to hit my own tail". The
   * default starts well back, because reading the world is the first thing you
   * do every round and the previous default framed a sliver of it.
   */
  zoom = 0.52;
  private zoomTarget = 0.52;
  /** Smoothed ground height under the camera, in globe radii. */
  private ground = 0;

  constructor(aspect: number, opts: ChaseCameraOptions = {}) {
    this.followAngle = opts.followAngle ?? 0.235;
    this.height = opts.height ?? 0.30;
    this.lookAhead = opts.lookAhead ?? 0.16;
    this.tau = opts.tau ?? 0.25;
    this.camera = new PerspectiveCamera(52, aspect, 0.002, 60);
    this.camera.position.set(0, 0, 2);
  }

  setZoom(v: number): void {
    this.zoomTarget = clamp(v, 0, 1);
  }

  /** Where the zoom is heading, as opposed to where it currently is. */
  get zoomWanted(): number {
    return this.zoomTarget;
  }

  nudgeZoom(delta: number): void {
    this.setZoom(this.zoomTarget + delta);
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Snap instantly — used on spawn and after a respawn, never mid-run. */
  reset(position: Vector3, heading: Vector3, ground = 0): void {
    this.ground = ground;
    _tmpP.copy(position);
    _tmpH.copy(heading);
    step(_tmpP, _tmpH, -this.followAngle);
    this.anchor.copy(_tmpP);
    this.smoothUp.copy(position);
    _tmpP.copy(position);
    _tmpH.copy(heading);
    step(_tmpP, _tmpH, this.lookAhead);
    this.lookTarget.copy(_tmpP);
    this.zoom = this.zoomTarget;
    this.apply();
  }

  update(position: Vector3, heading: Vector3, dt: number, speedFactor = 1, ground = 0): void {
    this.zoom = damp(this.zoom, this.zoomTarget, 0.3, dt);
    // Damp the ground term hard — the camera should rise over a mountain range,
    // not bob over every ridge.
    this.ground = damp(this.ground, ground, 0.55, dt);

    // Zoom widens the arc behind and the altitude together, so the head stays
    // in the same place on screen at every distance.
    const z = this.zoom;
    const follow = this.followAngle * (0.55 + z * 2.6);
    const height = this.height * (0.5 + z * 4.6);
    // Pull back a little at speed. A little: this is the only thing on the rig
    // allowed to react to velocity, and it is capped at 8%.
    const rush = 1 + clamp(speedFactor - 1, 0, 0.5) * 0.16;

    _tmpP.copy(position);
    _tmpH.copy(heading);
    step(_tmpP, _tmpH, -follow * rush);
    _desired.copy(_tmpP);

    _tmpP.copy(position);
    _tmpH.copy(heading);
    step(_tmpP, _tmpH, this.lookAhead);
    _look.copy(_tmpP);

    // Slerp along the sphere rather than lerping through it, or the camera
    // dives toward the core on fast turns.
    const k = 1 - Math.exp(-dt / this.tau);
    slerpPoint(this.anchor, _desired, k, this.anchor);
    slerpPoint(this.lookTarget, _look, k, this.lookTarget);
    slerpPoint(this.smoothUp, position, 1 - Math.exp(-dt / (this.tau * 1.6)), this.smoothUp);

    this.camera.position.copy(this.anchor).multiplyScalar(1 + this.ground + height * rush);
    this.apply();
  }

  private apply(): void {
    const z = this.zoom;
    const height = this.height * (0.5 + z * 4.6);
    this.camera.position.copy(this.anchor).multiplyScalar(1 + this.ground + height);
    // Up is the surface normal at the head. This is the whole no-roll guarantee:
    // there is no term anywhere that can tilt the horizon.
    _up.copy(this.smoothUp);
    this.camera.up.copy(_up);
    // Aim at the ground, not at the sea-level shell beneath it, or the framing
    // drifts downward every time the snake climbs.
    _aim.copy(this.lookTarget).multiplyScalar(1 + this.ground);
    this.camera.lookAt(_aim);
  }

  /** Approximate angular radius of the globe visible on screen, for the minimap. */
  get visibleAngle(): number {
    return 0.35 + this.zoom * 0.55;
  }
}
