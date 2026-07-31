# What two implementations found that one could not

**A shared helper gives you one bug and lets you call the agreement confirmation.**

This is an account of a week in which two codebases — this one and a private mobile fork of it —
audited the same game mechanic in parallel and turned up four defects. Each defect was real, each was
invisible to the implementation carrying it, and each was found only because the other implementation
existed. They arrived in pairs: the same class of error, in code with nothing in common.

The interesting part is not the bug that started it. It is that the pairs could not have been found by
sharing code, because in each pair the two causes were unrelated. What the members of a pair shared
was a *symptom*.

Written from this side. The fork's half is theirs; the errors attributed to me are mine.

---

## What started it

A bug report: *"flying over Tunisia and Nauru registers nothing, the run will not advance, and the
only way out is to end it."*

Tunisia turned out not to be the bug. Its capture region was tight — 48 km — but reachable; the report
was the parsimonious reading of a near-miss. Nauru was real, and the cause was in
[`src/game/targets.ts`](../src/game/targets.ts):

```ts
if (captureCountry === 0) {          // ← radius was ONLY a fallback
  captureRad = km / EARTH_RADIUS_KM;
}
```

Capture resolved country **instead of** radius. `world.bin` is 4096×2048, about 9.8 km per texel at
the equator, so Nauru — 21 km² — rasterises to a single cell, and its authored 300 km radius was
discarded on the grounds that a country rule existed. Winning required landing the head on one texel.

