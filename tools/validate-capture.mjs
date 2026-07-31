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

  // The floor must clear the tunnelling bound for every variant. Reads
  // baseSpeedDeg out of each variant rather than assuming the engine default,
  // which is the mistake that made the Tempest figure wrong.
  // A derivation that cannot read its inputs must not fall back on a remembered
  // number. This used to default to the 3.6 engine constant when a variant would
  // not parse, described as "the safe assumption" — safe only because 3.6 happens
  // to be the slowest of the three today. The day a variant is faster and its
  // override stops parsing, that fallback silently understates the bound and the
  // build stays green. Fail by name instead.
  const variants = [];
  for (const [file, hasWind] of [['expedition', false], ['tempest', true], ['terra', false]]) {
    let src;
    try {
      src = await readFile(join(ROOT, 'src', 'variants', `${file}.ts`), 'utf8');
    } catch {
      errors.push(`cannot read src/variants/${file}.ts, so the tunnelling bound cannot be derived — refusing to assume a speed`);
      continue;
    }
    const bm = src.match(/baseSpeedDeg:\s*([\d.]+)/);
    if (!bm) {
      // No override is legitimate: the variant inherits snake.ts. But confirm the
      // default is still what this test thinks it is, rather than assuming.
      const snake = await readFile(join(ROOT, 'src', 'core', 'snake.ts'), 'utf8');
      const dm = snake.match(/baseSpeedDeg:\s*([\d.]+)/);
      if (!dm) {
        errors.push(`src/variants/${file}.ts has no baseSpeedDeg and the default cannot be read from core/snake.ts — refusing to assume a speed`);
        continue;
      }
      variants.push([file, Number(dm[1]), hasWind]);
      continue;
    }
    variants.push([file, Number(bm[1]), hasWind]);
  }
  const { worst, detail } = requiredFloorKm(variants);
  if (MIN_INRADIUS_KM < worst) {
    errors.push(
      `MIN_INRADIUS_KM is ${MIN_INRADIUS_KM} km but the tunnelling bound requires ` +
      `${worst.toFixed(1)} km — ${detail.map((d) => `${d.name} d=${d.d} needs ${d.need}`).join(', ')}. ` +
      `A capture region below the bound can be stepped over between ticks. Raise the floor, ` +
      `or lower whichever speed multiplier grew.`,
    );
  }
  driftNote = `tunnelling bound ${worst.toFixed(1)} km (`
    + detail.map((d) => `${d.name} ${d.d} km/tick on ${d.terrain}`).join(', ') + ')';

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
 * Two constraints meet here and the stricter one wins.
 *
 * *Fairness*: one texel of world.bin is ~9.8 km at the equator, so anything near
 * that is a target you can only win by landing on a single sample of the raster.
 *
 * *Tunnelling*: capture is point-sampled once per tick, so the region must be
 * bigger than the head's stride — `requiredFloorKm()` puts that at **49.7 km**,
 * set by Tempest over ocean, and asserts it rather than trusting this comment.
 *
 * 55 clears the tunnelling bound and sits below the smallest authored radius in
 * the dataset (Singapore, 60 km, deliberately tight). It was 50, which cleared the
 * real bound by 0.3 km — passing, but by less than the error bars on any of the
 * numbers that produced it, and only discovered by computing it three times.
 */
const MIN_INRADIUS_KM = 55;

/**
 * The floor is not a taste decision. Capture is point-sampled once per tick while
 * self-collision is swept, so a capture region smaller than the head's stride can
 * be stepped clean over. Keeping the loss under 1% of the disc needs
 * `R >= 3.544 * d`, where `d` is the greatest distance the head travels in a tick.
 *
 * `d` was first computed with the *default* `baseSpeedDeg` of 3.6 — but
 * `tempest.ts` overrides it to 3.9, and Tempest is also the only variant that adds
 * wind, so the binding case was understated twice over. `requiredFloorKm()` now
 * derives the bound from the variant configs instead of trusting a number in a
 * comment, and `main` fails if `MIN_INRADIUS_KM` drops below it.
 */
const STACK_NO_TERRAIN = 1.25 * 1.35 * 1.3;     // ship surge x boost x wake
const KM_PER_DEG = (2 * Math.PI * EARTH_RADIUS_KM) / 360;
const TICK_HZ = 120;
const SAFETY = 3.544;                            // 2/sqrt(1-0.99^2), the <=1% loss criterion

