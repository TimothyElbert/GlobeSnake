import {
  Vector3, DataTexture, RGBAFormat, RedFormat, UnsignedByteType, NearestFilter, LinearFilter,
  ClampToEdgeWrapping, RepeatWrapping,
} from 'three';
import { clamp } from './sphere';

/**
 * The baked world: one 4096×2048 RGBA byte grid produced offline by tools/bake.
 *
 * Deliberately NOT a PNG. Canvas getImageData premultiplies alpha, which
 * silently corrupts RGB wherever A < 255 and rounds A itself — so a country
 * index stored in the alpha channel would come back subtly wrong and every
 * border in the game would be slightly haunted. A raw gzipped .bin decoded with
 * DecompressionStream is exact, and the same bytes go straight to the GPU as a
 * DataTexture, so the shader and the simulation can never disagree.
 */

export const enum Terrain {
  Ocean = 0,
  Shallow = 1,
  Coast = 2,
  Plains = 3,
  Forest = 4,
  Desert = 5,
  Mountain = 6,
  Ice = 7,
  River = 8,
  Lake = 9,
}

export const TERRAIN_COUNT = 10;

/** Sea level in the packed elevation byte. See tools/bake for the encoding. */
export const SEA_LEVEL_CODE = 100;
export const MAX_LAND_CODE = 255;
export const MAX_ELEV_M = 8848;
export const MAX_DEPTH_M = 11000;

export function elevationMetres(code: number): number {
  return code >= SEA_LEVEL_CODE
    ? ((code - SEA_LEVEL_CODE) / (MAX_LAND_CODE - SEA_LEVEL_CODE)) * MAX_ELEV_M
    : -((SEA_LEVEL_CODE - code) / SEA_LEVEL_CODE) * MAX_DEPTH_M;
}

export function isWater(t: Terrain): boolean {
  return t === Terrain.Ocean || t === Terrain.Shallow || t === Terrain.Lake;
}

/**
 * Terrain speed multipliers.
 *
 * Sol's council note, taken: a 40% mountain penalty was too punitive — it made
 * the correct play always "never touch a mountain", which is not a decision.
 * At 0.72, cutting over a range is a live trade against the distance saved.
 * Rivers are faster than the land around them, so the Nile and the Amazon read
 * as highways; that is the reward for noticing them.
 */
export const TERRAIN_SPEED: Readonly<Record<Terrain, number>> = {
  [Terrain.Ocean]: 1.1,
  [Terrain.Shallow]: 1.06,
  [Terrain.Coast]: 1.05,
  [Terrain.Plains]: 1.0,
  [Terrain.Forest]: 0.85,
  [Terrain.Desert]: 0.9,
  [Terrain.Mountain]: 0.72,
  [Terrain.Ice]: 0.8,
  [Terrain.River]: 1.18,
  [Terrain.Lake]: 1.08,
};

export const TERRAIN_NAME: Readonly<Record<Terrain, string>> = {
  [Terrain.Ocean]: 'Open ocean',
  [Terrain.Shallow]: 'Coastal water',
  [Terrain.Coast]: 'Coastline',
  [Terrain.Plains]: 'Plains',
  [Terrain.Forest]: 'Forest',
  [Terrain.Desert]: 'Desert',
  [Terrain.Mountain]: 'Mountains',
  [Terrain.Ice]: 'Ice',
  [Terrain.River]: 'River',
  [Terrain.Lake]: 'Lake',
};

/** Ice keeps your momentum instead of taking away your steering. */
export const TERRAIN_TURN_INERTIA: Readonly<Record<Terrain, number>> = {
  [Terrain.Ocean]: 0.12,
  [Terrain.Shallow]: 0.1,
  [Terrain.Coast]: 0.06,
  [Terrain.Plains]: 0.05,
  [Terrain.Forest]: 0.07,
  [Terrain.Desert]: 0.06,
  [Terrain.Mountain]: 0.1,
  [Terrain.Ice]: 0.34,
  [Terrain.River]: 0.08,
  [Terrain.Lake]: 0.1,
};

