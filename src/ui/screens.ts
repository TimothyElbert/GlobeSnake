import { dailyNumber } from '@core/loop';
import type { MusicStyle } from '@audio/audio';
import { collect } from '@game/records';
import { formatClock, formatScore } from '@game/scoring';
import type { RunLogEntry, GameMode } from '@game/session';
import type { Deck } from '@game/targets';
import { DECKS } from '@game/targets';
import type { WorldData } from '@core/world';
import { clearChildren, el } from './dom';
import { copyToClipboard, renderShareCard, shareText, type ShareData } from './shareCard';

/**
 * Full-screen overlays: the start sheet, pause, and the run summary.
 *
 * Difficulty is a *choice* here, never a silent judgement. The game adapts
 * within the deck you pick, but it will not decide behind your back that you
 * are a beginner — being quietly demoted is the fastest way to make someone
 * stop playing.
 */

export interface StartChoice {
  mode: GameMode;
  deck: Deck;
}

export interface VariantChrome {
  name: string;
  tagline: string;
  /** One line, always visible above the tabs. */
  short?: string;
  blurb: string;
  /** Extra lines describing what this variant changes. */
  rules?: string[];
  hintNames?: string[];
}

const MUSIC_INFO: Record<MusicStyle, { label: string; desc: string }> = {
  score: {
    label: 'Score',
    desc: 'A slow generative piece that retunes to the ground under the snake. Synthesised live, so it reacts.',
  },
  drone: {
    label: 'Drone',
    desc: 'The original sustained pad — no melody, no movement. Better for concentrating.',
  },
  off: { label: 'Off', desc: 'No music. Sound effects still play unless you mute.' },
};

const MODE_INFO: Record<GameMode, { label: string; desc: string }> = {
  endless: {
    label: 'Expedition',
    desc: 'Play until your own body catches you. The world gets more obscure the better you do.',
  },
  daily: {
    label: 'Daily Run',
    desc: 'Ten targets, one at a time, the same ten for everyone in this world today.',
  },
  relay: {
    label: 'Relay',
    desc: 'Two minutes on the clock. Every find buys you eight more seconds. It never gets easier.',
  },
  tour: {
    label: 'Grand Tour',
    desc: 'Twenty places, named up front, in any order you like — on a line that never lifts. Ranked on how fast you finish.',
  },
};

function storageKey(variant: string, mode: GameMode, deck: Deck): string {
  return `globesnake:${variant}:${mode}:${deck}:best`;
}

export function readBest(variant: string, mode: GameMode, deck: Deck): number {
  try {
    return Number(localStorage.getItem(storageKey(variant, mode, deck)) ?? 0) || 0;
  } catch {
    return 0;
  }
}

export function writeBest(variant: string, mode: GameMode, deck: Deck, score: number): boolean {
  try {
    const key = storageKey(variant, mode, deck);
    const prev = Number(localStorage.getItem(key) ?? 0) || 0;
    if (score > prev) {
      localStorage.setItem(key, String(score));
      return true;
    }
  } catch { /* private browsing; scores just do not persist */ }
  return false;
}

export class StartScreen {
  readonly root: HTMLElement;
  private mode: GameMode = 'endless';
  private deck: Deck = 'standard';
  private readonly modeButtons = new Map<GameMode, HTMLElement>();
  private readonly deckButtons = new Map<Deck, HTMLElement>();
  private readonly musicButtons = new Map<MusicStyle, HTMLElement>();
  private readonly tabs = new Map<string, { tab: HTMLElement; panel: HTMLElement }>();
  private recordsPanel!: HTMLElement;
  private sensitivityValue!: HTMLElement;
  private readonly bestLine: HTMLElement;
  private music: MusicStyle = 'score';
  private sensitivity = 1;

