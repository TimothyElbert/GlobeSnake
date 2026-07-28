# GLOBE SNAKE — Design Specification v1

Synthesized by the Opus 5 orchestrator from the v0 brief plus council input from Fable 5
and GPT-5.6 Sol. Where the councils split, the resolution and its reasoning are recorded.

---

## 0. The load-bearing decision

Fable's sharpest note, adopted wholesale: **the biggest risk is that this isn't Snake.**
On a globe sized for continents, a short body never intersects itself, self-collision goes
vestigial, and the game degenerates into "steer a cursor at a geography quiz." Everything
below is arranged so the body is a real, permanent hazard:

- Base speed tuned so an **equatorial lap takes ~50 s**. The world must feel small.
- Each capture adds **8–12° of arc** to the body. By capture five your body spans a continent.
- **The trail never despawns within a run.** It is a wall, not a tail. Your own history is
  the level design.
- Next targets are **biased toward the far side of your existing trail mass** (sample N
  candidates from the active tier, score each by how much trail lies near the great circle
  to it, prefer high-obstruction routes).

This is what makes the terrain-speed system matter. The question stops being "over the Andes
or around?" and becomes "over the Andes, around, or through the gap I left near Quito?"

---

## 1. Stack & deployment

TypeScript · Vite · Three.js (r185) · zero backend · zero runtime network calls.

Multi-entry Vite build → one GitHub Pages site: a launcher at `/` plus `/expedition/`,
`/tempest/`, `/terra/`. Shared `src/core/` engine; each variant is a thin rule + skin layer.
Deployed by GitHub Actions on push to `main`.

All world data is **baked offline** by `tools/bake/` into committed binaries, so the shipped
site never depends on an external host.

---

## 2. Sphere locomotion

Head is a unit vector `p ∈ S²`; heading is a unit tangent `h`, `h·p = 0`.

- **Step:** rotate `p` and `h` about `a = normalize(p × h)` by `θ = v·dt/R`. Walks a great
  circle. No poles, no seams, no lat-lon distortion.
