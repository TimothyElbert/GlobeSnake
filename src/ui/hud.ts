import { climateColor, climateLabel, TERRAIN_NAME, type Terrain } from '@core/world';
import { formatClock, formatScore, MAX_HINT_LEVEL } from '@game/scoring';
import type { CaptureEvent, Session } from '@game/session';
import type { LiveTarget } from '@game/targets';
import { baseUrl, clearChildren, el, hexToCss } from './dom';

/**
 * The heads-up display.
 *
 * DOM rather than canvas: text is the content of this game, and browser text
 * rendering beats anything worth hand-rolling into a WebGL overlay.
 *
 * The layout follows one rule learned the hard way — **nothing that matters may
 * sit in the middle of the screen**, because that is where the snake is and
 * where you are about to die. Capture cards used to appear dead centre and
 * blocked the one thing you needed to see. Everything now lives along the top
 * edge or in a corner, and the play area stays clear.
 */

export interface HudOptions {
  /** Terra Incognita stops the hint ladder before the exact pin. */
  maxHintLevel?: number;
  hintNames?: string[];
  onMute?: () => void;
}

export class Hud {
  readonly root: HTMLElement;
  private readonly promptPanel: HTMLElement;
  private readonly promptKicker: HTMLElement;
  private readonly promptName: HTMLElement;
  private readonly promptImageSlot: HTMLElement;
  private readonly promptWorth: HTMLElement;
  private readonly promptMeta: HTMLElement;
  private readonly parFill: HTMLElement;
  private readonly hintChip: HTMLElement;

  private readonly scoreValue: HTMLElement;
  private readonly scoreSub: HTMLElement;
  private readonly modeValue: HTMLElement;
  private readonly modeLabel: HTMLElement;
  private readonly modeSub: HTMLElement;

  private readonly speedValue: HTMLElement;
  private readonly speedTerrain: HTMLElement;
  private readonly speedParts: HTMLElement;
  private readonly speedBar: HTMLElement;

  private readonly whereCountry: HTMLElement;
  private readonly whereSwatch: HTMLElement;
  private readonly whereClimate: HTMLElement;

  private readonly boostFill: HTMLElement;
  private readonly wakeFill: HTMLElement;
  private readonly toastRail: HTMLElement;
  private readonly vignette: HTMLElement;
  private readonly tourPanel: HTMLElement;
  private readonly tourList: HTMLElement;
  private readonly tourReady: HTMLElement;
  private readonly muteButton: HTMLButtonElement;
  readonly minimapSlot: HTMLElement;

  private readonly maxHint: number;
  private readonly hintNames: string[];
  private lastCountry = '';
  private lastTerrain: Terrain | -1 = -1;
  private lastClimate = -1;
  private lastSpeedText = '';
  private lastTourSignature = '';

