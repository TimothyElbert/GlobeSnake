# Invariants

Rules that are cheap to break and expensive to notice. Every entry here is a bug that actually
shipped, or was caught only by looking at a rendered frame. Each says what breaks, what it looks
like, and what guards it now.

If you are about to touch geometry, relief, hints or the trail, read the relevant entry first.

---

## 1. Handedness and triangle winding are a matched pair

`src/core/sphere.ts` · `src/render/globeGeometry.ts`

```
x =  cos(lat) · cos(lon)
y =  sin(lat)
z = -cos(lat) · sin(lon)      ← the minus sign is load-bearing
```

Without the negation the (east, north, up) frame is **left-handed**. WebGL's world is right-handed,
so the result is a perfectly self-consistent planet that renders as a **mirror image of Earth** —
every country correctly placed relative to its neighbours, the whole thing flipped east for west.
It passes every country-lookup test, because the data agrees with itself.

**And**: negating one coordinate mirrors the surface, which reverses every triangle's winding. So
`globeGeometry`'s index order is paired to that sign. Get it wrong and the `BackSide` atmosphere
shell renders the *near* hemisphere, blanketing the whole planet in blue haze — which is how this
was first (mis)diagnosed as an atmosphere bug.

Consequently **east is `north × up`**, not `up × north`. That is why the cross products in
`turn()`, `bearingDeg()` and `signedTurnToward()` are ordered as they are. Flipping one without the
others silently reverses steering.

Every lat/lon ⇄ vector conversion must agree. There are inlined copies for speed in:
`core/world.ts` (`offsetOf`), `game/par.ts` (`cellOf`), `ui/minimap.ts` (`rasterize`),
`variants/inkMap.ts` (`stamp`), `game/session.ts` (`recordTrace`, `markExplored`),
`variants/weather.ts`, and both shaders in `render/globe.ts`.

**Test:** with the camera facing north, +20°E must project right of −20°E. Bearings from Cairo:
Istanbul ≈ 351°, Riyadh ≈ 108°, Cape Town ≈ 192°.

## 2. Relief exaggeration must be identical everywhere

`core/world.ts` (`RELIEF_SCALE`) · `render/globe.ts` (`uReliefScale`) · `render/snakeRibbon.ts`
(`relief`) · `app.ts` (`reliefScale` → camera, head, pins)

Terrain is exaggerated ~30× so mountains are visible. Anything that must sit *on* the ground reads
the same number, or it floats above it — or sinks into it — by exactly the difference.

This broke when Terra was given a flat globe: the ribbon was still reading the global default, so
the body climbed mountains that were not being drawn and looked like it was glitching over
invisible terrain. `app.ts` now derives all of them from `config.relief`, and a dev-only assertion
fails loudly if `config.relief` and `config.globe.relief` disagree.

**Zeroing displacement is not enough to hide terrain.** The vertex shader also bends the *shading
normal* by the height gradient (`uReliefNormal`), which hill-shades the surface independently. Terra
sets both to 0 — see §5.

## 3. The ribbon must be able to draw the whole lethal trail

`render/snakeRibbon.ts` · `app.ts`

The Grand Tour keeps a **permanent** trail, in every world. The ribbon draws at most `maxNodes`.
If that budget is smaller than the trail's capacity, the oldest stretch silently stops being drawn
while remaining perfectly lethal.

Symptoms, from a real report: *"the end of the tail was moving toward me going the other way"* (the
drawing window sliding forward) and then dying to a wall that was not on screen. Measured over 5.3
laps, the old default left 11,715 nodes — about 156,000 km — undrawn.

`app.ts` derives `maxNodes` from the snake's `capacity` rather than guessing, and
`SnakeRibbon.update` logs a `console.error` in dev if the drawn window ever starts later than the
lethal one.

## 4. Drawn width must equal lethal width

`render/snakeRibbon.ts` (`dryWidth`)

The dried older section of a permanent trail was drawn at **half** its collision width. Same class
of unfairness as not drawing it: you clear what looks like a gap and die anyway. Age is carried by
colour now, which cannot lie about the hitbox. **Leave `dryWidth` at 1.**

