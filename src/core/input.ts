import { Camera, Raycaster, Sphere, Vector2, Vector3 } from 'three';
import { clamp, signedTurnToward } from './sphere';
import type { SteerInput } from './snake';

export type InputScheme = 'keyboard' | 'pointer';
export type GameAction =
  | 'hint' | 'pause' | 'restart' | 'mute' | 'zoomIn' | 'zoomOut' | 'toggleMap' | 'borders';

/**
 * One input manager for all three control schemes.
 *
 * The mouse scheme is *pursuit steering*, not a virtual joystick: the cursor is
 * raycast onto the globe and the snake turns toward that surface point at its
 * normal maximum turn rate. Both council members independently rejected the
 * "horizontal cursor displacement drives turn rate" approach, and they were
 * right — it requires constant recentring and feels like driving with a
 * mis-calibrated gamepad. Pursuit steering also means touch is the same code
 * path with a different event name, so phones get a real control scheme rather
 * than an apology.
 */
export class InputManager {
  private readonly keys = new Set<string>();
  private readonly listeners = new Map<GameAction, Set<() => void>>();

  private readonly ndc = new Vector2();
  private readonly raycaster = new Raycaster();
  private readonly globe = new Sphere(new Vector3(0, 0, 0), 1);
  private readonly hitPoint = new Vector3();

  private pointerActive = false;
  private pointerDown = false;
  private hasAim = false;
  /** Normalised 0..1 distance from the cursor to the head on screen. */
  private aimScreenDistance = 0.5;

  scheme: InputScheme = 'keyboard';
  /** Set true by variants that want the pointer scheme from the first frame. */
  preferPointer = false;

  private readonly out: SteerInput = { turn: 0, boost: false, brake: false };

  constructor(
    private readonly element: HTMLElement,
    private readonly camera: Camera,
  ) {
    window.addEventListener('keydown', this.onKeyDown, { passive: false });
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    element.addEventListener('pointermove', this.onPointerMove);
    element.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointerup', this.onPointerUp);
    element.addEventListener('contextmenu', this.onContextMenu);
    element.addEventListener('wheel', this.onWheel, { passive: false });
    element.addEventListener('touchstart', this.onTouchStart, { passive: false });
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.element.removeEventListener('pointermove', this.onPointerMove);
    this.element.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointerup', this.onPointerUp);
    this.element.removeEventListener('contextmenu', this.onContextMenu);
    this.element.removeEventListener('wheel', this.onWheel);
    this.element.removeEventListener('touchstart', this.onTouchStart);
    this.listeners.clear();
  }

  on(action: GameAction, fn: () => void): () => void {
    let set = this.listeners.get(action);
    if (!set) this.listeners.set(action, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  private emit(action: GameAction): void {
    const set = this.listeners.get(action);
    if (set) for (const fn of set) fn();
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    // Space scrolls the page by default, and Space is the hint key — the single
    // most-pressed button in the game. Never let the browser have it.
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
      e.preventDefault();
    }
    if (e.repeat) return;
    this.keys.add(e.code);
    if (this.isSteeringKey(e.code)) this.scheme = 'keyboard';

    switch (e.code) {
      case 'Space': case 'KeyH': this.emit('hint'); break;
      case 'Escape': case 'KeyP': this.emit('pause'); break;
      case 'KeyR': this.emit('restart'); break;
      case 'KeyM': this.emit('mute'); break;
      case 'KeyT': this.emit('toggleMap'); break;
      case 'KeyB': this.emit('borders'); break;
      case 'PageUp': case 'Equal': this.emit('zoomIn'); break;
      case 'PageDown': case 'Minus': this.emit('zoomOut'); break;
    }
  };

  private isSteeringKey(code: string): boolean {
    return code === 'ArrowLeft' || code === 'ArrowRight' || code === 'KeyA' || code === 'KeyD';
  }

  private onKeyUp = (e: KeyboardEvent): void => { this.keys.delete(e.code); };
  private onBlur = (): void => { this.keys.clear(); this.pointerDown = false; };
  private onContextMenu = (e: Event): void => { e.preventDefault(); this.emit('hint'); };
  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.emit(e.deltaY > 0 ? 'zoomOut' : 'zoomIn');
  };
  private onTouchStart = (e: TouchEvent): void => {
    e.preventDefault();
    this.scheme = 'pointer';
    this.pointerActive = true;
  };

