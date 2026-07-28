#!/usr/bin/env node
/**
 * Vendor the flag SVGs the target dataset actually uses.
 *
 * Only the flags referenced by a `{"type":"flag"}` target are downloaded, so
 * the repo carries a few dozen small files instead of the whole 250-flag set,
 * and the shipped game makes no network call to anyone else's CDN at runtime.
 *
 * Source: lipis/flag-icons, MIT licensed. Attribution ships in-game.
 */
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'flags');
const CDN = 'https://cdn.jsdelivr.net/npm/flag-icons@7/flags/4x3';
const force = process.argv.includes('--force');

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function collectCodes() {
  const codes = new Set();
  for (const file of ['targets.t12.json', 'targets.t35.json']) {
    const path = join(ROOT, 'src', 'data', file);
    if (!(await exists(path))) continue;
    const records = JSON.parse(await readFile(path, 'utf8'));
    for (const r of records) {
      if (r.image?.type === 'flag' && r.image.iso2) codes.add(String(r.image.iso2).toLowerCase());
    }
  }
  return [...codes].sort();
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const codes = await collectCodes();
  if (codes.length === 0) {
    console.error('No flag targets found — is src/data populated?');
    process.exitCode = 1;
    return;
  }

  let fetched = 0;
  let cached = 0;
  const failed = [];

  for (const code of codes) {
    const dest = join(OUT, `${code}.svg`);
    if (!force && (await exists(dest))) { cached++; continue; }
    try {
      const res = await fetch(`${CDN}/${code}.svg`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const svg = await res.text();
      // Sanity: flag-icons files are real SVG; a 404 page would slip through
      // an `ok` check on some CDNs, so verify the payload actually is one.
      if (!svg.trimStart().startsWith('<svg')) throw new Error('not an SVG');
      await writeFile(dest, svg, 'utf8');
      fetched++;
    } catch (err) {
      failed.push(`${code}: ${err.message}`);
    }
  }

  console.log(`flags: ${fetched} fetched, ${cached} already present, ${codes.length} referenced`);
  if (failed.length) {
    console.error(`FAILED (${failed.length}):\n  ${failed.join('\n  ')}`);
    process.exitCode = 1;
  }
}

main();
