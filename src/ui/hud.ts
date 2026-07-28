import { climateColor, climateLabel, TERRAIN_NAME, type Terrain } from '@core/world';
import { formatClock, formatScore, MAX_HINT_LEVEL } from '@game/scoring';
import type { CaptureEvent, Session } from '@game/session';
import type { LiveTarget } from '@game/targets';
import { baseUrl, clearChildren, el, hexToCss } from './dom';

/**
 * The heads-up display.
 *
 * DOM rather than canvas, deliberately: text is the content of this game — a
 * place name is the puzzle — and browser text rendering, selection, subpixel
 * hinting and accessibility are all better than anything worth hand-rolling
 * into a WebGL overlay for a project this size.
 *
 * Layout follows one rule: the prompt owns the top centre and nothing competes
 * with it. Everything else lives in a corner and stays out of the way of a
 * player who is reading "Which country is this?" while steering.
 */

export interface HudOptions {
  /** Terra Incognita hides the exact-pin hint entirely; the ladder stops at 2. */
  maxHintLevel?: number;
  hintNames?: string[];
  accent?: string;
}

export class Hud {
  readonly root: HTMLElement;
  private readonly promptKicker: HTMLElement;
  private readonly promptName: HTMLElement;
  private readonly promptImageSlot: HTMLElement;
  private readonly promptMeta: HTMLElement;
  private readonly parFill: HTMLElement;
  private readonly hintChip: HTMLElement;

  private readonly scoreValue: HTMLElement;
  private readonly scoreSub: HTMLElement;
  private readonly modeValue: HTMLElement;
  private readonly modeLabel: HTMLElement;
  private readonly modeSub: HTMLElement;

  private readonly whereCountry: HTMLElement;
  private readonly whereTerrain: HTMLElement;
  private readonly whereSwatch: HTMLElement;
  private readonly speedValue: HTMLElement;
  private readonly speedParts: HTMLElement;
  private lastSpeedText = '';

  private readonly boostFill: HTMLElement;
  private readonly wakeFill: HTMLElement;
  private readonly toastRail: HTMLElement;
  private readonly vignette: HTMLElement;
  readonly minimapSlot: HTMLElement;

  private readonly maxHint: number;
  private readonly hintNames: string[];
  private lastCountry = '';
  private lastTerrain: Terrain | -1 = -1;
  private lastClimate = -1;

