# Handoff — state of play

Written at the end of the build sessions that produced the game. Start with
[../CLAUDE.md](../CLAUDE.md); this file is the "what is actually true right now, and what would I do
next" companion to it.

**Last updated:** after `9f8e239` (arrow-key steering restored).

---

## What is finished and verified

- **Three worlds, four modes each.** Expedition (canonical Earth), Tempest (analytic wind field),
  Terra Incognita (ink reveal with real fog of war). Modes: Expedition (endless), Daily Run (10
  targets, seeded per world per day), Relay (2 min + 8 s per find), Grand Tour (20 named up front,
  any order, permanent trail, ranked on finishing time, with a pre-start study period).
- **407 targets** across 5 tiers, machine-validated against the rasterised border map on every
  build. 54 flags, 15 country outlines, 25 hand-drawn landmark silhouettes.
- **Baked world data** from NASA (Blue Marble, GEBCO, Earth at Night), Natural Earth and
  Köppen-Geiger. 68 assertions over the result. Only ocean bathymetry is synthesised, and it affects
  nothing but colour.
- **Terrain relief** as real vertex displacement, shared exactly between shader, snake, camera and
  pins.
- **Mouse and arrow-key steering**, last-used-wins, with adjustable mouse sensitivity.
- **Local records** with plausibility validation. Route-card share image and clipboard block.
- **Generative audio** with a selectable drone, and a working mute.
- **Zero network at runtime.** Verified by resource-timing inspection.
- Performance measured once, on one machine: 120 fps vsync-capped on an RTX 4070 Ti SUPER, median
  frame 8.3 ms, zero frames over 33 ms across 601 frames. That is a fast GPU and says nothing about
  the low end; there is a one-way quality fallback (`Globe.setQuality`) that trips below 34 fps, and
  it has never actually been observed firing.

## Known gaps, honestly

Ranked by how much they would bother a player.

1. **Nobody has played it with their hands.** Every mechanic was verified by driving the simulation
   and reading numbers or captured frames. Game feel — turn radius, speed, camera damping,
   sensitivity defaults — was tuned by measuring geometry and by a scripted bot. It is plausible
   that the defaults are wrong in a way five minutes of play would reveal instantly.
2. **Audio is unaudited.** Confirmed to exist, to mute, and to crossfade between styles. Whether the
   generative score is pleasant over twenty minutes is unknown.
3. **Touch is untested on hardware.** The mobile HUD was verified by measuring bounding-box overlap
   at 390×844. Pursuit steering should make it work, but "should" is doing real work there.
4. **Cross-browser.** Chromium only. The risky features are `DecompressionStream` (world.bin),
   CSS `mask-image` (silhouette prompts) and `RedFormat` data textures (relief).
5. **Grand Tour balance.** The tier ladder for the twenty targets is a guess, and finishing time as
   the sole ranking metric has never been raced by two people.
6. **Terra's exploration metric** counts a cos-weighted disc around the path. It is honest but
   generous — a long straight line scores more than the same distance spent looking around.
7. **The share card** has never been posted anywhere, so its legibility as a social artefact is
   theoretical.

## Things deliberately not done

Do not "fix" these without a reason:

- **No leaderboard or backend.** Considered, designed, and declined in favour of the no-network
  guarantee. `game/records.ts` is deliberately shaped so a backend is a storage swap, not a rewrite.
- **No analytics.** Built and removed. See [INVARIANTS.md §11](INVARIANTS.md#no-network).
- **No brake.** Removed from the engine, not merely unbound.
- **Hints do not point at the answer.** The cone and circle offsets are intentional —
  [INVARIANTS.md §8](INVARIANTS.md#8-hints-must-not-point-at-the-answer).
- **Terra has no exact-pin hint.** That is how it earns its difficulty.
- **Ships pay in boost, not points**, so they never compete with the objective.

## If I had another session

Roughly in order of value:

1. **Play it and retune.** Everything above about game feel. Start with sensitivity defaults, camera
   zoom default, and whether the Grand Tour's twenty is too many.
2. **Cross-browser pass**, especially Safari — `DecompressionStream` support is the thing most likely
   to hard-fail, and `WorldData.load` currently throws a message the loading screen shows verbatim.
   A fallback inflate would remove the only single point of failure in the load path.
3. **Silhouette set audit.** The set is cohesive but a few are weak in isolation: Christ the
   Redeemer is generic, Mount Rushmore is stylised, Marina Bay Sands is subtle at prompt size. Giza
   took five attempts and finally worked as the Sphinx. Render a contact sheet
   ([TESTING.md](TESTING.md)) and be ruthless.
4. **Second pass on the target dataset.** 407 entries authored in two passes; tiers 3–5 in
   particular could use a difficulty sanity-check by someone who is not the author. The validator
   catches wrong coordinates, not wrong tiers.
5. **More worlds.** The variant system is genuinely cheap now — a fourth world is a config file, an
   HTML entry and a Vite input. The design council's rejected ideas (a day/night terminator game, a
   tectonic deep-time globe) are in [BRIEF.md](BRIEF.md).
6. **Accessibility.** Colour-blind safe biome palette, and a check that the game is playable with
   reduced motion (the CSS honours `prefers-reduced-motion` for UI, but the camera does not).

## Bugs that shipped, and how they were found

Worth reading as a list of failure modes this codebase is prone to. All are now guarded — see
[INVARIANTS.md](INVARIANTS.md).

| Bug | How it presented | Found by |
|---|---|---|
| Globe rendered as a mirror image of Earth | Every country in the right place relative to its neighbours; all lookups passed | Projecting two known cities to screen space |
| Atmosphere shell blanketed the whole planet in blue | Read as "the ocean is too bright" for three tuning passes | Bisecting by switching pieces off and shooting each state |
| Ships never added to the scene graph | Simulated, collidable, on the minimap, invisible on the globe | Placing one 3° ahead and looking |
| Invisible lethal trail in Grand Tour | Tail appeared to crawl toward the player; death by an unseen wall | Player report, then measuring drawn window vs lethal window |
| Dried trail drawn at half its collision width | Clearing a gap and dying anyway | Reading the code while fixing the above |
| Terra leaked the map four different ways | Continents visible through fog; whole world in the minimap | Player report, then auditing every overlay |
| Snake rode invisible mountains | Body climbing terrain a flat globe was not drawing | Player report |
| `vertexColors: true` with no colour attribute | Ships rendered pure black on a dark ocean | Inspecting material state at runtime |
| Hint cone aimed at the target | Hints far more useful than designed | Player report, then measuring offset over 25 targets |
| Player-facing copy drifted from mechanics, 3× | Docs taught removed controls | Player report; now a house rule in CLAUDE.md |

The pattern is consistent: **the bugs that survived were the ones that type-checked and were
internally consistent.** Every one was caught by rendering a frame and looking at it, or by measuring
a number, and never by reading the code.
