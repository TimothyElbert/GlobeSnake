# Verifying changes

The single most useful thing in this file: **`requestAnimationFrame` does not fire in a headless or
non-compositing browser pane.** The render loop never runs, so the HUD never updates, the ribbon
never rebuilds, and the canvas stays blank — none of which means anything is broken.

Several serious bugs here type-checked perfectly and shipped: a mirrored Earth, an invisible lethal
trail, and a ship fleet that was simulated and collidable but never added to the scene graph. "It
compiles" is not evidence. Drive the simulation and look at a frame.

---

## The dev hook

`src/app.ts` installs `window.__gs` when `import.meta.env.DEV`. It is the whole test harness.

```js
__gs.session        // the live Session (getter — survives restarts)
__gs.world  .globe  .camera  .ribbon  .scene  .renderer  .canvas  .audio  .hud  .input  .config
__gs.beginRun()                              // start/restart a run without clicking
__gs.step(n, turn = 0, boost = false)        // n fixed 1/120 s ticks, variant onFixed included
__gs.capture(seconds, w, h, quality)         // advance, render one frame, return a JPEG data URL
__gs.shot(name, seconds, w, h)               // same, but POST it to disk (see below)
```

`step()` deliberately calls the variant's `onFixed`. An earlier version did not, and cheerfully
reported that Tempest had no wind.

## Screenshots to disk

`vite.config.ts` adds a dev-only middleware at `/__shot` that writes posted PNG/JPEG data into
`./screenshots/` (gitignored). So:

```js
await __gs.shot('andes.jpg', 12, 1000, 580)
```

then `Read` the file. This is the only way to actually see the render without a compositing pane, and
it is how the mirrored globe, the atmosphere blanketing bug, the invisible ships and the Terra fog
leak were all found.

**Forcing frames:** anything that only updates during render — the HUD, the ribbon, particle
systems, Terra's ink — needs real frames. Call `capture(0, …)` in a loop:

```js
for (let i = 0; i < 200; i++) { __gs.step(6); __gs.capture(0, 240, 140, 0.3) }
```

One giant frame is not the same as many small ones. A single `shot(name, 14)` ages every wind
particle out at once and renders an empty sky — that is a harness artefact, not a bug.

## Recipes that have earned their keep

**Place the snake somewhere specific.** Spawns are random, so pin it:

```js
const S = await import('/src/core/sphere.ts')
const p = S.fromLatLon(-16, -70)                       // the Andes
__gs.session.snake.reset(p, S.tangentToward(p, S.fromLatLon(-6, -76)))
__gs.camera.reset(__gs.session.snake.position, __gs.session.snake.heading,
                  __gs.world.reliefAt(p) * 0.045)
```

**Is the globe mirrored?** Numerically, not by eye. Face north; east must project to the right:

```js
const cam = __gs.camera.camera
const ndc = (la, lo) => S.fromLatLon(la, lo).project(cam)
ndc(0, 20).x > ndc(0, -20).x        // must be true
```

**Is anything lethal undrawn?** Compare the ribbon's window against the trail's:

```js
const s = __gs.session
Math.max(s.snake.firstBodyNode, s.snake.nodeCount - __gs.ribbon.maxNodes) - s.snake.firstBodyNode
// must be 0, always
```

To reach the regime where this used to fail, disable collision and travel several laps:
`s.snake.spawnGrace = 1e9` (re-set it after each `step`, since `update` decrements it).

**Bisect a rendering problem** by switching pieces off and shooting each state — this is how the
atmosphere shell was identified as the cause of a full-planet blue wash:

```js
__gs.globe.atmosphere.visible = false;                        await __gs.shot('no-shell.jpg')
__gs.globe.material.uniforms.uAtmosphere.value.setHex(0);     await __gs.shot('no-scatter.jpg')
__gs.globe.setGraticule(0);                                   await __gs.shot('no-graticule.jpg')
```

**Read actual pixel values** rather than guessing at a JPEG. Note that `capture()` restores the
canvas size afterwards, which clears the buffer — so `readPixels` after `capture` returns zeros. Use
`shot()` and read the file, or read inside a single render.

**Check a shader's source really reloaded.** Shaders compile once at construction, so HMR may not
have replaced them:

```js
__gs.globe.material.fragmentShader.includes('pow(rim, 8.0)')
```

**Inspect the SVG artwork** by rasterising it with `sharp` (a devDependency) into a contact sheet and
reading the PNG. Replace `currentColor` with a light hex first, and render at both full size and
~110 px — an icon that reads large can be mud at prompt size. This is how the Giza silhouette was
caught reading as a mountain range.

## Automated checks

```bash
npm run verify        # typecheck + validate:targets + validate:capture + bake verify. Before every commit.
```

- **`tsc --noEmit`** — `strict`, plus `noUnusedLocals` / `noUnusedParameters`.
- **`npm run validate:targets`** — every one of the 407 targets against the rasterised border map.
  Country-captured targets *must* rasterise inside their own country; a flipped longitude sign is the
  most common authoring error and this catches it. Warnings are informational (border summits nudged
  to one side, sub-texel atolls); errors fail the build.
- **`npm run validate:capture`** — can each target actually be *won*? Measures the capture inradius
  (the smallest distance, over 32 bearings from the authored point, at which capture stops holding)
  and fails under 50 km. This is a different question from `validate:targets`, which only checks that
  the coordinates are authored correctly; it passed 407/407 while 31 targets were unreachable. Also
  reads `targets.ts` back and fails if the capture rule or its constants drift from the test's copy.
- **`node tools/bake/verify.mjs`** — 68 assertions over the baked world: magic and dimensions,
  Everest is mountain-class above 230, the Sahara is desert, the Amazon is forest, central Greenland
  is ice, Point Nemo is ocean with country 0, London is GBR, Brasília is BRA, mountain coverage as a
  share of land, ISO3 uniqueness, and antimeridian probes (Chukotka, Fiji, open Pacific) that catch
  polygon smearing.
- **Runtime guard** — `SnakeRibbon.update` logs a `console.error` in dev if the drawn window starts
  later than the lethal one. `app.ts` asserts that `config.relief` matches `config.globe.relief`.

## What has no automated coverage

Be honest about this when handing off:

- **Game feel.** Turn radius, speed, camera damping and sensitivity were tuned by measuring
  geometry (turn circle vs body width, circumference vs body length) and by a scripted
  perfect-knowledge bot, not by a human playing. Numbers are recorded in
  [DESIGN.md](DESIGN.md#revisions-made-during-the-build) revisions 2–4 and 8.
- **Audio.** Verified only as "the master gain reaches zero on mute" and "the buses crossfade".
  Nobody has confirmed it sounds good.
- **Real touch devices.** The mobile HUD was verified by measuring bounding boxes for overlap at
  390×844, not by holding a phone.
- **Cross-browser.** Developed and checked against Chromium. `DecompressionStream`, CSS
  `mask-image` and `RedFormat` textures are the features most likely to need attention elsewhere.
