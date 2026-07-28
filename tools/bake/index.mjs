#!/usr/bin/env node
/**
 * GlobeSnake offline world-data bake pipeline.
 *
 * Usage:  node tools/bake/index.mjs [--force]
 *   --force            re-download all cached sources
 *   env BAKE_OFFLINE=1 skip all network access (procedural fallback everywhere)
 *
 * Outputs (hard interface — see docs/DESIGN.md §3):
 *   public/data/world.bin        gzipped GSW1 raster, 4096x2048x4 bytes
 *   public/data/countries.json   country index table
 *   public/data/BAKE_REPORT.md   provenance + sanity report
 *   public/textures/earth_day.jpg, earth_night.jpg, earth_bump.png
 *
 * Design rule #1: the procedural fallback path must always produce a valid,
 * complete world.bin with zero network access. Real sources are additive
 * upgrades. A dead URL logs loudly, degrades, and is recorded in the report.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- constants

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const CACHE = path.join(__dirname, '.cache');
const OUT_DATA = path.join(ROOT, 'public', 'data');
const OUT_TEX = path.join(ROOT, 'public', 'textures');

const FORCE = process.argv.includes('--force');
const OFFLINE = process.env.BAKE_OFFLINE === '1';

export const WIDTH = 4096;
export const HEIGHT = 2048;
/** Elevation byte value that is exactly sea level. */
export const SEA_LEVEL = 100;
export const MAX_DEPTH_M = 11000; // elevation byte 0
export const MAX_ELEV_M = 8848;   // elevation byte 255

const W = WIDTH, H = HEIGHT;
const N = W * H;
const R_EARTH = 6371; // km
const KM_PER_TEXEL = 40075 / W; // ~9.78 km at equator

/** Köppen classes, byte 1..30 in this exact order (0 = ocean/none).
 *  This matches the Beck et al. GeoTIFF legend 1..30 one-to-one. */
export const KOPPEN = ['', 'Af', 'Am', 'Aw', 'BWh', 'BWk', 'BSh', 'BSk',
  'Csa', 'Csb', 'Csc', 'Cwa', 'Cwb', 'Cwc', 'Cfa', 'Cfb', 'Cfc',
  'Dsa', 'Dsb', 'Dsc', 'Dsd', 'Dwa', 'Dwb', 'Dwc', 'Dwd',
  'Dfa', 'Dfb', 'Dfc', 'Dfd', 'ET', 'EF'];
const KIDX = new Map(KOPPEN.map((c, i) => [c, i]));

/** Gameplay terrain classes (byte 2). */
export const TERRAIN = {
  OCEAN: 0, SHALLOW: 1, COAST: 2, PLAINS: 3, FOREST: 4,
  DESERT: 5, MOUNTAIN: 6, ICE: 7, RIVER: 8, LAKE: 9,
};
const TERRAIN_NAMES = ['ocean', 'shallow', 'coast', 'plains', 'forest',
  'desert', 'mountain', 'ice', 'river', 'lake'];

// Empirical grey->metres calibration for the NASA GEBCO_08 rev-elev PNG,
// probed against known elevations (Berlin 1→35 m, Montana plains 37→700 m,
// Denver 89→1610 m, Lhasa ~18.6 m/grey; Aconcagua 6961 m reads 250, so the
// encoding compresses above ~3200 m). Piecewise linear, 255 anchored to
// Everest (8848 m). Documented in BAKE_REPORT.md.
const GEBCO_KNEE_G = 180;
const GEBCO_M_PER_G_LOW = 18;           // 0..180  -> 0..3240 m
const GEBCO_KNEE_M = GEBCO_KNEE_G * GEBCO_M_PER_G_LOW;
const GEBCO_M_PER_G_HIGH = (MAX_ELEV_M - GEBCO_KNEE_M) / (255 - GEBCO_KNEE_G);
const gebcoGreyToMetres = (g) => g <= GEBCO_KNEE_G
  ? g * GEBCO_M_PER_G_LOW
  : GEBCO_KNEE_M + (g - GEBCO_KNEE_G) * GEBCO_M_PER_G_HIGH;

const SOURCES = {
  gebco: {
    name: 'GEBCO_08 rev elev 21600x10800 (NASA Visible Earth)',
    url: 'https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73934/gebco_08_rev_elev_21600x10800.png',
    file: 'gebco_08_rev_elev.png', licence: 'Public domain (NASA)',
  },
  day: {
    name: 'Blue Marble topo+bathy 5400x2700 (NASA)',
    url: 'https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73909/world.topo.bathy.200412.3x5400x2700.jpg',
    file: 'world.topo.bathy.jpg', licence: 'Public domain (NASA)',
  },
  night: {
    name: 'Earth at Night (NASA)',
    url: 'https://eoimages.gsfc.nasa.gov/images/imagerecords/55000/55167/earth_lights_lrg.jpg',
    file: 'earth_lights.jpg', licence: 'Public domain (NASA)',
  },
  countries: {
    name: 'world-atlas countries-50m TopoJSON',
    url: 'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json',
    file: 'countries-50m.json', licence: 'Public domain (Natural Earth derivative)',
  },
  land: {
    name: 'Natural Earth 50m land',
    url: 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_land.geojson',
    file: 'ne_50m_land.geojson', licence: 'Public domain (Natural Earth)',
  },
  lakes: {
    name: 'Natural Earth 50m lakes',
    url: 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_lakes.geojson',
    file: 'ne_50m_lakes.geojson', licence: 'Public domain (Natural Earth)',
  },
  rivers: {
    name: 'Natural Earth 50m rivers + lake centerlines',
    url: 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_rivers_lake_centerlines.geojson',
    file: 'ne_50m_rivers.geojson', licence: 'Public domain (Natural Earth)',
  },
  glaciers: {
    name: 'Natural Earth 50m glaciated areas',
    url: 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_glaciated_areas.geojson',
    file: 'ne_50m_glaciated_areas.geojson', licence: 'Public domain (Natural Earth)',
  },
  koppen: {
    name: 'Köppen-Geiger Beck et al. V1 present-day 0.5° GeoTIFF',
    url: 'https://ndownloader.figshare.com/files/12407516', // zip; single entry extracted via HTTP ranges
    file: 'Beck_KG_V1_present_0p5.tif', licence: 'CC BY 4.0 (Beck et al. 2018)',
  },
};

// ------------------------------------------------------------------ logging

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const warn = (...a) => console.warn(`[${((Date.now() - t0) / 1000).toFixed(1)}s] !!`, ...a);

/** Report accumulator, rendered to BAKE_REPORT.md at the end. */
const report = { sources: [], notes: [], stats: {}, outputs: [] };
const note = (s) => { report.notes.push(s); log('NOTE:', s); };

// -------------------------------------------------------- deterministic rng

/** Integer lattice hash -> [0,1). Fully deterministic, seed baked in. */
function hash2(x, y, seed) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 974634211)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Value noise over the texel grid, wrapping in x. freq = cells across the map. */
function vnoise(c, r, freq, seed) {
  const fx = (c / W) * freq, fy = (r / H) * freq * 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
  const xm = ((x0 % freq) + freq) % freq, xm1 = (xm + 1) % freq;
  const a = hash2(xm, y0, seed), b = hash2(xm1, y0, seed);
  const c2 = hash2(xm, y0 + 1, seed), d = hash2(xm1, y0 + 1, seed);
  return a + (b - a) * sx + (c2 - a) * sy + (a - b - c2 + d) * sx * sy;
}

/** fBm in [-1,1]. */
function fbm(c, r, baseFreq, octaves, seed) {
  let v = 0, amp = 0.5, f = baseFreq, tot = 0;
  for (let o = 0; o < octaves; o++) {
    v += amp * (vnoise(c, r, f, seed + o * 101) * 2 - 1);
    tot += amp; amp *= 0.5; f *= 2;
  }
  return v / tot;
}

// ----------------------------------------------------------- grid helpers

const rowLat = (r) => 90 - (r + 0.5) * 180 / H;
const colLon = (c) => -180 + (c + 0.5) * 360 / W;
const latToRow = (lat) => Math.min(H - 1, Math.max(0, Math.floor((90 - lat) / 180 * H)));
const lonToCol = (lon) => {
  let c = Math.floor((lon + 180) / 360 * W);
  return ((c % W) + W) % W;
};
const idxOf = (lat, lon) => latToRow(lat) * W + lonToCol(lon);

// ---------------------------------------------------------------- download

