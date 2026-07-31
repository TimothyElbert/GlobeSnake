# Globe Snake

Snake, played on a 3D globe of the real Earth. The food is places.

You are given a target — *Brazil*, then *Paris*, then *Big Ben*, and eventually things like
Kerguelen and Point Nemo — and you steer a snake across the planet to reach it. The faster you
arrive and the more obscure the place, the more it is worth. Terrain fights you: mountains slow
you down, rivers carry you, ice takes your momentum and keeps it. And your own body is getting
longer with every find.

**Three worlds, one snake.**

| | |
|---|---|
| **Expedition** | The canonical game. NASA's Blue Marble, city lights on the night side, real elevation under every metre. |
| **Tempest** | The same Earth with the atmosphere switched on. Jet streams, ocean gyres and hurricanes, all drawn on the globe before they reach you. |
| **Terra Incognita** | A blank vellum globe and a pen for a snake. Nothing is drawn until you go there — not even the coastlines — so finding your bearings is the game. |

Every world has four modes. **Expedition** runs until your own body catches you; **Relay** gives
you two minutes and eight more seconds per find; **Daily Run** is ten targets, one at a time, the
same ten for everyone playing that world today; and the **Grand Tour** names twenty places up
front, lets you take them in any order, never lifts the line, and ranks you on how fast you
finish. Dailies are seeded per world, so the three are three different puzzles on the same date.
Every run ends with a shareable route card drawn from the biomes you crossed.

---

## Play

Nothing to install. Open the site, pick a world, press Begin.

Steer with the arrow keys or the mouse — both are always live, and whichever you used last has
control. There is no brake; it was one binding too many.

| | |
|---|---|
| <kbd>←</kbd> <kbd>→</kbd> | Turn |
| <kbd>↑</kbd> | Boost (costs stamina) |
| **Mouse** | Steer toward the cursor · reach further ahead, or **hold**, to boost |
| <kbd>Space</kbd> | Hint (costs points from the current target) |
| **Wheel** | Zoom |
| <kbd>Esc</kbd> | Pause · <kbd>R</kbd> restart · <kbd>M</kbd> mute |

Boost is not scheme-specific: <kbd>↑</kbd> works while you are aiming with the mouse, and holding
the button works while you are turning with the keys. Cursor steering is also what makes the game
playable on a phone, rather than a keyboard game with an apology bolted on. Mouse sensitivity is
adjustable in the Controls tab; it does not affect the arrow keys, which always ask for a full turn.

**You cannot get permanently stuck.** Hints are charged against the current target's value, never
against points you have already banked, and if you are still lost at twice the par time the first
hint arrives on its own and costs nothing. Hints deliberately point at a *region* — the bearing
cone is swung off the true heading and the search circle is centred away from the answer, so they
narrow the search without solving it.

---

## Running it locally

```bash
npm install
npm run bake          # downloads public-domain geodata once, bakes public/data/world.bin
node tools/fetch-flags.mjs
npm run dev
```

`npm run bake` is only needed once; the baked outputs are committed. It caches downloads in
`tools/bake/.cache/` and is deterministic — the same inputs always produce a byte-identical
`world.bin`. If every download fails it falls back to a fully procedural world rather than
breaking the build.

```bash
npm run validate:targets   # checks all 407 targets against the baked border map
npm run validate:capture   # checks all 407 can actually be won — a different question
npm run build              # typecheck + production bundle into dist/
node tools/bake/verify.mjs # 68 assertions over the baked world data
```

Deployment is a GitHub Actions workflow on push to `main`; it validates the dataset, builds, and
publishes to Pages.

---

## How it works

**Movement is rotation.** There is no latitude or longitude anywhere in the simulation loop —
lat/lon has singularities at the poles and non-uniform spacing everywhere, and both show up as
gameplay bugs. The head is a unit vector `p` on the sphere and the heading is a unit tangent `h`;
moving forward rotates both in the plane they span, which walks a great circle exactly. Turning
rotates `h` about `p`. See [`src/core/sphere.ts`](src/core/sphere.ts).

**One grid drives everything.** `public/data/world.bin` is a 4096×2048 raw RGBA grid — elevation,
climate class, gameplay terrain, country index — baked offline from NASA and Natural Earth data
and shipped gzipped. The simulation reads it through a typed array and the globe shader reads the
identical bytes as a `DataTexture`, so what you see and what you collide with cannot drift apart.
It is deliberately not a PNG: `getImageData` premultiplies alpha, which would silently corrupt a
country index stored in the alpha channel and make every border in the game slightly wrong.

**Par is terrain-aware.** Scoring against raw elapsed time would mean spawn geometry beats skill —
2,000 km across the steppe is not the same problem as 2,000 km over the Himalayas. So par is an
A\* search over a coarse terrain-weighted grid, and your multiplier measures you against the best
route the ground allows. Because par already prices routing, there is no separate route bonus;
paying twice for one decision would make routing the only thing that matters.

**Fixed timestep.** The simulation always advances in 1/120 s slices regardless of frame rate. A
30 fps laptop and a 144 Hz desktop have to agree on whether you clipped your own tail, and
self-collision is tested against the trail's *arcs*, not just its stored samples, so a boosting
head cannot tunnel between two of them.

**Everything is local.** No backend, no accounts, no analytics, and no network requests at all
once the page has loaded. Best scores live in `localStorage`.

---

## Data and licences

All world data is public domain or permissively licensed, downloaded once at bake time and
committed, so the deployed site never calls out to anyone else's server.

- **Imagery and elevation** — NASA Visible Earth: Blue Marble topography+bathymetry, Earth at
  Night, and GEBCO\_08 elevation. Public domain.
- **Coastlines, borders, rivers, lakes, glaciers** — [Natural Earth](https://www.naturalearthdata.com/). Public domain.
- **Climate** — Köppen-Geiger classification: Beck, H.E. *et al.* (2018), *Present and future
  Köppen-Geiger climate classification maps at 1-km resolution*, Scientific Data 5:180214. CC BY 4.0.
- **Flags** — [flag-icons](https://github.com/lipis/flag-icons). MIT.
- **Landmark silhouettes and country outlines** — drawn for this project.
- **Engine** — [Three.js](https://threejs.org/). MIT.

Ocean depth is the one synthesized layer: there is no real bathymetric grid in the bake, so
undersea elevation is plausible shading rather than measurement. It affects nothing but colour.

See [`public/data/BAKE_REPORT.md`](public/data/BAKE_REPORT.md) for the full ledger of what is real
versus derived.

---

## Working on it

| | |
|---|---|
| [CLAUDE.md](CLAUDE.md) | Start here. Orientation, commands, house rules. |
| [docs/INVARIANTS.md](docs/INVARIANTS.md) | The traps, each with the bug it caused. Read before touching geometry, relief, hints or the trail. |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Module map, data flow, "to change X, edit Y". |
| [docs/TESTING.md](docs/TESTING.md) | How to verify without a compositing browser. Non-obvious. |
| [docs/HANDOFF.md](docs/HANDOFF.md) | Current state, known gaps, what to do next. |
| [docs/DESIGN.md](docs/DESIGN.md) | Why it is like this. Its Revisions section is authoritative. |
| [docs/BRIEF.md](docs/BRIEF.md) | Historical: the pre-build brief. Several proposals were overturned. |

```bash
npm run verify    # typecheck + target validation + capture fairness + 68 bake assertions
```

## Licence

Code MIT. Bundled data keeps its own licences, listed above and credited in-game.
