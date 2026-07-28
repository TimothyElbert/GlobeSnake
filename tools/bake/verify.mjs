#!/usr/bin/env node
/**
 * Verifies public/data/world.bin against the hard interface contract.
 * Run: node tools/bake/verify.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const buf = zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'public', 'data', 'world.bin')));
const countries = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'countries.json'), 'utf8'));

const TERRAIN_NAMES = ['ocean', 'shallow', 'coast', 'plains', 'forest',
  'desert', 'mountain', 'ice', 'river', 'lake'];
const KOPPEN = ['-', 'Af', 'Am', 'Aw', 'BWh', 'BWk', 'BSh', 'BSk',
  'Csa', 'Csb', 'Csc', 'Cwa', 'Cwb', 'Cwc', 'Cfa', 'Cfb', 'Cfc',
  'Dsa', 'Dsb', 'Dsc', 'Dsd', 'Dwa', 'Dwb', 'Dwc', 'Dwd',
  'Dfa', 'Dfb', 'Dfc', 'Dfd', 'ET', 'EF'];

const magic = buf.toString('ascii', 0, 4);
const W = buf.readUInt16LE(4), H = buf.readUInt16LE(6);

function sample(lat, lon) {
  const r = Math.min(H - 1, Math.max(0, Math.floor((90 - lat) / 180 * H)));
  let c = Math.floor((lon + 180) / 360 * W);
  c = ((c % W) + W) % W;
  const o = 8 + (r * W + c) * 4;
  return { elev: buf[o], climate: buf[o + 1], terrain: buf[o + 2], country: buf[o + 3] };
}
const isoIdx = (iso3) => countries.find((c) => c.iso3 === iso3)?.idx ?? -1;

const results = [];
const check = (name, actual, ok, expected) =>
  results.push({ name, actual, expected, pass: ok });

check('magic == "GSW1"', magic, magic === 'GSW1', 'GSW1');
check('dimensions 4096x2048', `${W}x${H}`, W === 4096 && H === 2048, '4096x2048');
check('payload size', buf.length, buf.length === 8 + W * H * 4, 8 + 4096 * 2048 * 4);

const everest = sample(27.99, 86.93);
check('Everest terrain == mountain', `${TERRAIN_NAMES[everest.terrain]} (${KOPPEN[everest.climate]})`,
  everest.terrain === 6, 'mountain');
check('Everest elevation > 230', everest.elev, everest.elev > 230, '> 230');

const sahara = sample(23, 13);
check('Sahara terrain == desert', `${TERRAIN_NAMES[sahara.terrain]} (${KOPPEN[sahara.climate]})`,
  sahara.terrain === 5, 'desert');

const amazon = sample(-3, -60);
check('Amazon terrain == forest', `${TERRAIN_NAMES[amazon.terrain]} (${KOPPEN[amazon.climate]})`,
  amazon.terrain === 4, 'forest');

const greenland = sample(75, -41);
check('Central Greenland == ice', `${TERRAIN_NAMES[greenland.terrain]} (${KOPPEN[greenland.climate]})`,
  greenland.terrain === 7, 'ice');

const nemo = sample(-48.876, -123.393);
check('Point Nemo == ocean', TERRAIN_NAMES[nemo.terrain], nemo.terrain === 0, 'ocean');
check('Point Nemo country == 0', nemo.country, nemo.country === 0, 0);

const london = sample(51.5, -0.13);
check('London country == GBR', `${london.country} (GBR idx=${isoIdx('GBR')})`,
  london.country === isoIdx('GBR') && london.country > 0, `${isoIdx('GBR')}`);

const brasilia = sample(-15.79, -47.88);
check('Brasília country == BRA', `${brasilia.country} (BRA idx=${isoIdx('BRA')})`,
  brasilia.country === isoIdx('BRA') && brasilia.country > 0, `${isoIdx('BRA')}`);

// Antimeridian smear guard: mid-Pacific open water must be ocean/no-country,
// which fails loudly if Russia/Fiji/Kiribati polygons wrapped across the map.
const pacific1 = sample(0, -170.0); // south of Kiribati chain, open water
const pacific2 = sample(-30, -175); // between Fiji and Chile, open water
check('Antimeridian: (0,-170) is ocean, country 0',
  `${TERRAIN_NAMES[pacific1.terrain]}/c${pacific1.country}`,
  pacific1.terrain <= 1 && pacific1.country === 0, 'ocean/0');
check('Antimeridian: (-30,-175) is ocean, country 0',
  `${TERRAIN_NAMES[pacific2.terrain]}/c${pacific2.country}`,
  pacific2.terrain <= 1 && pacific2.country === 0, 'ocean/0');
const siberia = sample(66, 170); // Chukotka: must still be Russian land
check('Antimeridian: Chukotka (66,170) == RUS',
  `${siberia.country} (RUS idx=${isoIdx('RUS')})`, siberia.country === isoIdx('RUS'), `${isoIdx('RUS')}`);
const fiji = sample(-17.8, 178); // Viti Levu
check('Fiji main island (−17.8,178) == FJI',
  `${fiji.country} (FJI idx=${isoIdx('FJI')})`, fiji.country === isoIdx('FJI'), `${isoIdx('FJI')}`);

// ---- mountain-range coverage ------------------------------------------
// Positive probes: mountain must appear within 1 texel (~10 km) of the
// named peak/spine point — peak coordinates routinely straddle a texel edge.
const nearMountain = (lat, lon) => {
  const r0 = Math.min(H - 1, Math.max(0, Math.floor((90 - lat) / 180 * H)));
  const c0 = ((Math.floor((lon + 180) / 360 * W) % W) + W) % W;
  for (let dr = -1; dr <= 1; dr++) {
    const r = r0 + dr;
    if (r < 0 || r >= H) continue;
    for (let dc = -1; dc <= 1; dc++) {
      if (buf[8 + (r * W + ((c0 + dc + W) % W)) * 4 + 2] === 6) return true;
    }
  }
  return false;
};
const RANGES = {
  'Andes: Aconcagua (-32.65,-70.01)': [-32.65, -70.01],
  'Andes: Cord. Blanca (-9.12,-77.6)': [-9.12, -77.6],
  'Andes: Illimani (-16.65,-67.79)': [-16.65, -67.79],
  'Andes: Puna spine (-25.2,-68.6)': [-25.2, -68.6],
  'Himalaya: Annapurna (28.6,83.82)': [28.6, 83.82],
  'Karakoram: K2 (35.88,76.51)': [35.88, 76.51],
  'Himalaya: Nanga Parbat (35.24,74.59)': [35.24, 74.59],
  'Alps: Mont Blanc (45.83,6.86)': [45.83, 6.86],
  'Alps: Bernina (46.38,9.91)': [46.38, 9.91],
  'Alps: Grossglockner (47.07,12.69)': [47.07, 12.69],
  'Rockies: Sawatch (39.12,-106.45)': [39.12, -106.45],
  'Rockies: RMNP (40.25,-105.62)': [40.25, -105.62],
  'Rockies: Tetons (43.74,-110.8)': [43.74, -110.8],
  'Rockies: Canadian (50.8,-116.3)': [50.8, -116.3],
  'Sierra Nevada: Whitney (36.58,-118.29)': [36.58, -118.29],
  'Caucasus: Elbrus (43.35,42.44)': [43.35, 42.44],
  'Zagros: Zard Kuh (32.35,50.07)': [32.35, 50.07],
  'Zagros: Dena (30.95,51.43)': [30.95, 51.43],
  'Atlas: Toubkal (31.06,-7.92)': [31.06, -7.92],
  'Ethiopia: Ras Dashen (13.23,38.37)': [13.23, 38.37],
  'NZ Alps: Mt Cook (-43.59,170.14)': [-43.59, 170.14],
  'NZ Alps: Mt Aspiring (-44.38,168.73)': [-44.38, 168.73],
  'Japan Alps: Hotaka (36.29,137.65)': [36.29, 137.65],
  'Japan: Fuji (35.36,138.73)': [35.36, 138.73],
};
for (const [name, [la, lo]] of Object.entries(RANGES)) {
  const got = nearMountain(la, lo);
  check(`range ${name}`, got ? 'mountain(±1tx)' : TERRAIN_NAMES[sample(la, lo).terrain], got, 'mountain');
}
// Negative probes: exact texel must NOT be mountain.
const FLATS = {
  'Amazon basin (-3,-60)': [-3, -60], 'Amazon basin (-5,-65)': [-5, -65],
  'Sahara interior (23,13)': [23, 13], 'Sahara interior (20,10)': [20, 10],
  'Great Plains (41,-100)': [41, -100], 'Great Plains (47,-100)': [47, -100],
  'Congo basin (0,22)': [0, 22],
  'E European Plain (53,35)': [53, 35], 'E European Plain (55,45)': [55, 45],
  'Tibet flat centre (34.5,89)': [34.5, 89],
};
for (const [name, [la, lo]] of Object.entries(FLATS)) {
  const t = sample(la, lo).terrain;
  check(`flat ${name} != mountain`, TERRAIN_NAMES[t], t !== 6, 'not mountain');
}
// Mountain share of land texels (gameplay target: ranges must be barriers).
{
  let land = 0, mtn = 0;
  for (let i = 0; i < W * H; i++) {
    if (buf[8 + i * 4] >= 100) { land++; if (buf[8 + i * 4 + 2] === 6) mtn++; }
  }
  const pct = 100 * mtn / land;
  console.log(`\nmountain = ${pct.toFixed(1)}% of land texels (target 8-12%)`);
  check('mountain share of land in [7,13]%', pct.toFixed(1) + '%', pct >= 7 && pct <= 13, '8-12%');
}

// ---- countries.json integrity -----------------------------------------
{
  const seen = new Map();
  let dup = null;
  for (const c of countries) {
    if (seen.has(c.iso3)) dup = `${c.iso3} (${seen.get(c.iso3)} + ${c.name})`;
    seen.set(c.iso3, c.name);
  }
  check('ISO3 codes unique', dup ?? 'all unique', dup === null, 'unique');
  check('AUS is Australia', seen.get('AUS'), seen.get('AUS') === 'Australia', 'Australia');
}

// ---- country outline SVGs ---------------------------------------------
const OUTLINE_ISO3 = ['CHL', 'ITA', 'GMB', 'NOR', 'VNM', 'MDG', 'NAM', 'MWI',
  'CUB', 'HRV', 'SOM', 'PAN', 'MNG', 'LAO', 'PRT'];
for (const iso of OUTLINE_ISO3) {
  const fp = path.join(ROOT, 'public', 'outlines', `${iso}.svg`);
  let ok = false, why = 'missing';
  if (fs.existsSync(fp)) {
    const s = fs.readFileSync(fp, 'utf8');
    const dMatch = s.match(/\sd="([^"]+)"/);
    const pathCount = (s.match(/<path\b/g) || []).length;
    if (!/^<svg [^>]*viewBox="0 0 200 200"/.test(s)) why = 'bad viewBox';
    else if (/<svg [^>]*(width|height)=/.test(s)) why = 'root has width/height';
    else if (pathCount !== 1) why = `${pathCount} paths`;
    else if (!/fill="currentColor"/.test(s) || !/fill-rule="evenodd"/.test(s)) why = 'bad fill attrs';
    else if (!dMatch || dMatch[1].length < 200) why = `d too short (${dMatch ? dMatch[1].length : 0})`;
    else if (!s.trimEnd().endsWith('</svg>')) why = 'not closed';
    else { ok = true; why = `${dMatch[1].length} d-chars`; }
  }
  check(`outline ${iso}.svg`, why, ok, 'valid 200x200 single-path SVG');
}

let width = 0;
for (const r of results) width = Math.max(width, r.name.length);
let pass = 0, fail = 0;
console.log('');
for (const r of results) {
  const tag = r.pass ? 'PASS' : 'FAIL';
  r.pass ? pass++ : fail++;
  console.log(`${tag}  ${r.name.padEnd(width)}  actual=${r.actual}  expected=${r.expected}`);
}
console.log(`\n${pass}/${results.length} checks passed${fail ? ` — ${fail} FAILED` : ''}`);
process.exit(fail ? 1 : 0);
