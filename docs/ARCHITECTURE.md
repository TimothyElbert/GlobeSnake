# Architecture

How the code is arranged, how a frame flows, and where to go to change a given thing.

Read [INVARIANTS.md](INVARIANTS.md) before editing geometry, relief, hints or the trail.

---

## The central idea

Every world is the same simulation with different rules and a different skin. `src/app.ts` exports
one function:

```ts
bootstrap(config: VariantConfig): Promise<void>
```

A variant is a config object plus optional lifecycle hooks. Nothing in the shell knows which world
it is running, which is the only reason three worlds at this quality were affordable.

```ts
interface VariantConfig {
  id: string
  chrome: VariantChrome           // name, tagline, blurb, rules text
  snake?: Partial<SnakeConfig>    // speed, turn rate, trail mode, capacity
  globe?: GlobeOptions            // parchment, relief, atmosphere, segments
  ribbon?: RibbonOptions          // width, drying, vertex budget
  maxHintLevel?: number           // Terra stops at 2 — no exact pin
  relief?: number                 // MUST match globe.relief — see INVARIANTS §2
  trackExploration?: boolean      // Terra: percent-of-globe metric
  hideLocation?: boolean          // Terra: no "You are in …"
  sunSpeed?: number
  onSetup? onFixed? onRender? onCapture? onReset?
}
```

`variants/expedition.ts` is almost pure config. `variants/tempest.ts` adds an analytic wind field in
`onFixed`. `variants/terra.ts` adds a GPU ink-accumulation pass in `onRender`.

## Directory map

```
src/
  app.ts            The shell: loads data, builds the scene, owns the loop, wires UI to session.
                    Also installs the window.__gs dev hook — see TESTING.md.
  launcher.ts       Landing page backdrop only. No game code.

  core/             No rendering. Only three's Vector3 for maths.
    sphere.ts       Great-circle stepping, turning, bearings, arc distance. Handedness lives here.
    snake.ts        Trail ring buffer, arc-length resampling, spatial-hash collision, wake-riding,
                    external advection (wind). Owns SnakeConfig.
    world.ts        Loads world.bin; samples terrain/climate/country/elevation; builds the
                    DataTexture the shader reads and the smoothed relief field.
    input.ts        Arrow keys and mouse pursuit steering, last-used-wins. Sensitivity.
    loop.ts         Fixed 120 Hz accumulator + render callback. mulberry32, daily seeds.

  render/
    globe.ts        One big shader: day/night, borders, graticule, relief displacement + normals,
                    hint overlays, and the parchment (Terra) branch. Plus the atmosphere shell.
    globeGeometry.ts Sphere built to our own convention. Winding is paired to sphere.ts — §1.
    snakeRibbon.ts  The body, as an incrementally-rebuilt ribbon coloured by biome-at-laydown.
    chaseCamera.ts  Damped, zero-roll chase rig that rides the terrain.
    props.ts        Snake head, target pin, starfield.

  game/
    session.ts      The orchestrator: phases, targets, capture, hints, scoring, modes, exploration.
                    The biggest file and the right place to start reading.
    targets.ts      Target pool, tier decks, adaptive drift, capture tests, far-side selection.
    scoring.ts      Value decay, hint and streak multipliers, formatting.
    par.ts          A* over a 2° terrain-weighted grid → the par time for a target.
    ships.ts        Shipping traffic simulation + instanced rendering.
    records.ts      Local personal records with plausibility validation.

  ui/               DOM, not canvas — text is the content of this game.
    hud.ts          Prompt / Grand Tour board / score / speed / hint / location / meters / toasts.
    screens.ts      Start sheet (tabbed), pause, run summary, loading.
    minimap.ts      Orthographic inset globe, rasterised on a 2D canvas at 20 Hz.
    shareCard.ts    End-of-run route card drawn to an equirectangular canvas.
    dom.ts styles.css launcher.css

  audio/audio.ts    Generative score, the original drone, and SFX. All synthesised, no files.

  variants/
    expedition.ts tempest.ts terra.ts
    weather.ts      Tempest: analytic jet streams, gyres, storms, and drawn streamlines.
    inkMap.ts       Terra: equirectangular render target the snake stamps into.

  data/targets.t12.json  tiers 1–2 (187)   ← authored, machine-validated
  data/targets.t35.json  tiers 3–5 (220)

tools/
  bake/index.mjs    Offline pipeline. Downloads once, caches, emits public/data + public/textures.
  bake/verify.mjs   68 assertions over the baked world. Run after any bake change.
  validate-targets.mjs  All 407 targets against the rasterised borders. Fails the build.
  fetch-flags.mjs   Vendors only the flags the dataset references.
```

