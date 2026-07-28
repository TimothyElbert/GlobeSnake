#!/usr/bin/env node
/**
 * Validate the target dataset against the baked world.
 *
 * Four hundred hand-authored coordinates is exactly the kind of dataset that
 * quietly rots: a flipped longitude sign puts Lima in the Pacific, and nobody
 * notices until a player drives to the middle of the ocean and the game says
 * "correct". So every country-captured target is checked against the same
 * rasterised borders the game itself reads, and a mismatch fails the build.
 *
 * Run: node tools/validate-targets.mjs
 */
import { readFile, access } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEA_LEVEL = 100;
const TERRAIN_NAMES = ['ocean', 'shallow', 'coast', 'plains', 'forest', 'desert', 'mountain', 'ice', 'river', 'lake'];
const WATER = new Set([0, 1, 9]);

const VALID_KINDS = new Set(['country', 'capital', 'city', 'landmark', 'feature', 'flag', 'outline']);
const REQUIRED_KEYS = ['id', 'tier', 'kind', 'name', 'prompt', 'lat', 'lon', 'radiusKm', 'countryIso3', 'blurb', 'image'];

const errors = [];
const warnings = [];

async function exists(p) { try { await access(p); return true; } catch { return false; } }

function loadWorld(buf) {
  const raw = gunzipSync(buf);
  const magic = raw.subarray(0, 4).toString('ascii');
  if (magic !== 'GSW1') throw new Error(`bad magic "${magic}"`);
  const width = raw.readUInt16LE(4);
  const height = raw.readUInt16LE(6);
  const bytes = raw.subarray(8);
  const sample = (lat, lon) => {
    let col = Math.floor((lon / 360 + 0.5) * width);
    let row = Math.floor((0.5 - lat / 180) * height);
    col = ((col % width) + width) % width;
    row = Math.max(0, Math.min(height - 1, row));
    const o = (row * width + col) * 4;
    return { elevation: bytes[o], climate: bytes[o + 1], terrain: bytes[o + 2], country: bytes[o + 3] };
  };
  return { width, height, sample };
}