  constructor(
    private readonly chrome: VariantChrome,
    private readonly onPlay: (choice: StartChoice) => void,
    private readonly onMusic?: (style: MusicStyle) => void,
    music: MusicStyle = 'score',
    private readonly onSensitivity?: (value: number) => void,
    sensitivity = 1,
  ) {
    this.music = music;
    this.sensitivity = sensitivity;
    this.bestLine = el('div', { class: 'stat-sub' });

    const modeGrid = el('div', { class: 'choices cols-2' });
    for (const m of ['endless', 'daily', 'relay', 'tour'] as GameMode[]) {
      const info = MODE_INFO[m];
      const btn = el('button', {
        class: 'choice',
        type: 'button',
        'aria-pressed': m === this.mode,
        onclick: () => this.selectMode(m),
      }, [
        el('div', {
          class: 'choice-title',
          text: m === 'daily' || m === 'tour' ? `${info.label} #${dailyNumber()}` : info.label,
        }),
        el('div', { class: 'choice-desc', text: info.desc }),
      ]);
      this.modeButtons.set(m, btn);
      modeGrid.append(btn);
    }

    const deckGrid = el('div', { class: 'choices cols-3' });
    for (const d of ['explorer', 'standard', 'expert'] as Deck[]) {
      const rule = DECKS[d];
      const btn = el('button', {
        class: 'choice',
        type: 'button',
        'aria-pressed': d === this.deck,
        onclick: () => this.selectDeck(d),
      }, [
        el('div', { class: 'choice-title', text: rule.label }),
        el('div', { class: 'choice-desc', text: rule.description }),
      ]);
      this.deckButtons.set(d, btn);
      deckGrid.append(btn);
    }

    const keyRow = (keys: string[], text: string) =>
      el('div', { class: 'key-row' }, [
        ...keys.map((k) => el('span', { class: 'keycap', text: k })),
        el('span', { text }),
      ]);

    // --- tab panels ---------------------------------------------------------
    const playPanel = el('div', { class: 'tab-panel' }, [
      el('h2', { text: 'Mode' }),
      modeGrid,
      el('h2', { text: 'Difficulty' }),
      deckGrid,
    ]);

    const worldPanel = el('div', { class: 'tab-panel', hidden: true }, [
      el('p', { class: 'lede', text: chrome.blurb }),
      ...(chrome.rules?.length
        ? [el('ul', { class: 'lede' }, chrome.rules.map((r) => el('li', { text: r })))]
        : []),
    ]);

    this.sensitivityValue = el('span', { class: 'slider-value', text: '1.00×' });
    const sensitivitySlider = el('input', {
      type: 'range', min: '0.35', max: '2.5', step: '0.05',
      value: String(this.sensitivity),
      class: 'slider',
      'aria-label': 'Steering sensitivity',
      oninput: (e: Event) => this.setSensitivity(Number((e.target as HTMLInputElement).value)),
    });

    const controlsPanel = el('div', { class: 'tab-panel', hidden: true }, [
      el('p', { class: 'lede', text:
        'Steer either way, whenever you like — the arrow keys turn, or the snake chases your cursor. ' +
        'Both are always live and the one you used last has control. Boost works from either.' }),

      el('h2', { text: 'Mouse sensitivity' }),
      el('div', { class: 'slider-row' }, [
        el('span', { class: 'slider-end', text: 'Smooth' }),
        sensitivitySlider,
        el('span', { class: 'slider-end', text: 'Sharp' }),
        this.sensitivityValue,
      ]),
      el('p', { class: 'lede', text:
        'How hard the snake chases the cursor. Low is calmer and easier to hold a line with; high ' +
        'snaps onto the cursor and makes threading a gap in your own body possible at speed. It ' +
        'cannot turn tighter than the snake physically can, whatever you set — and it does not ' +
        'affect the arrow keys, which always ask for a full turn.' }),

      el('h2', { text: 'Keys' }),
      el('div', { class: 'keys' }, [
        keyRow(['←', '→'], 'Turn'),
        keyRow(['↑'], 'Boost (costs stamina)'),
        keyRow(['Mouse'], 'Steer toward the cursor'),
        keyRow(['Hold'], 'Boost'),
        keyRow(['Space'], 'Hint — costs points from this target'),
        keyRow(['Wheel'], 'Zoom in and out'),
        keyRow(['Esc'], 'Pause'),
        keyRow(['M'], 'Mute'),
        keyRow(['R'], 'Restart'),
      ]),
    ]);

    this.recordsPanel = el('div', { class: 'tab-panel', hidden: true });

    const soundPanel = el('div', { class: 'tab-panel', hidden: true }, [
      el('h2', { text: 'Music' }),
      el('div', { class: 'choices cols-3' }, (['score', 'drone', 'off'] as MusicStyle[]).map((s) => {
        const btn = el('button', {
          class: 'choice', type: 'button', 'aria-pressed': s === this.music,
          onclick: () => this.selectMusic(s),
        }, [
          el('div', { class: 'choice-title', text: MUSIC_INFO[s].label }),
          el('div', { class: 'choice-desc', text: MUSIC_INFO[s].desc }),
        ]);
        this.musicButtons.set(s, btn);
        return btn;
      })),
      el('p', { class: 'lede', text: 'Sound effects follow the mute button in the corner, or M.' }),
    ]);

    const creditsPanel = el('div', { class: 'tab-panel', hidden: true }, [
      el('p', { class: 'lede', html:
        'Every asset here is public domain or permissively licensed, baked in at build time. ' +
        'Once the page has loaded, nothing here makes a network request of any kind — no backend, ' +
        'no account, no analytics, nobody counting you. Your records live only in this browser.' }),
      el('ul', { class: 'lede' }, [
        el('li', { html: 'Imagery and elevation — NASA Visible Earth: Blue&nbsp;Marble, Earth at Night, GEBCO_08. Public domain.' }),
        el('li', { html: 'Coastlines, borders, rivers, lakes, glaciers — Natural&nbsp;Earth. Public domain.' }),
        el('li', { html: 'Climate — Köppen-Geiger classification, Beck et&nbsp;al. (2018). CC&nbsp;BY&nbsp;4.0.' }),
        el('li', { html: 'Flags — flag-icons. MIT. Landmark silhouettes and country outlines drawn for this game.' }),
        el('li', { html: 'Engine — Three.js. MIT. Music and sound synthesised in the browser.' }),
      ]),
    ]);

    const panels: Record<string, HTMLElement> = {
      Play: playPanel,
      'This world': worldPanel,
      Controls: controlsPanel,
      Records: this.recordsPanel,
      Sound: soundPanel,
      Credits: creditsPanel,
    };

    const tabBar = el('div', { class: 'tabs', role: 'tablist' });
    for (const [name, panel] of Object.entries(panels)) {
      const tab = el('button', {
        class: 'tab', type: 'button', role: 'tab',
        'aria-selected': name === 'Play',
        onclick: () => this.selectTab(name),
      }, [name]);
      this.tabs.set(name, { tab, panel });
      tabBar.append(tab);
    }

    const sheet = el('div', { class: 'sheet panel' }, [
      el('div', { class: 'pill gold', text: chrome.tagline }),
      el('h1', { text: chrome.name }),
      el('p', { class: 'lede', text: chrome.short ?? chrome.blurb }),
      tabBar,
      ...Object.values(panels),
      el('div', { class: 'btn-row' }, [
        el('button', { class: 'btn', type: 'button', text: 'Begin', onclick: () => this.play() }),
        el('a', { class: 'btn ghost', href: '../', text: 'All three worlds' }),
        this.bestLine,
      ]),
    ]);

    this.root = el('div', { class: 'overlay' }, [sheet]);
    this.refreshBest();
  }