## Build and deploy

Vite, four entry points: `index.html` (launcher) plus `expedition/`, `tempest/`, `terra/`. Three.js
is split into its own chunk. GitHub Actions validates targets, builds with
`BASE_PATH=/<repo>/`, and publishes `dist` to Pages on push to `main`.

## Data flow

**Offline, once** — `tools/bake` pulls NASA Blue Marble + GEBCO elevation + Earth-at-Night, Natural
Earth vectors, world-atlas borders and Köppen-Geiger climate, and bakes them into
`public/data/world.bin` (4096×2048×4 bytes, gzipped) plus `countries.json` and three textures.
Committed, so a clone needs no network.

**At load** — `WorldData.load()` inflates `world.bin`, builds the nearest-filtered `DataTexture` the
shader samples and a smoothed linear-filtered relief field for displacement. Textures load from
`public/textures`. Targets are bundled into the JS.

**Per frame** — `GameLoop` runs a fixed-step accumulator:

```
fixedStep(1/120)                       render(frameDt)
  input.sample() → SteerInput            globe.setSunPhase / update
  session.update(dt, steer)              ribbon.update(snake)        ← reads trail, biome, relief
    snake.update  (move, trail,          head.update / camera.update
                   collision, wake)      applyHints(session)         ← wedge / ring / pin
    ships.update                         hud.update(session)
    capture tests → events               minimap.update(…, exploredMask)
    exploration marking                  audio.updateAmbience
  config.onFixed  (e.g. Tempest wind)    config.onRender  (e.g. Terra ink stamps)
                                         renderer.render(scene, camera)
```

The single most important structural property: **the simulation and the globe shader read the same
baked grid.** Physics samples it through a typed array, the shader samples the identical bytes as a
texture. They cannot disagree about where Chile is.

## To change X, edit Y

| Want to change | Go to |
|---|---|
| Speed, turn rate, body length, growth | `core/snake.ts` → `DEFAULT_SNAKE_CONFIG` (per-world overrides in `variants/*.ts`) |
| Terrain speed multipliers, biome colours | `core/world.ts` → `TERRAIN_SPEED`, `CLIMATE_COLOR` |
| How scoring decays, hint or streak maths | `game/scoring.ts` |
| Hint behaviour, jitter, what each level reveals | `game/session.ts` + `applyHints` in `app.ts` |
| Globe look: lighting, borders, graticule, relief, parchment | `render/globe.ts` |
| Snake look: width, taper, scales, drying | `render/snakeRibbon.ts` |
| Camera framing or zoom range | `render/chaseCamera.ts` |
| HUD layout | `ui/hud.ts` + `ui/styles.css` |
| Start card, tabs, records, summary | `ui/screens.ts` |
| Modes, phases, capture rules, exploration | `game/session.ts` |
| Add or fix a target | `src/data/targets.t*.json`, then `npm run validate:targets` |
| Add a landmark silhouette | `public/silhouettes/<id>.svg`, referenced from the dataset |
| Anything about the baked world | `tools/bake/index.mjs`, then `node tools/bake/verify.mjs` |
| Add a fourth world | copy `variants/expedition.ts`, add an HTML entry + `vite.config.ts` input |

## Conventions worth knowing

- **Path aliases**: `@core`, `@render`, `@game`, `@ui`, `@audio`, `@data`.
- **No allocation in the hot path.** `core/` uses module-level scratch vectors; the ribbon writes
  into preallocated typed arrays and rebuilds incrementally.
- **`strict` TypeScript**, `noUnusedLocals` and `noUnusedParameters` on. `npm run build` typechecks.
- **Comments explain *why*.** Most of the non-obvious code here is non-obvious because the obvious
  version was tried and produced a visible bug; the comment records which one.
