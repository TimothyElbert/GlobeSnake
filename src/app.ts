import {
  ACESFilmicToneMapping, Scene, SRGBColorSpace, Texture, TextureLoader, Vector3, WebGLRenderer,
} from 'three';
import { GameLoop, todaySeed } from '@core/loop';
import { InputManager } from '@core/input';
import { RELIEF_SCALE, WorldData, type Terrain } from '@core/world';
import { DEFAULT_SNAKE_CONFIG, type SnakeConfig } from '@core/snake';
import { Globe, type GlobeOptions } from '@render/globe';
import { SnakeRibbon, type RibbonOptions } from '@render/snakeRibbon';
import { ChaseCamera } from '@render/chaseCamera';
import { SnakeHead, Starfield, TargetPin } from '@render/props';
import { Session, type GameMode } from '@game/session';
import { dayKey, submit as submitRecord } from '@game/records';
import type { Deck, TargetRecord } from '@game/targets';
import { Hud } from '@ui/hud';
import { Minimap } from '@ui/minimap';
import {
  LoadingScreen, PauseScreen, StartScreen, SummaryScreen, type VariantChrome,
} from '@ui/screens';
import { baseUrl, el } from '@ui/dom';
import { GameAudio } from '@audio/audio';
import t12 from '@data/targets.t12.json';
import t35 from '@data/targets.t35.json';

/**
 * The shell all three worlds are built on.
 *
 * Every variant is the same simulation with different rules and a different
 * skin — that is the whole reason there can be three of them at this quality.
 * Variants hook in through `onSetup` / `onFixed` / `onRender` and by overriding
 * config; nothing below needs to know which world it is running.
 */

export interface AppContext {
  scene: Scene;
  renderer: WebGLRenderer;
  camera: ChaseCamera;
  globe: Globe;
  ribbon: SnakeRibbon;
  world: WorldData;
  session: Session;
  hud: Hud;
  audio: GameAudio;
  input: InputManager;
  /** Seconds since the page loaded. */
  time: number;
}

export interface VariantConfig {
  id: string;
  chrome: VariantChrome;
  snake?: Partial<SnakeConfig>;
  globe?: GlobeOptions;
  ribbon?: RibbonOptions;
  /** Terra Incognita stops the hint ladder before the exact pin. */
  maxHintLevel?: number;
  hintNames?: string[];
  starBrightness?: number;
  /** Terra Incognita: record how much of the globe the player uncovered. */
  trackExploration?: boolean;
  /**
   * Vertical exaggeration used by everything that must sit on the ground.
   * Must match `globe.relief`, or the snake floats above the terrain (or sinks
   * into it) by exactly the difference.
   */
  relief?: number;
  /** Fraction of a day per second for the terminator. 0 freezes the sun. */
  sunSpeed?: number;
  defaultDeck?: Deck;
  onSetup?: (ctx: AppContext) => void;
  onFixed?: (ctx: AppContext, dt: number) => void;
  onRender?: (ctx: AppContext, dt: number) => void;
  onCapture?: (ctx: AppContext) => void;
  onReset?: (ctx: AppContext) => void;
}

const ALL_TARGETS = [...(t12 as TargetRecord[]), ...(t35 as TargetRecord[])];