  private onPointerMove = (e: PointerEvent): void => {
    const rect = this.element.getBoundingClientRect();
    this.ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.pointerActive = true;
    // A trackpad nudge should not steal control mid-corner from a keyboard
    // player, so only a deliberate movement switches scheme.
    if (Math.abs(e.movementX) + Math.abs(e.movementY) > 2) this.scheme = 'pointer';
  };

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button === 2) return; // handled by contextmenu
    this.pointerDown = true;
    this.scheme = 'pointer';
  };

  private onPointerUp = (): void => { this.pointerDown = false; };

  /**
   * Where on the globe the cursor is pointing, or null if it is off the planet.
   * On a miss we do not give up: we slide the aim to the nearest point on the
   * visible limb, so steering stays responsive when the cursor drifts into space.
   */
  private computeAim(headWorld: Vector3, globeRadius: number): boolean {
    if (!this.pointerActive) return false;
    this.globe.radius = globeRadius;
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hit = this.raycaster.ray.intersectSphere(this.globe, this.hitPoint);
    if (hit) {
      this.hitPoint.normalize();
      this.hasAim = true;
    } else {
      // Nearest point on the ray to the centre, projected out to the surface.
      this.raycaster.ray.closestPointToPoint(this.globe.center, this.hitPoint);
      if (this.hitPoint.lengthSq() < 1e-9) return false;
      this.hitPoint.normalize();
      this.hasAim = true;
    }

    // Screen-space throttle: how far the cursor sits from the head.
    const headNdc = headWorld.clone().multiplyScalar(globeRadius).project(this.camera);
    this.aimScreenDistance = clamp(
      Math.hypot(this.ndc.x - headNdc.x, this.ndc.y - headNdc.y) / 1.4,
      0,
      1,
    );
    return true;
  }

  /**
   * Produce this frame's steering command.
   * `position`/`heading` are the snake's unit vectors; `turnRateRad` is how far
   * it could turn this frame, used to normalise the pursuit error.
   */
  sample(position: Vector3, heading: Vector3, globeRadius: number, turnRateRad: number): SteerInput {
    const o = this.out;
    o.turn = 0;
    o.boost = false;
    o.brake = false;

    if (this.scheme === 'pointer' || this.preferPointer) {
      if (this.computeAim(position, globeRadius)) {
        const err = signedTurnToward(position, heading, this.hitPoint);
        // Normalise by a couple of frames' worth of turn so the snake commits
        // fully to a real correction but does not jitter on sub-degree error.
        o.turn = clamp(err / Math.max(turnRateRad * 2, 1e-4), -1, 1);
        if (Math.abs(err) < 0.008) o.turn = 0;

        if (this.aimScreenDistance < 0.15) o.brake = true;
        else if (this.aimScreenDistance > 0.5) o.boost = true;
        if (this.pointerDown) { o.boost = true; o.brake = false; }
        return o;
      }
      if (!this.hasAim) this.scheme = 'keyboard';
    }

    const left = this.keys.has('ArrowLeft') || this.keys.has('KeyA');
    const right = this.keys.has('ArrowRight') || this.keys.has('KeyD');
    if (left !== right) o.turn = left ? -1 : 1;
    o.boost = this.keys.has('ArrowUp') || this.keys.has('KeyW') || this.keys.has('ShiftLeft');
    o.brake = this.keys.has('ArrowDown') || this.keys.has('KeyS');
    return o;
  }

  /** Current aim point on the globe, for the cursor reticle. Null if none. */
  get aimPoint(): Vector3 | null {
    return this.scheme === 'pointer' && this.hasAim ? this.hitPoint : null;
  }

  get usingPointer(): boolean {
    return this.scheme === 'pointer';
  }
}