/** Desert drains boost stamina faster; that is its cost, on top of the slowdown. */
export const TERRAIN_STAMINA_DRAIN: Readonly<Record<Terrain, number>> = {
  [Terrain.Ocean]: 1.0,
  [Terrain.Shallow]: 1.0,
  [Terrain.Coast]: 1.0,
  [Terrain.Plains]: 1.0,
  [Terrain.Forest]: 1.15,
  [Terrain.Desert]: 1.7,
  [Terrain.Mountain]: 1.35,
  [Terrain.Ice]: 1.1,
  [Terrain.River]: 0.8,
  [Terrain.Lake]: 1.0,
};

/**
 * Köppen classes, in the exact order the baker writes them (1..30; 0 = water).
 */
export const CLIMATE_CODES = [
  'Ocean',
  'Af', 'Am', 'Aw', 'BWh', 'BWk', 'BSh', 'BSk',
  'Csa', 'Csb', 'Csc', 'Cwa', 'Cwb', 'Cwc', 'Cfa', 'Cfb', 'Cfc',
  'Dsa', 'Dsb', 'Dsc', 'Dsd', 'Dwa', 'Dwb', 'Dwc', 'Dwd', 'Dfa', 'Dfb', 'Dfc', 'Dfd',
  'ET', 'EF',
] as const;

export const CLIMATE_NAME: Readonly<Record<string, string>> = {
  Ocean: 'Ocean', Af: 'Tropical rainforest', Am: 'Tropical monsoon', Aw: 'Tropical savanna',
  BWh: 'Hot desert', BWk: 'Cold desert', BSh: 'Hot steppe', BSk: 'Cold steppe',
  Csa: 'Hot-summer Mediterranean', Csb: 'Warm-summer Mediterranean', Csc: 'Cold-summer Mediterranean',
  Cwa: 'Humid subtropical', Cwb: 'Subtropical highland', Cwc: 'Cold subtropical highland',
  Cfa: 'Humid subtropical', Cfb: 'Oceanic', Cfc: 'Subpolar oceanic',
  Dsa: 'Mediterranean continental', Dsb: 'Mediterranean continental', Dsc: 'Mediterranean subarctic',
  Dsd: 'Mediterranean subarctic', Dwa: 'Monsoon continental', Dwb: 'Monsoon continental',
  Dwc: 'Monsoon subarctic', Dwd: 'Monsoon subarctic', Dfa: 'Hot-summer continental',
  Dfb: 'Warm-summer continental', Dfc: 'Subarctic', Dfd: 'Extreme subarctic',
  ET: 'Tundra', EF: 'Ice cap',
};

/**
 * The snake's skin, by climate. This is the palette the whole game is scored
 * against: the body records the colour of every biome it has crossed, so these
 * have to look good *next to each other*, not just individually. Families move
 * through hue coherently — tropics emerald, arid amber, temperate jade,
 * continental indigo, polar ice-blue — so a long body reads as a legible
 * gradient of where you have been rather than a bag of skittles.
 */
export const CLIMATE_COLOR: Readonly<Record<string, number>> = {
  // Jade rather than the sea-teal it started as. The body has to read against
  // whatever it is crossing, and an ocean-coloured snake on the ocean is
  // invisible exactly when you are furthest from anything else to look at.
  Ocean: 0x2fd6a8,
  Af: 0x0f9b52, Am: 0x1eb463, Aw: 0x6fc04a,
  BWh: 0xe8a838, BWk: 0xd9b06a, BSh: 0xd98b3e, BSk: 0xc9a76b,
  Csa: 0xb5c94a, Csb: 0x8fbf58, Csc: 0x76b070,
  Cwa: 0x53bf7a, Cwb: 0x45b48c, Cwc: 0x3fa392,
  Cfa: 0x3ec18a, Cfb: 0x46bfa4, Cfc: 0x4aacaf,
  Dsa: 0x7a9ec4, Dsb: 0x6b93c2, Dsc: 0x5d86bb, Dsd: 0x5079b4,
  Dwa: 0x6e8fd0, Dwb: 0x627fc8, Dwc: 0x5670c0, Dwd: 0x4a62b8,
  Dfa: 0x4f97c9, Dfb: 0x4787c4, Dfc: 0x5f7fc0, Dfd: 0x6b7fc9,
  ET: 0xa9d6e8, EF: 0xe8f4fb,
};