async function fetchCached(src) {
  const fp = path.join(CACHE, src.file);
  if (!FORCE && fs.existsSync(fp) && fs.statSync(fp).size > 0) {
    report.sources.push({ ...src, status: 'cached', bytes: fs.statSync(fp).size });
    return fp;
  }
  if (OFFLINE) {
    report.sources.push({ ...src, status: 'SKIPPED (offline) -> fallback', bytes: 0 });
    warn(`offline: skipping ${src.name}`);
    return null;
  }
  try {
    log(`downloading ${src.name} ...`);
    const res = await fetch(src.url, { redirect: 'follow', signal: AbortSignal.timeout(300000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 128) throw new Error(`suspiciously small response (${buf.length} B)`);
    fs.writeFileSync(fp, buf);
    report.sources.push({ ...src, status: 'downloaded', bytes: buf.length });
    log(`  ok (${(buf.length / 1e6).toFixed(1)} MB)`);
    return fp;
  } catch (e) {
    warn(`DOWNLOAD FAILED for ${src.name}: ${e.message} — continuing with fallback`);
    report.sources.push({ ...src, status: `FAILED (${e.message}) -> fallback`, bytes: 0 });
    return null;
  }
}

/** Extract one entry from a remote zip using HTTP range requests
 *  (avoids downloading the whole 71 MB Köppen archive). */
async function fetchZipEntry(src, entryRegex) {
  const fp = path.join(CACHE, src.file);
  if (!FORCE && fs.existsSync(fp) && fs.statSync(fp).size > 0) {
    report.sources.push({ ...src, status: 'cached', bytes: fs.statSync(fp).size });
    return fp;
  }
  if (OFFLINE) {
    report.sources.push({ ...src, status: 'SKIPPED (offline) -> fallback', bytes: 0 });
    return null;
  }
  const range = async (from, to) => {
    const res = await fetch(src.url, {
      redirect: 'follow',
      headers: { Range: `bytes=${from}-${to}` },
      signal: AbortSignal.timeout(60000),
    });
    if (res.status !== 206 && res.status !== 200) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  };
  try {
    log(`fetching ${src.name} (ranged zip extraction) ...`);
    const probe = await fetch(src.url, {
      redirect: 'follow', headers: { Range: 'bytes=0-0' }, signal: AbortSignal.timeout(30000),
    });
    const cr = probe.headers.get('content-range');
    probe.body?.cancel();
    if (!cr) throw new Error('no content-range; server refuses ranges');
    const total = parseInt(cr.split('/')[1], 10);
    // End of central directory lives in the last <=65557 bytes.
    const tailLen = Math.min(total, 66000);
    const tail = await range(total - tailLen, total - 1);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('EOCD not found');
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOfs = tail.readUInt32LE(eocd + 16);
    const cd = await range(cdOfs, cdOfs + cdSize - 1);
    let p = 0, found = null;
    while (p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50) {
      const method = cd.readUInt16LE(p + 10);
      const compSize = cd.readUInt32LE(p + 20);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const localOfs = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      if (entryRegex.test(name)) { found = { name, method, compSize, localOfs }; break; }
      p += 46 + nameLen + extraLen + commentLen;
    }
    if (!found) throw new Error('entry not found in zip');
    log(`  found ${found.name} (${found.compSize} B compressed)`);
    const lh = await range(found.localOfs, found.localOfs + 29);
    if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('bad local header');
    const nl = lh.readUInt16LE(26), el = lh.readUInt16LE(28);
    const dataStart = found.localOfs + 30 + nl + el;
    const comp = await range(dataStart, dataStart + found.compSize - 1);
    const raw = found.method === 8 ? zlib.inflateRawSync(comp)
      : found.method === 0 ? comp
        : (() => { throw new Error(`unsupported zip method ${found.method}`); })();
    fs.writeFileSync(fp, raw);
    report.sources.push({ ...src, status: `downloaded (${found.name} extracted from zip via ranges)`, bytes: raw.length });
    log(`  ok (${(raw.length / 1e3).toFixed(0)} kB)`);
    return fp;
  } catch (e) {
    warn(`KÖPPEN FETCH FAILED: ${e.message} — using procedural climate fallback`);
    report.sources.push({ ...src, status: `FAILED (${e.message}) -> procedural fallback`, bytes: 0 });
    return null;
  }
}

// ------------------------------------------------------- polygon rasterizer

/** Unwrap a lon/lat ring so consecutive longitude deltas are <= 180°.
 *  This is what keeps Russia/Fiji/Kiribati from smearing across the map. */
function unwrapRing(ring) {
  const out = new Array(ring.length);
  let prev = ring[0][0], offset = 0;
  out[0] = [prev, ring[0][1]];
  for (let i = 1; i < ring.length; i++) {
    let lon = ring[i][0] + offset;
    const d = lon - prev;
    if (d > 180) { offset -= 360; lon -= 360; }
    else if (d < -180) { offset += 360; lon += 360; }
    prev = lon;
    out[i] = [lon, ring[i][1]];
  }
  return out;
}

/** Even-odd scanline fill of one polygon (outer ring + holes).
 *  paint(r, c) is called for texels whose centre is inside. */
function fillPolygon(rings, paint) {
  if (!rings.length || rings[0].length < 3) return;
  const un = rings.map(unwrapRing);
  // Align hole rings to the outer ring's unwrapped frame.
  if (un.length > 1) {
    let oMin = Infinity, oMax = -Infinity;
    for (const p of un[0]) { if (p[0] < oMin) oMin = p[0]; if (p[0] > oMax) oMax = p[0]; }
    const oMid = (oMin + oMax) / 2;
    for (let i = 1; i < un.length; i++) {
      let mn = Infinity, mx = -Infinity;
      for (const p of un[i]) { if (p[0] < mn) mn = p[0]; if (p[0] > mx) mx = p[0]; }
      const k = Math.round((oMid - (mn + mx) / 2) / 360);
      if (k !== 0) for (const p of un[i]) p[0] += k * 360;
    }
  }
  let latMin = 90, latMax = -90;
  for (const ring of un) for (const p of ring) {
    if (p[1] < latMin) latMin = p[1];
    if (p[1] > latMax) latMax = p[1];
  }
  const r0 = Math.max(0, Math.floor((90 - latMax) / 180 * H) - 1);
  const r1 = Math.min(H - 1, Math.ceil((90 - latMin) / 180 * H) + 1);
  const xs = [];
  for (let r = r0; r <= r1; r++) {
    const lat = rowLat(r);
    xs.length = 0;
    for (const ring of un) {
      const n = ring.length;
      for (let i = 0; i < n; i++) {
        const a = ring[i], b = ring[(i + 1) % n];
        if ((a[1] > lat) === (b[1] > lat)) continue;
        const t = (lat - a[1]) / (b[1] - a[1]);
        xs.push(a[0] + t * (b[0] - a[0]));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      let c0 = Math.ceil((xs[i] + 180) * W / 360 - 0.5);
      let c1 = Math.floor((xs[i + 1] + 180) * W / 360 - 0.5);
      if (c1 < c0) continue;
      if (c1 - c0 >= W - 1) { for (let c = 0; c < W; c++) paint(r, c); continue; }
      for (let c = c0; c <= c1; c++) paint(r, ((c % W) + W) % W);
    }
  }
}

/** Rasterize a GeoJSON geometry (Polygon/MultiPolygon). */
function fillGeometry(geom, paint) {
  if (!geom) return;
  if (geom.type === 'Polygon') fillPolygon(geom.coordinates, paint);
  else if (geom.type === 'MultiPolygon') for (const poly of geom.coordinates) fillPolygon(poly, paint);
  else if (geom.type === 'GeometryCollection') for (const g of geom.geometries) fillGeometry(g, paint);
}

/** Rasterize a polyline (rivers). Antimeridian handled by unwrapping. */
function drawPolyline(coords, paint) {
  if (coords.length < 2) return;
  const un = unwrapRing(coords);
  for (let i = 0; i + 1 < un.length; i++) {
    const [lon1, lat1] = un[i], [lon2, lat2] = un[i + 1];
    const dc = (lon2 - lon1) / 360 * W, dr = (lat1 - lat2) / 180 * H;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dc), Math.abs(dr))));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const lat = lat1 + (lat2 - lat1) * t, lon = lon1 + (lon2 - lon1) * t;
      const r = Math.floor((90 - lat) / 180 * H);
      if (r < 0 || r >= H) continue;
      let c = Math.floor((lon + 180) / 360 * W);
      c = ((c % W) + W) % W;
      paint(r, c);
    }
  }
}

function drawLineGeometry(geom, paint) {
  if (!geom) return;
  if (geom.type === 'LineString') drawPolyline(geom.coordinates, paint);
  else if (geom.type === 'MultiLineString') for (const l of geom.coordinates) drawPolyline(l, paint);
}

// -------------------------------------------------- country outline SVGs

/** Render a country geometry to a 200x200 silhouette SVG.
 *  Equirectangular scaled by cos(mean lat) — no rotation normalisation
 *  (Chile stays long and vertical). Antimeridian-safe via unwrapping.
 *  Subpaths under 0.3% of the country's area are dropped. */
