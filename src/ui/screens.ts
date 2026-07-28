import { dailyNumber } from '@core/loop';
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
  blurb: string;
  /** Extra lines describing what this variant changes. */
  rules?: string[];
  hintNames?: string[];
}

const MODE_INFO: Record<GameMode, { label: string; desc: string }> = {
  endless: {
    label: 'Expedition',
    desc: 'Play until your own body catches you. The world gets more obscure the better you do.',
  },
  daily: {
    label: 'Daily Run',
    desc: 'Ten targets, the same ten for everyone on Earth today. Ends with a route card you can share.',
  },
  relay: {
    label: 'Relay',
    desc: 'Two minutes on the clock. Every find buys you eight more seconds. It never gets easier.',
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
  private readonly bestLine: HTMLElement;

  constructor(
    private readonly chrome: VariantChrome,
    private readonly onPlay: (choice: StartChoice) => void,
  ) {
    this.bestLine = el('div', { class: 'stat-sub' });

    const modeGrid = el('div', { class: 'choices cols-3' });
    for (const m of ['endless', 'daily', 'relay'] as GameMode[]) {
      const info = MODE_INFO[m];
      const btn = el('button', {
        class: 'choice',
        type: 'button',
        'aria-pressed': m === this.mode,
        onclick: () => this.selectMode(m),
      }, [
        el('div', { class: 'choice-title', text: m === 'daily' ? `${info.label} #${dailyNumber()}` : info.label }),
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

    const sheet = el('div', { class: 'sheet panel' }, [
      el('div', { class: 'pill gold', text: chrome.tagline }),
      el('h1', { text: chrome.name }),
      el('p', { class: 'lede', text: chrome.blurb }),

      el('h2', { text: 'Mode' }),
      modeGrid,
      el('h2', { text: 'Difficulty' }),
      deckGrid,

      el('h2', { text: 'Controls' }),
      el('div', { class: 'keys' }, [
        keyRow(['←', '→'], 'Turn'),
        keyRow(['↑'], 'Boost (costs stamina)'),
        keyRow(['↓'], 'Brake — turns tighter'),
        keyRow(['Space'], chrome.hintNames ? 'Hint (costs points)' : 'Hint (costs points)'),
        keyRow(['Mouse'], 'Steer toward the cursor'),
        keyRow(['Esc'], 'Pause'),
        keyRow(['M'], 'Mute'),
        keyRow(['R'], 'Restart'),
      ]),

      ...(chrome.rules?.length
        ? [el('h2', { text: 'In this world' }),
           el('ul', { class: 'lede' }, chrome.rules.map((r) => el('li', { text: r })))]
        : []),

      el('div', { class: 'btn-row' }, [
        el('button', { class: 'btn', type: 'button', text: 'Begin', onclick: () => this.play() }),
        el('a', { class: 'btn ghost', href: '../', text: 'All three worlds' }),
        this.bestLine,
      ]),

      el('p', { class: 'credit', html:
        'Imagery: NASA Blue Marble &amp; GEBCO (public domain) · Borders: Natural Earth (public domain) · ' +
        'Climate: Köppen-Geiger, Beck et al. (CC BY 4.0) · Flags: flag-icons (MIT)' }),
    ]);

    this.root = el('div', { class: 'overlay' }, [sheet]);
    this.refreshBest();
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
      : data.mode === 'relay' ? 'Time' : 'Expedition complete';
    const lede = data.died
      ? 'The one rule of snake, on a planet-sized board.'
      : data.mode === 'daily'
        ? `Daily Run #${dailyNumber()} — everyone on Earth got these ten, in this order.`
        : 'The clock has run out. The route stands.';

    this.body.append(
      el('div', { class: 'pill gold', text: data.variant }),
      el('h1', { text: title }),
      el('p', { class: 'lede', text: lede }),
      el('div', { class: 'score-hero' }, [
        el('span', { class: 'n', text: formatScore(data.score) }),
        el('span', { class: 'best', text: isRecord ? 'a new personal best' : `best ${formatScore(best)}` }),
      ]),
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
