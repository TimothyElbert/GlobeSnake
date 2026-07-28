import '@ui/styles.css';
import { Vector3 } from 'three';
import { mulberry32 } from '@core/loop';
import { bootstrap, type AppContext } from '../app';
import { StormSprites, WindField, WindStreaks } from './weather';

/**
 * TEMPEST — the same Earth, with the atmosphere switched on.
 *
 * The council split here. Fable wanted it and called riding a jet stream the
 * trailer moment; Sol wanted it killed because currents that shove the player
 * make deaths feel arbitrary. Both are right about different games, and the
 * difference between them is *visibility*. So the wind here is drawn — fourteen
 * hundred streamlines over the visible hemisphere, storms as spirals you can
 * see from a continent away — and it never touches your steering, only your
 * position. Being carried somewhere is then a navigation problem you can read
 * in advance, which is the only version of this idea worth building.
 */

let field: WindField | null = null;
let streaks: WindStreaks | null = null;
let storms: StormSprites | null = null;
let rng = mulberry32(0x5eed);
const wind = new Vector3();

void bootstrap({
  id: 'tempest',
  chrome: {
    name: 'Tempest',
    tagline: 'The wind takes a side',
    short: 'The same planet with the atmosphere switched on — ride the jet streams.',
    blurb:
      'The same planet, alive with weather. Rivers of air run east along the jet streams; the great ocean ' +
      'gyres turn beneath you; hurricanes wander the tropics with real teeth. Every current is drawn on the ' +
      'globe before it reaches you, so the wind is a road you choose — a following jet will throw you across ' +
      'an ocean, and a headwind will make you earn every degree.',
    rules: [
      'Jet streams run eastward near 32° and 58° in both hemispheres. Find one and let go.',
      'Trade winds push west across the tropics. Going east down there is the long way round.',
      'Storms spin hard near the eyewall and pull gently inward. Cutting the edge is fast; the centre is not.',
      'Wind moves you. It never steers for you — your controls stay yours the whole way.',
    ],
  },
  // A little more speed and a little more agility: the air is doing some of
  // the work, so the snake needs the authority to argue with it.
  snake: { baseSpeedDeg: 3.9, turnRateDeg: 150, boostCapacity: 4.0 },
  globe: { nightLift: 0.30, saturation: 1.1, atmosphere: 1.45 },
  ribbon: { rimColor: 0x8ce9ff },
  starBrightness: 0.85,
  sunSpeed: 1 / 300,

  onSetup(ctx: AppContext) {
    field = new WindField(ctx.world);
    streaks = new WindStreaks(field);
    storms = new StormSprites();
    ctx.scene.add(streaks.lines);
    for (const m of storms.meshes) ctx.scene.add(m);
    field.reset(rng);
  },

  onReset() {
    rng = mulberry32(0x5eed);
    field?.reset(rng);
  },

  onFixed(ctx, dt) {
    if (!field) return;
    field.update(dt, rng);
    // Sample once per tick at the head and hand it to the stepper, which
    // advects position and parallel-transports the heading.
    field.sample(ctx.session.snake.position, wind);
    ctx.session.snake.wind.copy(wind);
  },

  onRender(ctx, dt) {
    if (!field || !streaks || !storms) return;
    streaks.update(dt, ctx.session ? ctx.session.snake.position : new Vector3(1, 0, 0), rng);
    storms.update(field.storms, ctx.time);
  },
});