  constructor(opts: HudOptions = {}) {
    this.maxHint = opts.maxHintLevel ?? MAX_HINT_LEVEL;
    this.hintNames = opts.hintNames ?? ['Bearing & range', 'Search area', 'Exact location'];

    this.promptKicker = el('div', { class: 'prompt-kicker', text: 'FIND' });
    this.promptImageSlot = el('div');
    this.promptName = el('div', { class: 'prompt-name', text: '—' });
    this.promptMeta = el('div', { class: 'prompt-meta' });
    this.parFill = el('i', { class: 'par-fill' });
    this.hintChip = el('span', { class: 'hint-chip' });

    const prompt = el('div', { class: 'prompt panel' }, [
      this.promptKicker,
      this.promptImageSlot,
      this.promptName,
      this.promptMeta,
      el('div', { class: 'par-track' }, [this.parFill]),
    ]);

    this.scoreValue = el('div', { class: 'stat-value gold', text: '0' });
    this.scoreSub = el('div', { class: 'stat-sub', text: 'no streak' });
    const tl = el('div', { class: 'hud-tl panel' }, [
      el('div', { class: 'stat-label', text: 'Score' }),
      this.scoreValue,
      this.scoreSub,
    ]);

    this.modeLabel = el('div', { class: 'stat-label', text: 'Elapsed' });
    this.modeValue = el('div', { class: 'stat-value', text: '0:00' });
    this.modeSub = el('div', { class: 'stat-sub', text: '' });
    const tr = el('div', { class: 'hud-tr panel' }, [this.modeLabel, this.modeValue, this.modeSub]);

    this.whereCountry = el('div', { class: 'where-country', text: '—' });
    this.whereSwatch = el('span', { class: 'swatch' });
    this.whereTerrain = el('span', { text: '' });
    this.speedValue = el('span', { class: 'speed-value', text: '×1.00' });
    this.speedParts = el('span', { class: 'speed-parts', text: '' });
    const bl = el('div', { class: 'hud-bl panel where' }, [
      el('div', { class: 'stat-label', text: 'You are in' }),
      this.whereCountry,
      el('div', { class: 'where-terrain' }, [this.whereSwatch, this.whereTerrain]),
      el('div', { class: 'speed-row' }, [this.speedValue, this.speedParts]),
    ]);

    this.boostFill = el('i');
    this.wakeFill = el('i');
    const bc = el('div', { class: 'hud-bc panel' }, [
      el('div', { class: 'meters' }, [
        el('div', {}, [
          el('div', { class: 'meter-label', text: 'Boost' }),
          el('div', { class: 'meter boost' }, [this.boostFill]),
        ]),
        el('div', {}, [
          el('div', { class: 'meter-label', text: 'Draft' }),
          el('div', { class: 'meter wake' }, [this.wakeFill]),
        ]),
        this.hintChip,
      ]),
    ]);

    this.minimapSlot = el('div', { class: 'hud-br panel minimap' });
    this.toastRail = el('div', { class: 'toast-rail' });
    this.vignette = el('div', { class: 'danger-vignette' });

    this.root = el('div', { class: 'layer' }, [
      prompt, tl, tr, bl, bc, this.minimapSlot, this.toastRail,
    ]);
    document.body.append(this.vignette);
  }

  mount(parent: HTMLElement = document.body): void {
    parent.append(this.root);
  }

  setVisible(v: boolean): void {
    this.root.style.display = v ? '' : 'none';
    this.vignette.style.display = v ? '' : 'none';
  }

  /**
   * Silhouettes and outlines are drawn with `fill="currentColor"` so the game
   * can tint them — but an SVG loaded through an `<img>` tag is a separate
   * document and inherits nothing, so `currentColor` would resolve to black and
   * the shape would vanish against the dark HUD. A CSS mask paints the element's
   * own background through the artwork instead, which both keeps the tint and
   * lets a single file serve the light parchment of Terra and the dark sky of
   * Expedition. Flags stay as real images: they have their own colours.
   */
  private maskShape(url: string, label: string): HTMLElement {
    const node = el('div', { class: 'prompt-image mask', role: 'img', 'aria-label': label });
    node.style.setProperty('-webkit-mask-image', `url("${url}")`);
    node.style.maskImage = `url("${url}")`;
    return node;
  }

  /** Render a new target prompt, including flags, outlines and silhouettes. */
  setTarget(t: LiveTarget, index: number, total: number): void {
    clearChildren(this.promptImageSlot);
    const base = baseUrl();

    if (t.image?.type === 'flag' && t.image.iso2) {
      this.promptKicker.textContent = 'WHOSE FLAG IS THIS?';
      this.promptImageSlot.append(el('img', {
        class: 'prompt-image flag',
        src: `${base}flags/${t.image.iso2}.svg`,
        alt: 'A national flag',
      }));
      this.promptName.textContent = '';
      this.promptName.style.display = 'none';
    } else if (t.image?.type === 'outline' && t.image.iso3) {
      this.promptKicker.textContent = 'WHICH COUNTRY IS THIS?';
      this.promptImageSlot.append(this.maskShape(`${base}outlines/${t.image.iso3}.svg`, 'The outline of a country'));
      this.promptName.textContent = '';
      this.promptName.style.display = 'none';
    } else if (t.image?.type === 'silhouette' && t.image.id) {
      this.promptKicker.textContent = 'FIND THIS LANDMARK';
      this.promptImageSlot.append(this.maskShape(`${base}silhouettes/${t.image.id}.svg`, 'The silhouette of a landmark'));
      this.promptName.textContent = '';
      this.promptName.style.display = 'none';
    } else {
      this.promptKicker.textContent = t.kind === 'country' ? 'FIND THE COUNTRY'
        : t.kind === 'capital' ? 'FIND THE CAPITAL'
        : t.kind === 'city' ? 'FIND THE CITY'
        : t.kind === 'feature' ? 'FIND THIS PLACE'
        : 'FIND';
      this.promptName.style.display = '';
      this.promptName.textContent = t.prompt;
    }

    clearChildren(this.promptMeta);
    this.promptMeta.append(
      el('span', { class: 'pill gold', text: `Tier ${t.tier}` }),
      el('span', {}, [document.createTextNode('Target '), el('b', { text: String(index + 1) }),
        document.createTextNode(total > 0 ? ` of ${total}` : '')]),
    );
  }

