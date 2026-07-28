import { Vector3 } from 'three';
import { Terrain, WorldData, climateColor } from '@core/world';
import type { Snake } from '@core/snake';

/**
 * The inset globe.
 *
 * Sol's council note, adopted: with a chase camera you can only see a sliver of
 * the planet, so a player who *knows* the answer still cannot orient toward it
 * while dodging their own body. The inset fixes that without giving anything
 * away — it shows where you are, which way you point, and where your body lies,
 * but never the target until a hint has been paid for.
 *
 * Drawn as an orthographic raster in a 2D canvas rather than a second WebGL
 * pass: one small ImageData write at 20 Hz costs less than a second render
 * target, and it composites with the DOM HUD for free.
 */

const SRC_W = 1024;
const SRC_H = 512;

const _p = new Vector3();
const _up = new Vector3();
const _right = new Vector3();
const _n = new Vector3(0, 1, 0);

export class Minimap {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly image: ImageData;
  /** Downsampled globe colours, RGB triples, equirectangular. */
  private readonly atlas: Uint8Array;
  private size: number;
  private sinceRaster = 0;

  constructor(world: WorldData, size = 148) {
    this.size = size;
    this.canvas = document.createElement('canvas');
    this.canvas.width = size;
    this.canvas.height = size;
    this.canvas.style.width = `${size}px`;
    this.canvas.style.height = `${size}px`;
    const ctx = this.canvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;
    this.image = ctx.createImageData(size, size);
    this.atlas = new Uint8Array(SRC_W * SRC_H * 3);
    this.buildAtlas(world);
  }

  /**
   * Flatten the world once into a small palette image. Land is tinted by its
   * climate colour so the minimap and the snake speak the same visual language.
   */
  private buildAtlas(world: WorldData): void {
    const sx = world.width / SRC_W;
    const sy = world.height / SRC_H;
    for (let y = 0; y < SRC_H; y++) {
      const srcY = Math.min(world.height - 1, (y * sy) | 0);
      for (let x = 0; x < SRC_W; x++) {
        const srcX = Math.min(world.width - 1, (x * sx) | 0);
        const o = (srcY * world.width + srcX) * 4;
        const terrain = world.bytes[o + 2] as Terrain;
        const climate = world.bytes[o + 1];
        const d = (y * SRC_W + x) * 3;
        if (terrain === Terrain.Ocean || terrain === Terrain.Shallow) {
          this.atlas[d] = 12; this.atlas[d + 1] = 32; this.atlas[d + 2] = 54;
        } else if (terrain === Terrain.Lake) {
          this.atlas[d] = 22; this.atlas[d + 1] = 52; this.atlas[d + 2] = 78;
        } else {
          const c = climateColor(climate);
          // Desaturate toward the panel background so the snake reads on top.
          this.atlas[d] = (((c >> 16) & 255) * 0.52 + 14) | 0;
          this.atlas[d + 1] = (((c >> 8) & 255) * 0.52 + 20) | 0;
          this.atlas[d + 2] = ((c & 255) * 0.52 + 26) | 0;
        }
      }
    }
  }

  setSize(size: number): void {
    this.size = size;
    this.canvas.width = size;
    this.canvas.height = size;
    this.canvas.style.width = `${size}px`;
    this.canvas.style.height = `${size}px`;
  }

