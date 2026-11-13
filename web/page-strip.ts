import { copyHighlights } from './highlight-copy.ts';

/**
 * Stiffness of the critically damped spring pages follow, as ω times the turn's duration. A spring
 * keeps velocity continuous: a page eases off the mark instead of leaving at full speed (the old
 * ease-out started at 4.5 times its average speed), peaks at about 3 times it, and settles without
 * overshoot. At 8 only 0.3% of the distance is left at the end, closed over the whole turn.
 */
const STIFFNESS = 8;
/** Points of the CSS linear() easing that carries the spring to the compositor. */
const SAMPLES = 64;
/** Milliseconds over which the resting copy fades into the live page (see settle). */
const SETTLE_FADE = 140;
const SLOTS = 4;

/**
 * A critically damped spring from `from`, moving at `velocity` (px per ms), to `to` over `duration`
 * ms: position and velocity `time` ms in. The small remainder at the end is taken out linearly over
 * the turn, so it lands exactly on `to` with nothing left to snap.
 */
export function spring(from: number, to: number, velocity: number, duration: number, time: number) {
  const k = STIFFNESS / duration, distance = to - from, t = Math.min(Math.max(time, 0), duration);
  const rest = (d: number) => (distance + (k * distance - velocity) * d) * Math.exp(-k * d);
  const remainder = rest(duration) / duration;
  const gap = rest(t) - remainder * t;
  const speed = ((k * distance - velocity) - k * (distance + (k * distance - velocity) * t)) * Math.exp(-k * t) - remainder;
  return { x: to - gap, velocity: -speed };
}

/**
 * The spring as a CSS linear() easing from `from` to `to`, so it runs on the compositor. Samples
 * crowd the start, where the curve bends most. Values may leave 0..1 when the page was moving away.
 */
export function springEasing(from: number, to: number, velocity: number, duration: number): string {
  const distance = to - from;
  const points = Array.from({ length: SAMPLES + 1 }, (_, index) => {
    const share = (index / SAMPLES) ** 1.6;
    const progress = (spring(from, to, velocity, duration, share * duration).x - from) / distance;
    return `${index === SAMPLES ? 1 : +progress.toFixed(5)} ${+(share * 100).toFixed(3)}%`;
  });
  return `linear(${points.join(', ')})`;
}

/** The spring from rest across a whole page, for the one-off slides and covers (see motion.ts). */
export const PAGE_EASING = springEasing(0, 1, 0, 1);

type Slot = { pane: HTMLDivElement; frame: HTMLIFrameElement; ready: boolean };
/** A page's motion from `from` to `to`, starting at `velocity` (px per ms of effect time). */
type Motion = { from: number; to: number; velocity: number; duration: number; animation: Animation };
type Pane = { slot: Slot; order: number; x: number; motion?: Motion };
export type StripMode = 'slide' | 'cover';

/**
 * Interruptible page turns within one chapter. A resident layer keeps SLOTS copies of the
 * current chapter loaded, so a turn only scrolls two of them and starts in the same frame.
 * Pages sit in reading order: `slide` lays them side by side, `cover` stacks earlier pages
 * on top. A turn during a turn retargets every visible page from where it is now.
 */
export class PageStrip {
  private layer?: HTMLDivElement;
  private slots: Slot[] = [];
  private key = '';
  private wanted = '';
  private loadTimer?: ReturnType<typeof setTimeout>;
  private loading?: Promise<void>;
  private panes: Pane[] = [];
  private current = 0;
  private mode: StripMode = 'slide';
  private frame?: HTMLIFrameElement;
  private frameVisibility = '';
  private settleToken = 0;
  private completion: Promise<void> = Promise.resolve();
  private speed = 1;
  private fade?: Animation;

  finished(): Promise<void> { return this.completion; }

  setSpeed(speed: number): void {
    this.speed = speed;
    for (const pane of this.panes) pane.motion?.animation.updatePlaybackRate(speed);
    this.fade?.updatePlaybackRate(speed);
  }

  /** True while pages are moving or about to settle back onto the live document. */
  get active(): boolean { return this.panes.length > 0; }

  ready(key: string): boolean {
    return this.key === key && this.slots.length === SLOTS && this.slots.every(slot => slot.ready);
  }

  /** The first turn also uses resident pages, even before the idle preload has run. */
  async readyForTurn(host: HTMLElement, live: HTMLIFrameElement, key: string): Promise<boolean> {
    if (this.ready(key)) return true;
    this.wanted = key;
    clearTimeout(this.loadTimer);
    if (this.key !== key || !this.loading) this.load(host, live, key);
    await this.loading;
    return this.wanted === key && this.ready(key);
  }

