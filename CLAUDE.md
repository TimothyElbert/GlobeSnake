# Globe Snake — working notes

Snake on a 3D globe of the real Earth. The food is real places; you steer the snake's head into
them, scored on speed and obscurity. Three worlds share one engine, four modes each.

**Live:** https://timothyelbert.github.io/GlobeSnake/ · **Repo:** TimothyElbert/GlobeSnake
Static site on GitHub Pages, deployed by Actions on push to `main`. No backend, ever.

---

## Read these, in this order

| | |
|---|---|
| **This file** | How to work here, and what will bite you. Start and stay here. |
| [docs/INVARIANTS.md](docs/INVARIANTS.md) | The traps, each with the bug it actually caused. **Read before touching geometry, relief, hints or the trail.** |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Module map, data flow, "to change X, edit Y". |
| [docs/TESTING.md](docs/TESTING.md) | How to verify without a compositing browser. Non-obvious and necessary. |
| [docs/HANDOFF.md](docs/HANDOFF.md) | What is true right now: finished, known gaps, what to do next, and every bug that shipped. |
| [docs/TWO-IMPLEMENTATIONS.md](docs/TWO-IMPLEMENTATIONS.md) | Four defects found in pairs across two codebases. Read if you are about to trust a test. |
| [docs/DESIGN.md](docs/DESIGN.md) | *Why* it is like this. Its **Revisions** section is authoritative wherever it contradicts the sections above it. |
| [docs/BRIEF.md](docs/BRIEF.md) | Historical only — the pre-build brief. Several proposals in it were overturned. |

## Commands

```bash
npm install
npm run dev              # Vite on :5173 — see docs/TESTING.md before trying to verify anything
npm run verify           # typecheck + target + capture validation + bake assertions. Before every commit.
npm run build            # tsc --noEmit && vite build
```

Data is baked and committed, so a fresh clone needs no network:

```bash
npm run bake                    # re-derive public/data + public/textures (downloads once, cached)
node tools/bake/verify.mjs      # 68 assertions over the baked world
node tools/fetch-flags.mjs      # vendor the flag SVGs the dataset references
npm run validate:targets        # all 407 targets against the rasterised borders
npm run validate:capture        # all 407 can actually be won — a different question
```

## Scale, for orientation

~10,250 lines of TypeScript/ESM. 407 targets across 5 tiers, 241 countries, 54 flags,
15 country outlines, 25 hand-drawn landmark silhouettes. `public/data` is 2.3 MB, textures 1.6 MB.

---

## House rules

**No network at runtime.** Every asset is baked in at build time. The Credits tab promises, in
writing, that nothing here makes a request once loaded — and that promise is only worth something
if it is absolute. Do not add analytics, web fonts, CDN scripts or telemetry. A visitor counter was
built and then deliberately removed. See [docs/INVARIANTS.md](docs/INVARIANTS.md#no-network).

**Verify, do not assume.** `requestAnimationFrame` does not fire in a headless browser pane, so
"it compiles" tells you nothing about whether the planet is on screen. Use the `window.__gs` dev
hook to drive the simulation and capture real frames — [docs/TESTING.md](docs/TESTING.md). Several
serious bugs here (a mirrored Earth, an invisible lethal trail, ships absent from the scene graph)
type-checked perfectly and shipped.

**Compute it twice by different routes, and treat the agreement as the result.** A single number is
not a measurement here, however carefully produced. Every error found while fixing the capture bug
was caught by a second route disagreeing, and not one by inspecting the first: a constant transcribed
into a test went stale *inside the commit that added the test*; a wind bound measured by sampling the
globe uniformly came back 44% low because four sparse storms are effectively unhittable that way; a
sweep reported `b_max` pinned at exactly 0.00 and exactly 50.00 at once, which is a clamp wearing a
measurement's clothes; and a turn-radius fit was 34% high because the multiplier chain had boost
applied twice. Each was a sound method returning a plausible number about the wrong quantity — which
is also what shipped the original bug, since `validate:targets` measured whether a target was
*authored* correctly and was read as whether it could be *won*. When two routes agree to a fraction
of a percent, report the agreement, not the number.

**Prefer measurement and algebra as the two routes, because they fail in opposite directions.** The
capture floor's wind term was wrong twice: once *low*, from sampling a field to find a supremum that
sampling cannot converge to (four sparse storms are effectively unhittable, and the maximum kept
climbing with sample count — a bound that improves when you look harder is not a bound); then once
*high*, from multiplying separate maxima that cannot co-occur (the fastest terrain is river, and
`isWater` excludes River, so a gyre cannot be present on it). Both errors produced a figure that
survived review. They are not one mistake with two signs: **sampling cannot find a supremum, and
algebra cannot know what is reachable.** Neither route is safe alone, which is the actual reason to
run both rather than merely a preference for redundancy.

**Fairness is a hard constraint.** Anything lethal must be drawn, at its true size. Two separate
bugs came from breaking this. If you cannot draw it, do not let it kill.

**Keep the docs true in the same commit.** The player-facing copy has drifted from the mechanics
three times: the launcher taught arrow keys after they were removed, Terra advertised a permanent
trail after it moved to Grand Tour, ships were sold as points after they became fuel. When you
change a mechanic, grep for it. Surfaces that describe behaviour: `index.html` (launcher),
`src/ui/screens.ts` (in-game tabs), `src/variants/*.ts` (world blurbs and rules), `README.md`,
`docs/DESIGN.md`.

**Dead code that implies a feature is a bug.** The brake was unbound but left in the engine; it
read as a control the game had. Remove, do not orphan.

---

## The shape of it

`src/app.ts` exports `bootstrap(config: VariantConfig)`. Each world is a thin config plus optional
`onSetup` / `onFixed` / `onRender` / `onCapture` / `onReset` hooks. Nothing in the shell knows which
world it is running — that is why three worlds at this quality were affordable.

```
src/core/      sphere math, snake + trail + collision, baked-world sampler, input, fixed-step loop
src/render/    globe shader, ribbon, chase camera, props (head/pin/stars)
src/game/      session (the orchestrator), targets, scoring, par (A*), ships, records
src/ui/        hud, screens, minimap, share card, styles
src/audio/     generative score + drone, all synthesised
src/variants/  expedition · tempest (analytic wind) · terra (ink reveal, fog of war)
tools/bake/    offline pipeline: NASA + Natural Earth + Köppen → public/data/world.bin
```

Movement is rotation on the unit sphere; there is deliberately no lat/lon in the simulation loop.
One baked 4096×2048 grid feeds both the physics and the globe shader, so visuals and collision
cannot disagree by construction.

## Where the bodies are buried

Six things account for most of the difficulty. All are documented properly in
[docs/INVARIANTS.md](docs/INVARIANTS.md); this is the index:

1. **Coordinate handedness and triangle winding are a matched pair.** Change one, change both.
2. **Relief exaggeration must be identical** in the globe shader, the ribbon and the app.
3. **The ribbon's vertex budget must cover the whole lethal trail.**
4. **`world.bin` is deliberately not a PNG**, and the data texture's orientation differs from image
   textures.
5. **Terra Incognita must not leak the map** — through relief shading, the minimap, or the HUD.
6. **A target's capture rule must be country *and* radius, never one instead of the other.** The
   exclusive version made 32 targets unwinnable and softlocked runs, while the dataset validator
   passed 407/407. The capture floor is tied to the *fastest* variant's per-tick advance — see
   [INVARIANTS §12](docs/INVARIANTS.md); it is not a number you may pick by feel.