const CLIMATE_COLOR_BY_INDEX = CLIMATE_CODES.map((c) => CLIMATE_COLOR[c] ?? 0x8899aa);

export function climateColor(index: number): number {
  return CLIMATE_COLOR_BY_INDEX[clamp(index | 0, 0, CLIMATE_CODES.length - 1)];
}

export function climateLabel(index: number): string {
  const code = CLIMATE_CODES[clamp(index | 0, 0, CLIMATE_CODES.length - 1)];
  return CLIMATE_NAME[code] ?? code;
}

/**
 * How far the tallest land rises above sea level, in globe radii.
 *
 * Wildly exaggerated — Everest is really 0.0014 radii, which is invisible — and
 * that is the point. The terrain speed model is the game's main routing
 * decision, and before the relief existed there was no way to *see* that you
 * were about to grind to a crawl. Mountains you can watch the snake climb are
 * the readout.
 *
 * Both the vertex shader and the snake read this same constant against the same
 * smoothed height field, so the body always sits exactly on the drawn surface.
 */
export const RELIEF_SCALE = 0.045;

/** Resolution of the smoothed height field shared by the GPU and the sim. */
const RELIEF_W = 1024;
const RELIEF_H = 512;

export interface CountryRecord {
  idx: number;
  name: string;
  iso3: string;
  iso2: string;
  lat: number;
  lon: number;
  areaRank: number;
}

export interface SurfaceSample {
  elevation: number;   // packed byte
  climate: number;     // 0..30
  terrain: Terrain;
  country: number;     // index into WorldData.countries, 0 = none
}

const MAGIC = 0x31575347; // "GSW1" little-endian

export class WorldData {
  readonly width: number;
  readonly height: number;
  readonly bytes: Uint8Array;
  readonly countries: CountryRecord[];
  private readonly byIso3 = new Map<string, CountryRecord>();
  private readonly byIndex = new Map<number, CountryRecord>();
  private _texture: DataTexture | null = null;
  private _reliefTexture: DataTexture | null = null;
  private readonly relief: Uint8Array;

  private constructor(width: number, height: number, bytes: Uint8Array, countries: CountryRecord[]) {
    this.width = width;
    this.height = height;
    this.bytes = bytes;
    this.countries = countries;
    for (const c of countries) {
      this.byIndex.set(c.idx, c);
      // Territories sometimes share their parent state's ISO3 in border data.
      // Last-write-wins would resolve "Australia" to a one-texel reef, so the
      // larger landmass always keeps the code.
      const key = c.iso3.toUpperCase();
      const held = this.byIso3.get(key);
      if (!held || c.areaRank < held.areaRank) this.byIso3.set(key, c);
    }
    this.relief = this.buildRelief();
  }

  static async load(baseUrl: string): Promise<WorldData> {
    const [binRes, countriesRes] = await Promise.all([
      fetch(`${baseUrl}data/world.bin`),
      fetch(`${baseUrl}data/countries.json`),
    ]);
    if (!binRes.ok) throw new Error(`world.bin: ${binRes.status} ${binRes.statusText}`);
    if (!countriesRes.ok) throw new Error(`countries.json: ${countriesRes.status}`);

    // GitHub Pages will not set Content-Encoding for us, so unzip client-side.
    // DecompressionStream is native everywhere we target and beats shipping a
    // JS inflate implementation by ~40 KB.
    let buf: ArrayBuffer;
    if (typeof DecompressionStream !== 'undefined' && binRes.body) {
      const stream = binRes.body.pipeThrough(new DecompressionStream('gzip'));
      buf = await new Response(stream).arrayBuffer();
    } else {
      throw new Error('This browser lacks DecompressionStream; please update it.');
    }

    const view = new DataView(buf);
    if (view.getUint32(0, true) !== MAGIC) throw new Error('world.bin: bad magic');
    const width = view.getUint16(4, true);
    const height = view.getUint16(6, true);
    const expected = 8 + width * height * 4;
    if (buf.byteLength < expected) {
      throw new Error(`world.bin truncated: ${buf.byteLength} < ${expected}`);
    }

    const bytes = new Uint8Array(buf, 8, width * height * 4);
    const countries = (await countriesRes.json()) as CountryRecord[];
    return new WorldData(width, height, bytes, countries);
  }