  /**
   * Loads the slots with a copy of the live document once its layout settles. `key` names the
   * chapter, typography, viewport and highlight revision; the copies reload only when it changes.
   */
  prepare(host: HTMLElement, live: HTMLIFrameElement, key: string): void {
    this.wanted = key;
    if (this.key === key && this.slots.length) return;
    clearTimeout(this.loadTimer);
    this.loadTimer = setTimeout(() => this.load(host, live, key), 250);
  }

  private load(host: HTMLElement, live: HTMLIFrameElement, key: string): void {
    const doc = live.contentDocument;
    if (this.wanted !== key || !doc?.body) return;
    // Never reload copies that are on screen; try again once the motion has settled.
    if (this.active) { this.loadTimer = setTimeout(() => this.load(host, live, key), 250); return; }
    this.ensureLayer(host);
    this.key = key;
    const html = '<!doctype html>' + doc.documentElement.outerHTML;
    this.loading = Promise.all(this.slots.map(slot => new Promise<void>(resolve => {
      slot.ready = false;
      const timer = setTimeout(resolve, 1500);
      const done = () => { clearTimeout(timer); resolve(); };
      slot.frame.onerror = done;
      slot.frame.onload = async () => {
        const target = slot.frame.contentDocument;
        if (!target || this.key !== key) { done(); return; }
        await target.fonts.ready;
        if (this.key !== key) { done(); return; }
        copyHighlights(doc, target);
        slot.ready = true;
        done();
      };
      slot.frame.srcdoc = html;
    }))).then(() => {});
  }

  private ensureLayer(host: HTMLElement): void {
    if (this.layer?.parentElement === host) return;
    this.layer?.remove();
    const layer = document.createElement('div');
    layer.className = 'motion-strip';
    layer.setAttribute('aria-hidden', 'true');
    // Slots never move in the DOM: reparenting an iframe would reload its document.
    this.slots = Array.from({ length: SLOTS }, () => {
      const pane = document.createElement('div');
      pane.className = 'motion-page';
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-same-origin');
      frame.setAttribute('aria-hidden', 'true');
      frame.tabIndex = -1;
      pane.append(frame);
      layer.append(pane);
      return { pane, frame, ready: false };
    });
    host.append(layer);
    this.layer = layer;
  }

  /**
   * Turns one page. The live document is committed underneath right away; the returned promise
   * resolves once the motion has started, so the next turn can interrupt it.
   */
  async turn(live: HTMLIFrameElement, mode: StripMode, direction: number, duration: number,
    update: () => void | Promise<void>, spread = false): Promise<void> {
    const view = live.contentWindow!;
    // Each copy of a spread carries its spine with it (styles.css): the live one is under the strip.
    if (this.layer) this.layer.dataset.spread = String(spread);
    if (this.fade && this.mode === mode) {
      // A turn while the last one fades into the live page picks its pages up again.
      this.fade.cancel();
      this.fade = undefined;
      live.style.visibility = 'hidden';
    } else if (!this.active || this.mode !== mode) {
      this.reset();
      this.mode = mode;
      this.frame = live;
      this.frameVisibility = live.style.visibility;
      this.panes = [{ slot: this.acquire(), order: 0, x: 0 }];
      this.current = 0;
      this.show(this.panes[0], view.scrollX, view.scrollY, 0);
      this.layer!.dataset.mode = mode;
      this.layer!.classList.add('active');
      live.style.visibility = 'hidden';
    }
    await update();
    const width = this.layer!.clientWidth;
    const previous = this.panes.find(pane => pane.order === this.current)!;
    const order = this.current + (direction < 0 ? -1 : 1);
    // Turning back to a page that is still leaving reuses it where it is.
    let joined: { pane: Pane; velocity: number } | undefined;
    if (!this.panes.some(pane => pane.order === order)) {
      // A new slide page starts beside the page it follows, moving with it; a cover page starts
      // under the current page, or off to the left when it is an earlier page sliding back over it.
      const now = this.state(previous);
      const start = mode === 'slide' ? now.x + (order - previous.order) * width : order < this.current ? -width : 0;
      const pane: Pane = { slot: this.acquire(), order, x: start };
      this.show(pane, view.scrollX, view.scrollY, start);
      this.panes.push(pane);
      if (mode === 'slide') joined = { pane, velocity: now.velocity };
    }
    this.current = order;
    this.retarget(width, duration, joined);
  }