Sweeping the aim error in the running engine, flying at Nauru from 600 km out: a perfect line still
won (closest approach 5.8 km), 5 km of error still won, **10 km missed and everything above missed.**
So not strictly impossible — it demanded better than 10 km of precision, while the hint system
[deliberately jitters](INVARIANTS.md#8-hints-must-not-point-at-the-answer) its cone by 12–29° and its
search circle by 640–1065 km. No player following a hint could have landed it.

Thirty-two targets had a capture inradius under 50 km. Ten were under 3.5 km.

`npm run validate:targets` passed 407/407 throughout, because it asks whether a target's coordinates
are *authored* correctly — whether Tunisia's point rasterises inside Tunisia. Whether a player can
ever satisfy the win condition is a different question, and nothing was asking it.

**The failure was not a missing test. It was a test that looked like it covered the thing it did
not.**

---

## The four defects, in pairs

### Pair one: bisection

Both sides independently built a scanner to measure the **capture inradius** — walk outward from a
target along 32 bearings, take the smallest distance at which capture stops holding. It answers "how
badly may I aim and still win", which is what a player experiences.

Both sides implemented the outward walk as a **binary search**. Bisection assumes the predicate is
monotone along the ray. A country is any shape at all: fjords, estuaries, lakes, enclaves — each a
hole where capture fails. Given a hole, bisection does not find the first failure. It finds *a*
failure, or steps over the hole entirely and reports a distance far beyond it.

Every error ran the same way — overstating:

| target | true | bisection said |
|---|---|---|
| `flag-norway` | 93.26 km | *no finding at all* |
| `flag-bangladesh` | 24.26 km | 80.07 km |
| `country-portugal` | 58.59 km | 73.60 km |
| `flag-israel` | 37.51 km | 44.28 km |

Norway's cause is a 12.5 km band of country-0 where Sognefjord cuts inland at 93.5 km. Bangladesh's is
the Meghna estuary. Thirteen targets were overstated and none understated. An inradius that reads too
large is precisely the error a fairness test must never make.

The fork found Norway first and reported it. I confirmed it, found Bangladesh — which their scan had
also missed — and switched to a 1 km linear walk refined by bisection only within the last kilometre,
where monotonicity does hold.

**After both scanners were repaired independently: 63 of 63 comparable targets agreed within 0.02 km.**
Portugal and Israel to the centimetre, Norway to 10 m. That included two targets neither of us had
flagged, Denmark and Croatia, which showed up only because the other side existed.

### Pair two: the poles

Both scanners then turned out to be degenerate at the poles, **by mechanisms with nothing in common.**

Mine built its local frame from a fixed `[0, 1, 0]` reference, which is parallel to `p` at a pole.
There `cross` returns zero, `normalise` hands back zeros, the walk never advances, capture holds
forever, and the scan reports its ceiling.

The fork had no tangent frame at all — spherical trigonometry instead. At the pole
`cos(lat) = 6.1e-17` collapses an `atan2` numerator, and the sign of that numerator becomes the only
surviving information. So the longitude quantises no matter how wide you fan the bearings: measured
at both poles on the full 32-bearing fan, **32 bearings produce 3 distinct longitudes** — −90, 0 and
90. Three meridians.

Both failures scan fewer directions than they report. Both therefore *overstate* the inradius. **Both
read as safe.** And `landmark-south-pole` sits at exactly −90.

Neither of us could have found the other's by inspection. A zero cross product and a collapsing
`atan2` share no code, no shape, and no fix. What they share is the symptom — so the symptom is what
is now asserted, in both repos: *the 32 bearings must reach 32 distinct positions.*

**The pair was asymmetric, and that matters more than the tidier story.** The fork's defect was live:
it was actively overstating the south pole. Mine was latent, because `fromLatLon(-90, 0)` leaves a
residual `cos(-90°) = 6.1e-17` that happens to be enough to define a direction — my 32 bearings did
reach 32 distinct positions, by luck. Forcing that residual to a true zero collapses all 32 onto one.

I had written, in the function itself: *"degenerate at the exact poles; no target sits there."* A
target sat there. The comment was a claim about the world stated as a claim about the code, and it was
true on the day it was written.

---

## The number that was wrong twice, in opposite directions

Capture is point-sampled once per tick, while self-collision is swept along the arc. So a capture
region smaller than the head's stride can be stepped clean over. Keeping the loss under 1% of the disc
requires `R ≥ 3.544 · d`, where `d` is the greatest distance the head travels in one tick.

`d` depends on a wind field, and the wind term was wrong twice.

**First, too low — from measuring.** I sampled the live field and got 3.18 °/s. It looked clean. It
was not: a longer sweep gave 4.53, another seed 5.005, and *the maximum kept climbing with sample
count*. A supremum over four sparse storms on a sphere is not something random sampling converges to.
Uniform scattering essentially never lands in an eyewall; my first sweep had only ever caught storm
edges. (It also had a harness bug — a fresh PRNG per tick, restarting the sequence so storms never
matured.) The fork measured 4.90 by the denser method and flagged mine as suspect, correctly.

**Then, too high — from algebra.** Bounding it analytically gave 5.73 °/s, and I combined that with
the fastest terrain multiplier (river, 1.18) to get `d` = 14.67 and a required floor of 52.0 km. I
told the fork the floor had failed.

It had not. The fork pointed out that `isWater` in [`core/world.ts`](../src/core/world.ts) is Ocean,
Shallow and **Lake** — River is not water — and gyres are gated on `isWater` at the sample point. **The
fastest terrain is exactly the terrain where a gyre cannot be present.** I had multiplied maxima that
cannot co-occur. The physical bound is `d` = 14.03 on ocean, requiring 49.7 km.

So the original 50 km floor cleared the real bound by 300 metres. It passed — by a margin smaller than
the error bars on any of the numbers that produced it.

Both errors produced a figure that survived review, and they are not one mistake with two signs:

> **Sampling cannot find a supremum. Algebra cannot know what is reachable.**

That is the reason to compute a number by both routes, and it is a better reason than a general
preference for redundancy, because it says *which two* and *why*.

Independently derived, the two sides landed on `d` = 14.03 and 14.04, and wind supremums of 5.730 and
5.745 — agreement to 0.1% and 0.3%.

---

## What changed

- **Capture is `country OR radius`**, never one instead of the other. A country rule still means "you
  were in the country"; the radius adds a disc around the representative point, which for anywhere
  larger than the disc lies entirely inside the country and changes nothing.
- **[`tools/validate-capture.mjs`](../tools/validate-capture.mjs)** measures the inradius for all 407
  targets on every build and in CI, so a broken location cannot deploy. It was confirmed to fail on the
  old code *before* being trusted — it reported all 32.
- **The floor is not a remembered number.** The test re-derives the tunnelling bound each run from the
  variant configs, the terrain table and `isWater` membership, takes a max over physically reachable
  terrain/wind combinations, and fails if the floor drops below it. It refuses to assume a speed when a
  config will not parse, rather than falling back on a default that is only safe by coincidence.
- **The floor is 55 km, declared as margin rather than arithmetic** — the honest basis, given five
  feel-tuned multipliers and an analytic field.
- **The test reads its own source back** and fails if the capture rule is reverted or its transcribed
  constants drift. That guard exists because my copy of one constant went stale *inside the commit that
  introduced it*.

---

## A note on who can catch what

The "three meridians" figure above has its own history, and it is the eighth instance of the pattern
this document describes — the first one *inside* the document.

When first published, that sentence read "their 32 bearings became three meridians." The fork's
measurement at the time was **six** bearings collapsing to three longitudes. Thirty-two was my
extrapolation of their result, written as if it were their result, and it made the defect sound worse
than the evidence showed. I caught it on a re-read and corrected it in place, naming the original
claim rather than swapping it silently. The fork then measured the full fan and found the
extrapolation was, in fact, exactly right — which is the least interesting thing about it. **A claim
being true does not make it supported**, and "I guessed and got away with it" is not a defence worth
having in a document about numbers that survive review.

The part worth generalising is theirs. The fork had reviewed that document, specifically to check
whether their half was represented fairly, read the sentence containing the inflated number, and
approved it. They were the only person with the data to catch it — it was their measurement — and
they did not, because they were scanning for unfairness *against* them rather than overstatement *in
their favour*.

> **A reviewer of an account of their own errors is systematically the wrong person to catch a number
> that flatters them, and systematically the only one who has the data to.**

Which is the same shape as everything else here: the check was real, competently performed, and
pointed at a slightly different question than the one that mattered.

## What this does not show

Two implementations, one investigation. The pairs were found because two parties were talking, not by
any systematic method — nobody set out to look for a polar degeneracy. Both codebases descend from a
common ancestor, so "nothing in common" describes these particular functions, not the projects.

And the arrangement only works while the independence is real. If the fixtures are regenerated from a
shared helper, or the two methods are reconciled until they agree, the second opinion quietly becomes a
mirror. The fork proposed keeping their superseded 8-direction scanner alive next to the new one for
exactly this reason, before either of us had the evidence above.

The practical form of all this is short: **when a second route disagrees, the disagreement is the
finding.** Every error here was caught that way, and not one by looking harder at the first number.
