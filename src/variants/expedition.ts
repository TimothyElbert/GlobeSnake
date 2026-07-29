import '@ui/styles.css';
import { bootstrap } from '../app';

/**
 * EXPEDITION — the canonical world.
 *
 * NASA's Blue Marble, a real atmosphere, city lights on the night side, and the
 * full rule set with nothing removed or exaggerated. This is the one that has
 * to be *finished* before either of the others is allowed to exist, because the
 * failure mode both council members ranked first was three impressive
 * prototypes and no game.
 */
void bootstrap({
  id: 'expedition',
  chrome: {
    name: 'Expedition',
    tagline: 'The canonical world',
    short: 'The real Earth, played straight. Start here.',
    blurb:
      'A snake crawling on the real Earth. You are given a place — a country, a city, a landmark, ' +
      'sometimes only a flag — and you have to get your head there before the clock eats the points. ' +
      'The ground fights back: mountains slow you, rivers carry you, ice takes your momentum and keeps it. ' +
      'And your own body is getting longer with every find.',
    rules: [
      'Terrain changes your speed. Crossing the Andes is slower than going round them — sometimes.',
      'Draft your own body at close range for a speed surge, and a bright line down your spine.',
      'Swallow a cargo ship to refill your boost. It pays in fuel, never in points.',
      'Stuck for twice the par time? The first hint arrives on its own, and it costs nothing.',
    ],
  },
  sunSpeed: 1 / 420,
});
