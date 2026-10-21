import { copyHighlights } from './highlight-copy.ts';

/** Strong deceleration, like switching Windows 10 virtual desktops. */
export const PAGE_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';
const SLOTS = 4;

type Slot = { pane: HTMLDivElement; frame: HTMLIFrameElement; ready: boolean };
type Pane = { slot: Slot; order: number; animation?: Animation };
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
  private panes: Pane[] = [];
  private current = 0;
  private mode: StripMode = 'slide';
  private frame?: HTMLIFrameElement;
  private frameVisibility = '';
  private settleToken = 0;

  /** True while pages are moving or about to settle back onto the live document. */
  get active(): boolean { return this.panes.length > 0; }

  ready(key: string): boolean {
    return this.key === key && this.slots.length === SLOTS && this.slots.every(slot => slot.ready);
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
    for (const slot of this.slots) {
      slot.ready = false;
      slot.frame.onload = async () => {
        const target = slot.frame.contentDocument;
        if (!target || this.key !== key) return;
        await target.fonts.ready;
        if (this.key !== key) return;
        copyHighlights(doc, target);
        slot.ready = true;
      };
      slot.frame.srcdoc = html;
    }
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
    update: () => void | Promise<void>): Promise<void> {
    const view = live.contentWindow!;
    if (!this.active || this.mode !== mode) {
      this.reset();
      this.mode = mode;
      this.frame = live;
      this.frameVisibility = live.style.visibility;
      this.panes = [{ slot: this.acquire(), order: 0 }];
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
    if (!this.panes.some(pane => pane.order === order)) {
      const pane: Pane = { slot: this.acquire(), order };
      // A new slide page starts beside the page it follows; a cover page starts under the current
      // page, or off to the left when it is an earlier page sliding back over it.
      const start = mode === 'slide' ? this.offset(previous) + (order - previous.order) * width
        : order < this.current ? -width : 0;
      this.show(pane, view.scrollX, view.scrollY, start);
      this.panes.push(pane);
    }
    this.current = order;
    this.retarget(width, duration);
  }

  /** Every page animates from its present position to where the new current page puts it. */
  private retarget(width: number, duration: number): void {
    const token = ++this.settleToken;
    const animations: Animation[] = [];
    for (const pane of this.panes) {
      const from = this.offset(pane);
      pane.animation?.cancel();
      const to = this.mode === 'slide' ? (pane.order - this.current) * width
        : pane.order < this.current ? -width : 0;
      if (this.mode === 'cover') pane.slot.pane.style.zIndex = String(1000 - pane.order);
      pane.slot.pane.style.transform = `translate(${to}px, 0)`;
      if (Math.abs(to - from) < 0.5) { pane.animation = undefined; continue; }
      pane.animation = pane.slot.pane.animate(
        [{ transform: `translate(${from}px, 0)` }, { transform: `translate(${to}px, 0)` }],
        { duration, easing: PAGE_EASING });
      animations.push(pane.animation);
    }
    Promise.all(animations.map(animation => animation.finished)).then(
      () => { if (token === this.settleToken) this.settle(); }, () => { /* superseded */ });
  }

  /** Current horizontal position, mid-animation included. */
  private offset(pane: Pane): number {
    return new DOMMatrixReadOnly(getComputedStyle(pane.slot.pane).transform).m41;
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
    pane.animation?.cancel();
    pane.slot.pane.classList.remove('visible');
    pane.slot.pane.style.transform = '';
    pane.slot.pane.style.zIndex = '';
    this.panes = this.panes.filter(item => item !== pane);
  }

  /** The current page rests exactly where the live document is, so the swap is invisible. */
  private settle(): void {
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
    this.reset();
    this.key = '';
    for (const slot of this.slots) slot.ready = false;
  }
}