/**
 * Terrain and wind are not independent, so the bound is a max over *physically
 * reachable* combinations rather than a product of separate maxima.
 *
 * `isWater` in core/world.ts is Ocean, Shallow and **Lake** — River is not water.
 * Gyres are gated on `isWater` at the sample point, so the fastest terrain (river,
 * 1.18) is exactly the terrain where a gyre cannot be contributing. Storms are
 * gated only on the *storm's own centre*, so eyewall wind does reach a river texel
 * inland of an ocean-centred storm; the jet and turbulence are everywhere.
 *
 * Taking 1.18 together with the full 5.73 wind — as this file first did — prices a
 * combination the engine cannot produce. Conservative, but not physical, and it
 * overstated the bound by 2.3 km.
 */
const TERRAIN_CASES = [
  { name: 'river', speed: 1.18, water: false },
  { name: 'ocean', speed: 1.10, water: true },
  { name: 'lake', speed: 1.08, water: true },
  { name: 'coast', speed: 1.05, water: false },
];
const WIND_BAND_AND_STORM = 4.830;               // jet + trade + turbulence + eyewall
const WIND_GYRE = 0.900;                         // water only

/**
 * Supremum of |wind| in degrees/second, derived from the constants in
 * `variants/weather.ts`: the jet/trade band peak (1.549 at lat 32) plus the full
 * turbulence range, plus a gyre at maximum falloff, plus a storm eyewall at
 * maximum strength. 5.73 °/s.
 *
 * Do not replace this with a measured figure. Sampling the live field returned
 * 3.18 °/s from a short sweep and 5.005 from a long one — it was still climbing
 * with sample count, because a supremum over four sparse storms is not something
 * random sampling converges to. The fork independently measured 4.90 and
 * constructed 6.24. An empirical maximum is a lower bound on the supremum, and a
 * floor built on one is a floor built on however long you happened to run.
 */
const WIND_SUP_DEG_S = 5.73;

function requiredFloorKm(variantSpeeds) {
  let worst = 0, detail = [];
  for (const [name, baseSpeedDeg, hasWind] of variantSpeeds) {
    let best = { d: 0, terrain: null };
    for (const t of TERRAIN_CASES) {
      const chain = (baseSpeedDeg * t.speed * STACK_NO_TERRAIN / TICK_HZ) * KM_PER_DEG;
      const windDeg = hasWind ? WIND_BAND_AND_STORM + (t.water ? WIND_GYRE : 0) : 0;
      const d = chain + (windDeg / TICK_HZ) * KM_PER_DEG;
      if (d > best.d) best = { d, terrain: t.name };
    }
    const need = SAFETY * best.d;
    detail.push({ name, d: +best.d.toFixed(2), terrain: best.terrain, need: +need.toFixed(1) });
    if (need > worst) worst = need;
  }
  return { worst, detail };
}

/** Bearings sampled when measuring the inradius. */
const BEARINGS = 32;

const errors = [];
const warnings = [];
let driftNote = '';

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

/**
 * A unit tangent at `p` rotated `bearingDeg` clockwise from local north.
 *
 * The reference axis must not be parallel to `p`, or `cross` returns the zero
 * vector, `normalise` hands back zeros, `advance` never moves, and the scan
 * reports the ceiling — i.e. a degenerate target is reported as maximally *safe*,
 * which is the worst possible direction for this failure.
 *
 * This used to say "degenerate at the exact poles; no target sits there."
 * `landmark-south-pole` sits at exactly −90. It survived only because
 * `fromLatLon(-90, 0)` leaves a residual `cos(-90°) = 6.1e-17` that happens to
 * define a direction — a right answer resting on floating-point luck. Pick an
 * axis that is actually perpendicular instead.
 */