function outlineSVG(geom) {
  const polys = (geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates)
    .map((rings) => rings.map(unwrapRing));
  const meanLon = (ring) => ring.reduce((s, p) => s + p[0], 0) / ring.length;
  // Align holes to their outer ring's frame.
  for (const rings of polys) {
    const m0 = meanLon(rings[0]);
    for (let i = 1; i < rings.length; i++) {
      const k = Math.round((m0 - meanLon(rings[i])) / 360);
      if (k) for (const p of rings[i]) p[0] += k * 360;
    }
  }
  // Align every polygon to the largest polygon's frame (Chatham-Islands
  // style parts on the far side of ±180 must not smear the box).
  const roughSize = (rings) => {
    const r = rings[0];
    let a = 0;
    for (let i = 0; i + 1 < r.length; i++) a += (r[i][0] - r[i + 1][0]) * (r[i][1] + r[i + 1][1]);
    return Math.abs(a);
  };
  let main = polys[0], best = -1;
  for (const p of polys) { const s = roughSize(p); if (s > best) { best = s; main = p; } }
  const mainLon = meanLon(main[0]);
  for (const rings of polys) {
    const k = Math.round((mainLon - meanLon(rings[0])) / 360);
    if (k) for (const ring of rings) for (const p of ring) p[0] += k * 360;
  }
  // Project: x = lon·cos(mean lat), y = −lat.
  let sLat = 0, nLat = 0;
  for (const rings of polys) for (const p of rings[0]) { sLat += p[1]; nLat++; }
  const kx = Math.max(0.15, Math.cos((sLat / nLat) * Math.PI / 180));
  const proj = polys.map((rings) => rings.map((ring) => ring.map(([lon, lat]) => [lon * kx, -lat])));
  // Drop sub-0.3%-area parts (a thousand rocks off Norway are noise).
  const shoelace = (ring) => {
    let a = 0;
    for (let i = 0; i + 1 < ring.length; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    return Math.abs(a / 2);
  };
  const areas = proj.map((rings) => shoelace(rings[0]));
  const total = areas.reduce((a, b) => a + b, 0);
  const keep = areas.map((a) => a >= 0.003 * total);
  // Far-flung dependency drop: when one mainland dominates (>50% of area),
  // parts separated from it by a sea gap larger than 35% of the mainland's
  // span are excluded — Svalbard must not squash Norway's hook, and the
  // Azores must not turn Portugal sideways. A part that is itself >30% of
  // the country is never dropped (that is a second main island, not a
  // dependency).
  let mainIdx = 0;
  for (let i = 1; i < areas.length; i++) if (areas[i] > areas[mainIdx]) mainIdx = i;
  if (areas[mainIdx] / total > 0.5 && proj.length > 1) {
    const mr = proj[mainIdx][0];
    let mx0 = Infinity, my0 = Infinity, mx1 = -Infinity, my1 = -Infinity;
    for (const [x, y] of mr) {
      if (x < mx0) mx0 = x; if (x > mx1) mx1 = x;
      if (y < my0) my0 = y; if (y > my1) my1 = y;
    }
    const mainSpan = Math.max(mx1 - mx0, my1 - my0);
    const sub = (ring) => ring.filter((_, i) => i % 4 === 0 || ring.length < 40);
    const mSub = sub(mr);
    for (let i = 0; i < proj.length; i++) {
      if (i === mainIdx || !keep[i] || areas[i] / total > 0.3) continue;
      let gap = Infinity;
      for (const [ax, ay] of sub(proj[i][0])) {
        for (const [bx, by] of mSub) {
          const d = Math.hypot(ax - bx, ay - by);
          if (d < gap) gap = d;
        }
        if (gap <= 0.35 * mainSpan) break;
      }
      if (gap > 0.35 * mainSpan) keep[i] = false;
    }
  }
  const kept = proj.filter((_, i) => keep[i]);
  // Fit to the box with a 5-unit margin, centred, aspect preserved.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const rings of kept) for (const ring of rings) for (const [x, y] of ring) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const sc = 190 / Math.max(x1 - x0, y1 - y0, 1e-9);
  const tx = (200 - (x1 - x0) * sc) / 2 - x0 * sc;
  const ty = (200 - (y1 - y0) * sc) / 2 - y0 * sc;
  let d = '';
  for (const rings of kept) {
    for (const ring of rings) {
      let seg = '', lastX = null, lastY = null, count = 0;
      for (const [px, py] of ring) {
        const X = Math.round((px * sc + tx) * 100) / 100;
        const Y = Math.round((py * sc + ty) * 100) / 100;
        if (lastX !== null && Math.abs(X - lastX) < 0.15 && Math.abs(Y - lastY) < 0.15) continue;
        seg += (lastX === null ? `M${X} ${Y}` : `L${X} ${Y}`);
        lastX = X; lastY = Y; count++;
      }
      if (count >= 3) d += seg + 'Z';
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path fill="currentColor" fill-rule="evenodd" d="${d}"/></svg>\n`;
}

// ----------------------------------------------------- distance transform

/** Chamfer distance (km, approximate great-circle via per-row cos scaling)
 *  from every texel to the nearest texel where srcMask is truthy.
 *  Wraps in x. Good to a few texels of accuracy, which is all we need. */
function chamferKm(srcMask) {
  const d = new Float32Array(N).fill(1e9);
  for (let i = 0; i < N; i++) if (srcMask[i]) d[i] = 0;
  const hCost = new Float32Array(H), vCost = KM_PER_TEXEL * (180 / 360) * (W / H); // = 9.78 for 2:1
  const dCost = new Float32Array(H);
  for (let r = 0; r < H; r++) {
    const cl = Math.max(0.02, Math.cos(rowLat(r) * Math.PI / 180));
    hCost[r] = KM_PER_TEXEL * cl;
    dCost[r] = Math.hypot(hCost[r], vCost);
  }
  for (let iter = 0; iter < 3; iter++) {
    let changed = false;
    for (let r = 0; r < H; r++) {
      const base = r * W, up = (r - 1) * W;
      for (let c = 0; c < W; c++) {
        const i = base + c;
        let v = d[i];
        const cl = base + ((c - 1 + W) % W);
        if (d[cl] + hCost[r] < v) v = d[cl] + hCost[r];
        if (r > 0) {
          if (d[up + c] + vCost < v) v = d[up + c] + vCost;
          if (d[up + ((c - 1 + W) % W)] + dCost[r] < v) v = d[up + ((c - 1 + W) % W)] + dCost[r];
          if (d[up + ((c + 1) % W)] + dCost[r] < v) v = d[up + ((c + 1) % W)] + dCost[r];
        }
        if (v < d[i]) { d[i] = v; changed = true; }
      }
    }
    for (let r = H - 1; r >= 0; r--) {
      const base = r * W, dn = (r + 1) * W;
      for (let c = W - 1; c >= 0; c--) {
        const i = base + c;
        let v = d[i];
        const cr = base + ((c + 1) % W);
        if (d[cr] + hCost[r] < v) v = d[cr] + hCost[r];
        if (r < H - 1) {
          if (d[dn + c] + vCost < v) v = d[dn + c] + vCost;
          if (d[dn + ((c - 1 + W) % W)] + dCost[r] < v) v = d[dn + ((c - 1 + W) % W)] + dCost[r];
          if (d[dn + ((c + 1) % W)] + dCost[r] < v) v = d[dn + ((c + 1) % W)] + dCost[r];
        }
        if (v < d[i]) { d[i] = v; changed = true; }
      }
    }
    if (!changed) break;
  }
  return d;
}

// ---------------------------------------------------------------- ISO table

/** ISO 3166-1 numeric -> [alpha-3, alpha-2]. world-atlas feature ids are the
 *  numeric codes as (possibly zero-padded) strings. */
const ISO_NUM = {
  4: ['AFG', 'af'], 8: ['ALB', 'al'], 10: ['ATA', 'aq'], 12: ['DZA', 'dz'], 16: ['ASM', 'as'],
  20: ['AND', 'ad'], 24: ['AGO', 'ao'], 28: ['ATG', 'ag'], 31: ['AZE', 'az'], 32: ['ARG', 'ar'],
  36: ['AUS', 'au'], 40: ['AUT', 'at'], 44: ['BHS', 'bs'], 48: ['BHR', 'bh'], 50: ['BGD', 'bd'],
  51: ['ARM', 'am'], 52: ['BRB', 'bb'], 56: ['BEL', 'be'], 60: ['BMU', 'bm'], 64: ['BTN', 'bt'],
  68: ['BOL', 'bo'], 70: ['BIH', 'ba'], 72: ['BWA', 'bw'], 74: ['BVT', 'bv'], 76: ['BRA', 'br'],
  84: ['BLZ', 'bz'], 86: ['IOT', 'io'], 90: ['SLB', 'sb'], 92: ['VGB', 'vg'], 96: ['BRN', 'bn'],
  100: ['BGR', 'bg'], 104: ['MMR', 'mm'], 108: ['BDI', 'bi'], 112: ['BLR', 'by'], 116: ['KHM', 'kh'],
  120: ['CMR', 'cm'], 124: ['CAN', 'ca'], 132: ['CPV', 'cv'], 136: ['CYM', 'ky'], 140: ['CAF', 'cf'],
  144: ['LKA', 'lk'], 148: ['TCD', 'td'], 152: ['CHL', 'cl'], 156: ['CHN', 'cn'], 158: ['TWN', 'tw'],
  162: ['CXR', 'cx'], 166: ['CCK', 'cc'], 170: ['COL', 'co'], 174: ['COM', 'km'], 175: ['MYT', 'yt'],
  178: ['COG', 'cg'], 180: ['COD', 'cd'], 184: ['COK', 'ck'], 188: ['CRI', 'cr'], 191: ['HRV', 'hr'],
  192: ['CUB', 'cu'], 196: ['CYP', 'cy'], 203: ['CZE', 'cz'], 204: ['BEN', 'bj'], 208: ['DNK', 'dk'],
  212: ['DMA', 'dm'], 214: ['DOM', 'do'], 218: ['ECU', 'ec'], 222: ['SLV', 'sv'], 226: ['GNQ', 'gq'],
  231: ['ETH', 'et'], 232: ['ERI', 'er'], 233: ['EST', 'ee'], 234: ['FRO', 'fo'], 238: ['FLK', 'fk'],
  239: ['SGS', 'gs'], 242: ['FJI', 'fj'], 246: ['FIN', 'fi'], 248: ['ALA', 'ax'], 250: ['FRA', 'fr'],
  254: ['GUF', 'gf'], 258: ['PYF', 'pf'], 260: ['ATF', 'tf'], 262: ['DJI', 'dj'], 266: ['GAB', 'ga'],
  268: ['GEO', 'ge'], 270: ['GMB', 'gm'], 275: ['PSE', 'ps'], 276: ['DEU', 'de'], 288: ['GHA', 'gh'],
  292: ['GIB', 'gi'], 296: ['KIR', 'ki'], 300: ['GRC', 'gr'], 304: ['GRL', 'gl'], 308: ['GRD', 'gd'],
  312: ['GLP', 'gp'], 316: ['GUM', 'gu'], 320: ['GTM', 'gt'], 324: ['GIN', 'gn'], 328: ['GUY', 'gy'],
  332: ['HTI', 'ht'], 334: ['HMD', 'hm'], 336: ['VAT', 'va'], 340: ['HND', 'hn'], 344: ['HKG', 'hk'],
  348: ['HUN', 'hu'], 352: ['ISL', 'is'], 356: ['IND', 'in'], 360: ['IDN', 'id'], 364: ['IRN', 'ir'],
  368: ['IRQ', 'iq'], 372: ['IRL', 'ie'], 376: ['ISR', 'il'], 380: ['ITA', 'it'], 384: ['CIV', 'ci'],
  388: ['JAM', 'jm'], 392: ['JPN', 'jp'], 398: ['KAZ', 'kz'], 400: ['JOR', 'jo'], 404: ['KEN', 'ke'],
  408: ['PRK', 'kp'], 410: ['KOR', 'kr'], 414: ['KWT', 'kw'], 417: ['KGZ', 'kg'], 418: ['LAO', 'la'],
  422: ['LBN', 'lb'], 426: ['LSO', 'ls'], 428: ['LVA', 'lv'], 430: ['LBR', 'lr'], 434: ['LBY', 'ly'],
  438: ['LIE', 'li'], 440: ['LTU', 'lt'], 442: ['LUX', 'lu'], 446: ['MAC', 'mo'], 450: ['MDG', 'mg'],
  454: ['MWI', 'mw'], 458: ['MYS', 'my'], 462: ['MDV', 'mv'], 466: ['MLI', 'ml'], 470: ['MLT', 'mt'],
  474: ['MTQ', 'mq'], 478: ['MRT', 'mr'], 480: ['MUS', 'mu'], 484: ['MEX', 'mx'], 492: ['MCO', 'mc'],
  496: ['MNG', 'mn'], 498: ['MDA', 'md'], 499: ['MNE', 'me'], 500: ['MSR', 'ms'], 504: ['MAR', 'ma'],
  508: ['MOZ', 'mz'], 512: ['OMN', 'om'], 516: ['NAM', 'na'], 520: ['NRU', 'nr'], 524: ['NPL', 'np'],
  528: ['NLD', 'nl'], 531: ['CUW', 'cw'], 533: ['ABW', 'aw'], 534: ['SXM', 'sx'], 535: ['BES', 'bq'],
  540: ['NCL', 'nc'], 548: ['VUT', 'vu'], 554: ['NZL', 'nz'], 558: ['NIC', 'ni'], 562: ['NER', 'ne'],
  566: ['NGA', 'ng'], 570: ['NIU', 'nu'], 574: ['NFK', 'nf'], 578: ['NOR', 'no'], 580: ['MNP', 'mp'],
  581: ['UMI', 'um'], 583: ['FSM', 'fm'], 584: ['MHL', 'mh'], 585: ['PLW', 'pw'], 586: ['PAK', 'pk'],
  591: ['PAN', 'pa'], 598: ['PNG', 'pg'], 600: ['PRY', 'py'], 604: ['PER', 'pe'], 608: ['PHL', 'ph'],
  612: ['PCN', 'pn'], 616: ['POL', 'pl'], 620: ['PRT', 'pt'], 624: ['GNB', 'gw'], 626: ['TLS', 'tl'],
  630: ['PRI', 'pr'], 634: ['QAT', 'qa'], 638: ['REU', 're'], 642: ['ROU', 'ro'], 643: ['RUS', 'ru'],
  646: ['RWA', 'rw'], 652: ['BLM', 'bl'], 654: ['SHN', 'sh'], 659: ['KNA', 'kn'], 660: ['AIA', 'ai'],
  662: ['LCA', 'lc'], 663: ['MAF', 'mf'], 666: ['SPM', 'pm'], 670: ['VCT', 'vc'], 674: ['SMR', 'sm'],
  678: ['STP', 'st'], 682: ['SAU', 'sa'], 686: ['SEN', 'sn'], 688: ['SRB', 'rs'], 690: ['SYC', 'sc'],
  694: ['SLE', 'sl'], 702: ['SGP', 'sg'], 703: ['SVK', 'sk'], 704: ['VNM', 'vn'], 705: ['SVN', 'si'],
  706: ['SOM', 'so'], 710: ['ZAF', 'za'], 716: ['ZWE', 'zw'], 724: ['ESP', 'es'], 728: ['SSD', 'ss'],
  729: ['SDN', 'sd'], 732: ['ESH', 'eh'], 740: ['SUR', 'sr'], 744: ['SJM', 'sj'], 748: ['SWZ', 'sz'],
  752: ['SWE', 'se'], 756: ['CHE', 'ch'], 760: ['SYR', 'sy'], 762: ['TJK', 'tj'], 764: ['THA', 'th'],
  768: ['TGO', 'tg'], 772: ['TKL', 'tk'], 776: ['TON', 'to'], 780: ['TTO', 'tt'], 784: ['ARE', 'ae'],
  788: ['TUN', 'tn'], 792: ['TUR', 'tr'], 795: ['TKM', 'tm'], 796: ['TCA', 'tc'], 798: ['TUV', 'tv'],
  800: ['UGA', 'ug'], 804: ['UKR', 'ua'], 807: ['MKD', 'mk'], 818: ['EGY', 'eg'], 826: ['GBR', 'gb'],
  831: ['GGY', 'gg'], 832: ['JEY', 'je'], 833: ['IMN', 'im'], 834: ['TZA', 'tz'], 840: ['USA', 'us'],
  850: ['VIR', 'vi'], 854: ['BFA', 'bf'], 858: ['URY', 'uy'], 860: ['UZB', 'uz'], 862: ['VEN', 've'],
  876: ['WLF', 'wf'], 882: ['WSM', 'ws'], 887: ['YEM', 'ye'], 894: ['ZMB', 'zm'],
};
/** Fallbacks for features without a valid numeric id (disputed territories). */
const ISO_BY_NAME = {
  'Kosovo': ['XKX', 'xk'],
  'N. Cyprus': ['ZNC', 'cy'],
  'Northern Cyprus': ['ZNC', 'cy'],
  'Somaliland': ['SOL', 'so'],
};

// ------------------------------------------------------------------- main

async function main() {
  log(`GlobeSnake bake starting (${OFFLINE ? 'OFFLINE' : 'online'}, force=${FORCE})`);
  fs.mkdirSync(CACHE, { recursive: true });
  fs.mkdirSync(OUT_DATA, { recursive: true });
  fs.mkdirSync(OUT_TEX, { recursive: true });

  let sharp = null;
  try { sharp = (await import('sharp')).default; }
  catch (e) { warn(`sharp unavailable (${e.message}) — elevation & textures degrade`); }
  let topojson = null;
  try { topojson = await import('topojson-client'); }
  catch (e) { warn(`topojson-client unavailable (${e.message})`); }

  // ---------------- downloads (all optional; each failure degrades) --------
  const files = {};
  files.countries = await fetchCached(SOURCES.countries);
  files.land = await fetchCached(SOURCES.land);
  files.lakes = await fetchCached(SOURCES.lakes);
  files.rivers = await fetchCached(SOURCES.rivers);
  files.glaciers = await fetchCached(SOURCES.glaciers);
  files.gebco = sharp ? await fetchCached(SOURCES.gebco) : null;
  files.day = sharp ? await fetchCached(SOURCES.day) : null;
  files.night = sharp ? await fetchCached(SOURCES.night) : null;
  files.koppen = sharp ? await fetchZipEntry(SOURCES.koppen, /present_0p5\.tif$/i) : null;

  // ---------------- stage 1: land / lakes / glaciers masks ----------------
  log('stage 1: rasterizing land / lakes / glaciers');
  const landMask = new Uint8Array(N);
  const lakeMask = new Uint8Array(N);
  const glacierMask = new Uint8Array(N);
  const riverMask = new Uint8Array(N);
  let landSource = 'procedural';

  if (files.land) {
    try {
      const gj = JSON.parse(fs.readFileSync(files.land, 'utf8'));
      for (const f of gj.features) fillGeometry(f.geometry, (r, c) => { landMask[r * W + c] = 1; });
      landSource = 'Natural Earth 50m land polygons';
    } catch (e) { warn(`land parse failed: ${e.message}`); }
  }

  // ---------------- stage 2: countries ------------------------------------
  log('stage 2: rasterizing countries');
  const country = new Uint8Array(N);
  let countries = []; // {idx,name,iso3,iso2,lat,lon,areaRank}
  let countrySource = 'none (no data — country byte all 0)';

  if (files.countries && topojson) {
    try {
      const topo = JSON.parse(fs.readFileSync(files.countries, 'utf8'));
      const fc = topojson.feature(topo, topo.objects.countries);
      let feats = fc.features.filter((f) => f.geometry);
      // Spherical area (km²) per feature, for fill order + areaRank + merging.
      const areaOf = (geom) => {
        let a = 0;
        const ringA = (ring) => {
          let s = 0;
          for (let i = 0; i + 1 < ring.length; i++) {
            const [l1, p1] = ring[i], [l2, p2] = ring[i + 1];
            let dl = l2 - l1;
            if (dl > 180) dl -= 360; else if (dl < -180) dl += 360;
            s += dl * Math.PI / 180 * (2 + Math.sin(p1 * Math.PI / 180) + Math.sin(p2 * Math.PI / 180));
          }
          return -s * R_EARTH * R_EARTH / 2;
        };
        const polys = geom.type === 'Polygon' ? [geom.coordinates]
          : geom.type === 'MultiPolygon' ? geom.coordinates : [];
        for (const rings of polys) for (const ring of rings) a += ringA(ring);
        return Math.abs(a);
      };
      for (const f of feats) f._area = areaOf(f.geometry);

      if (feats.length > 254) {
        feats.sort((a, b) => b._area - a._area);
        const dropped = feats.slice(254).map((f) => f.properties?.name || '?');
        note(`more than 254 countries (${feats.length}); merged smallest into neighbours: ${dropped.join(', ')}`);
        feats = feats.slice(0, 254);
      }
      // Stable source order for idx assignment; paint big->small so small win.
      countries = feats.map((f, i) => {
        const num = parseInt(f.id, 10);
        const iso = (Number.isFinite(num) && ISO_NUM[num]) || ISO_BY_NAME[f.properties?.name] || ['UNK', 'un'];
        return {
          idx: i + 1, name: f.properties?.name ?? `#${f.id}`,
          iso3: iso[0], iso2: iso[1], lat: 0, lon: 0, areaRank: 0,
          _area: f._area, _feat: f,
        };
      });
      const byArea = [...countries].sort((a, b) => b._area - a._area);
      byArea.forEach((c, i) => { c.areaRank = i + 1; });
      // ISO3 must be unique: world-atlas reuses parent-state ids for some
      // territories (e.g. Ashmore & Cartier carries 036 = Australia), and
      // several disputed areas have no id at all. The larger landmass
      // (smaller areaRank) keeps the genuine code; the rest get synthetic
      // X01.. codes so ISO3 -> country lookup is unambiguous.
      {
        const byCode = new Map();
        for (const c of countries) {
          if (!byCode.has(c.iso3)) byCode.set(c.iso3, []);
          byCode.get(c.iso3).push(c);
        }
        let synth = 0;
        for (const [code, list] of byCode) {
          list.sort((a, b) => a.areaRank - b.areaRank);
          const keepFrom = code === 'UNK' ? 0 : 1; // UNK is not a real code; nobody keeps it
          for (let k = keepFrom; k < list.length; k++) {
            const c = list[k];
            c.iso3 = `X${String(++synth).padStart(2, '0')}`;
            note(`ISO3 ${code} contested: "${c.name}" (areaRank ${c.areaRank}) reassigned to synthetic ${c.iso3}` +
              (keepFrom === 1 ? `; "${list[0].name}" keeps ${code}` : ''));
          }
        }
      }
      for (const c of byArea) { // largest painted first, smallest overwrite
        fillGeometry(c._feat.geometry, (r, cc) => { country[r * W + cc] = c.idx; });
      }
      // Guarantee every country owns at least one texel.
      const owned = new Set(country);
      for (const c of countries) {
        if (owned.has(c.idx)) continue;
        const g = c._feat.geometry;
        const firstRing = g.type === 'Polygon' ? g.coordinates[0] : g.coordinates[0][0];
        let sx = 0, sy = 0;
        for (const p of firstRing) { sx += p[0]; sy += p[1]; }
        const i = idxOf(sy / firstRing.length, sx / firstRing.length);
        country[i] = c.idx; landMask[i] = 1;
        note(`stamped 1 texel for tiny country ${c.name}`);
      }
      countrySource = 'world-atlas countries-50m (Natural Earth ids)';
    } catch (e) { warn(`countries failed: ${e.message}`); }
  }
  // Countries imply land even where NE land raster missed slivers.
  for (let i = 0; i < N; i++) if (country[i]) landMask[i] = 1;

  if (landSource === 'procedural' && countrySource.startsWith('world-atlas')) {
    landSource = 'world-atlas country polygons (NE land unavailable)';
  } else if (landSource === 'procedural') {
    // Zero-network fallback: plausible continents from seeded fBm.
    log('  synthesizing procedural landmass (no vector data)');
    for (let r = 0; r < H; r++) {
      const lat = rowLat(r);
      const polar = Math.max(0, 1 - Math.abs(lat + 15) / 90); // damp far north
      for (let c = 0; c < W; c++) {
        const n1 = fbm(c, r, 6, 5, 7001) + 0.45 * fbm(c, r, 24, 4, 7002);
        if (n1 * (0.65 + 0.35 * polar) > 0.18 || lat < -72) landMask[r * W + c] = 1;
      }
    }
  }

  if (files.lakes) {
    try {
      const gj = JSON.parse(fs.readFileSync(files.lakes, 'utf8'));
      for (const f of gj.features) fillGeometry(f.geometry, (r, c) => {
        const i = r * W + c;
        if (landMask[i]) lakeMask[i] = 1; // lakes only exist on land
      });
    } catch (e) { warn(`lakes parse failed: ${e.message}`); }
  }
  if (files.glaciers) {
    try {
      const gj = JSON.parse(fs.readFileSync(files.glaciers, 'utf8'));
      for (const f of gj.features) fillGeometry(f.geometry, (r, c) => { glacierMask[r * W + c] = 1; });
    } catch (e) { warn(`glaciers parse failed: ${e.message}`); }
  }
  if (files.rivers) {
    try {
      const gj = JSON.parse(fs.readFileSync(files.rivers, 'utf8'));
      let count = 0;
      for (const f of gj.features) {
        if (f.properties?.featurecla && !/river/i.test(f.properties.featurecla)) continue;
        drawLineGeometry(f.geometry, (r, c) => { riverMask[r * W + c] = 1; });
        count++;
      }
      log(`  rasterized ${count} river features`);
    } catch (e) { warn(`rivers parse failed: ${e.message}`); }
  }

  // ---------------- stage 3: distance transforms --------------------------
  log('stage 3: distance transforms (coast / continentality)');
  const waterMask = new Uint8Array(N);
  for (let i = 0; i < N; i++) waterMask[i] = (!landMask[i] || lakeMask[i]) ? 1 : 0;
  const oceanOnly = new Uint8Array(N);
  for (let i = 0; i < N; i++) oceanOnly[i] = landMask[i] ? 0 : 1;
  const distToLandKm = chamferKm(landMask);   // meaningful over ocean
  const distToOceanKm = chamferKm(oceanOnly); // meaningful over land (continentality)

  // ---------------- stage 4: elevation ------------------------------------
  log('stage 4: elevation');
  const elevM = new Float32Array(N); // +m above sea level on land; ocean depth as negative
  let elevSource = 'procedural (fBm, continentality-scaled)';

  let landGray = null;
  if (files.gebco && sharp) {
    try {
      const img = sharp(files.gebco, { limitInputPixels: false });
      const meta = await img.metadata();
      log(`  GEBCO source: ${meta.width}x${meta.height}, ${meta.channels}ch, depth=${meta.depth}`);
      const { data, info } = await sharp(files.gebco, { limitInputPixels: false })
        .toColourspace('b-w').raw().toBuffer({ resolveWithObject: true });
      const sw = info.width, sh = info.height, ch = info.channels;
      const bps = data.length / (sw * sh * ch); // bytes per sample (1 or 2)
      log(`  decoded raw ${sw}x${sh} ch=${ch} bytesPerSample=${bps}`);
      // Block downsample: mean+max blend preserves peaks (Everest must survive).
      landGray = new Uint8Array(N);
      for (let r = 0; r < H; r++) {
        const y0 = Math.floor(r * sh / H), y1 = Math.floor((r + 1) * sh / H);
        for (let c = 0; c < W; c++) {
          const x0 = Math.floor(c * sw / W), x1 = Math.floor((c + 1) * sw / W);
          let sum = 0, mx = 0, cnt = 0;
          for (let y = y0; y < y1; y++) {
            const rowBase = y * sw;
            for (let x = x0; x < x1; x++) {
              let v;
              if (bps === 2) v = data[((rowBase + x) * ch) * 2 + 1]; // hi byte of LE? use readUInt16 below
              else v = data[(rowBase + x) * ch];
              sum += v; if (v > mx) mx = v; cnt++;
            }
          }
          landGray[r * W + c] = Math.min(255, Math.round((sum / cnt) * 0.6 + mx * 0.4));
        }
      }
      elevSource = 'NASA GEBCO_08 rev elev (mean+max block downsample)';
    } catch (e) {
      warn(`GEBCO decode failed: ${e.message} — procedural elevation fallback`);
      landGray = null;
    }
  }

  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const i = r * W + c;
      if (landMask[i]) {
        if (landGray) {
          elevM[i] = gebcoGreyToMetres(landGray[i]);
        } else {
          // Procedural: interiors higher, ridged noise for ranges.
          const cont = Math.min(1, distToOceanKm[i] / 1500);
          const base = 30 + 900 * cont;
          const n = fbm(c, r, 12, 5, 4242);
          const ridge = Math.pow(1 - Math.abs(fbm(c, r, 20, 4, 4243)), 6);
          elevM[i] = Math.max(1, base + 700 * n + 4500 * ridge * (0.25 + 0.75 * cont));
        }
      } else {
        // Bathymetry is synthesized from distance to coast (no bathy source).
        const d = distToLandKm[i];
        const t = Math.min(1, d / 260);
        const shelf = t * t * (3 - 2 * t); // smoothstep to abyssal plain
        let depth = 25 + 5400 * shelf + 700 * Math.max(0, fbm(c, r, 16, 4, 9091));
        elevM[i] = -Math.min(MAX_DEPTH_M, depth);
      }
    }
  }
  landGray = null;

  const elevCode = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (elevM[i] >= 0) {
      elevCode[i] = SEA_LEVEL + Math.min(155, Math.round(155 * elevM[i] / MAX_ELEV_M));
    } else {
      elevCode[i] = Math.max(0, Math.round(SEA_LEVEL * (1 - (-elevM[i]) / MAX_DEPTH_M)));
    }
  }
  // Note: landGray is kept alive — terrain classification measures slope in
  // the grey-linear domain (18 m/grey). The piecewise stretch above the knee
  // amplifies grey jitter ~4x, which would make the (genuinely flat) Tibetan
  // plateau read as steep; grey-linear slope keeps plateaus flat while real
  // valley-to-peak fronts (which span the knee) stay steep.
  const gebcoGray = landGray;

  // ---------------- stage 5: climate --------------------------------------
  log('stage 5: climate');
  const climate = new Uint8Array(N);
  let koppenGrid = null, kw = 0, kh = 0;
  let climSource = 'procedural (latitude bands + lapse + continentality + noise)';
  let realTexels = 0, procTexels = 0;

  if (files.koppen && sharp) {
    try {
      const { data, info } = await sharp(files.koppen).raw().toBuffer({ resolveWithObject: true });
      kw = info.width; kh = info.height;
      log(`  Köppen raster: ${kw}x${kh} ch=${info.channels}`);
      koppenGrid = new Uint8Array(kw * kh);
      if (info.channels >= 3) {
        // Palette TIFF expanded to RGB by libvips: recover the class index by
        // inverting the TIFF ColorMap (tag 320), nearest-colour fallback.
        const tif = fs.readFileSync(files.koppen);
        if (tif.toString('latin1', 0, 2) !== 'II') throw new Error('non-LE TIFF');
        const ifd = tif.readUInt32LE(4);
        const nTags = tif.readUInt16LE(ifd);
        let cmapOff = -1;
        for (let ti = 0; ti < nTags; ti++) {
          const o = ifd + 2 + ti * 12;
          if (tif.readUInt16LE(o) === 320) { cmapOff = tif.readUInt32LE(o + 8); break; }
        }
        if (cmapOff < 0) throw new Error('no ColorMap tag in palette TIFF');
        const pal = []; // [r,g,b,class]
        for (let k = 1; k <= 30; k++) {
          pal.push([tif.readUInt16LE(cmapOff + k * 2) >> 8,
            tif.readUInt16LE(cmapOff + (256 + k) * 2) >> 8,
            tif.readUInt16LE(cmapOff + (512 + k) * 2) >> 8, k]);
        }
        for (let i = 0; i < kw * kh; i++) {
          const r0 = data[i * info.channels], g0 = data[i * info.channels + 1], b0 = data[i * info.channels + 2];
          if (r0 === 255 && g0 === 255 && b0 === 255) continue; // ocean/nodata (white)
          let bestK = 0, bestD = 40; // require a reasonably close colour
          for (const [pr, pg, pb, k] of pal) {
            const d = Math.abs(pr - r0) + Math.abs(pg - g0) + Math.abs(pb - b0);
            if (d < bestD) { bestD = d; bestK = k; if (d === 0) break; }
          }
          koppenGrid[i] = bestK;
        }
      } else {
        for (let i = 0; i < kw * kh; i++) {
          const v = data[i * info.channels];
          koppenGrid[i] = v >= 1 && v <= 30 ? v : 0;
        }
      }
      // Dilate a few cells so coastal texels just outside the 0.5° land cells
      // still pick up a real class.
      for (let pass = 0; pass < 4; pass++) {
        const next = koppenGrid.slice();
        for (let y = 0; y < kh; y++) {
          for (let x = 0; x < kw; x++) {
            const i = y * kw + x;
            if (koppenGrid[i]) continue;
            const nb = [
              koppenGrid[y * kw + (x + 1) % kw], koppenGrid[y * kw + (x - 1 + kw) % kw],
              y > 0 ? koppenGrid[(y - 1) * kw + x] : 0, y < kh - 1 ? koppenGrid[(y + 1) * kw + x] : 0,
            ];
            for (const v of nb) if (v) { next[i] = v; break; }
          }
        }
        koppenGrid = next;
      }
      climSource = 'Beck et al. Köppen-Geiger V1 present-day 0.5° (CC BY 4.0), procedural infill for gaps';
    } catch (e) {
      warn(`Köppen decode failed: ${e.message} — procedural climate fallback`);
      koppenGrid = null;
    }
  }

  /** Procedural Köppen classifier from synthesized T/P. Deterministic. */
  function proceduralKoppen(r, c, i) {
    const lat = rowLat(r);
    const alat = Math.abs(lat);
    const cosLat = Math.max(0, Math.cos(lat * Math.PI / 180));
    const elevKm = Math.max(0, elevM[i]) / 1000;
    const cont = distToOceanKm[i];
    const n1 = fbm(c, r, 30, 4, 1337), n2 = fbm(c, r, 18, 4, 2338), n3 = fbm(c, r, 40, 3, 3339);
    const Tann = -20 + 48 * Math.pow(cosLat, 1.2) - 6.5 * elevKm - 0.002 * cont + 2 * n1;
    let range = (6 + Math.min(32, 0.035 * cont)) * Math.pow(Math.min(1.6, alat / 45), 1.3) + 4;
    const Tmax = Tann + 0.55 * range, Tmin = Tann - 0.55 * range;
    let P = 250
      + 1900 * Math.exp(-Math.pow((lat - 5) / 11, 2))
      + 900 * Math.exp(-Math.pow((alat - 48) / 14, 2));
    P *= 1 - 0.72 * Math.exp(-Math.pow((alat - 24) / 9, 2));
    P *= Math.exp(-cont / 1800);
    P *= 1 + 0.55 * n2;
    P = Math.max(12, P);
    const sf = Math.min(0.95, Math.max(0.05,
      0.5 + 0.25 * n3 + (alat < 30 ? 0.15 : 0) - (alat > 27 && alat < 45 ? 0.18 : 0)));

    let code;
    if (Tmax < 0) code = 'EF';
    else if (Tmax < 10) code = 'ET';
    else {
      const pth = Math.max(10, 20 * Tann + (sf >= 0.7 ? 280 : sf >= 0.3 ? 140 : 0));
      if (P < pth) {
        const hot = Tann >= 18;
        code = P < pth / 2 ? (hot ? 'BWh' : 'BWk') : (hot ? 'BSh' : 'BSk');
      } else if (Tmin >= 18) {
        const pdry = (P / 12) * (1 - sf) * 0.9;
        code = pdry >= 60 ? 'Af' : (P >= 25 * (100 - pdry) ? 'Am' : 'Aw');
      } else {
        const s2 = sf < 0.3 ? 's' : sf > 0.7 ? 'w' : 'f';
        let s3 = Tmax >= 22 ? 'a' : Tmax >= 15 ? 'b' : 'c';
        if (Tmin > -3) {
          code = 'C' + s2 + s3;
        } else {
          if (Tmin < -38 && s3 === 'c') s3 = 'd';
          code = 'D' + s2 + s3;
        }
      }
    }
    return KIDX.get(code) ?? KIDX.get('Cfb');
  }

  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const i = r * W + c;
      if (!landMask[i]) { climate[i] = 0; continue; }
      let v = 0;
      if (koppenGrid) {
        const kx = Math.min(kw - 1, Math.floor((colLon(c) + 180) / 360 * kw));
        const ky = Math.min(kh - 1, Math.floor((90 - rowLat(r)) / 180 * kh));
        v = koppenGrid[ky * kw + kx];
      }
      if (v) realTexels++;
      else { v = proceduralKoppen(r, c, i); procTexels++; }
      climate[i] = v;
    }
  }
  koppenGrid = null;
  log(`  climate: ${realTexels} real texels, ${procTexels} procedural`);

  // ---------------- stage 6: terrain classification -----------------------
  log('stage 6: terrain classification');
  const terrain = new Uint8Array(N);

  // Local slope in m/km against land neighbours only (coast cliffs to the
  // seabed must not read as mountains). When GEBCO greys are available the
  // slope is measured in the grey-linear domain (18 m/grey): the piecewise
  // stretch above the knee amplifies grey jitter ~4x, which would make flat
  // high plateaus (Tibet) read steep. Real range fronts span the knee and
  // stay steep either way.
  const sLin = new Float32Array(N);
  for (let r = 0; r < H; r++) {
    const dxKm = Math.max(0.5, KM_PER_TEXEL * Math.cos(rowLat(r) * Math.PI / 180));
    const dyKm = KM_PER_TEXEL;
    for (let c = 0; c < W; c++) {
      const i = r * W + c;
      if (!landMask[i]) continue;
      let s = 0;
      const nb = [
        [r * W + (c + 1) % W, dxKm], [r * W + (c - 1 + W) % W, dxKm],
        [r > 0 ? (r - 1) * W + c : -1, dyKm], [r < H - 1 ? (r + 1) * W + c : -1, dyKm],
      ];
      for (const [j, d] of nb) {
        if (j < 0 || !landMask[j]) continue;
        const g = gebcoGray
          ? Math.abs(gebcoGray[j] - gebcoGray[i]) * GEBCO_M_PER_G_LOW / d
          : Math.abs(elevM[j] - elevM[i]) / d;
        if (g > s) s = g;
      }
      sLin[i] = s;
    }
  }
  // Ruggedness: max slope within ±2 texels (~±20 km). This is what lets
  // range *interiors* (high valleys between crests) classify as mountain
  // instead of only the escarpment fronts.
  const rug = new Float32Array(N);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const i = r * W + c;
      if (!landMask[i]) continue;
      let m = 0;
      for (let dr = -2; dr <= 2; dr++) {
        const rr = r + dr;
        if (rr < 0 || rr >= H) continue;
        for (let dc = -2; dc <= 2; dc++) {
          const v = sLin[rr * W + (c + dc + W) % W];
          if (v > m) m = v;
        }
      }
      rug[i] = m;
    }
  }

  const kClass = (i) => KOPPEN[climate[i]] || '';
  for (let r = 0; r < H; r++) {
    const lat = rowLat(r);
    for (let c = 0; c < W; c++) {
      const i = r * W + c;
      if (!landMask[i]) { terrain[i] = TERRAIN.OCEAN; continue; }
      if (lakeMask[i]) { terrain[i] = TERRAIN.LAKE; continue; }
      const k = kClass(i);
      // Base biome from climate.
      let t;
      if (k.startsWith('BW')) t = TERRAIN.DESERT;
      else if (k.startsWith('BS')) t = TERRAIN.PLAINS; // steppe = grassland
      else if (k === 'Af' || k === 'Am') t = TERRAIN.FOREST;
      else if (k === 'Aw') t = TERRAIN.PLAINS;        // savanna
      else if (k.startsWith('Cf') || k.startsWith('Cw')) t = TERRAIN.FOREST;
      else if (k.startsWith('Df') || k.startsWith('Dw')) t = TERRAIN.FOREST; // taiga
      else t = TERRAIN.PLAINS; // Cs, Ds, and any leftovers
      // Ice: EF, glaciated areas, and Arctic tundra. Alpine/subarctic ET
      // (Tibet, the Scandes, Iceland lowlands) is NOT ice — the plateau and
      // Scandinavia must stay traversable; actual icecaps arrive via the
      // glaciated-areas mask.
      if (k === 'EF' || glacierMask[i] || (k === 'ET' && Math.abs(lat) >= 66)) t = TERRAIN.ICE;
      // Mountain needs elevation AND steepness. Tuned against real ranges
      // (see tools/bake docs + verify.mjs): the slope tiers catch fronts,
      // the ruggedness tier fills range interiors; flat plateau centres
      // (Tibet) fail all four and stay plains.
      const e = elevM[i], s = sLin[i];
      if ((s >= 40 && e >= 600) || (s >= 30 && e >= 1200) || (s >= 20 && e >= 2500)
        || (rug[i] >= 50 && e >= 1000)) {
        t = TERRAIN.MOUNTAIN;
      }
      terrain[i] = t;
    }
  }
  // Coast: land within ~1 texel of water (8-neighbourhood).
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const i = r * W + c;
      if (!landMask[i] || lakeMask[i]) continue;
      let coastal = false;
      for (let dr = -1; dr <= 1 && !coastal; dr++) {
        const rr = r + dr;
        if (rr < 0 || rr >= H) continue;
        for (let dc = -1; dc <= 1; dc++) {
          const j = rr * W + (c + dc + W) % W;
          if (waterMask[j]) { coastal = true; break; }
        }
      }
      if (coastal) terrain[i] = TERRAIN.COAST;
    }
  }
  // Rivers last: land-only speed lanes, win over everything but open water.
  for (let i = 0; i < N; i++) {
    if (riverMask[i] && landMask[i] && !lakeMask[i]) terrain[i] = TERRAIN.RIVER;
  }
  // Shallow water: ocean within ~2 texels of land.
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const i = r * W + c;
      if (landMask[i]) continue;
      if (distToLandKm[i] <= 2.2 * KM_PER_TEXEL) terrain[i] = TERRAIN.SHALLOW;
    }
  }

  // ---------------- stage 7: country representative points ----------------
  log('stage 7: country representative points');
  if (countries.length) {
    // Distance to the nearest texel belonging to a different country / water,
    // then argmax per country = pole of inaccessibility on our grid.
    const boundary = new Uint8Array(N);
    for (let r = 0; r < H; r++) {
      for (let c = 0; c < W; c++) {
        const i = r * W + c;
        const v = country[i];
        if (!v) { boundary[i] = 1; continue; } // water/none counts as boundary source
        const nb = [r * W + (c + 1) % W, r * W + (c - 1 + W) % W,
          r > 0 ? (r - 1) * W + c : -1, r < H - 1 ? (r + 1) * W + c : -1];
        for (const j of nb) {
          if (j < 0 || country[j] !== v) { boundary[i] = 1; break; }
        }
      }
    }
    const dIn = chamferKm(boundary);
    const best = new Float32Array(countries.length + 1).fill(-1);
    const bestI = new Int32Array(countries.length + 1).fill(-1);
    for (let i = 0; i < N; i++) {
      const v = country[i];
      if (!v) continue;
      if (dIn[i] > best[v]) { best[v] = dIn[i]; bestI[v] = i; }
    }
    for (const cn of countries) {
      const i = bestI[cn.idx];
      if (i >= 0) {
        cn.lat = Math.round(rowLat(Math.floor(i / W)) * 10) / 10;
        cn.lon = Math.round(colLon(i % W) * 10) / 10;
      }
    }
  }

  // ---------------- stage 7b: country outline SVGs ------------------------
  log('stage 7b: country outline SVGs');
  const OUTLINE_ISO3 = ['CHL', 'ITA', 'GMB', 'NOR', 'VNM', 'MDG', 'NAM', 'MWI',
    'CUB', 'HRV', 'SOM', 'PAN', 'MNG', 'LAO', 'PRT'];
  if (countries.length) {
    const outDir = path.join(ROOT, 'public', 'outlines');
    fs.mkdirSync(outDir, { recursive: true });
    let written = 0, totalBytes = 0;
    for (const iso of OUTLINE_ISO3) {
      const cn = countries.find((c) => c.iso3 === iso);
      if (!cn || !cn._feat) { warn(`outline: no geometry for ${iso}`); continue; }
      const svg = outlineSVG(cn._feat.geometry);
      const fp = path.join(outDir, `${iso}.svg`);
      fs.writeFileSync(fp, svg);
      written++; totalBytes += svg.length;
    }
    report.outputs.push({
      file: `public/outlines/*.svg (${written} countries)`, bytes: totalBytes,
      note: OUTLINE_ISO3.join(' '),
    });
    log(`  wrote ${written}/${OUTLINE_ISO3.length} outlines`);
  } else {
    note('no country geometry — outline SVGs NOT written');
  }
  for (const cn of countries) { delete cn._feat; delete cn._area; }

  // ---------------- stage 8: pack world.bin -------------------------------
  log('stage 8: packing world.bin');
  const raw = Buffer.alloc(8 + N * 4);
  raw.write('GSW1', 0, 'ascii');
  raw.writeUInt16LE(W, 4);
  raw.writeUInt16LE(H, 6);
  for (let i = 0; i < N; i++) {
    const o = 8 + i * 4;
    raw[o] = elevCode[i];
    raw[o + 1] = climate[i];
    raw[o + 2] = terrain[i];
    raw[o + 3] = country[i];
  }
  const gz = zlib.gzipSync(raw, { level: 9 });
  const binPath = path.join(OUT_DATA, 'world.bin');
  fs.writeFileSync(binPath, gz);
  report.outputs.push({ file: 'public/data/world.bin', bytes: gz.length, note: `${raw.length} B uncompressed` });
  log(`  world.bin: ${(gz.length / 1e6).toFixed(2)} MB gzipped (${(raw.length / 1e6).toFixed(1)} MB raw)`);

  const cjPath = path.join(OUT_DATA, 'countries.json');
  fs.writeFileSync(cjPath, JSON.stringify(countries, null, 1));
  report.outputs.push({ file: 'public/data/countries.json', bytes: fs.statSync(cjPath).size, note: `${countries.length} countries` });

  // ---------------- stage 9: textures -------------------------------------
  log('stage 9: textures');
  if (sharp) {
    // Day texture.
    const dayPath = path.join(OUT_TEX, 'earth_day.jpg');
    let daySource = 'synthesized from terrain classes';
    if (files.day) {
      try {
        await sharp(files.day, { limitInputPixels: false })
          .resize(4096, 2048, { fit: 'fill', kernel: 'lanczos3' })
          .jpeg({ quality: 82 }).toFile(dayPath);
        daySource = 'NASA Blue Marble topo+bathy (resized 4096x2048)';
      } catch (e) { warn(`day texture failed: ${e.message}`); files.day = null; }
    }
    if (!files.day) {
      // Synthesize a plausible day map from our own classified data.
      const px = Buffer.alloc(N * 3);
      const PAL = {
        [TERRAIN.OCEAN]: [10, 26, 51], [TERRAIN.SHALLOW]: [26, 68, 115],
        [TERRAIN.COAST]: [168, 158, 118], [TERRAIN.PLAINS]: [122, 143, 78],
        [TERRAIN.FOREST]: [44, 96, 52], [TERRAIN.DESERT]: [214, 190, 128],
        [TERRAIN.MOUNTAIN]: [134, 122, 104], [TERRAIN.ICE]: [235, 240, 244],
        [TERRAIN.RIVER]: [42, 92, 140], [TERRAIN.LAKE]: [30, 80, 130],
      };
      for (let i = 0; i < N; i++) {
        const p = PAL[terrain[i]];
        const shade = terrain[i] === TERRAIN.OCEAN
          ? 0.75 + 0.25 * (elevCode[i] / SEA_LEVEL)
          : 0.8 + 0.5 * ((elevCode[i] - SEA_LEVEL) / 155);
        px[i * 3] = Math.min(255, p[0] * shade);
        px[i * 3 + 1] = Math.min(255, p[1] * shade);
        px[i * 3 + 2] = Math.min(255, p[2] * shade);
      }
      await sharp(px, { raw: { width: W, height: H, channels: 3 } })
        .jpeg({ quality: 82 }).toFile(dayPath);
    }
    report.outputs.push({ file: 'public/textures/earth_day.jpg', bytes: fs.statSync(dayPath).size, note: daySource });

    // Night texture.
    const nightPath = path.join(OUT_TEX, 'earth_night.jpg');
    let nightSource = 'synthesized (near-black, faint land glow)';
    if (files.night) {
      try {
        await sharp(files.night, { limitInputPixels: false })
          .resize(2048, 1024, { fit: 'fill', kernel: 'lanczos3' })
          .jpeg({ quality: 82 }).toFile(nightPath);
        nightSource = 'NASA Earth at Night (resized 2048x1024)';
      } catch (e) { warn(`night texture failed: ${e.message}`); files.night = null; }
    }
    if (!files.night) {
      const w2 = 2048, h2 = 1024;
      const px = Buffer.alloc(w2 * h2 * 3);
      for (let r = 0; r < h2; r++) {
        for (let c = 0; c < w2; c++) {
          const i = (r * 2) * W + c * 2;
          const land = landMask[i];
          const g = land ? Math.floor(10 + 24 * hash2(c, r, 5150) * hash2(c + 7, r + 3, 5151)) : 2;
          const o = (r * w2 + c) * 3;
          px[o] = g; px[o + 1] = g; px[o + 2] = Math.min(255, g * 0.8);
        }
      }
      await sharp(px, { raw: { width: w2, height: h2, channels: 3 } })
        .jpeg({ quality: 82 }).toFile(nightPath);
    }
    report.outputs.push({ file: 'public/textures/earth_night.jpg', bytes: fs.statSync(nightPath).size, note: nightSource });

    // Bump map from our own elevation (land only, ocean flat mid-grey).
    const bumpPath = path.join(OUT_TEX, 'earth_bump.png');
    {
      const w2 = 2048, h2 = 1024;
      const px = Buffer.alloc(w2 * h2);
      for (let r = 0; r < h2; r++) {
        for (let c = 0; c < w2; c++) {
          let sum = 0;
          for (let dr = 0; dr < 2; dr++) {
            for (let dc = 0; dc < 2; dc++) {
              const i = (r * 2 + dr) * W + (c * 2 + dc);
              sum += elevCode[i] > SEA_LEVEL
                ? 128 + Math.round(127 * (elevCode[i] - SEA_LEVEL) / 155)
                : 128;
            }
          }
          px[r * w2 + c] = Math.round(sum / 4);
        }
      }
      await sharp(px, { raw: { width: w2, height: h2, channels: 1 } })
        .png({ compressionLevel: 9 }).toFile(bumpPath);
      report.outputs.push({ file: 'public/textures/earth_bump.png', bytes: fs.statSync(bumpPath).size, note: 'derived from baked elevation' });
    }
  } else {
    note('sharp unavailable — textures NOT written (world.bin unaffected)');
  }

  // ---------------- stage 10: stats + report ------------------------------
  log('stage 10: coverage stats + BAKE_REPORT.md');
  const texArea = new Float32Array(H); // km² per texel at each row
  for (let r = 0; r < H; r++) {
    texArea[r] = KM_PER_TEXEL * (Math.PI * R_EARTH / H) * Math.cos(rowLat(r) * Math.PI / 180) * (40075 / (2 * Math.PI * R_EARTH));
  }
  const terrCount = new Array(10).fill(0);
  const contArea = {};
  const continentOf = (lat, lon) => {
    if (lat <= -60) return 'Antarctica';
    if (lat >= 59 && lon >= -75 && lon <= -10) return 'North America'; // Greenland
    if (lon >= -82 && lon <= -34 && lat <= 13) return 'South America';
    if (lon <= -30) return 'North America';
    if (lat >= 36 && lon >= -25 && lon <= 62 && !(lon >= 26 && lat <= 44)) return 'Europe';
    if (((lon >= -20 && lon <= 35 && lat <= 38) || (lon > 35 && lon <= 52 && lat <= 12)) && lat >= -40) return 'Africa';
    if ((lat <= -10 && lon >= 110) || (lat <= -1 && lon >= 129) || (lat <= -28 && lon >= 160)) return 'Oceania';
    return 'Asia';
  };
  let landAreaTotal = 0;
  for (let r = 0; r < H; r++) {
    const lat = rowLat(r), a = texArea[r];
    for (let c = 0; c < W; c++) {
      const i = r * W + c;
      terrCount[terrain[i]]++;
      if (landMask[i]) {
        landAreaTotal += a;
        const k = continentOf(lat, colLon(c));
        contArea[k] = (contArea[k] || 0) + a;
      }
    }
  }
  report.stats.terrain = TERRAIN_NAMES.map((n, i) => ({
    class: `${i} ${n}`, texels: terrCount[i], pct: (100 * terrCount[i] / N).toFixed(2),
  }));
  report.stats.landAreaMkm2 = (landAreaTotal / 1e6).toFixed(1);
  report.stats.continents = contArea;
  report.stats.elevSource = elevSource;
  report.stats.climSource = climSource;
  report.stats.landSource = landSource;
  report.stats.countrySource = countrySource;
  report.stats.climateRealPct = realTexels + procTexels > 0
    ? (100 * realTexels / (realTexels + procTexels)).toFixed(1) : '0';

  writeReport();
  log('bake complete.');
  for (const t of report.stats.terrain) log(`  ${t.class}: ${t.pct}%`);
}