async function main() {
  const worldPath = join(ROOT, 'public', 'data', 'world.bin');
  const countriesPath = join(ROOT, 'public', 'data', 'countries.json');
  if (!(await exists(worldPath))) {
    console.error('world.bin missing — run `npm run bake` first.');
    process.exit(1);
  }

  const world = loadWorld(await readFile(worldPath));
  const countries = JSON.parse(await readFile(countriesPath, 'utf8'));
  const byIso3 = new Map(countries.map((c) => [c.iso3.toUpperCase(), c]));

  const records = [];
  for (const file of ['targets.t12.json', 'targets.t35.json']) {
    const path = join(ROOT, 'src', 'data', file);
    if (!(await exists(path))) { errors.push(`missing dataset ${file}`); continue; }
    let parsed;
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'));
    } catch (err) {
      errors.push(`${file} is not valid JSON: ${err.message}`);
      continue;
    }
    if (!Array.isArray(parsed)) { errors.push(`${file} is not an array`); continue; }
    for (const r of parsed) records.push({ ...r, __file: file });
  }

  const ids = new Set();
  const usedFlags = new Set();
  const usedOutlines = new Set();
  const usedSilhouettes = new Set();
  const tierCounts = {};
  const kindCounts = {};

  for (const r of records) {
    const where = `${r.__file}:${r.id ?? '(no id)'}`;

    for (const key of REQUIRED_KEYS) {
      if (!(key in r)) errors.push(`${where}: missing key "${key}"`);
    }
    if (ids.has(r.id)) errors.push(`${where}: duplicate id`);
    ids.add(r.id);

    if (!VALID_KINDS.has(r.kind)) errors.push(`${where}: unknown kind "${r.kind}"`);
    if (!(r.tier >= 1 && r.tier <= 5)) errors.push(`${where}: tier out of range (${r.tier})`);
    if (!(r.lat >= -90 && r.lat <= 90)) errors.push(`${where}: latitude out of range (${r.lat})`);
    if (!(r.lon >= -180 && r.lon <= 180)) errors.push(`${where}: longitude out of range (${r.lon})`);
    if (typeof r.blurb !== 'string' || r.blurb.length < 8) errors.push(`${where}: blurb too short`);
    if (typeof r.blurb === 'string' && r.blurb.length > 140) warnings.push(`${where}: blurb is ${r.blurb.length} chars`);

    tierCounts[r.tier] = (tierCounts[r.tier] ?? 0) + 1;
    kindCounts[r.kind] = (kindCounts[r.kind] ?? 0) + 1;

    if (r.image) {
      if (r.image.type === 'flag') {
        if (!r.image.iso2) errors.push(`${where}: flag image without iso2`);
        else usedFlags.add(r.image.iso2.toLowerCase());
      } else if (r.image.type === 'outline') {
        if (!r.image.iso3) errors.push(`${where}: outline image without iso3`);
        else usedOutlines.add(r.image.iso3.toUpperCase());
      } else if (r.image.type === 'silhouette') {
        if (!r.image.id) errors.push(`${where}: silhouette image without id`);
        else usedSilhouettes.add(r.image.id);
      } else {
        errors.push(`${where}: unknown image type "${r.image.type}"`);
      }
    }

    const s = world.sample(r.lat, r.lon);

    // Country-captured targets: the point MUST rasterise inside its own country,
    // because that is literally the win condition the game will evaluate.
    const capturedByCountry = (r.kind === 'country' || r.kind === 'flag' || r.kind === 'outline') && r.countryIso3;
    if (capturedByCountry) {
      const rec = byIso3.get(String(r.countryIso3).toUpperCase());
      if (!rec) {
        warnings.push(`${where}: ISO3 "${r.countryIso3}" not in the baked border map — will fall back to a radius capture`);
      } else if (s.country !== rec.idx) {
        const actual = countries.find((c) => c.idx === s.country);
        errors.push(
          `${where}: point (${r.lat}, ${r.lon}) rasterises to ` +
          `${actual ? actual.name : `nothing (terrain ${TERRAIN_NAMES[s.terrain]})`}, not ${rec.name}`,
        );
      }
    } else if (r.countryIso3) {
      // Point targets only need their ISO tag to be plausible; a lighthouse on
      // a headland legitimately rasterises to water at 10 km per texel.
      const rec = byIso3.get(String(r.countryIso3).toUpperCase());
      if (rec && s.country !== rec.idx && !WATER.has(s.terrain)) {
        const actual = countries.find((c) => c.idx === s.country);
        warnings.push(`${where}: tagged ${rec.iso3} but sits in ${actual ? actual.name : 'unclaimed land'}`);
      }
    }

    // A land landmark that lands in open ocean is a sign error, not a headland.
    if (s.terrain === 0 && r.countryIso3 && !capturedByCountry) {
      warnings.push(`${where}: sits in open ocean (elevation ${s.elevation}, sea level ${SEA_LEVEL})`);
    }
  }

  // Assets referenced by the dataset must actually exist.
  for (const [dir, set, ext] of [
    ['flags', usedFlags, 'svg'],
    ['outlines', usedOutlines, 'svg'],
    ['silhouettes', usedSilhouettes, 'svg'],
  ]) {
    for (const name of set) {
      const p = join(ROOT, 'public', dir, `${name}.${ext}`);
      if (!(await exists(p))) errors.push(`missing asset public/${dir}/${name}.${ext}`);
    }
  }

  console.log(`\n${records.length} targets across ${ids.size} unique ids`);
  console.log('by tier:', Object.entries(tierCounts).sort().map(([k, v]) => `T${k}=${v}`).join('  '));
  console.log('by kind:', Object.entries(kindCounts).sort().map(([k, v]) => `${k}=${v}`).join('  '));
  console.log(`assets: ${usedFlags.size} flags, ${usedOutlines.size} outlines, ${usedSilhouettes.size} silhouettes`);

  if (warnings.length) {
    console.log(`\n${warnings.length} warnings:`);
    for (const w of warnings.slice(0, 40)) console.log(`  ! ${w}`);
    if (warnings.length > 40) console.log(`  … and ${warnings.length - 40} more`);
  }

  if (errors.length) {
    console.error(`\n${errors.length} ERRORS:`);
    for (const e of errors) console.error(`  ✗ ${e}`);
    process.exit(1);
  }

  console.log('\nAll target checks passed.\n');
}

main().catch((err) => { console.error(err); process.exit(1); });
