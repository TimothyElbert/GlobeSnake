# GLOBE SNAKE — Design Council Brief

## The ask (verbatim intent from the user)

Build a complete, hostable-on-GitHub-Pages game. Premise: classic Snake (eat dots, grow,
can't hit yourself) but the snake crawls on a **3D Google-Earth-style globe**, and the "dots"
are **real-world locations**. You score by how fast you drive the snake's **head** into the
target location. Harder/more obscure targets = more points (Brazil easy → Paris harder →
Big Ben harder → increasingly obscure; sometimes the prompt is an **image** — a flag, a
landmark silhouette — instead of text). You can **sacrifice points for a hint** that
highlights the target on the map, bound to a **single keystroke**, so you never get stuck.

Softer wishes (spirit, not spec):
- Arrow-key control primary; also want a **mouse-driven demo version**.
- Snake **changes color reactive to climate**.
- Snake is **reactive to topography** — different speeds in water / mountains / desert /
  plains, such that routing *around* a mountain range is sometimes correct.
- Occasional **naval/cargo ships** moving around; swallow one for bonus points.
- Three final versions: one canonical + polished, the others taking **liberties** in the
  name of being more fun / beautiful / interesting / unique.

Constraints: static hosting (GitHub Pages), free assets only, must actually be polished and
production-shaped, not a prototype.

---

## Proposed architecture (v0 — critique this, don't rubber-stamp it)

**Stack:** TypeScript + Vite + Three.js (r185). Zero backend. Multi-entry Vite build →
one Pages site with a launcher that links the three versions. Shared `core/` engine package,
three thin `variants/` that re-skin and re-rule it.

**Sphere locomotion math.** Snake head is a unit vector `p` on S²; heading is a unit tangent
`h` with `h·p = 0`. Forward step = rotate both `p` and `h` about axis `a = normalize(p × h)`
by `θ = v·dt/R` — this walks a great circle, no poles/singularities, no lat-lon distortion.
Turning = rotate `h` about `p`. Re-orthonormalize `h` against `p` each frame to kill drift.

**Body & collision.** Trail is a polyline of unit vectors resampled to constant arc-length
spacing. Body length = f(score). Self-collision = angular distance from head to any trail
point past a neck gap < collision radius; accelerated with a lat/lon bucket spatial hash.

**World data.** Bake ONE offline-generated equirectangular RGBA PNG ("world data map",
~4096×2048), sampled at runtime via an offscreen canvas → `Uint8Array`, O(1) lookup by
lat/lon, and also fed to the globe shader so visuals and gameplay agree by construction:
- R = elevation (quantized, sea level at a known code)
- G = climate class (Köppen-ish index)
- B = gameplay terrain class (ocean / coast / plains / forest / desert / mountain / ice)
- A = country/region index (for targeting, highlighting, and "you are in X" readouts)

Sources must be public-domain or permissive: Natural Earth (PD) vectors, NASA/Blue-Marble
imagery (PD), Köppen-Geiger raster (CC BY). Baker must degrade gracefully to a procedural
climate model (latitude + elevation + continentality) if a download fails, so the build is
never network-dependent.

**Speed / terrain model (first pass).** plains 1.00 · ocean 1.10 · coast 1.05 · forest 0.85
· desert 0.90 (+stamina drain) · mountain 0.60 · ice 0.75 with **reduced turn authority**
(slippery). Rivers act as speed lanes. Intent: crossing the Andes should feel like a real
decision against going around.

**Climate colour.** Head colour = climate class at head. Each trail vertex *stores the colour
of the biome where it was laid down*, so the body becomes a ribbon-record of everywhere
you've been.

**Scoring.** `base(tier) × speedMultiplier(t vs par) × routeBonus − hintCost`. Hint is
escalating and keystroke-bound: press once → hemisphere/region narrowed; again → tighter
ring; again → exact pin. Each press costs a growing share of that target's remaining value.

**Targets dataset.** ~400 entries across tiers: countries → capitals/major cities → landmarks
→ flags (image prompt) → physical features → genuinely obscure (Tristan da Cunha, Nauru,
Point Nemo). Landmark art: **hand-authored SVG silhouettes** rather than photos — zero
copyright exposure, and a cohesive art direction. Flags: permissive SVG flag set.

**Ships.** Cargo/naval vessels traverse plausible shipping lanes on the ocean; swallowing one
grants bonus points and a short speed surge.

## Proposed three versions (this is the part most in need of challenge)

1. **EXPEDITION** — canonical. Photoreal-ish Blue Marble globe, atmosphere/fresnel rim,
   night lights, stars. Keyboard primary, mouse steering supported. The full spec above.
2. **TERRA INCOGNITA** — antique-cartography liberty take. Blank parchment globe; the snake
   is a pen nib and *draws the world as it travels* — coastlines, hachured mountains,
   hand-lettered labels bloom into existence behind it. Fog-of-war, contemplative.
3. **TEMPEST** — dynamic-planet liberty take. Live simulated weather: jet streams and ocean
   currents shove the snake, ride them for enormous speed; hurricanes, monsoon fronts,
   polar aurora, day/night terminator as a real mechanic. Chaotic arcade energy.

---

## What I want from you (be blunt, be specific, disagree with me)

1. **Kill or keep** each of the three versions. If you'd replace one, name the replacement and
   why it's a better use of the same engine. Rank the trio for "would a stranger play this
   twice."
2. **The single biggest design risk** in the v0 above, and the specific fix.
3. **Control scheme.** On a sphere with a head-following camera, is relative steering
   (←/→ turn) obviously right, or is there a better scheme? How should the mouse version work
   so it's genuinely good rather than a degraded port?
4. **Difficulty & scoring.** Does tier × speed-decay hold up? How do you keep an expert
   engaged without making a novice feel stupid, given the target set spans "Brazil" to
   "Point Nemo"? What does the hint economy need to look like so it's a real decision?
5. **The one mechanic we're missing** that would make this memorable rather than merely
   competent. Only propose things buildable in a static browser game with no backend.
6. **Failure modes** you predict in a from-one-prompt build of this scope, ranked.

Answer in tight prose or bullets. No hedging, no restating my brief back to me. Assume the
reader is the person who will implement it today.