## 5. Terra Incognita must not leak the map

`variants/terra.ts` · `render/globe.ts` (parchment branch) · `ui/minimap.ts` · `ui/hud.ts`

The whole premise is that you do not know where you are until you have looked. Four separate
channels have leaked it:

- **Relief shading.** Setting `relief: 0` stops displacement but not the normal perturbation, which
  hill-shaded blank vellum and drew every continent through the fog. Needs `reliefNormal: 0` too.
- **The paper texture.** Ageing was sampled from the elevation channel, painting the continents onto
  the blank paper as grey blotches. It is plain noise now.
- **The minimap.** It rendered the entire world's coastlines in the corner while the main globe hid
  them. It now takes `session.exploredMask` and draws unseen ground as blank vellum.
- **The HUD.** "You are in: Kazakhstan" is the free geography teacher everywhere else and the answer
  here. `hideLocation: true`.

Coastlines appear only where `inked > 0`. If you add any new overlay, ask what it reveals.

## 6. `world.bin` is deliberately not a PNG

`core/world.ts` · `tools/bake/index.mjs`

The baked grid is a raw gzipped `.bin`, fetched as an `ArrayBuffer` and inflated with
`DecompressionStream`. It is not a PNG because canvas `getImageData` **premultiplies alpha**, which
silently corrupts RGB wherever A < 255 and rounds A itself — and the country index lives in the
alpha channel. Every border in the game would be subtly haunted.

Format (little-endian): magic `GSW1`, `uint16` width, `uint16` height, then `w·h·4` bytes,
row-major, row 0 = north pole, column 0 = lon −180. Per texel:
`[0]` elevation (sea level = 100), `[1]` Köppen class (0 = water, 1–30), `[2]` gameplay terrain
class, `[3]` country index into `countries.json`.

**Texture orientation differs by source.** The data texture is uploaded `flipY: false` with
`NearestFilter`, so `v = 0` is the north pole. Image textures load `flipY: true`, so `v = 1` is the
north pole. Hence `dataUv(uv) = vec2(uv.x, 1.0 - uv.y)` in the shader. Nearest filtering is
mandatory — linear interpolation between class indices produces meaningless in-between values.

The separate `reliefTexture` *is* linear-filtered, because it is a continuous height field. Vertex
displacement straight from the nearest-sampled grid produces single-texel spikes.

## 7. The simulation runs at a fixed 120 Hz

`core/loop.ts` · `core/snake.ts`

A 30 fps laptop and a 144 Hz desktop must agree on whether you clipped your own tail. Collision is
tested against the trail's **arcs**, not just its stored samples, or a boosting head tunnels between
two of them. Never move gameplay state into the render callback.

## 8. Hints must not point at the answer

`game/session.ts` (`rollHintJitter`, `targetTangent`, `searchCentre`)

The offsets are deliberate, not a bug:

- The level-1 cone is swung 12–29° off the true bearing, biased away from zero. Uniform jitter is
  not enough — it lands near-centred often enough to teach players to read the centreline, which
  makes every later cone more useful than intended.
- The level-2 circle is centred 640–1065 km off the target inside its own 1500 km radius. Centred on
  the answer it is a bullseye smaller than most countries.
- Country highlighting is level **3** only. At level 2 it *was* the answer for a country target,
  making the middle rung better value than the top rung.
- The minimap shows the search area, not the target, until the exact pin is bought.
- The Grand Tour marks the nearest tile only *after* a hint is paid for. Marking it always narrows
  twenty candidates to one for free.

Offsets are rolled once per target and stored. Re-rolling per frame averages out to the truth.

## 9. Daily and Grand Tour plans must depend on the seed alone

`game/session.ts` (`buildDailyPlan`, `buildTour`, `pickPure`)

"Everyone got these ten, in this order" has to be literally true. Free-play target selection uses
adaptive difficulty and a trail-obstruction bias — both good, and both would make two players'
dailies diverge. Seeded modes use `pickPure`, which touches nothing but the RNG and a fixed tier
ladder. Seeds are salted per world (`variantSalt`) so the three worlds are three different puzzles
on the same date.

## 10. Records are validated on the way in