- **Turn:** rotate `h` about `p`. Re-orthonormalize `h ← normalize(h − (h·p)p)` every frame.
- **Turn model:** commanded heading approaches target at ≤ 220°/s, rate-limited by an
  angular-momentum term so ice feels slippery **without reducing input authority**
  (Sol's correction — predictability is non-negotiable; ice adds inertia, not deafness).
- Fixed timestep 120 Hz accumulator, render interpolated. Collision cannot depend on FPS.

**Body & collision.** Trail is a ring buffer of unit vectors resampled to constant arc-length
spacing. Self-collision = angular distance from head to any trail node past a neck gap
< collision radius, accelerated by a lat/lon bucket spatial hash. Continuous check against
trail *segments*, not just nodes, so a fast head cannot tunnel through a thin body.

---

## 3. World data — one baked binary

`tools/bake/` downloads once, produces `public/data/world.bin` (gzipped, fetched as
`ArrayBuffer`), 4096×2048, 4 bytes/texel:

| byte | meaning |
|---|---|
| 0 | elevation, quantized; sea level at a fixed code |
| 1 | climate class (Köppen-ish index) |
| 2 | gameplay terrain class (ocean/coast/plains/forest/desert/mountain/ice) |
| 3 | country / region index |

**Not a PNG.** Both councils independently flagged the trap: canvas `getImageData`
premultiplies alpha, silently mangling RGB wherever A<255 and rounding A itself. A raw
gzipped `.bin` is exact, simpler, and needs no canvas round-trip. The same data is uploaded
to a `DataTexture` (nearest filtering) so the shader and the simulation agree by construction.

**Sources** — all public domain or permissive, downloaded at bake time, never at runtime:

| asset | source | licence |
|---|---|---|
| land elevation | NASA Visible Earth GEBCO_08 rev elev (21600×10800, 18 MB) | Public domain |
| surface imagery | NASA Blue Marble topo+bathy (5400×2700, 2.5 MB) | Public domain |
| night lights | NASA Earth at Night (548 KB) | Public domain |
| coasts / land / lakes / rivers / glaciers | Natural Earth vector 50m | Public domain |
| countries + IDs | world-atlas TopoJSON 50m | Public domain |
| climate | Köppen-Geiger 1991–2020 (Beck et al.) | CC BY 4.0 — attributed in-game |
| flags | `flag-icons` SVG | MIT |
| landmarks | **hand-authored SVG silhouettes** | ours — zero copyright exposure |

The baker implements a **procedural climate fallback** (latitude + elevation + continentality
+ noise) and is written and validated against that fallback *first*. Real-source upgrades are
strictly additive. The build can never be broken by a dead URL.

**Terrain speed** (Sol's correction — 40% mountain slowdown was too punishing):
ocean 1.10 · coast 1.05 · plains 1.00 · desert 0.90 (drains boost stamina) ·
forest 0.85 · ice 0.80 (+inertia) · mountain 0.72, scaled continuously by elevation rather
than snapped to the class. **Rivers are speed lanes** — follow the Nile.

---

## 4. Controls

Relative steering, unanimous across the council: there is no consistent global "up" on S².

**Keyboard** — ←/→ continuous turn (tap = ~10° nudge) · ↑ boost to 135% (stamina-limited,
widens turn radius 20%) · ↓ brake to 70% (tightens radius 15%) · **Space = hint**
(Sol is right: the core action does not get buried on `H`; `H` is kept as an alias) ·
wheel/PgUp-PgDn zoom · `M` mute · `Esc` pause.

**Mouse — pursuit steering, not a port.** Raycast the cursor onto the globe (on a miss,
intersect the camera-facing plane through the origin and normalize); project `(q − p)` into
the tangent plane at `p`; rotate `h` toward it at the same capped turn rate. Cursor *distance*
from the head is throttle: inner 15% brake, middle cruise, outer 25% boost. Left-hold boost,
right-click hint. Both councils independently rejected "horizontal cursor displacement →
turn rate" as a bad virtual joystick. This is the slither.io feel, it is arguably the better
scheme, and it makes **touch support nearly free** — so it ships as a first-class mode, not a
"demo."

**Camera** — behind and above along the anti-heading; up-vector slerped toward `p`;
critically damped, ~0.25 s time constant; **roll is always zero**; fixed FOV; shows roughly a
third of the globe. A stable graticule and a fixed compass give the eye a reference frame.
A persistent **inset globe** shows head, heading, body and coastlines — but never the target
before a hint. After each capture: **1.25 s at 25% speed** while the new prompt appears.
Together these are the anti-nausea and anti-disorientation package both councils demanded.

---

## 5. Scoring, difficulty, hints

`score = round(base × speed × hint × streak)`

- **base** by tier: 100 / 160 / 250 / 380 / 550.
- **speed** — par must be **distance- and terrain-normalized**, or spawn geometry beats skill.
  Par = A* over a coarse 2° terrain grid, edge cost = spherical distance ÷ terrain speed,
  plus 2.5 s recognition. `speed = clamp(exp(0.55·(1 − actual/par)), 0.35, 1.6)`.
  Floored deliberately: a slow find always pays. Zeroing out a completed find teaches quitting.
- **hint** multiplier: 1.00 / 0.85 / 0.60 / 0.25 — charged against *this target's* value,
  never against banked score, and computed from the original value so stalling never makes a
  hint cheaper. The clock keeps running during hints.
- **streak**: +0.1 per consecutive hint-free capture, capped 1.5.
- **No separate route bonus** — terrain-aware par already prices routing; a second term
  double-counts it.

**Hint ladder** (Space, escalating): ① 90° bearing wedge + near/mid/far band · ② translucent
1500 km circle · ③ exact pulsing pin. Hint ① fires **automatically and free at 2× par** —
the "never get stuck" promise must not require self-humiliation.

**Difficulty** is a chosen deck (Explorer / Standard / Expert), not a silent judgement, with
adaptive drift inside it: two sub-par hint-free finds promote a tier, a timeout or a pin-hint
demotes one. Experts reach Point Nemo by target six; novices stay among capitals.

An always-on, always-free **"You are in: Kazakhstan"** readout is the game's quiet geography
teacher. It never reveals where a target *is*, only where *you* are.

**Targets** (~400): T1 countries · T2 capitals & major cities · T3 landmarks ·
T4 flags and country-outline silhouettes (image prompts) · T5 physical features
(Mariana Trench, Atacama, Baikal) · T6 genuinely obscure (Tristan da Cunha, Nauru, Point Nemo).
Country targets hit-test by **country-index equality**; point targets by angular radius scaled
by tier. A wrong radius reads as "the game cheated."

**Ships** — cargo and naval vessels traverse plausible great-circle shipping lanes. Swallow
one for bonus points and a short speed surge. Deliberately *not* required for a good score,
and visually distinct from targets.

---

## 6. The mechanic that makes it memorable

**Wake-riding** (Sol) — and it only works because the trail is permanent (Fable). Hold the
head between 1.5 and 4 collision radii of a non-neck body segment with heading alignment
`dot > 0.8` and a draft meter charges over 0.4 s; while aligned, speed ramps +30% and streak
gains up to +0.25. Entering the collision radius still kills you. The drafted segment gets a
travelling pulse, the camera tightens, a wind tone rises.

This converts body growth from pure punishment into a skill surface: experts deliberately lay
orbital routes early, then surf them at lethal proximity later. It is the single best
interaction between the three systems we already have.

**Daily Run** (Fable) — a `mulberry32` PRNG seeded `YYYYMMDD`: everyone gets the same
10-target gauntlet in the same order. End screen renders the run's full trail polyline and
target pins to an offscreen equirectangular canvas → `toDataURL` share image, plus a
Wordle-style clipboard block. `localStorage` keeps bests and streaks. Zero backend. The trail
ribbon — already coloured by every biome you crossed — *is* the share card.

This absorbs the replayability goal of Sol's proposed "Atlas Relay" variant without spending
a whole variant slot on it, and it ships in **all three** versions.

---

## 7. The three versions

**1. EXPEDITION** — canonical. NASA Blue Marble globe, atmosphere fresnel rim, night lights,
stars, terminator. Keyboard + mouse + touch. Full spec above. Ships to *done* before a line of
variant code is written.

**2. TEMPEST** — the arcade liberty take. Weather is a **baked analytic tangent vector field**,
not a simulation: 3–4 latitude-band jet streams and 2–3 ocean gyres defined analytically,
curl-noise turbulence, plus moving vortex kernels (`ω × r` with falloff) advected along
scripted hurricane tracks. Wind adds to the head's tangent velocity; streamlines are rendered
on the globe so every push is **telegraphed and never a surprise death** — that is the fix for
Sol's objection that currents make deaths feel arbitrary. Aurora and terminator as shader
dressing. Riding a jet stream around the world is the trailer moment.

**3. TERRA INCOGNITA** — the contemplative liberty take. Antique parchment globe; the snake is
a pen nib that *inks the world as it travels*, rendered into an offscreen equirectangular
reveal texture used as a mix mask between blank vellum and a fully-drawn antique map. Labels
bloom into hand-lettered existence behind you; progress persists in `localStorage`.

**Fog-of-war is cut.** Both councils killed it independently and for the same reason: the game
*is* "find Paris," so hiding the map converts a geography test into a random walk. Faint
embossed coastlines, graticule and continent silhouettes are always visible. Terra earns its
difficulty honestly instead: **it has no exact-pin hint at all** — hints give bearing and
great-circle distance only. Dead reckoning.

Build order: Expedition to done → Tempest → Terra Incognita.

---

## 8. Ranked failure modes and their mitigations

1. **Three half-games.** Hard gate: Expedition passes a full checklist — controls, collision,
   restart flow, audio, share card, mobile perf — before any variant work starts. If the day
   runs short the trio becomes a duo; Terra is the designated cut.
2. **Data-bake rabbit hole / the PNG alpha trap.** Procedural fallback built and shipped
   against first; real sources are additive. Raw `.bin`, never a PNG alpha channel.
3. **Camera disorientation / motion sickness.** Zero roll, 0.25 s damping, fixed FOV, capped
   zoom, graticule, compass, inset globe, spawn grace, instant restart.
4. **Low-end GPU collapse.** Gameplay raster separate from visual texture, nearest-sampled,
   DPR capped at 1.5, pooled trail geometry as instanced segments in a ring buffer — never
   rebuilt per frame — and a quality preset that drops clouds and night lights.
5. **False self-collision** at trail joins, high latitudes, or low frame rates → fixed
   timestep + segment-wise continuous collision.
6. **Dataset inconsistency** across 400 entries → schema-validated, coordinates verified
   against the baked country index at build time; a mismatch fails the build.
7. **Ships become mandatory** or read as targets → capped value, distinct silhouette and colour.
8. **"Mouse support" shipped as unplayable touch** → pursuit steering built the same hour as
   keyboard, and tested at phone viewport.

---

---

## Revisions made during the build

Recorded because each of these overturned something asserted above, and the reasoning
matters more than the conclusion.

**1. The trail is not permanent in Expedition or Tempest.** §0 committed to "the trail never
despawns within a run — it is a wall, not a tail." Building it exposed that this is a different
game: a permanent line makes every run end in inevitable self-encirclement, and it quietly
discards the rule the brief actually asked for ("collect dots, grow longer, can't collide with
yourself"). The insight underneath it was still right, so it was kept in the form that does not
change the genre: **the world is small and the body grows fast**. Ten degrees of arc per capture
means the body spans a third of the planet by capture ten, which is a real hazard without
abandoning classic Snake. The permanent trail survives where it genuinely belongs — Terra
Incognita, where an indelible line *is* the fiction, and where it earns that variant its
distinct rule set.

**2. Speed halved, from a ~50 s equatorial lap to ~100 s.** The council's small-world argument
was framed as making the body dangerous, and at 50 s it did — but a typical hop is 80° of arc,
which at that speed is eleven seconds. That is not enough time to remember where Montevideo is,
and remembering is the game. The threat from the body is *spatial*, not temporal, so halving the
speed cost none of it and bought back all the thinking.

**3. Turn rate cut from 220°/s to 135°/s.** Measured after the fact: at 220°/s the turning circle
was 0.03° across against a body 0.84° wide, so the snake could turn a complete loop inside its own
width. That is unkillable and looks broken. At 135°/s the circle is 2.7° — a little over three
body-widths, which is where Snake has always felt right.

**4. The speed-scoring exponent raised from 0.55 to 0.8.** A perfect-knowledge bot was run
through six captures and only ever earned ×1.08–×1.15, meaning the entire top half of the
multiplier range was unreachable and mastery paid nothing. At 0.8 flawless play is worth ×1.4.

**5. The Daily Run is planned up front.** Adaptive difficulty and the trail-obstruction bias in
target selection are both good, and both would have made two players' daily runs diverge — which
would make "everyone on Earth got these ten, in this order" a lie on the share card. The daily
plan is now drawn from the date seed alone on a fixed 1-1-2-2-3-3-4-4-5-5 tier ladder, with no
reference to the player.

**6. Mountain coverage was re-baked.** The first bake classified mountain at 1.5% of land, because
slope thresholds calibrated for real cartography wash out at 10 km per texel. At that density there
was nothing to route around and §3's central promise was decorative. Retuned to 9.8% of land, with
range-spine assertions (Andes, Himalaya, Alps, Rockies, Caucasus, Zagros, Atlas, Ethiopian
Highlands, Southern Alps, Japanese Alps) and negative cases (Amazon, Sahara, Great Plains, Congo,
East European Plain, central Tibet) now enforced by the bake's own verifier.

---

## Attribution shipped in-game

NASA Visible Earth / Blue Marble & GEBCO_08 (public domain) · Natural Earth (public domain) ·
Köppen-Geiger climate classification, Beck et al. 2023 (CC BY 4.0) · `flag-icons` (MIT) ·
Three.js (MIT).