  /**
   * Every page springs from where it is, at the speed it has, to where the new current page puts it,
   * so a turn taken mid-turn carries on smoothly instead of braking and starting again.
   */
  private retarget(width: number, duration: number, joined?: { pane: Pane; velocity: number }): void {
    const token = ++this.settleToken;
    const animations: Animation[] = [];
    for (const pane of this.panes) {
      const now = pane === joined?.pane ? { x: pane.x, velocity: joined.velocity } : this.state(pane);
      pane.motion?.animation.cancel();
      pane.motion = undefined;
      const to = this.mode === 'slide' ? (pane.order - this.current) * width
        : pane.order < this.current ? -width : 0;
      pane.x = to;
      if (this.mode === 'cover') pane.slot.pane.style.zIndex = String(1000 - pane.order);
      pane.slot.pane.style.transform = `translate(${to}px, 0)`;
      if (Math.abs(to - now.x) < 0.5) continue;
      const animation = pane.slot.pane.animate(
        [{ transform: `translate(${now.x}px, 0)` }, { transform: `translate(${to}px, 0)` }],
        { duration, easing: springEasing(now.x, to, now.velocity, duration) });
      animation.updatePlaybackRate(this.speed);
      pane.motion = { from: now.x, to, velocity: now.velocity, duration, animation };
      animations.push(animation);
    }
    this.completion = Promise.all(animations.map(animation => animation.finished)).then(
      () => token === this.settleToken ? this.settle(token) : undefined, () => { /* superseded */ });
  }

  /**
   * Where a page is and how fast it moves (px per ms at the present speed), from its spring rather
   * than the computed style: no style flush, and the velocity a retarget needs to carry on.
   */
  private state(pane: Pane): { x: number; velocity: number } {
    const motion = pane.motion;
    const time = Number(motion?.animation.currentTime ?? NaN);
    if (!motion || !Number.isFinite(time) || time >= motion.duration) return { x: pane.x, velocity: 0 };
    const { x, velocity } = spring(motion.from, motion.to, motion.velocity, motion.duration, time);
    // The new animation plays at this.speed; keep the speed on screen the same.
    return { x, velocity: velocity * motion.animation.playbackRate / this.speed };
  }

  private show(pane: Pane, x: number, y: number, left: number): void {
    const { slot } = pane;
    slot.frame.contentWindow?.scrollTo(x, y);
    slot.pane.style.transform = `translate(${left}px, 0)`;
    slot.pane.style.zIndex = this.mode === 'cover' ? String(1000 - pane.order) : '';
    slot.pane.classList.add('visible');
  }

  /** Reuses a free slot, or recycles the page farthest from the current one. */
  private acquire(): Slot {
    const used = new Set(this.panes.map(pane => pane.slot));
    const free = this.slots.find(slot => !used.has(slot));
    if (free) return free;
    const far = this.panes.reduce((a, b) => Math.abs(a.order - this.current) >= Math.abs(b.order - this.current) ? a : b);
    this.drop(far);
    return far.slot;
  }

  private drop(pane: Pane): void {
    pane.motion?.animation.cancel();
    pane.slot.pane.classList.remove('visible');
    pane.slot.pane.style.transform = '';
    pane.slot.pane.style.zIndex = '';
    this.panes = this.panes.filter(item => item !== pane);
  }

  /**
   * The current page rests exactly where the live document is. Moving pages are compositor layers,
   * whose text is grayscale, while the live page has ClearType: swapped in one frame the strokes
   * jumped in weight. The live page shows underneath and the resting copy fades out over it.
   * `token` is the turn that came to rest; without one the swap is immediate.
   */
  private settle(token?: number): Promise<void> | void {
    if (this.frame) this.frame.style.visibility = this.frameVisibility;
    if (token !== undefined && this.layer && this.panes.length) {
      const fade = this.fade = this.layer.animate([{ opacity: 1 }, { opacity: 0 }],
        { duration: SETTLE_FADE, easing: 'ease-out' });
      fade.updatePlaybackRate(this.speed);
      return fade.finished.then(() => {
        if (this.fade !== fade || token !== this.settleToken) return;
        this.fade = undefined;
        this.clear();
      }, () => { /* picked up by another turn, or reset */ });
    }
    this.clear();
  }

  private clear(): void {
    this.fade?.cancel();
    this.fade = undefined;
    for (const pane of [...this.panes]) this.drop(pane);
    this.layer?.classList.remove('active');
    if (this.frame) this.frame.style.visibility = this.frameVisibility;
    this.frame = undefined;
  }

  /** Stops any motion at once and shows the live document. */
  reset(): void {
    this.settleToken++;
    if (this.active) this.settle();
  }

  /** Forgets the loaded copies, e.g. when the chapter, typography or highlights change. */
  invalidate(): void {
    clearTimeout(this.loadTimer);
    this.wanted = '';
    this.reset();
    this.key = '';
    this.loading = undefined;
    for (const slot of this.slots) slot.ready = false;
  }
}
