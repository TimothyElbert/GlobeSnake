import { Terrain, WorldData, climateColor } from '@core/world';
import { formatScore } from '@game/scoring';
import type { RunLogEntry } from '@game/session';
import { hexToCss } from './dom';

/**
 * The share card.
 *
 * The single highest-leverage feature in the design for "would a stranger play
 * this twice", and it costs almost nothing because the interesting part is
 * already computed: the trail is *already* coloured by every biome the snake
 * crossed. Flattening it onto an equirectangular map turns a run into an
 * artefact — a hand-drawn-looking route across the world that is different for
 * every player and every day.
 *
 * Everything is local. There is no backend, no upload, no account: the image
 * is a data URL the player can save, and the text block goes to the clipboard.
 */

export interface ShareData {
  title: string;
  subtitle: string;
  score: number;
  traceLat: number[];
  traceLon: number[];
  traceClimate: number[];
  log: RunLogEntry[];
  distanceKm: number;
  hintsUsed: number;
  variant: string;
}

const W = 1200;
const H = 660;
const MAP_TOP = 96;
const MAP_H = 480;

export function renderShareCard(world: WorldData, data: ShareData): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#060a11';
  ctx.fillRect(0, 0, W, H);

  drawWorld(ctx, world);
  drawTrace(ctx, data);
  drawPins(ctx, data);
  drawChrome(ctx, data);

  return canvas;
}

/** A muted equirectangular basemap, sampled straight from the game's own grid. */
function drawWorld(ctx: CanvasRenderingContext2D, world: WorldData): void {
  const img = ctx.createImageData(W, MAP_H);
  const d = img.data;
  const sx = world.width / W;
  const sy = world.height / MAP_H;
  for (let y = 0; y < MAP_H; y++) {
    const srcY = Math.min(world.height - 1, (y * sy) | 0);
    for (let x = 0; x < W; x++) {
      const srcX = Math.min(world.width - 1, (x * sx) | 0);
      const o = (srcY * world.width + srcX) * 4;
      const terrain = world.bytes[o + 2] as Terrain;
      const p = (y * W + x) * 4;
      if (terrain === Terrain.Ocean || terrain === Terrain.Shallow || terrain === Terrain.Lake) {
        d[p] = 9; d[p + 1] = 18; d[p + 2] = 31;
      } else {
        const c = climateColor(world.bytes[o + 1]);
        d[p] = (((c >> 16) & 255) * 0.26 + 16) | 0;
        d[p + 1] = (((c >> 8) & 255) * 0.26 + 22) | 0;
        d[p + 2] = ((c & 255) * 0.26 + 30) | 0;
      }
      d[p + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, MAP_TOP);

  // Graticule, faint, for the map-plate feel.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, MAP_TOP, W, MAP_H);
  ctx.clip();
  ctx.strokeStyle = 'rgba(140, 178, 220, 0.10)';
  ctx.lineWidth = 1;
  for (let lon = -180; lon <= 180; lon += 30) {
    const x = ((lon + 180) / 360) * W;
    ctx.beginPath(); ctx.moveTo(x, MAP_TOP); ctx.lineTo(x, MAP_TOP + MAP_H); ctx.stroke();
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const y = MAP_TOP + ((90 - lat) / 180) * MAP_H;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(140, 178, 220, 0.20)';
  const eq = MAP_TOP + MAP_H / 2;
  ctx.beginPath(); ctx.moveTo(0, eq); ctx.lineTo(W, eq); ctx.stroke();
  ctx.restore();
}

function project(lat: number, lon: number): [number, number] {
  return [((lon + 180) / 360) * W, MAP_TOP + ((90 - lat) / 180) * MAP_H];
}

/** The route, coloured by the climate it crossed. */
function drawTrace(ctx: CanvasRenderingContext2D, data: ShareData): void {
  const { traceLat: la, traceLon: lo, traceClimate: cl } = data;
  if (la.length < 2) return;

  ctx.save();
  ctx.lineWidth = 3.4;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowBlur = 10;

  for (let i = 1; i < la.length; i++) {
    // A jump greater than 180° is the antimeridian, not a teleport. Without
    // this the card gets a bright line straight across the Pacific.
    if (Math.abs(lo[i] - lo[i - 1]) > 180) continue;
    const [x0, y0] = project(la[i - 1], lo[i - 1]);
    const [x1, y1] = project(la[i], lo[i]);
    const col = hexToCss(climateColor(cl[i]));
    ctx.strokeStyle = col;
    ctx.shadowColor = col;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }
  ctx.restore();
}

function drawPins(ctx: CanvasRenderingContext2D, data: ShareData): void {
  ctx.save();
  ctx.font = '700 12px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  data.log.forEach((entry, i) => {
    const [x, y] = project(entry.lat, entry.lon);
    ctx.beginPath();
    ctx.arc(x, y, 11, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(6, 10, 17, 0.86)';
    ctx.fill();
    ctx.strokeStyle = entry.hintLevel === 0 ? '#ffc94a' : '#7f8ea6';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = entry.hintLevel === 0 ? '#ffc94a' : '#9fb0c6';
    ctx.fillText(String(i + 1), x, y + 0.5);
  });
  ctx.restore();
}

function drawChrome(ctx: CanvasRenderingContext2D, data: ShareData): void {
  ctx.save();
  ctx.fillStyle = '#e8eef6';
  ctx.font = '600 34px Georgia, "Times New Roman", serif';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(data.title, 40, 52);

  ctx.fillStyle = '#93a4bb';
  ctx.font = '400 15px system-ui, sans-serif';
  ctx.fillText(data.subtitle, 40, 76);

  ctx.textAlign = 'right';
  ctx.fillStyle = '#ffc94a';
  ctx.font = '700 44px ui-monospace, monospace';
  ctx.fillText(formatScore(data.score), W - 40, 60);
  ctx.fillStyle = '#5d6d84';
  ctx.font = '600 11px system-ui, sans-serif';
  ctx.fillText('POINTS', W - 40, 78);

  // Footer stats.
  const y = MAP_TOP + MAP_H + 34;
  ctx.textAlign = 'left';
  ctx.font = '400 14px system-ui, sans-serif';
  ctx.fillStyle = '#93a4bb';
  const clean = data.log.filter((e) => e.hintLevel === 0).length;
  const stats = [
    `${data.log.length} found`,
    `${clean} without hints`,
    `${Math.round(data.distanceKm).toLocaleString('en-US')} km travelled`,
  ].join('   ·   ');
  ctx.fillText(stats, 40, y);

  ctx.textAlign = 'right';
  ctx.fillStyle = '#5d6d84';
  ctx.font = '400 12px system-ui, sans-serif';
  ctx.fillText(`GLOBE SNAKE · ${data.variant}`, W - 40, y);
  ctx.restore();
}

/** The Wordle-style clipboard block. */
export function shareText(data: ShareData, url: string): string {
  const marks = data.log
    .map((e) => (e.hintLevel === 0 ? (e.seconds <= e.parSeconds ? '🟩' : '🟨') : e.hintLevel >= 3 ? '⬜' : '🟦'))
    .join('');
  return [
    `${data.title} — ${formatScore(data.score)}`,
    marks,
    `${data.log.length} found · ${data.hintsUsed} hints · ${Math.round(data.distanceKm).toLocaleString('en-US')} km`,
    url,
  ].join('\n');
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API needs a secure context and permission; fall back to the
    // ancient trick so the button still does something on file:// and http://.
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
