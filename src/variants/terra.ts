import '@ui/styles.css';
import { Vector3 } from 'three';
import { bootstrap, type AppContext } from '../app';
import { InkMap } from './inkMap';

/**
 * TERRA INCOGNITA — the contemplative world.
 *
 * A blank vellum globe and a pen for a snake. Travelling inks the world in
 * behind you: coastlines darken, land takes a sepia wash, mountains grow
 * hachures.
 *
 * Two decisions define this variant, and both are refusals.
 *
 * **There is no fog of war.** Both council members killed it independently and
 * for the same reason: the game *is* "find Paris", so hiding the map converts a
 * geography test into a random walk. Coastlines are always faintly embossed on
 * the vellum. What travel changes is how *finished* the map is, not whether you
 * can navigate at all.
 *
 * **There is no exact-pin hint.** The ladder stops at a bearing and a range —
 * dead reckoning, the way it was actually done. This is how the variant earns
 * its difficulty honestly, instead of by blinding you.
 *
 * And here, alone among the three, the trail is *permanent*. An indelible line
 * is the entire fiction, so the map you draw is also the maze you must survive.
 */

let ink: InkMap | null = null;
let lastStamp = new Vector3(1, 0, 0);
let stampAccum = 0;

void bootstrap({
  id: 'terra',
  chrome: {
    name: 'Terra Incognita',
    tagline: 'Draw it yourself',
    short: 'A blank globe, a pen for a snake, and no coastlines until you have been there.',
    blurb:
      'A globe of blank vellum and a snake that is really a pen. Nothing is drawn until you go there: ' +
      'coastlines, washes and hachures appear only along the ground you have covered, so finding your ' +
      'bearings is the game rather than a preliminary to it. There is no pin here either — only a ' +
      'bearing, a distance, and your nerve. Take the Grand Tour if you want the line to stop lifting.',
    rules: [
      'You start on blank vellum. Coastlines only appear where you have travelled, so finding your bearings *is* the game.',
      'Nothing tells you where you are — no country readout, and the inset globe is fogged like the world. Only your own map, as far as you have drawn it.',
      'Hints give bearing and range only. No search circle, no pin, no shortcut to the answer.',
      'How much of the planet you uncovered is recorded separately from your score — a big score in one corner is a different run from a small one that crossed an ocean.',
      'Grand Tour is the hard one: twenty places named up front, any order you like, and a line that never lifts.',
    ],
    hintNames: ['Bearing & range', 'Tighter bearing'],
  },
  maxHintLevel: 2,
  hintNames: ['Bearing & range', 'Tighter bearing'],
  trackExploration: true,
  hideLocation: true,

  // Slower and more deliberate: this world is for thinking, and a permanent
  // trail punishes a wandering line far more than a vacating tail does.
  // A normal, vacating tail. The indelible line moved to the Grand Tour, where
  // knowing the whole list up front is what makes an unforgiving trail a
  // planning problem rather than an ambush.
  snake: {
    baseSpeedDeg: 3.1,
    turnRateDeg: 105,
    startBodyDeg: 9,
    capacity: 40000,
  },
  globe: {
    parchment: true,
    graticule: 0,
    atmosphere: 0.42,
    atmosphereColor: 0xc9a97a,
    segments: [256, 128],
    // A flat globe, *and* a flat shading normal. Zeroing the displacement alone
    // was not enough: the vertex shader still bent the normal by the height
    // gradient, so blank vellum was hill-shaded and every continent showed
    // through the fog as a relief map. Both have to go, or this world quietly
    // hands you the thing it is meant to make you go and find.
    relief: 0,
    reliefNormal: 0,
  },
  relief: 0,
  ribbon: {
    rimColor: 0x8a6a45,
    scalePitch: 1400,
    maxNodes: 40000,
    // The last ~12° of arc is the pen; everything older has dried into map.
    // Full width throughout — the drawn line and the lethal line are the same
    // line, and narrowing the old part was quietly killing people in gaps that
    // looked clear.
    dryAfterNodes: 100,
    dryFadeNodes: 70,
    dryColor: 0x5a3d22,
  },
  starBrightness: 0.35,
  sunSpeed: 0,
  defaultDeck: 'standard',

  onSetup(ctx: AppContext) {
    ink = new InkMap();
    ink.clear(ctx.renderer);
    ctx.globe.setInkTexture(ink.texture);
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__ink = ink;
  },

  onReset(ctx) {
    ink?.clear(ctx.renderer);
    stampAccum = 0;
    lastStamp.copy(ctx.session ? ctx.session.snake.position : new Vector3(1, 0, 0));
  },

  onRender(ctx, dt) {
    if (!ink || !ctx.session) return;
    const head = ctx.session.snake.position;

    // Stamp along the path rather than once per frame: at 60 fps the head can
    // move further than the nib is wide, which would leave a dotted line.
    stampAccum += dt;
    const moved = Math.acos(Math.max(-1, Math.min(1, head.dot(lastStamp)))) * (180 / Math.PI);
    if (moved > 0.35 || stampAccum > 0.12) {
      const steps = Math.max(1, Math.min(8, Math.ceil(moved / 0.35)));
      for (let i = 1; i <= steps; i++) {
        _lerp.copy(lastStamp).lerp(head, i / steps).normalize();
        // A modest wash and a decisive line. The first cut used a very wide,
        // very soft nib, which left a half-inked smudge rather than a drawn
        // map — partial reveal reads as a stain, not as cartography.
        ink.stamp(ctx.renderer, _lerp, 4.5, 0.30);
        ink.stamp(ctx.renderer, _lerp, 1.4, 0.5);
      }
      lastStamp.copy(head);
      stampAccum = 0;
    }
  },

  onCapture(ctx) {
    // A capture is a survey point: it inks a generous region around itself, so
    // the finished map is a chain of well-drawn places joined by thin routes.
    if (!ink || !ctx.session?.target) return;
    for (let i = 0; i < 3; i++) {
      ink.stamp(ctx.renderer, ctx.session.target.position, 13 - i * 3.5, 0.16);
    }
  },
});

const _lerp = new Vector3();