  /** Byte offset of the texel containing this direction. */
  private offsetOf(p: Vector3): number {
    // Inlined lat/lon: this runs several times per tick per snake segment.
    const lat = Math.asin(p.y < -1 ? -1 : p.y > 1 ? 1 : p.y);
    const lon = Math.atan2(-p.z, p.x); // see the handedness note in sphere.ts
    let col = ((lon / (Math.PI * 2) + 0.5) * this.width) | 0;
    let row = ((0.5 - lat / Math.PI) * this.height) | 0;
    // Longitude wraps; latitude clamps.
    col = ((col % this.width) + this.width) % this.width;
    if (row < 0) row = 0;
    else if (row >= this.height) row = this.height - 1;
    return (row * this.width + col) * 4;
  }

  private offsetOfLatLon(latDeg: number, lonDeg: number): number {
    let col = ((lonDeg / 360 + 0.5) * this.width) | 0;
    let row = ((0.5 - latDeg / 180) * this.height) | 0;
    col = ((col % this.width) + this.width) % this.width;
    if (row < 0) row = 0;
    else if (row >= this.height) row = this.height - 1;
    return (row * this.width + col) * 4;
  }

  sample(p: Vector3, out: SurfaceSample): SurfaceSample {
    const o = this.offsetOf(p);
    const b = this.bytes;
    out.elevation = b[o];
    out.climate = b[o + 1];
    out.terrain = b[o + 2] as Terrain;
    out.country = b[o + 3];
    return out;
  }

  sampleLatLon(latDeg: number, lonDeg: number, out: SurfaceSample): SurfaceSample {
    const o = this.offsetOfLatLon(latDeg, lonDeg);
    const b = this.bytes;
    out.elevation = b[o];
    out.climate = b[o + 1];
    out.terrain = b[o + 2] as Terrain;
    out.country = b[o + 3];
    return out;
  }

  terrainAt(p: Vector3): Terrain {
    return this.bytes[this.offsetOf(p) + 2] as Terrain;
  }

  climateAt(p: Vector3): number {
    return this.bytes[this.offsetOf(p) + 1];
  }

  countryAt(p: Vector3): number {
    return this.bytes[this.offsetOf(p) + 3];
  }

  elevationCodeAt(p: Vector3): number {
    return this.bytes[this.offsetOf(p)];
  }

  countryByIndex(idx: number): CountryRecord | undefined {
    return this.byIndex.get(idx);
  }

  countryByIso3(iso3: string): CountryRecord | undefined {
    return this.byIso3.get(iso3.toUpperCase());
  }

  countryNameAt(p: Vector3): string {
    const idx = this.countryAt(p);
    if (idx === 0) {
      return isWater(this.terrainAt(p)) ? 'International waters' : 'Unclaimed territory';
    }
    return this.byIndex.get(idx)?.name ?? 'Unknown';
  }

  /**
   * Continuous speed multiplier at a point. The terrain class sets the base and
   * elevation modulates it, so the Andes bite harder than the Appalachians and
   * a high plateau is not the same as a steep ridge.
   */
  speedAt(p: Vector3): number {
    const o = this.offsetOf(p);
    const terrain = this.bytes[o + 2] as Terrain;
    let s = TERRAIN_SPEED[terrain] ?? 1;
    const code = this.bytes[o];
    if (code > SEA_LEVEL_CODE) {
      const km = elevationMetres(code) / 1000;
      s *= 1 - clamp(km * 0.028, 0, 0.2);
    }
    return s;
  }