  /** Per-frame refresh. Reads the session; writes nothing back. */
  update(session: Session, opts: { totalTargets?: number } = {}): void {
    this.scoreValue.textContent = formatScore(session.score);
    this.scoreSub.textContent = session.streak > 0
      ? `${session.streak} clean · ×${(1 + Math.min(0.5, session.streak * 0.1)).toFixed(1)}`
      : 'no streak';

    if (session.options.mode === 'relay') {
      this.modeLabel.textContent = 'Time left';
      this.modeValue.textContent = formatClock(session.relayRemaining);
      this.modeValue.style.color = session.relayRemaining < 15 ? 'var(--danger)' : '';
      this.modeSub.textContent = `${session.targetIndex} found`;
    } else if (session.options.mode === 'daily') {
      this.modeLabel.textContent = 'Daily run';
      this.modeValue.textContent = `${session.targetIndex}/${session.dailyTotal}`;
      this.modeSub.textContent = formatClock(session.elapsed);
    } else {
      this.modeLabel.textContent = 'Elapsed';
      this.modeValue.textContent = formatClock(session.elapsed);
      this.modeSub.textContent = `${session.targetIndex} found · tier ${session.drift.tier}`;
    }

    // Par bar: how much of this target's clock has burned.
    const ratio = session.parSeconds > 0 ? session.targetElapsed / session.parSeconds : 0;
    this.parFill.style.width = `${Math.min(100, ratio * 100).toFixed(1)}%`;
    this.parFill.classList.toggle('over', ratio > 1);

    // Location readout — free, always on, and the best teaching tool we have.
    const country = session.locationName;
    if (country !== this.lastCountry) {
      this.lastCountry = country;
      this.whereCountry.textContent = country;
    }
    const terrain = session.snake.surface.terrain;
    const climate = session.snake.surface.climate;
    // Keyed on both: the climate can change under an unchanged terrain class
    // (savanna to steppe is all "plains"), and that transition is exactly the
    // one the snake's colour is about to make.
    if (terrain !== this.lastTerrain || climate !== this.lastClimate) {
      this.lastTerrain = terrain;
      this.lastClimate = climate;
      this.whereTerrain.textContent = `${TERRAIN_NAME[terrain]} · ${climateLabel(climate)}`;
    }
    const cc = hexToCss(climateColor(climate));
    this.whereSwatch.style.background = cc;
    this.whereSwatch.style.color = cc;

    // Speed, and what is causing it. Colour-coded because the number alone is
    // easy to miss mid-corner — green when the ground is helping, red when it
    // is not.
    const speed = session.speedReadout();
    this.speedValue.textContent = `×${speed.total.toFixed(2)}`;
    this.speedValue.style.color = speed.total > 1.04 ? 'var(--accent)'
      : speed.total < 0.94 ? 'var(--danger)' : 'var(--ink)';
    const partsText = speed.parts
      .filter((p) => Math.abs(p.factor - 1) > 0.02)
      .map((p) => `${p.label} ×${p.factor.toFixed(2)}`)
      .join(' · ');
    if (partsText !== this.lastSpeedText) {
      this.lastSpeedText = partsText;
      this.speedParts.textContent = partsText || 'no modifiers';
    }

    const cfg = session.snake.cfg;
    this.boostFill.style.width = `${(session.snake.boostStamina / cfg.boostCapacity) * 100}%`;
    this.wakeFill.style.width = `${session.snake.wake.charge * 100}%`;

    this.updateHintChip(session);

    // Proximity warning. Only inside three body-widths, so it means something.
    const prox = session.snake.proximityDeg();
    const danger = prox < cfg.collisionRadiusDeg * 3.2
      ? 1 - prox / (cfg.collisionRadiusDeg * 3.2)
      : 0;
    this.vignette.style.opacity = String(Math.min(0.85, danger * danger));
    void opts;
  }