/** Stable per-world salt so each world's daily is a different puzzle. */
function variantSalt(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export async function bootstrap(config: VariantConfig): Promise<void> {
  const loading = new LoadingScreen(config.chrome.name);

  let world: WorldData;
  let day: Texture;
  let night: Texture;
  try {
    loading.progress(0.1, 'reading the world');
    world = await WorldData.load(baseUrl());
    loading.progress(0.55, 'unrolling the map');
    const loader = new TextureLoader();
    [day, night] = await Promise.all([
      loader.loadAsync(`${baseUrl()}textures/earth_day.jpg`),
      loader.loadAsync(`${baseUrl()}textures/earth_night.jpg`),
    ]);
    day.colorSpace = SRGBColorSpace;
    night.colorSpace = SRGBColorSpace;
    day.anisotropy = 8;
    loading.progress(0.85, 'lighting the stars');
  } catch (err) {
    loading.fail(`Could not load world data — ${(err as Error).message}`);
    console.error(err);
    return;
  }

  const canvas = el('canvas');
  document.body.append(canvas);

  const renderer = new WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
    stencil: false,
    // Only in dev: toDataURL needs the back buffer to survive past the draw
    // call, and it costs real memory bandwidth, so production never pays for it.
    preserveDrawingBuffer: import.meta.env.DEV,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.94;
  renderer.outputColorSpace = SRGBColorSpace;

  const scene = new Scene();
  const globe = new Globe(world, day, night, config.globe);
  // The drawn body and the lethal body are the same object, so the ribbon's
  // half-width is *derived* from the collision radius rather than tuned next to
  // it. A snake that looks fatter than it kills — or thinner — is the kind of
  // unfairness players correctly never forgive.
  const collisionRadiusDeg = config.snake?.collisionRadiusDeg ?? DEFAULT_SNAKE_CONFIG.collisionRadiusDeg;
  const ribbon = new SnakeRibbon({
    width: collisionRadiusDeg * (Math.PI / 180),
    ...config.ribbon,
  });
  const head = new SnakeHead();
  // Two pins, not one. The hint pin is owned by applyHints and is cleared every
  // frame the hint level says it should not be visible; sharing it with the
  // capture flash meant the capture marker was erased the instant it appeared.
  const pin = new TargetPin();
  const capturePin = new TargetPin(0x6cf0b4, 0.075);
  let captureFlash = 0;
  const stars = new Starfield(config.starBrightness ?? 1);
  scene.add(stars.mesh, globe.mesh, ribbon.mesh, head.group, pin.mesh, capturePin.mesh, globe.atmosphere);

  const camera = new ChaseCamera(window.innerWidth / window.innerHeight);
  const input = new InputManager(canvas, camera.camera);
  const audio = new GameAudio();

  const hud = new Hud({
    maxHintLevel: config.maxHintLevel,
    hintNames: config.hintNames,
    onMute: () => toggleMute(),
  });
  hud.mount();
  hud.setVisible(false);
  hud.setMuted(audio.muted);
  hud.onHintClick(() => { void audio.ensureStarted(); takeHint(); });

  function toggleMute(): void {
    void audio.ensureStarted();
    const m = audio.toggleMute();
    hud.setMuted(m);
    hud.showMessage(m ? 'Muted' : 'Sound on', 1100);
  }

  const minimap = new Minimap(world);
  hud.minimapSlot.append(minimap.canvas);

  let session: Session | null = null;
  let ctx: AppContext | null = null;
  let deck: Deck = config.defaultDeck ?? 'standard';
  let mode: GameMode = 'endless';
  let time = 0;
  let lowQuality = false;
  // Whatever the globe is displacing by, the snake, camera and pins must use
  // the same number or they will not touch the ground.
  const reliefScale = config.relief ?? RELIEF_SCALE;

  // Persisted view preferences. Borders default ON: this is a game about
  // recognising countries, and a player who cannot see where one ends is being
  // asked to do it with a hand tied.
  const pref = <T,>(key: string, fallback: T): T => {
    try {
      const raw = localStorage.getItem(`globesnake:pref:${key}`);
      return raw === null ? fallback : (JSON.parse(raw) as T);
    } catch { return fallback; }
  };
  const setPref = (key: string, value: unknown): void => {
    try { localStorage.setItem(`globesnake:pref:${key}`, JSON.stringify(value)); } catch { /* private mode */ }
  };

  camera.setZoom(pref('zoom', camera.zoom));
  // Always on. Knowing which country you are in is the game's core readout, and
  // a border you have to remember to switch on is a border most people never see.
  globe.setBorders(true);
  audio.loadPreference();

  // --- screens --------------------------------------------------------------

  const start = new StartScreen(
    config.chrome,
    (choice) => {
      mode = choice.mode;
      deck = choice.deck;
      start.hide();
      void audio.ensureStarted();
      beginRun();
    },
    (style) => { void audio.ensureStarted(); audio.setMusicStyle(style); },
    audio.musicStyle,
  );
  start.mount();

  const pause = new PauseScreen(
    () => { pause.hide(); session && (session.phase = 'playing'); },
    () => { pause.hide(); beginRun(); },
  );
  pause.mount();

  const summary = new SummaryScreen(world, () => { summary.hide(); beginRun(); }, () => {
    summary.hide();
    hud.setVisible(false);
    start.show();
  });
  summary.mount();

  // --- touch affordances ----------------------------------------------------

  const touch = el('div', { class: 'touch-controls' }, [
    el('button', {
      class: 'touch-btn', type: 'button', text: 'HINT',
      onclick: () => session && takeHint(),
    }),
  ]);
  hud.root.append(touch);

  // --- run lifecycle --------------------------------------------------------

  function beginRun(): void {
    // The fleet belongs to the Session, so it is rebuilt every run and has to
    // be re-parented into the scene each time. Without this the ships were
    // simulated, collidable and drawn on the minimap while being completely
    // absent from the globe — which read as "ships are invisible" rather than
    // "ships were never in the scene graph".
    if (session) scene.remove(session.ships.group);

    // Salt the daily seed with the world, so the three of them are three
    // different puzzles on the same date — otherwise finding Nauru in
    // Expedition would hand you the answer in Tempest and Terra as well.
    const seed = mode === 'daily' || mode === 'tour'
      ? (todaySeed() ^ variantSalt(config.id) ^ (mode === 'tour' ? 0x54_4f_55_52 : 0)) >>> 0
      : undefined;

    // Only the Grand Tour keeps an indelible line, and only there does the
    // ribbon's dried-ink treatment make sense.
    const permanent = mode === 'tour';
    ribbon.setDrying(permanent);

    session = new Session(world, ALL_TARGETS, {
      mode, deck, seed,
      snake: permanent
        ? { ...config.snake, trailMode: 'permanent', growthPerCaptureDeg: 0 }
        : config.snake,
      maxHintLevel: config.maxHintLevel,
      trackExploration: config.trackExploration,
    });
    ctx = { scene, renderer, camera, globe, ribbon, world, session, hud, audio, input, time };
    scene.add(session.ships.group);

    session.setEvents({
      onTarget: (t, i) => {
        hud.setTarget(t, i, mode === 'daily' ? session!.dailyTotal : 0);
        globe.clearHints();
        pin.setOpacity(0);
      },
      onCapture: (e) => {
        hud.showCapture(e);
        audio.capture(e.target.tier, session!.streak);
        capturePin.setPosition(
          e.target.position,
          world.reliefAt(e.target.position) * reliefScale + 0.005,
        );
        captureFlash = 2.2;
        config.onCapture?.(ctx!);
      },
      onHint: (level, cost) => {
        hud.showHintTaken(level, cost);
        audio.hint(cost === 0);
      },
      onShip: (_p, refillSeconds) => { hud.showShip(refillSeconds); audio.ship(); },
      onDeath: () => { audio.death(); window.setTimeout(showSummary, 900); },
      onFinish: () => { window.setTimeout(showSummary, 700); },
    });

    session.start();
    globe.setBorders(true);
    camera.reset(
      session.snake.position,
      session.snake.heading,
      world.reliefAt(session.snake.position) * reliefScale,
    );
    hud.clearToasts();
    hud.setVisible(true);
    hud.setTourVisible(mode === 'tour');
    audio.revive();
    config.onReset?.(ctx);
  }

  function showSummary(): void {
    if (!session) return;
    // Records are written once, here, so a run cannot be banked twice by
    // reopening the summary.
    submitRecord({
      variant: config.chrome.name,
      mode, deck,
      day: mode === 'daily' || mode === 'tour' ? dayKey() : '',
      score: session.score,
      found: session.log.length,
      seconds: session.elapsed,
      completed: session.tourCompleted,
      explored: session.exploredFraction,
      hints: session.log.filter((e) => e.hintLevel > 0).length,
      distanceKm: session.snake.distanceTravelledKm,
    });
    summary.show({
      variant: config.chrome.name,
      mode, deck,
      died: session.phase === 'dead',
      score: session.score,
      log: session.log,
      elapsed: session.elapsed,
      distanceKm: session.snake.distanceTravelledKm,
      traceLat: session.traceLat,
      traceLon: session.traceLon,
      traceClimate: session.traceClimate,
      explored: session.exploredFraction,
      completed: session.tourCompleted,
    });
  }

  function takeHint(): void {
    if (!session || session.phase !== 'playing') return;
    session.requestHint();
  }

  // --- input wiring ---------------------------------------------------------

  input.on('hint', () => { void audio.ensureStarted(); takeHint(); });
  input.on('pause', () => {
    if (!session) return;
    if (summary.visible) return;
    if (session.phase === 'playing') { session.phase = 'paused'; pause.show(); }
    else if (session.phase === 'paused') { session.phase = 'playing'; pause.hide(); }
  });
  // R restarts, but only once a run is actually under way — pressing it while
  // the start sheet is up would skip the mode and difficulty choice entirely.
  input.on('restart', () => {
    if (session && start.root.hidden) { summary.hide(); pause.hide(); beginRun(); }
  });
  input.on('mute', () => toggleMute());
  input.on('zoomIn', () => { camera.nudgeZoom(-0.09); setPref('zoom', camera.zoomWanted); });
  input.on('zoomOut', () => { camera.nudgeZoom(0.09); setPref('zoom', camera.zoomWanted); });

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.resize(window.innerWidth / window.innerHeight);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && session?.phase === 'playing') { session.phase = 'paused'; pause.show(); }
  });

  // --- the hint overlays ----------------------------------------------------

  const _tan = new Vector3();
  function applyHints(s: Session): void {
    const level = s.hintLevel;
    if (!s.target || level === 0) { globe.clearHints(); pin.setOpacity(0); return; }

    if (level >= 1) {
      // Recomputed every frame: the wedge is cast from where you are *now*, so
      // it stays useful as you move rather than becoming a stale arrow.
      s.targetTangent(_tan);
      globe.setWedge(s.snake.position, _tan, Math.PI / 4, 1);
      const [lo, hi] = s.distanceBand();
      globe.setBand(s.snake.position, lo, hi, 1);
    }
    if (level >= 2) {
      globe.setRing(s.target.position, s.searchRadiusRad, 1);
      const country = s.highlightCountry;
      if (country > 0) globe.highlightCountry(country, 1);
    }
    if (level >= 3) {
      pin.setPosition(s.target.position, world.reliefAt(s.target.position) * reliefScale + 0.004);
      pin.setColor(0xffc94a);
      pin.setOpacity(1);
    }
  }

  // --- the loop -------------------------------------------------------------

  function fixedStep(dt: number): void {
    if (!session || !ctx) return;
    if (session.phase !== 'playing' && session.phase !== 'captured') return;
    const cfg = session.snake.cfg;
    const steer = input.sample(
      session.snake.position, session.snake.heading, 1,
      (cfg.turnRateDeg * Math.PI) / 180 * dt,
    );
    session.update(dt, steer);
    config.onFixed?.(ctx, dt);
  }

  const loop = new GameLoop(
    fixedStep,
    (_alpha, frameDt) => {
      time += frameDt;
      if (ctx) ctx.time = time;

      globe.setSunPhase(time * (config.sunSpeed ?? 1 / 360));
      globe.update(time);
      stars.update(time);
      pin.update(time);
      capturePin.update(time);
      if (captureFlash > 0) {
        captureFlash = Math.max(0, captureFlash - frameDt);
        capturePin.setOpacity(Math.min(1, captureFlash / 0.7));
      } else {
        capturePin.setOpacity(0);
      }

      if (session) {
        const s = session;
        const ground = world.reliefAt(s.snake.position) * reliefScale;
        ribbon.update(s.snake, globe.sun, time);
        head.update(s.snake.position, s.snake.heading, s.snake.surface.climate, ground + 0.0035, time);
        head.setEyeGlow(s.snake.wake.active);
        camera.update(s.snake.position, s.snake.heading, frameDt, s.snake.speedScale, ground);
        applyHints(s);

        if (s.phase === 'playing' || s.phase === 'captured') {
          hud.update(s);
          minimap.update(
            frameDt, s.snake.position, s.snake.heading, s.snake,
            s.hintLevel >= 2 && s.target ? s.target.position : null,
            (fn) => s.ships.forEachAlive(fn),
          );
          audio.updateAmbience(
            s.snake.surface.terrain as Terrain,
            s.snake.speedScale,
            s.snake.wake.charge,
          );
          const prox = s.snake.proximityDeg();
          const danger = prox < s.snake.cfg.collisionRadiusDeg * 3.2
            ? 1 - prox / (s.snake.cfg.collisionRadiusDeg * 3.2) : 0;
          audio.proximity(danger);
        }
      }

      if (ctx) config.onRender?.(ctx, frameDt);

      // Quality fallback. One-way on purpose: flipping back and forth as the
      // frame rate hovers around the threshold is worse than either state.
      if (!lowQuality && loop.fps < 34 && time > 6) {
        lowQuality = true;
        globe.setQuality(renderer, true);
        stars.setBrightness(0.6);
      }

      renderer.render(scene, camera.camera);
    },
  );

  if (config.onSetup) {
    ctx = { scene, renderer, camera, globe, ribbon, world, session: session!, hud, audio, input, time };
    config.onSetup(ctx);
  }

  // Dev-only handle so the simulation can be driven and inspected without a
  // renderer — headless browsers never fire requestAnimationFrame, and the
  // physics deserves to be testable independently of anything being on screen.
  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__gs = {
      get session() { return session; },
      world, globe, camera, ribbon, loop, config, scene, renderer, canvas, audio, hud,
      beginRun,
      /**
       * Advance and render `seconds` of game time synchronously, then return a
       * JPEG data URL. Headless browsers never fire requestAnimationFrame, so
       * without this the renderer is completely unobservable — and "it compiles"
       * is not the same claim as "the planet is on screen".
       */
      capture(seconds = 0, w = 640, h = 360, quality = 0.72) {
        const steps = Math.round(seconds * 120);
        for (let i = 0; i < steps; i++) fixedStep(1 / 120);
        const prevW = renderer.domElement.width;
        const prevH = renderer.domElement.height;
        renderer.setSize(w, h, false);
        camera.resize(w / h);
        loop.renderFrame(0, seconds > 0 ? seconds : 1 / 60);
        const url = renderer.domElement.toDataURL('image/jpeg', quality);
        renderer.setSize(prevW, prevH, false);
        camera.resize(prevW / prevH);
        return url;
      },
      /** Capture and POST straight to disk via the dev screenshot sink. */
      async shot(name: string, seconds = 0, w = 1000, h = 600) {
        const data = (this as { capture(s: number, w: number, h: number, q: number): string })
          .capture(seconds, w, h, 0.9);
        const res = await fetch('/__shot', {
          method: 'POST',
          body: JSON.stringify({ name, data }),
        });
        return res.json();
      },
      // Mirrors the real fixed-step callback, variant hook included — a harness
      // that skips onFixed would happily report that Tempest has no wind.
      step(n: number, turn = 0, boost = false, brake = false) {
        for (let i = 0; i < n; i++) {
          if (!session || !ctx) return;
          session.update(1 / 120, { turn, boost, brake });
          config.onFixed?.(ctx, 1 / 120);
        }
      },
    };
  }

  loading.progress(1, 'ready');
  loading.done();
  start.show();
  loop.start();
}