  private selectTab(name: string): void {
    for (const [key, { tab, panel }] of this.tabs) {
      const on = key === name;
      tab.setAttribute('aria-selected', String(on));
      panel.hidden = !on;
    }
    if (name === 'Records') this.renderRecords();
  }

  private setSensitivity(v: number): void {
    this.sensitivity = v;
    this.sensitivityValue.textContent = `${v.toFixed(2)}×`;
    this.onSensitivity?.(v);
  }

  private selectMusic(s: MusicStyle): void {
    this.music = s;
    for (const [k, b] of this.musicButtons) b.setAttribute('aria-pressed', String(k === s));
    this.onMusic?.(s);
  }

  private renderRecords(): void {
    clearChildren(this.recordsPanel);
    const view = collect(this.chrome.name, ['explorer', 'standard', 'expert']);

    if (view.daily.length === 0 && view.free.length === 0) {
      this.recordsPanel.append(el('p', { class: 'lede', text:
        'Nothing yet. Finish a run and it will appear here — these are stored in this browser only.' }));
      return;
    }

    if (view.daily.length) {
      this.recordsPanel.append(el('h2', { text: 'Daily & Grand Tour' }));
      const rows = view.daily.map(({ mode, day, rec }) => el('tr', {}, [
        el('td', { text: day }),
        el('td', { class: 'name', text: MODE_INFO[mode].label }),
        el('td', { text: `${formatScore(rec.firstScore)} · ${formatClock(rec.firstSeconds)}` }),
        el('td', { text: `${formatScore(rec.bestScore)} · ${formatClock(rec.bestSeconds)}` }),
        el('td', { class: 'pts', text: rec.bestCompletedSeconds > 0
          ? formatClock(rec.bestCompletedSeconds)
          : `${rec.bestFound} found` }),
      ]));
      this.recordsPanel.append(el('table', { class: 'runlog' }, [
        el('thead', {}, [el('tr', {}, [
          el('th', { text: 'Day' }), el('th', { text: 'Mode' }),
          el('th', { text: 'First' }), el('th', { text: 'Best' }),
          el('th', { text: 'Completed' }),
        ])]),
        el('tbody', {}, rows),
      ]));
    }

    if (view.free.length) {
      this.recordsPanel.append(el('h2', { text: 'Free play' }));
      const rows = view.free.map(({ mode, deck, rec }) => el('tr', {}, [
        el('td', { class: 'name', text: MODE_INFO[mode].label }),
        el('td', { text: DECKS[deck].label }),
        el('td', { text: `${rec.bestFound} found` }),
        el('td', { text: formatClock(rec.bestSeconds) }),
        el('td', { text: rec.bestExplored > 0 ? `${Math.round(rec.bestExplored * 100)}% seen` : '—' }),
        el('td', { class: 'pts', text: formatScore(rec.bestScore) }),
      ]));
      this.recordsPanel.append(el('table', { class: 'runlog' }, [
        el('thead', {}, [el('tr', {}, [
          el('th', { text: 'Mode' }), el('th', { text: 'Deck' }), el('th', { text: 'Longest' }),
          el('th', { text: 'Survived' }), el('th', { text: 'Explored' }), el('th', { text: 'Best score' }),
        ])]),
        el('tbody', {}, rows),
      ]));
    }
  }