`game/records.ts`

There is no server, so the only thing that can corrupt records is hand-edited `localStorage` — but a
stored run claiming a million points from three captures would sit at the top of the table forever.
`isPlausible` bounds score against the theoretical maximum for that many captures and rejects
impossible times. Kept as a separate function so that adding a backend later is a storage change,
not a rewrite of the trust model.

## <a name="no-network"></a>11. No network at runtime

Everything is baked at build time. The in-game Credits tab states outright that nothing here makes
a request once loaded. A GoatCounter integration was written, reviewed and deliberately deleted:
being able to say that without an asterisk is worth more than visit counts.

If you need to check this holds: after load, `performance.getEntriesByType('resource')` must contain
no entry whose name lies outside `location.origin`.

## 12. Every target must be capturable

`game/targets.ts` · `tools/validate-capture.mjs`

Capture used to be **country _or_ radius, exclusively**: resolving a country index discarded the
authored `radiusKm`, and the tier defaults for tiers 1–2 were `0`. `world.bin` is 4096×2048, about
9.8 km per texel at the equator, so Nauru — 21 km² — rasterises to a **single cell**, and its
authored 300 km radius was thrown away on the grounds that a country rule existed. Thirty-one
targets had a capture inradius under 50 km; ten were under 3.5 km.

Flying at Nauru from 600 km out and sweeping the aim error, measured in the running engine: a
*perfect* line still won (closest approach 5.8 km, inside the texel), 5 km of aim error still won,
**10 km of aim error missed and every value above it missed.** So these were not quite mathematically
impossible — they demanded better than 10 km of precision on a globe you steer with a mouse, while
[the hint system deliberately jitters its cone by 12–29° and offsets its search circle by 640–1065 km](#8-hints-must-not-point-at-the-answer).
No player following a hint could ever have landed it. The run could not advance and the only way out
was to end it.

The rules are now OR-ed, and every target resolves a radius whether or not it also has a country
rule. A country rule still means "you were in the country"; the radius only adds a disc around the
representative point, which for anywhere larger than the disc lies entirely inside the country and
changes nothing. No entry in `TIER_RADIUS_KM` may be zero — 75 targets carry no authored radius and
would fall straight through to it.

The metric that matters is the **capture inradius**: walk outward from the authored point along 32
bearings, and take the smallest distance at which capture stops holding. It answers "how badly may I
aim and still win", which is what a player actually experiences, and unlike a cell count it does not
care how the raster happens to be resolved. `npm run validate:capture` measures it for all 407 and
fails under 50 km. It also reads `targets.ts` back and fails if the OR is reverted or the constant
drifts from the test's copy of it.

Note that capture is **point-sampled once per tick**, unlike self-collision, which is swept along the
arc. So a capture region can in principle be stepped straight over. A path passing at perpendicular
distance `b` from the authored point has a chord of `2·√(R² − b²)` inside the guaranteed disc, so at
least one sample lands iff `b ≤ √(R² − (d/2)²)`, where `d` is the greatest distance the head can
travel in one tick. Keeping the loss under 1% of the disc means **`R ≥ 3.544 · d`**.

`d` is larger than it looks, because every multiplier in `Snake.update` stacks: terrain (river 1.18)
× ship surge 1.25 × boost 1.35 × wake 1.3, on `baseSpeedDeg` 3.6 at 1/120 s — **8.64 km per tick**.
Tempest adds wind on top, applied after `step()` and outside that chain; measured at storm eyewalls it
peaks at 3.18 °/s, another 2.95 km, for **11.59 km per tick** and a required floor of **41.1 km**.

The 50 km floor therefore holds, but with 1.22× headroom, not the comfortable margin the
non-Tempest figure suggests. **Raise the floor before raising any speed multiplier**, and re-measure
rather than extrapolating — the binding term is `d`, and it is a product of five things that were
each tuned for feel, by different people, at different times.

**This one shipped, and `npm run validate:targets` passed 407/407 the whole time.** It checks that
coordinates are authored correctly — that Tunisia's point rasterises inside Tunisia. Whether a
player can ever satisfy the win condition is a different property, and nothing was testing it.