  /**
   * @param centre  where the camera is looking — the head
   * @param target  revealed only when a hint has paid for it
   */
  update(
    dt: number,
    centre: Vector3,
    heading: Vector3,
    snake: Snake,
    target: Vector3 | null,
    ships: ((fn: (p: Vector3) => void) => void) | null,
  ): void {
    this.sinceRaster += dt;
    // The raster only changes as the globe turns under you; 20 Hz is invisible.
    if (this.sinceRaster > 0.05) {
      this.sinceRaster = 0;
      this.rasterize(centre);
    } else {
      this.ctx.putImageData(this.image, 0, 0);
    }

    const s = this.size;
    const r = s / 2 - 2;
    const cx = s / 2;
    const cy = s / 2;
    const ctx = this.ctx;

    // Basis: north up, east right. Never rotates with the snake — a minimap
    // that spins is a minimap nobody can read.
    _up.copy(_n).addScaledVector(centre, -centre.y);
    if (_up.lengthSq() < 1e-8) _up.copy(heading);
    _up.normalize();
    _right.copy(centre).cross(_up).normalize();

    const project = (p: Vector3): [number, number] | null => {
      if (p.dot(centre) <= 0.02) return null;
      return [cx + p.dot(_right) * r, cy - p.dot(_up) * r];
    };

    // Body.
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(90, 240, 190, 0.92)';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    const first = snake.firstBodyNode;
    const count = snake.nodeCount;
    const stride = Math.max(1, Math.floor((count - first) / 260));
    let drawing = false;
    for (let i = first; i < count; i += stride) {
      snake.nodeAt(i, _p);
      const pt = project(_p);
      if (!pt) { drawing = false; continue; }
      if (drawing) ctx.lineTo(pt[0], pt[1]);
      else { ctx.moveTo(pt[0], pt[1]); drawing = true; }
    }
    ctx.stroke();

    // Ships.
    if (ships) {
      ctx.fillStyle = 'rgba(255, 214, 150, 0.85)';
      ships((p) => {
        const pt = project(p);
        if (!pt) return;
        ctx.fillRect(pt[0] - 1.5, pt[1] - 1.5, 3, 3);
      });
    }

    // Target, only once revealed.
    if (target) {
      const pt = project(target);
      if (pt) {
        ctx.strokeStyle = 'rgba(255, 201, 74, 0.95)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(pt[0], pt[1], 5.5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = 'rgba(255, 201, 74, 0.95)';
        ctx.beginPath();
        ctx.arc(pt[0], pt[1], 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Head, with a heading tick.
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.fill();
    const hx = heading.dot(_right);
    const hy = -heading.dot(_up);
    const hl = Math.hypot(hx, hy) || 1;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + (hx / hl) * 11, cy + (hy / hl) * 11);
    ctx.stroke();

    // Limb and a fixed north marker: the stable reference frame the camera
    // deliberately does not provide.
    ctx.strokeStyle = 'rgba(150, 190, 235, 0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(190, 214, 240, 0.9)';
    ctx.font = '600 9px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('N', cx, 11);
  }

  private rasterize(centre: Vector3): void {
    const s = this.size;
    const r = s / 2 - 2;
    const data = this.image.data;
    data.fill(0);

    _up.copy(_n).addScaledVector(centre, -centre.y);
    if (_up.lengthSq() < 1e-8) _up.set(1, 0, 0).addScaledVector(centre, -centre.x);
    _up.normalize();
    _right.copy(centre).cross(_up).normalize();

    const cx = s / 2;
    const cy = s / 2;
    for (let py = 0; py < s; py++) {
      const ny = (cy - py - 0.5) / r;
      for (let px = 0; px < s; px++) {
        const nx = (px + 0.5 - cx) / r;
        const d2 = nx * nx + ny * ny;
        const o = (py * s + px) * 4;
        if (d2 > 1) continue;
        const nz = Math.sqrt(1 - d2);

        // Unproject: point = right*nx + up*ny + centre*nz.
        const x = _right.x * nx + _up.x * ny + centre.x * nz;
        const y = _right.y * nx + _up.y * ny + centre.y * nz;
        const z = _right.z * nx + _up.z * ny + centre.z * nz;

        const lat = Math.asin(Math.max(-1, Math.min(1, y)));
        const lon = Math.atan2(z, x);
        let col = ((lon / (Math.PI * 2) + 0.5) * SRC_W) | 0;
        let row = ((0.5 - lat / Math.PI) * SRC_H) | 0;
        col = ((col % SRC_W) + SRC_W) % SRC_W;
        if (row < 0) row = 0; else if (row >= SRC_H) row = SRC_H - 1;
        const a = (row * SRC_W + col) * 3;

        // A little limb shading so the disc reads as a sphere.
        const shade = 0.55 + 0.45 * nz;
        data[o] = this.atlas[a] * shade;
        data[o + 1] = this.atlas[a + 1] * shade;
        data[o + 2] = this.atlas[a + 2] * shade;
        data[o + 3] = 255;
      }
    }
    this.ctx.putImageData(this.image, 0, 0);
  }
}
