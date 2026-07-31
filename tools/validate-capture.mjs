#!/usr/bin/env node
/**
 * Can every target actually be captured?
 *
 * `validate-targets.mjs` checks that a target's coordinates are *authored*
 * correctly — that Tunisia's point rasterises inside Tunisia. It passed 407/407
 * while the game shipped targets that were, in practice, impossible to reach.
 * Correct coordinates and a reachable win condition are different properties,
 * and only one of them was being tested.
 *
 * This file tests the other one, by replicating the runtime capture rule from
 * `src/game/targets.ts` byte for byte and asking a blunter question: if I fly at
 * this thing, does the game say yes?
 *
 * The metric is the **capture inradius** — walk outward from the authored point
 * along 32 bearings and record the distance at which capture stops holding; the
 * inradius is the smallest of those. It answers "how badly may I aim and still
 * win", which is the thing a player experiences. A country whose whole territory
 * is one 9.8 km texel has an inradius near 5 km, and the run softlocks.
 *
 * Run: node tools/validate-capture.mjs
 */
import { readFile, access } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EARTH_RADIUS_KM = 6371;
const DEG = Math.PI / 180;

/**
 * Mirrors TIER_RADIUS_KM in src/game/targets.ts.
 *
 * This is a transcription, and transcriptions drift — this one already did once,
 * during the very commit that added the file, which is about as fast as a copy of
 * a constant can go stale. `assertNoDrift` below reads the real declaration out
 * of the source and fails if the two stop agreeing, because a capture test that
 * silently measures the wrong rule is worse than no capture test at all.
 */
const TIER_RADIUS_KM = [0, 250, 200, 150, 220, 320];

async function assertNoDrift() {
  const src = await readFile(join(ROOT, 'src', 'game', 'targets.ts'), 'utf8');
  const m = src.match(/const TIER_RADIUS_KM = \[([^\]]*)\]/);
  if (!m) {
    errors.push('could not find TIER_RADIUS_KM in src/game/targets.ts — this test may be measuring a rule the game no longer uses');
    return;
  }
  const actual = m[1].split(',').map((s) => Number(s.trim()));
  if (actual.length !== TIER_RADIUS_KM.length || actual.some((v, i) => v !== TIER_RADIUS_KM[i])) {
    errors.push(
      `TIER_RADIUS_KM drift: targets.ts says [${actual.join(', ')}] but this test assumes ` +
      `[${TIER_RADIUS_KM.join(', ')}]. Update tools/validate-capture.mjs to match.`,
    );
  }
  for (let tier = 1; tier <= 5; tier++) {
    if (!(actual[tier] > 0)) {
      errors.push(`TIER_RADIUS_KM[${tier}] is ${actual[tier]}: any target at tier ${tier} without an authored radiusKm would be uncapturable if its country rule ever failed to resolve`);
    }
  }

  // Tripwire for the exact regression this file exists to prevent: the country
  // rule replacing the radius rather than adding to it.
  if (/captureCountry > 0\)\s*return world\.countryAt/.test(src)) {
    errors.push(
      'isCaptured() has reverted to country-INSTEAD-OF-radius. The two rules must be OR-ed ' +
      '(`if (country > 0 && match) return true;` then the radius test), or every country too ' +
      'small to rasterise becomes unwinnable.',
    );
  }
  if (/if \(captureCountry === 0\) \{/.test(src)) {
    errors.push(
      'TargetPool resolves captureRad only when there is no country rule. Resolve it always — ' +
      'the radius is the floor that keeps micro-states reachable.',
    );
  }
}

/**
 * Minimum acceptable inradius, in km.
 *
 * One texel of world.bin is ~9.8 km at the equator, so anything below that is a
 * target you can only hit by landing on a single sample of the raster. 60 km is
 * roughly 18 seconds of flight at base speed: enough that a deliberate approach
 * lands it, small enough that it is still a place and not a region.
 */
const MIN_INRADIUS_KM = 50;