function tangentAtBearing(p, bearingDeg) {
  // Smallest-magnitude basis vector, so the reference is never near-parallel to
  // `p` anywhere on the sphere. A `|p.y| > 0.9` threshold also works, but a
  // threshold is a number someone must later justify; this has no tuning in it.
  const a = [Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2])];
  const up = [0, 0, 0];
  up[a.indexOf(Math.min(...a))] = 1;
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
 *
 * **Linear scan, deliberately, not bisection.** Bisection assumes the predicate
 * is monotone along the ray, and a capture region is any shape at all: a country
 * has fjords, estuaries, lakes and enclaves, each a hole that capture fails
 * inside. Given a hole, bisection does not find the first failure — it finds *a*
 * failure, or steps over the hole entirely and reports a distance far beyond it.
 *
 * This was a real bug in this file, caught by the mobile fork's independent
 * implementation. Every disagreement ran the same way, with bisection
 * overstating: Norway 93.25 km actual against "no finding at all" (a 12.5 km gap
 * of country-0 where Sognefjord cuts inland at 93.5 km), Portugal 58.5 against
 * 73.6, Israel 37.5 against 44.3. An inradius that is too large is precisely the
 * error a fairness test must not make.
 *
 * `SCAN_STEP_KM` must stay below the narrowest hole worth catching. One texel is
 * ~9.8 km of longitude at the equator but `cos(lat)` of that further north — only
 * ~2.0 km at Norway's latitude — so the step is 1 km, and the walk stops at the
 * first failure rather than running to the limit. The result is then refined by
 * bisection *within the last good kilometre*, where monotonicity does hold.
 */
const SCAN_STEP_KM = 1;
const SCAN_LIMIT_KM = 600;

function inradiusKm(cap, position, world) {
  let worst = Infinity, clamped = true;
  for (let i = 0; i < BEARINGS; i++) {
    const h = tangentAtBearing(position, (360 / BEARINGS) * i);
    let lastGood = 0, firstBad = -1;
    for (let km = SCAN_STEP_KM; km <= SCAN_LIMIT_KM; km += SCAN_STEP_KM) {
      if (isCaptured(cap, position, advance(position, h, km / EARTH_RADIUS_KM), world)) lastGood = km;
      else { firstBad = km; break; }
    }
    if (firstBad < 0) continue;                      // still capturing at the limit
    clamped = false;
    let lo = lastGood, hi = firstBad;
    for (let step = 0; step < 12; step++) {
      const mid = (lo + hi) / 2;
      if (isCaptured(cap, position, advance(position, h, mid / EARTH_RADIUS_KM), world)) lo = mid;
      else hi = mid;
    }
    if (lo < worst) worst = lo;
  }
  return { km: worst === Infinity ? SCAN_LIMIT_KM : worst, clamped: worst === Infinity || clamped };
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

    // 3b. A country-kind target whose ISO3 is absent from the border map is
    //     carried entirely by its radius. That works, but it means countryAt()
    //     returns ocean everywhere in that country, so anything else keying off
    //     the border map is silently wrong there. Tuvalu is the live case: it is
    //     a sovereign state and the bake does not emit it.
    if ((r.kind === 'country' || r.kind === 'flag' || r.kind === 'outline')
        && r.countryIso3 && cap.captureCountry === 0) {
      warnings.push(
        `${where}: ISO3 "${r.countryIso3}" is absent from countries.json, so capture is radius-only ` +
        `and world.countryAt() reports unclaimed territory everywhere inside it`,
      );
    }

    // 3c. The 32 bearings must actually go 32 different ways.
    //
    // The pole is a coordinate singularity and every parameterisation has its own
    // way of dying there — this one via a zero cross product, the mobile fork's
    // via a vanishing `atan2` numerator that quantised 6 bearings onto 3
    // meridians. Both failures report a *smaller* scanned set as a *larger*
    // inradius, i.e. they read as safe. Neither implementation could have found
    // the other's by inspection, because the causes have nothing in common; what
    // they share is only the symptom. So assert the symptom.
    const spread = new Set();
    for (let i = 0; i < BEARINGS; i++) {
      const q = advance(position, tangentAtBearing(position, (360 / BEARINGS) * i), 200 / EARTH_RADIUS_KM);
      spread.add(q.map((v) => v.toFixed(9)).join(','));
    }
    if (spread.size !== BEARINGS) {
      errors.push(
        `${where}: ${BEARINGS} bearings collapse to ${spread.size} distinct positions at ` +
        `(${r.lat}, ${r.lon}) — the scan is sampling fewer directions than it reports, which ` +
        `overstates the inradius. Coordinate singularity in the tangent frame.`,
      );
    }

    // 4. Aim tolerance. This is the check that would have caught Nauru.
    const { km: inradius, clamped } = inradiusKm(cap, position, world);
    rows.push({ where, id: r.id, tier: r.tier, kind: r.kind, inradius, clamped, cap });
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
  if (driftNote) console.log(`${driftNote}; floor ${MIN_INRADIUS_KM} km`);
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
