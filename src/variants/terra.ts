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
    blurb:
      'A globe of blank vellum, faintly embossed with coastlines, and a snake that is really a pen. ' +
      'Everywhere you travel the world inks itself in behind you — washes, hachures, a darkening shore. ' +
      'The line never dries and never fades: by the end of a long run the map you have drawn is also the ' +
      'maze you have to survive. And there is no pin here. Only a bearing, a distance, and your nerve.',
    rules: [
      'Your trail is permanent. Nothing you draw ever goes away — plan the whole run, not the next minute.',
      'Hints give bearing and range only. No search circle, no pin, no shortcut to the answer.',
      'Coastlines are always visible. You are drawing the world, not discovering whether it exists.',
      'The map keeps what you drew. Your best route card is the one worth framing.',
    ],
    hintNames: ['Bearing & range', 'Tighter bearing'],
  },
  maxHintLevel: 2,
  hintNames: ['Bearing & range', 'Tighter bearing'],

  // Slower and more deliberate: this world is for thinking, and a permanent
  // trail punishes a wandering line far more than a vacating tail does.
  snake: {
    baseSpeedDeg: 3.1,
    turnRateDeg: 120,
    trailMode: 'permanent',
    startBodyDeg: 6,
    // Irrelevant under `permanent`: nothing is ever released, so the body is
    // simply everywhere you have been.
    growthPerCaptureDeg: 0,
    // Matched to the ribbon's vertex budget below — the drawn body and the
    // lethal body must be the same object, or you die to something invisible.
    // 40,000 nodes is roughly thirteen laps of the planet, or ~25 minutes.
    capacity: 40000,
  },
  globe: {
    parchment: true,
    graticule: 0,
    atmosphere: 0.42,
    atmosphereColor: 0xc9a97a,
    segments: [256, 128],
  },
  ribbon: { rimColor: 0x8a6a45, width: 0.0072, scalePitch: 1400, maxNodes: 40000 },
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
        // A wide soft nib for the wash, a tight dark one for the line itself.
        ink.stamp(ctx.renderer, _lerp, 5.5, 0.10);
        ink.stamp(ctx.renderer, _lerp, 1.6, 0.30);
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