  constructor(opts: HudOptions = {}) {
    this.maxHint = opts.maxHintLevel ?? MAX_HINT_LEVEL;
    this.hintNames = opts.hintNames ?? ['Bearing & range', 'Search area', 'Exact location'];

    // --- the prompt, and the value bleeding out of it ----------------------
    this.promptKicker = el('div', { class: 'prompt-kicker', text: 'FIND' });
    this.promptImageSlot = el('div');
    this.promptName = el('div', { class: 'prompt-name', text: '—' });
    this.promptWorth = el('div', { class: 'prompt-worth' });
    this.promptMeta = el('div', { class: 'prompt-meta' });
    this.parFill = el('i', { class: 'par-fill' });
    this.hintChip = el('button', { class: 'hint-chip', type: 'button' });

    // --- terrain, right beside the prompt where it cannot be ignored -------
    this.speedValue = el('span', { class: 'speed-value', text: '×1.00' });
    this.speedTerrain = el('div', { class: 'speed-terrain', text: '—' });
    this.speedParts = el('div', { class: 'speed-parts', text: '' });
    this.speedBar = el('i');
    const speedPanel = el('div', { class: 'speed-panel panel' }, [
      el('div', { class: 'stat-label', text: 'Going' }),
      el('div', { class: 'speed-head' }, [this.speedValue]),
      this.speedTerrain,
      el('div', { class: 'speed-track' }, [this.speedBar]),
      this.speedParts,
    ]);

    this.promptPanel = el('div', { class: 'prompt panel' }, [
      this.promptKicker,
      this.promptImageSlot,
      this.promptName,
      this.promptWorth,
      this.promptMeta,
      el('div', { class: 'par-track' }, [this.parFill]),
    ]);

    // --- the top bar --------------------------------------------------------
    //
    // Speed and the hint sit in a column immediately beside whatever is in the
    // centre — the prompt, or the Grand Tour board. They cannot live *inside*
    // the prompt, because the Tour replaces it; but pushed out to a corner they
    // are simply not where anyone is looking. A matching spacer on the far side
    // keeps the centre panel actually centred.
    // Built after the tour panel so the centre stack can reference both.
    const sidePanel = el('div', { class: 'hud-side' }, [
      speedPanel,
      el('div', { class: 'panel hint-panel' }, [
        el('div', { class: 'stat-label', text: 'Hint' }),
        this.hintChip,
      ]),
    ]);
    // The tour board joins this stack further down, once it has been built.
    const centre = el('div', { class: 'hud-centre' }, [this.promptPanel]);
    const topBar = el('div', { class: 'hud-top' }, [
      el('div', { class: 'hud-spacer' }),
      centre,
      sidePanel,
    ]);

    this.scoreValue = el('div', { class: 'score-value', text: '0' });
    this.scoreSub = el('div', { class: 'stat-sub', text: 'no streak' });
    const tl = el('div', { class: 'hud-tl panel' }, [
      el('div', { class: 'stat-label', text: 'Score' }),
      this.scoreValue,
      this.scoreSub,
    ]);

    this.modeLabel = el('div', { class: 'stat-label', text: 'Elapsed' });
    this.modeValue = el('div', { class: 'stat-value', text: '0:00' });
    this.modeSub = el('div', { class: 'stat-sub', text: '' });
    this.muteButton = el('button', {
      class: 'icon-btn', type: 'button', title: 'Mute (M)', 'aria-label': 'Mute',
      onclick: () => opts.onMute?.(),
    }, ['🔊']) as HTMLButtonElement;
    const tr = el('div', { class: 'hud-tr panel' }, [
      this.modeLabel, this.modeValue, this.modeSub, this.muteButton,
    ]);

    // --- the Grand Tour board ------------------------------------------------
    // Twenty places belong on one board, at the top, with their pictures. A
    // single-target prompt is meaningless when everything is live at once, and
    // a text list off to the side was both hard to read and actively wrong —
    // it rendered image prompts as the words "(flag)".
    this.tourList = el('div', { class: 'tour-grid' });
    this.tourReady = el('div', { class: 'tour-ready' });
    this.tourPanel = el('div', { class: 'hud-tour panel', hidden: true }, [
      el('div', { class: 'stat-label', text: 'Find all twenty — any order' }),
      this.tourList,
      this.tourReady,
    ]);
    centre.append(this.tourPanel);

    this.whereCountry = el('div', { class: 'where-country', text: '—' });
    this.whereSwatch = el('span', { class: 'swatch' });
    this.whereClimate = el('span', { text: '' });
    const bl = el('div', { class: 'hud-bl panel where' }, [
      el('div', { class: 'stat-label', text: 'You are in' }),
      this.whereCountry,
      el('div', { class: 'where-terrain' }, [this.whereSwatch, this.whereClimate]),
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
      ]),
    ]);

    this.minimapSlot = el('div', { class: 'hud-br panel minimap' });
    this.toastRail = el('div', { class: 'toast-rail' });
    this.vignette = el('div', { class: 'danger-vignette' });

    this.root = el('div', { class: 'layer' }, [
      topBar, tl, tr, bl, bc, this.minimapSlot, this.toastRail,
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

  setMuted(m: boolean): void {
    this.muteButton.textContent = m ? '🔇' : '🔊';
    this.muteButton.classList.toggle('muted', m);
  }

  onHintClick(fn: () => void): void {
    this.hintChip.addEventListener('click', fn);
  }

  /**
   * Silhouettes and outlines are `fill="currentColor"`, and an SVG in an `<img>`
   * inherits nothing — it would resolve to black and vanish. A CSS mask paints
   * the element's own background through the artwork instead.
   */
  private maskShape(url: string, label: string): HTMLElement {
    const node = el('div', { class: 'prompt-image mask', role: 'img', 'aria-label': label });
    node.style.setProperty('-webkit-mask-image', `url("${url}")`);
    node.style.maskImage = `url("${url}")`;
    return node;
  }

  setTarget(t: LiveTarget, index: number, total: number): void {
    clearChildren(this.promptImageSlot);
    const base = baseUrl();

    if (t.image?.type === 'flag' && t.image.iso2) {
      this.promptKicker.textContent = 'WHOSE FLAG IS THIS?';
      this.promptImageSlot.append(el('img', {
        class: 'prompt-image flag', src: `${base}flags/${t.image.iso2}.svg`, alt: 'A national flag',
      }));
      this.promptName.style.display = 'none';
    } else if (t.image?.type === 'outline' && t.image.iso3) {
      this.promptKicker.textContent = 'WHICH COUNTRY IS THIS?';
      this.promptImageSlot.append(this.maskShape(`${base}outlines/${t.image.iso3}.svg`, 'A country outline'));
      this.promptName.style.display = 'none';
    } else if (t.image?.type === 'silhouette' && t.image.id) {
      this.promptKicker.textContent = 'FIND THIS LANDMARK';
      this.promptImageSlot.append(this.maskShape(`${base}silhouettes/${t.image.id}.svg`, 'A landmark silhouette'));
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
      el('span', {}, [
        document.createTextNode('Target '), el('b', { text: String(index + 1) }),
        document.createTextNode(total > 0 ? ` of ${total}` : ''),
      ]),
    );
  }

  /**
   * Swap the single-target prompt for the Grand Tour board.
   *
   * They are mutually exclusive: on the Tour there is no "current target" in
   * any sense the player cares about, so a prompt naming one of the twenty is
   * noise sitting where the board should be.
   */
  setTourVisible(on: boolean): void {
    this.tourPanel.hidden = !on;
    this.promptPanel.hidden = on;
    this.lastTourSignature = '';
  }

  /** One tile: the prompt as the player will actually have to recognise it. */
  private tourTile(t: LiveTarget, found: boolean, nearest: boolean): HTMLElement {
    const base = baseUrl();
    const art = el('div', { class: 'tour-art' });
    if (t.image?.type === 'flag' && t.image.iso2) {
      art.append(el('img', { class: 'flag', src: `${base}flags/${t.image.iso2}.svg`, alt: t.name }));
    } else if (t.image?.type === 'outline' && t.image.iso3) {
      art.append(this.maskShape(`${base}outlines/${t.image.iso3}.svg`, t.name));
    } else if (t.image?.type === 'silhouette' && t.image.id) {
      art.append(this.maskShape(`${base}silhouettes/${t.image.id}.svg`, t.name));
    } else {
      art.append(el('span', { class: 'tour-word', text: t.prompt }));
    }
    return el('div', {
      class: `tour-tile${found ? ' found' : ''}${nearest && !found ? ' nearest' : ''}`,
      title: t.image ? undefined : t.name,
    }, [art]);
  }

  private updateTour(session: Session): void {
    const all = session.tourAll;
    if (all.length === 0) return;
    // Which of the twenty is closest is itself a hint, and a strong one — it
    // narrows the search before you have moved. So the tile is only marked once
    // a hint has actually been bought, and then it is there to tell you *which*
    // place the bearing belongs to, which the hint would be useless without.
    const nearestId = session.hintLevel > 0 ? session.target?.id ?? '' : '';
    const signature = `${nearestId}|${all.map((t) => (session.isTourFound(t.id) ? '1' : '0')).join('')}`;
    if (signature === this.lastTourSignature) return;
    this.lastTourSignature = signature;

    clearChildren(this.tourList);
    for (const t of all) {
      this.tourList.append(this.tourTile(t, session.isTourFound(t.id), t.id === nearestId));
    }
  }

  /** The study period banner, shown until the player starts the clock. */
  setTourReady(ready: boolean): void {
    clearChildren(this.tourReady);
    this.tourReady.classList.toggle('on', ready);
    if (ready) {
      this.tourReady.append(
        el('span', { text: 'Take as long as you like — the clock starts when you do.' }),
        el('span', { class: 'go' }, [el('kbd', { text: 'Click' }), document.createTextNode(' to begin')]),
      );
    }
  }

  /** Per-frame refresh. Reads the session; writes nothing back. */
  update(session: Session): void {
    this.scoreValue.textContent = formatScore(session.score);
    this.scoreSub.textContent = session.streak > 0
      ? `${session.streak} clean · ×${(1 + Math.min(0.5, session.streak * 0.1)).toFixed(1)}`
      : 'no streak';

    const mode = session.options.mode;
    if (mode === 'relay') {
      this.modeLabel.textContent = 'Time left';
      this.modeValue.textContent = formatClock(session.relayRemaining);
      this.modeValue.style.color = session.relayRemaining < 15 ? 'var(--danger)' : '';
      this.modeSub.textContent = `${session.targetIndex} found`;
    } else if (mode === 'daily') {
      this.modeLabel.textContent = 'Daily run';
      this.modeValue.textContent = `${session.targetIndex}/${session.dailyTotal}`;
      this.modeSub.textContent = formatClock(session.elapsed);
    } else if (mode === 'tour') {
      // A stopwatch, not a countdown: the Grand Tour is ranked on how quickly
      // you finish, and nothing is taken away while you think.
      this.modeLabel.textContent = 'Grand Tour';
      this.modeValue.textContent = formatClock(session.elapsed);
      this.modeSub.textContent = `${session.tourAll.length - session.tourRemaining.length} of ${session.tourAll.length} found`;
      this.updateTour(session);
    } else {
      this.modeLabel.textContent = 'Elapsed';
      this.modeValue.textContent = formatClock(session.elapsed);
      this.modeSub.textContent = `${session.targetIndex} found · tier ${session.drift.tier}`;
    }

    // --- what this target is still worth ------------------------------------
    const worth = session.projectedValue();
    this.promptWorth.textContent = `worth ${formatScore(worth)}`;
    this.promptWorth.classList.toggle('spent', worth <= 0);

    const ratio = session.parSeconds > 0 ? session.targetElapsed / session.parSeconds : 0;
    this.parFill.style.width = `${Math.min(100, (ratio / 3) * 100).toFixed(1)}%`;
    this.parFill.classList.toggle('over', ratio > 1);

    // --- terrain, up top ----------------------------------------------------
    const speed = session.speedReadout();
    this.speedValue.textContent = `×${speed.total.toFixed(2)}`;
    const hot = speed.total > 1.04;
    const cold = speed.total < 0.94;
    this.speedValue.style.color = hot ? 'var(--accent)' : cold ? 'var(--danger)' : 'var(--ink)';
    // Bar centred on ×1: right of centre is help, left is drag.
    const pct = Math.max(0, Math.min(1, (speed.total - 0.5) / 1.0));
    this.speedBar.style.width = `${Math.abs(pct - 0.5) * 100}%`;
    this.speedBar.style.left = `${Math.min(pct, 0.5) * 100}%`;
    this.speedBar.style.background = hot ? 'var(--accent)' : cold ? 'var(--danger)' : 'var(--ink-faint)';

    const terrain = session.snake.surface.terrain;
    const climate = session.snake.surface.climate;
    if (terrain !== this.lastTerrain) {
      this.lastTerrain = terrain;
      this.speedTerrain.textContent = TERRAIN_NAME[terrain];
    }
    // Skip the first entry: it is the terrain, already named in bold above.
    const partsText = speed.parts
      .slice(1)
      .filter((p) => Math.abs(p.factor - 1) > 0.02)
      .map((p) => `${p.label} ×${p.factor.toFixed(2)}`)
      .join(' · ');
    if (partsText !== this.lastSpeedText) {
      this.lastSpeedText = partsText;
      this.speedParts.textContent = partsText || 'no modifiers';
    }

    // --- location, the free geography teacher -------------------------------
    const country = session.locationName;
    if (country !== this.lastCountry) {
      this.lastCountry = country;
      this.whereCountry.textContent = country;
    }
    if (climate !== this.lastClimate) {
      this.lastClimate = climate;
      this.whereClimate.textContent = climateLabel(climate);
    }
    const cc = hexToCss(climateColor(climate));
    this.whereSwatch.style.background = cc;
    this.whereSwatch.style.color = cc;

    const cfg = session.snake.cfg;
    this.boostFill.style.width = `${(session.snake.boostStamina / cfg.boostCapacity) * 100}%`;
    this.wakeFill.style.width = `${session.snake.wake.charge * 100}%`;

    this.updateHintChip(session);

    const prox = session.snake.proximityDeg();
    const danger = prox < cfg.collisionRadiusDeg * 3.2 ? 1 - prox / (cfg.collisionRadiusDeg * 3.2) : 0;
    this.vignette.style.opacity = String(Math.min(0.85, danger * danger));
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
    // On the Grand Tour a hint can only sensibly point at whichever place is
    // closest, so say so rather than naming a "current target" that does not
    // exist when twenty of them are live.
    const label = session.options.mode === 'tour'
      ? `Nearest place · ${this.hintNames[paid] ?? 'Hint'}`
      : (this.hintNames[paid] ?? 'Hint');
    this.hintChip.append(
      el('kbd', { text: 'Space' }),
      document.createTextNode(`${label} · −${formatScore(session.nextHintCost)}`),
    );
  }

  // --- transient feedback ---------------------------------------------------

  showCapture(e: CaptureEvent): void {
    const node = el('div', { class: 'toast panel' }, [
      el('div', { class: 'toast-points', text: `+${formatScore(e.breakdown.total)}` }),
      el('div', { class: 'toast-title', text: e.target.name }),
      el('div', { class: 'toast-blurb', text: e.target.blurb }),
    ]);
    this.pushToast(node, 4200);
  }

  showShip(refill: number): void {
    this.pushToast(el('div', { class: 'toast panel small' }, [
      el('div', { class: 'toast-title', text: `Cargo swallowed  +${refill.toFixed(1)}s boost` }),
    ]), 1600);
  }

  showHintTaken(level: number, cost: number): void {
    const label = cost > 0
      ? `${this.hintNames[level - 1] ?? 'Hint'} · −${formatScore(cost)}`
      : `${this.hintNames[0]} — on the house`;
    this.pushToast(el('div', { class: 'toast panel small' }, [
      el('div', { class: 'toast-title', text: label }),
    ]), 1800);
  }

  showMessage(text: string, ms = 2000): void {
    this.pushToast(el('div', { class: 'toast panel small' }, [
      el('div', { class: 'toast-title', text }),
    ]), ms);
  }

  private pushToast(node: HTMLElement, ms: number): void {
    this.toastRail.append(node);
    while (this.toastRail.childElementCount > 3) this.toastRail.firstElementChild?.remove();
    window.setTimeout(() => {
      node.classList.add('leaving');
      window.setTimeout(() => node.remove(), 400);
    }, ms);
  }

  clearToasts(): void {
    clearChildren(this.toastRail);
    this.lastTourSignature = '';
  }

  dispose(): void {
    this.root.remove();
    this.vignette.remove();
  }
}