function writeReport() {
  const KNOWN = {
    Asia: 44.6, Africa: 30.4, 'North America': 24.7, 'South America': 17.8,
    Antarctica: 14.0, Europe: 10.2, Oceania: 8.5,
  };
  const lines = [];
  lines.push('# GlobeSnake bake report');
  lines.push('');
  lines.push('Generated by `tools/bake/index.mjs` (no timestamp: outputs are byte-identical for identical inputs).');
  lines.push('');
  lines.push('## Sources');
  lines.push('');
  lines.push('| source | licence | status | bytes |');
  lines.push('|---|---|---|---|');
  for (const s of report.sources) {
    lines.push(`| [${s.name}](${s.url}) | ${s.licence} | ${s.status} | ${s.bytes.toLocaleString()} |`);
  }
  lines.push('');
  lines.push('## What is real vs. synthesized');
  lines.push('');
  lines.push(`- **Land/ocean mask**: ${report.stats.landSource}`);
  lines.push(`- **Land elevation**: ${report.stats.elevSource}. The PNG's grey encoding is nonlinear; calibrated piecewise against known elevations (≈${GEBCO_M_PER_G_LOW} m/grey up to grey ${GEBCO_KNEE_G} ≈ ${GEBCO_KNEE_M} m, then ≈${GEBCO_M_PER_G_HIGH.toFixed(1)} m/grey with grey 255 anchored to Everest ${MAX_ELEV_M} m). Mid-mountain elevations (3–5 km) may read up to ~20% high.`);
  lines.push('- **Bathymetry**: SYNTHESIZED everywhere — smooth-stepped distance-to-coast to a ~5400–6100 m abyssal plain plus seeded noise. No real bathymetric grid is ingested; the elevation byte over ocean is plausible, not measured.');
  lines.push(`- **Climate**: ${report.stats.climSource}. ${report.stats.climateRealPct}% of land texels carry a real class; the remainder (small islands / coastal slivers below 0.5° resolution) use the procedural classifier.`);
  lines.push(`- **Countries**: ${report.stats.countrySource}.`);
  lines.push('- **Terrain**: derived (classification over climate + elevation + slope + NE water/glacier/river layers).');
  lines.push('');
  lines.push('## Classification rules (defensibility notes)');
  lines.push('');
  lines.push('- Mountain requires elevation AND steepness, measured in the GEBCO grey-linear domain to avoid stretch-amplified plateau jitter: slope≥40 m/km @ ≥600 m, ≥30 @ ≥1200 m, ≥20 @ ≥2500 m, or ruggedness (max slope within ±2 texels) ≥50 @ ≥1000 m. The ruggedness tier fills range interiors so the Andes/Rockies/Alps read as continuous ranges, tuned to ≈10% of land texels. Flat plateau centres (Tibet) fail all tiers and stay plains; plateau margins classify as mountain.');
  lines.push('- Desert = Köppen BW. **Deviation from the brief**: BS (steppe) maps to plains, not desert — steppe is grassland; this keeps the Great Plains, Sahel and Kazakh steppe traversable grassland rather than desert.');
  lines.push('- Forest = Af, Am, Cf*, Cw*, Df*, Dw* (Dw = East Siberian taiga; omitting it would leave half of Siberia unforested). **Deviation**: Aw (savanna) maps to plains, not forest.');
  lines.push('- Ice = EF, or Natural Earth glaciated areas, or ET at |lat| ≥ 66° (Arctic tundra). Alpine/subarctic ET (Tibet, the Scandes, Iceland lowlands) is NOT ice. Mountain overrides ice on steep terrain so the Himalayan front reads mountain, while flat ice sheets (central Greenland, Antarctica) read ice.');
  lines.push('- Coast = land texel with water in its 8-neighbourhood. Shallow = ocean within ~2 texels of land. River = NE 50m river centerlines (1 texel wide, land only, drawn last). Lake = NE 50m lakes.');
  lines.push('- The Caspian Sea is outside the NE land polygons and therefore reads as **ocean** (terrain 0/1, country 0, synthesized depth); Lake Victoria, the Great Lakes, Baikal etc. read as lake (9).');
  lines.push('- Country outline SVGs: per-country equirectangular ×cos(mean lat), no rotation normalisation; subpaths <0.3% of country area dropped; far-flung dependencies (sea gap >35% of the mainland span, e.g. Svalbard for Norway, Azores/Madeira for Portugal) excluded so mainland silhouettes stay identifiable.');
  lines.push('');
  lines.push('## Outputs');
  lines.push('');
  lines.push('| file | bytes | note |');
  lines.push('|---|---|---|');
  for (const o of report.outputs) lines.push(`| ${o.file} | ${o.bytes.toLocaleString()} | ${o.note} |`);
  lines.push('');
  lines.push('## Coverage sanity');
  lines.push('');
  lines.push(`Total land area (cos-weighted): **${report.stats.landAreaMkm2} M km²** (expected ≈ 149).`);
  lines.push('');
  lines.push('| terrain class | % of all texels |');
  lines.push('|---|---|');
  for (const t of report.stats.terrain) lines.push(`| ${t.class} | ${t.pct}% |`);
  lines.push('');
  lines.push('| continent (approx. box classifier) | baked M km² | known M km² |');
  lines.push('|---|---|---|');
  for (const [k, v] of Object.entries(report.stats.continents).sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${k} | ${(v / 1e6).toFixed(1)} | ${KNOWN[k] ?? '—'} |`);
  }
  lines.push('');
  if (report.notes.length) {
    lines.push('## Notes / degradations');
    lines.push('');
    for (const n of report.notes) lines.push(`- ${n}`);
    lines.push('');
  }
  lines.push('## Attribution');
  lines.push('');
  lines.push('NASA Visible Earth / Blue Marble & GEBCO_08 (public domain) · Natural Earth (public domain) · world-atlas (ISC, data public domain) · Köppen-Geiger classification: Beck, H.E. et al. (2018) *Present and future Köppen-Geiger climate classification maps at 1-km resolution*, Scientific Data 5:180214 (CC BY 4.0).');
  lines.push('');
  fs.writeFileSync(path.join(OUT_DATA, 'BAKE_REPORT.md'), lines.join('\n'));
}

await main();