/** Bearings sampled when measuring the inradius. */
const BEARINGS = 32;

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
  // Replicates WorldData.offsetOf: 3D unit vector in, byte offset out. The
  // handedness (-z in the atan2) is load-bearing — see src/core/sphere.ts.
  const countryAt = (p) => {
    const lat = Math.asin(p[1] < -1 ? -1 : p[1] > 1 ? 1 : p[1]);
    const lon = Math.atan2(-p[2], p[0]);
    let col = ((lon / (Math.PI * 2) + 0.5) * width) | 0;
    let row = ((0.5 - lat / Math.PI) * height) | 0;
    col = ((col % width) + width) % width;
    if (row < 0) row = 0; else if (row >= height) row = height - 1;
    return bytes[(row * width + col) * 4 + 3];
  };
  return { width, height, bytes, countryAt };
}

/** Mirrors fromLatLon in src/core/sphere.ts, including the sign of z. */
function fromLatLon(latDeg, lonDeg) {
  const lat = latDeg * DEG, lon = lonDeg * DEG;
  const cl = Math.cos(lat);
  return [cl * Math.cos(lon), Math.sin(lat), -cl * Math.sin(lon)];
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function normalise(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/** Walk `arc` radians from `p` along the great circle heading `h`. */
function advance(p, h, arc) {
  const c = Math.cos(arc), s = Math.sin(arc);
  return normalise([
    p[0] * c + h[0] * s,
    p[1] * c + h[1] * s,
    p[2] * c + h[2] * s,
  ]);
}

/** A unit tangent at `p` rotated `bearingDeg` clockwise from local north. */
function tangentAtBearing(p, bearingDeg) {
  // Degenerate at the exact poles; no target sits there.
  const up = [0, 1, 0];
  const east = normalise(cross(up, p));
  const north = normalise(cross(p, east));
  const b = bearingDeg * DEG;
  const c = Math.cos(b), s = Math.sin(b);
  return normalise([
    north[0] * c + east[0] * s,
    north[1] * c + east[1] * s,
    north[2] * c + east[2] * s,
  ]);
}

/**
 * Resolve a record's capture rule exactly as `TargetPool`'s constructor does.
 * If this drifts from targets.ts the test is worthless, so it is deliberately a
 * transcription rather than a reimplementation.
 */
function resolveCapture(r, byIso3) {
  let captureCountry = 0;
  let captureRad = 0;
  if ((r.kind === 'country' || r.kind === 'flag' || r.kind === 'outline') && r.countryIso3) {
    captureCountry = byIso3.get(String(r.countryIso3).toUpperCase())?.idx ?? 0;
  }
  const km = r.radiusKm ?? TIER_RADIUS_KM[Math.min(Math.max(r.tier, 1), 5)] ?? 200;
  captureRad = km / EARTH_RADIUS_KM;
  return { captureCountry, captureRad, radiusKm: km };
}

/** Mirrors isCaptured in src/game/targets.ts. */
function isCaptured(cap, position, head, world) {
  if (cap.captureCountry > 0 && world.countryAt(head) === cap.captureCountry) return true;
  if (cap.captureRad <= 0) return false;
  return Math.acos(Math.max(-1, Math.min(1, dot(head, position)))) <= cap.captureRad;
}

/**
 * Smallest distance, over `BEARINGS` directions, at which capture stops holding.
 * Binary search per bearing: capture regions are not convex (a country is any
 * shape at all) so this reports the first failure outward, which is the
 * conservative reading and the one a player feels.
 */
function inradiusKm(cap, position, world, limitKm = 400) {
  let worst = Infinity;
  for (let i = 0; i < BEARINGS; i++) {
    const h = tangentAtBearing(position, (360 / BEARINGS) * i);
    let lo = 0, hi = limitKm;
    if (isCaptured(cap, position, advance(position, h, hi / EARTH_RADIUS_KM), world)) {
      worst = Math.min(worst, hi);
      continue;
    }
    for (let step = 0; step < 18; step++) {
      const mid = (lo + hi) / 2;
      if (isCaptured(cap, position, advance(position, h, mid / EARTH_RADIUS_KM), world)) lo = mid;
      else hi = mid;
    }
    worst = Math.min(worst, lo);
  }
  return worst;
}

async function main() {
  const worldPath = join(ROOT, 'public', 'data', 'world.bin');
  if (!(await exists(worldPath))) {
    console.error('world.bin missing — run `npm run bake` first.');
    process.exit(1);
  }
  await assertNoDrift();
  const world = loadWorld(await readFile(worldPath));
  const countries = JSON.parse(await readFile(join(ROOT, 'public', 'data', 'countries.json'), 'utf8'));
  const byIso3 = new Map(countries.map((c) => [c.iso3.toUpperCase(), c]));

  const records = [];
  for (const file of ['targets.t12.json', 'targets.t35.json']) {
    const path = join(ROOT, 'src', 'data', file);
    if (!(await exists(path))) { errors.push(`missing dataset ${file}`); continue; }
    for (const r of JSON.parse(await readFile(path, 'utf8'))) records.push({ ...r, __file: file });
  }

  const rows = [];
  for (const r of records) {
    const where = `${r.__file}:${r.id}`;
    const position = fromLatLon(r.lat, r.lon);
    const cap = resolveCapture(r, byIso3);

    // 1. Standing on the authored point must win. If this fails the target is
    //    unreachable outright and the run softlocks.
    if (!isCaptured(cap, position, position, world)) {
      errors.push(`${where}: NOT capturable standing on its own coordinates`);
      continue;
    }

    // 2. The far side of the planet must not win, or the rule is vacuous.
    const antipode = [-position[0], -position[1], -position[2]];
    if (isCaptured(cap, position, antipode, world)) {
      errors.push(`${where}: capturable from the antipode — capture rule is meaningless`);
    }

    // 3. Country rules must round-trip through the raster the game reads.
    if (cap.captureCountry > 0 && world.countryAt(position) !== cap.captureCountry) {
      errors.push(`${where}: country rule ${r.countryIso3} does not match the raster at its own point`);
    }

    // 4. Aim tolerance. This is the check that would have caught Nauru.
    const inradius = inradiusKm(cap, position, world);
    rows.push({ where, id: r.id, tier: r.tier, kind: r.kind, inradius, cap });
    if (inradius < MIN_INRADIUS_KM) {
      errors.push(
        `${where}: capture inradius is ${inradius.toFixed(1)} km (minimum ${MIN_INRADIUS_KM}). ` +
        `A player must land within ${inradius.toFixed(1)} km of one point to win.`,
      );
    } else if (inradius < MIN_INRADIUS_KM * 1.5) {
      warnings.push(`${where}: tight capture inradius ${inradius.toFixed(1)} km`);
    }
  }

  rows.sort((a, b) => a.inradius - b.inradius);
  console.log(`\n${records.length} targets checked for capturability`);
  if (rows.length) {
    console.log('\ntightest 10:');
    for (const r of rows.slice(0, 10)) {
      console.log(`  ${r.inradius.toFixed(1).padStart(7)} km  T${r.tier} ${r.kind.padEnd(9)} ${r.id}`);
    }
    const med = rows[Math.floor(rows.length / 2)];
    console.log(`median inradius ${med.inradius.toFixed(0)} km`);
  }

  if (warnings.length) {
    console.log(`\n${warnings.length} warnings:`);
    for (const w of warnings.slice(0, 20)) console.log(`  ! ${w}`);
    if (warnings.length > 20) console.log(`  … and ${warnings.length - 20} more`);
  }
  if (errors.length) {
    console.error(`\n${errors.length} ERRORS:`);
    for (const e of errors) console.error(`  ✗ ${e}`);
    process.exit(1);
  }
  console.log('\nAll targets are capturable.\n');
}

main().catch((err) => { console.error(err); process.exit(1); });