  /**
   * Smoothed land height, 0 at sea level and 1 at the highest land, sampled
   * bilinearly. This is the *authoritative* relief: the globe's vertex shader
   * displaces by the texture built from this same array, so anything that wants
   * to sit on the ground — the body, the head, the camera — asks here and lands
   * exactly on the drawn surface rather than near it.
   */
  reliefAt(p: Vector3): number {
    const lat = Math.asin(p.y < -1 ? -1 : p.y > 1 ? 1 : p.y);
    const lon = Math.atan2(-p.z, p.x);
    const fx = (lon / (Math.PI * 2) + 0.5) * RELIEF_W - 0.5;
    const fy = (0.5 - lat / Math.PI) * RELIEF_H - 0.5;

    let x0 = Math.floor(fx);
    const y0 = Math.max(0, Math.min(RELIEF_H - 1, Math.floor(fy)));
    const tx = fx - x0;
    const ty = fy - y0;
    const y1 = Math.min(RELIEF_H - 1, y0 + 1);
    x0 = ((x0 % RELIEF_W) + RELIEF_W) % RELIEF_W;
    const x1 = (x0 + 1) % RELIEF_W;

    const e = this.relief;
    const a = e[y0 * RELIEF_W + x0];
    const b = e[y0 * RELIEF_W + x1];
    const c = e[y1 * RELIEF_W + x0];
    const d = e[y1 * RELIEF_W + x1];
    const top = a + (b - a) * tx;
    const bot = c + (d - c) * tx;
    return (top + (bot - top) * ty) / 255;
  }

  /** Height above the unit sphere, in globe radii, at `p`. */
  surfaceRadiusAt(p: Vector3): number {
    return 1 + this.reliefAt(p) * RELIEF_SCALE;
  }

  /**
   * Box-downsample the elevation byte into a smooth height field.
   *
   * Smoothing is not a compromise here, it is the requirement: displacing
   * vertices straight from the 4096-wide nearest-sampled grid produces a field
   * of single-texel spikes, and the snake would be climbing needles.
   */
  private buildRelief(): Uint8Array {
    const out = new Uint8Array(RELIEF_W * RELIEF_H);
    const sx = this.width / RELIEF_W;
    const sy = this.height / RELIEF_H;
    const span = Math.max(1, Math.round(sx));
    for (let y = 0; y < RELIEF_H; y++) {
      const y0 = Math.min(this.height - 1, (y * sy) | 0);
      for (let x = 0; x < RELIEF_W; x++) {
        const x0 = (x * sx) | 0;
        let sum = 0;
        let n = 0;
        for (let dy = 0; dy < span; dy++) {
          const yy = Math.min(this.height - 1, y0 + dy);
          for (let dx = 0; dx < span; dx++) {
            const xx = (x0 + dx) % this.width;
            const code = this.bytes[(yy * this.width + xx) * 4];
            // Ocean contributes zero rather than a negative depth: the sea
            // surface is flat, whatever the sea floor is doing underneath.
            sum += code > SEA_LEVEL_CODE ? code - SEA_LEVEL_CODE : 0;
            n++;
          }
        }
        const avg = sum / n / (MAX_LAND_CODE - SEA_LEVEL_CODE);
        out[y * RELIEF_W + x] = Math.min(255, Math.round(avg * 255));
      }
    }
    return out;
  }

  /** Linear-filtered height field for vertex displacement. */
  get reliefTexture(): DataTexture {
    if (!this._reliefTexture) {
      const tex = new DataTexture(this.relief, RELIEF_W, RELIEF_H, RedFormat, UnsignedByteType);
      tex.magFilter = LinearFilter;
      tex.minFilter = LinearFilter;
      tex.wrapS = RepeatWrapping;
      tex.wrapT = ClampToEdgeWrapping;
      tex.flipY = false;
      tex.generateMipmaps = false;
      tex.needsUpdate = true;
      this._reliefTexture = tex;
    }
    return this._reliefTexture;
  }

  /** Upload the raw grid to the GPU so shaders read exactly what physics reads. */
  get texture(): DataTexture {
    if (!this._texture) {
      // DataTexture keeps a view on our buffer; no copy, no premultiplication,
      // nearest filtering so class indices are never blended into nonsense.
      const tex = new DataTexture(this.bytes, this.width, this.height, RGBAFormat, UnsignedByteType);
      tex.magFilter = NearestFilter;
      tex.minFilter = NearestFilter;
      tex.wrapS = RepeatWrapping;      // longitude wraps
      tex.wrapT = ClampToEdgeWrapping; // latitude does not
      tex.flipY = false;               // row 0 is the north pole, by contract
      tex.generateMipmaps = false;
      tex.needsUpdate = true;
      this._texture = tex;
    }
    return this._texture;
  }
}

export function makeSample(): SurfaceSample {
  return { elevation: SEA_LEVEL_CODE, climate: 0, terrain: Terrain.Ocean, country: 0 };
}