  private updateHintChip(session: Session): void {
    clearChildren(this.hintChip);
    this.hintChip.className = 'hint-chip';
    const paid = session.paidHintLevel;

    if (session.autoHintShown && paid === 0) {
      this.hintChip.classList.add('free');
      this.hintChip.append(document.createTextNode('Free hint given'));
      return;
    }
    if (paid >= this.maxHint) {
      this.hintChip.classList.add('spent');
      this.hintChip.append(document.createTextNode('No hints left'));
      return;
    }
    this.hintChip.append(
      el('kbd', { text: 'Space' }),
      document.createTextNode(`${this.hintNames[paid] ?? 'Hint'} · −${formatScore(session.nextHintCost)}`),
    );
  }

  // --- transient feedback ---------------------------------------------------

  showCapture(e: CaptureEvent): void {
    const node = el('div', { class: 'toast panel' }, [
      el('div', { class: 'toast-points', text: `+${formatScore(e.breakdown.total)}` }),
      el('div', { class: 'toast-title', text: e.target.name }),
      el('div', { class: 'toast-blurb', text: e.target.blurb }),
      el('div', { class: 'toast-mults' }, [
        el('span', {}, [document.createTextNode('speed '), el('b', { text: `×${e.breakdown.speed.toFixed(2)}` })]),
        el('span', {}, [document.createTextNode('streak '), el('b', { text: `×${e.breakdown.streak.toFixed(1)}` })]),
        e.breakdown.hintLevel > 0
          ? el('span', {}, [document.createTextNode('hint '), el('b', { text: `×${e.breakdown.hint.toFixed(2)}` })])
          : el('span', { text: e.breakdown.beatPar ? 'under par' : 'over par' }),
      ]),
    ]);
    this.pushToast(node, 3400);
  }

  showShip(bonus: number): void {
    this.pushToast(el('div', { class: 'toast panel small' }, [
      el('div', { class: 'toast-title', text: `Cargo swallowed  +${bonus}` }),
    ]), 1500);
  }

  showHintTaken(level: number, cost: number): void {
    const label = cost > 0
      ? `${this.hintNames[level - 1] ?? 'Hint'} · −${formatScore(cost)}`
      : `${this.hintNames[0]} — on the house`;
    this.pushToast(el('div', { class: 'toast panel small' }, [
      el('div', { class: 'toast-title', text: label }),
    ]), 1700);
  }

  showMessage(text: string, ms = 2000): void {
    this.pushToast(el('div', { class: 'toast panel small' }, [
      el('div', { class: 'toast-title', text }),
    ]), ms);
  }

  private pushToast(node: HTMLElement, ms: number): void {
    this.toastRail.append(node);
    window.setTimeout(() => {
      node.classList.add('leaving');
      window.setTimeout(() => node.remove(), 400);
    }, ms);
  }

  clearToasts(): void {
    clearChildren(this.toastRail);
  }

  dispose(): void {
    this.root.remove();
    this.vignette.remove();
  }
}