  private selectMode(m: GameMode): void {
    this.mode = m;
    for (const [k, b] of this.modeButtons) b.setAttribute('aria-pressed', String(k === m));
    this.refreshBest();
  }

  private selectDeck(d: Deck): void {
    this.deck = d;
    for (const [k, b] of this.deckButtons) b.setAttribute('aria-pressed', String(k === d));
    this.refreshBest();
  }

  private refreshBest(): void {
    const best = readBest(this.chrome.name, this.mode, this.deck);
    this.bestLine.textContent = best > 0 ? `Your best here: ${formatScore(best)}` : '';
  }

  private play(): void {
    this.onPlay({ mode: this.mode, deck: this.deck });
  }

  show(): void { this.root.hidden = false; this.refreshBest(); this.root.scrollTop = 0; }
  hide(): void { this.root.hidden = true; }
  mount(parent: HTMLElement = document.body): void { parent.append(this.root); }
}

export class PauseScreen {
  readonly root: HTMLElement;

  constructor(onResume: () => void, onRestart: () => void) {
    this.root = el('div', { class: 'overlay', hidden: true }, [
      el('div', { class: 'sheet panel' }, [
        el('h1', { text: 'Paused' }),
        el('p', { class: 'lede', text: 'The world is holding still. It will not wait forever.' }),
        el('div', { class: 'btn-row' }, [
          el('button', { class: 'btn', type: 'button', text: 'Resume', onclick: onResume }),
          el('button', { class: 'btn ghost', type: 'button', text: 'Restart run', onclick: onRestart }),
          el('a', { class: 'btn ghost', href: '../', text: 'Leave' }),
        ]),
      ]),
    ]);
  }

  show(): void { this.root.hidden = false; }
  hide(): void { this.root.hidden = true; }
  get visible(): boolean { return !this.root.hidden; }
  mount(parent: HTMLElement = document.body): void { parent.append(this.root); }
}

export interface SummaryData {
  variant: string;
  mode: GameMode;
  deck: Deck;
  died: boolean;
  score: number;
  log: RunLogEntry[];
  elapsed: number;
  distanceKm: number;
  traceLat: number[];
  traceLon: number[];
  traceClimate: number[];
  explored: number;
  completed: boolean;
}

export class SummaryScreen {
  readonly root: HTMLElement;
  private readonly body: HTMLElement;

  constructor(
    private readonly world: WorldData,
    private readonly onAgain: () => void,
    private readonly onMenu: () => void,
  ) {
    this.body = el('div', { class: 'sheet panel' });
    this.root = el('div', { class: 'overlay', hidden: true }, [this.body]);
  }

  show(data: SummaryData): void {
    clearChildren(this.body);
    const isRecord = writeBest(data.variant, data.mode, data.deck, data.score);
    const best = readBest(data.variant, data.mode, data.deck);
    const hintsUsed = data.log.filter((e) => e.hintLevel > 0).length;

    const title = data.died
      ? 'You caught yourself'
      : data.mode === 'relay' ? 'Time'
      : data.mode === 'tour' ? (data.completed ? 'Grand Tour complete' : 'Tour abandoned')
      : 'Expedition complete';
    const lede = data.died
      ? 'The one rule of snake, on a planet-sized board.'
      : data.mode === 'daily'
        ? `Daily Run #${dailyNumber()} — everyone playing this world today got these ten, in this order.`
        : data.mode === 'tour'
          ? `All twenty, in ${formatClock(data.elapsed)}. That is the number to beat.`
          : 'The clock has run out. The route stands.';

    this.body.append(
      el('div', { class: 'pill gold', text: data.variant }),
      el('h1', { text: title }),
      el('p', { class: 'lede', text: lede }),
      el('div', { class: 'score-hero' }, [
        el('span', { class: 'n', text: data.mode === 'tour' ? formatClock(data.elapsed) : formatScore(data.score) }),
        el('span', { class: 'best', text: data.mode === 'tour'
          ? `${data.log.length} of 20 · ${formatScore(data.score)} points`
          : isRecord ? 'a new personal best' : `best ${formatScore(best)}` }),
      ]),
      ...(data.explored > 0.001
        ? [el('p', { class: 'lede', text:
            `You uncovered ${(data.explored * 100).toFixed(1)}% of the planet — recorded separately from your score.` })]
        : []),
    );

    if (data.log.length) {
      const rows = data.log.map((e, i) => el('tr', {}, [
        el('td', { text: String(i + 1) }),
        el('td', { class: 'name', text: e.name }),
        el('td', { text: `T${e.tier}` }),
        el('td', {
          class: e.seconds <= e.parSeconds ? 'fast' : 'slow',
          text: `${e.seconds.toFixed(1)}s / ${e.parSeconds.toFixed(0)}s`,
        }),
        el('td', { class: 'slow', text: e.hintLevel ? `hint ${e.hintLevel}` : '—' }),
        el('td', { class: 'pts', text: formatScore(e.points) }),
      ]));

      this.body.append(
        el('h2', { text: 'The run' }),
        el('table', { class: 'runlog' }, [
          el('thead', {}, [el('tr', {}, [
            el('th', { text: '#' }), el('th', { text: 'Target' }), el('th', { text: 'Tier' }),
            el('th', { text: 'Time / par' }), el('th', { text: 'Hints' }), el('th', { text: 'Points' }),
          ])]),
          el('tbody', {}, rows),
        ]),
      );
    }

    // --- share card --------------------------------------------------------
    const shareData: ShareData = {
      title: data.mode === 'daily' ? `Globe Snake Daily #${dailyNumber()}` : `Globe Snake · ${data.variant}`,
      subtitle: `${MODE_INFO[data.mode].label} · ${DECKS[data.deck].label} · ${formatClock(data.elapsed)}`,
      score: data.score,
      traceLat: data.traceLat,
      traceLon: data.traceLon,
      traceClimate: data.traceClimate,
      log: data.log,
      distanceKm: data.distanceKm,
      hintsUsed,
      variant: data.variant,
    };

    const canvas = renderShareCard(this.world, shareData);
    canvas.className = 'share-card';
    const text = shareText(shareData, location.href.split('?')[0]);

    this.body.append(
      el('h2', { text: 'Your route' }),
      canvas,
      el('div', { class: 'share-text', text }),
      el('div', { class: 'btn-row' }, [
        el('button', { class: 'btn', type: 'button', text: 'Play again', onclick: this.onAgain }),
        el('button', {
          class: 'btn ghost', type: 'button', text: 'Copy result',
          onclick: async (ev: Event) => {
            const btn = ev.currentTarget as HTMLElement;
            btn.textContent = (await copyToClipboard(text)) ? 'Copied' : 'Copy failed';
            window.setTimeout(() => { btn.textContent = 'Copy result'; }, 1600);
          },
        }),
        el('button', {
          class: 'btn ghost', type: 'button', text: 'Save route card',
          onclick: () => {
            const a = document.createElement('a');
            a.download = `globe-snake-${data.mode}-${data.score}.png`;
            a.href = canvas.toDataURL('image/png');
            a.click();
          },
        }),
        el('button', { class: 'btn ghost', type: 'button', text: 'Menu', onclick: this.onMenu }),
      ]),
    );

    this.root.hidden = false;
    this.root.scrollTop = 0;
  }

  hide(): void { this.root.hidden = true; }
  get visible(): boolean { return !this.root.hidden; }
  mount(parent: HTMLElement = document.body): void { parent.append(this.root); }
}

export class LoadingScreen {
  readonly root: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly msg: HTMLElement;

  constructor(title: string) {
    this.bar = el('i');
    this.msg = el('div', { class: 'loading-msg', text: 'waking the planet' });
    this.root = el('div', { class: 'loading' }, [
      el('div', { class: 'loading-title', text: title }),
      el('div', { class: 'loading-bar' }, [this.bar]),
      this.msg,
    ]);
    document.body.append(this.root);
  }

  progress(fraction: number, message?: string): void {
    this.bar.style.width = `${Math.round(fraction * 100)}%`;
    if (message) this.msg.textContent = message;
  }

  done(): void {
    this.root.classList.add('done');
    window.setTimeout(() => this.root.remove(), 460);
  }

  fail(message: string): void {
    this.msg.textContent = message;
    this.msg.style.color = 'var(--danger)';
    this.bar.style.background = 'var(--danger)';
  }
}
