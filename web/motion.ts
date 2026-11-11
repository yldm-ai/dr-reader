import { copyHighlights } from './highlight-copy.ts';
import { PAGE_EASING, PageStrip } from './page-strip.ts';

/** A loaded copy of the page on show, kept so the next transition can cover the live page at once. */
type Standby = {
  key: string; revision: number; doc: Document | null; x: number; y: number;
  overlay: HTMLDivElement; controller: AbortController; pane: HTMLDivElement | null;
  /** Further loaded copies of the chapter for the turn to place where it needs them (see place). */
  pool: HTMLDivElement[];
};

/** Ready copies of the chapter a transition places instead of loading (see place). */
type Pool = { doc: Document | null; panes: HTMLDivElement[] };

/**
 * How many copies of the chapter a transition places besides the one covering the live page: each
 * StPageFlip page has its own (a spread four; a single soft page three, a hard one two), a fold its
 * uncovered page and either the facing page's face or, turning back, the arriving page.
 */
export function poolSize(effect: string, spread: boolean): number {
  // StPageFlip turns also lay one more copy flat over the landed pages (see turnPage).
  if (effect === 'turn') return spread ? 5 : 4;
  if (effect === 'turn-hard') return spread ? 5 : 3;
  if (effect === 'turn-fold' || effect === 'turn-fold-edge') return 2;
  return effect === 'none' ? 0 : 1;
}

/** Waits for the main thread to be idle, so background copies do not hold up reading. */
const idle = () => new Promise<void>(resolve => 'requestIdleCallback' in window
  ? requestIdleCallback(() => resolve(), { timeout: 600 }) : setTimeout(resolve, 50));

type Transition = {
  controller: AbortController;
  overlay: HTMLDivElement;
  frame: HTMLIFrameElement;
  visibility: string;
  animations: Animation[];
  cleaned: boolean;
  disposeFlip?: () => void;
  pool?: Pool;
};

/** Distance (CSS px) over which the spread spine fades as a soft flap's corner reaches it. */
const SPINE_FADE = 36;
/**
 * Share of a StPageFlip turn's path over which the sheet slows to rest (see settle). The library
 * moves the sheet at one speed and stops it dead on the page; the last stretch now eases down.
 */
const SETTLE = .22;

/**
 * Replays a turn's frames at the library's pace and then slows smoothly to rest over the last
 * SETTLE of the path, ending at zero speed. The middle keeps its speed, so the turn takes SETTLE
 * longer. The frames are one per pixel or so of the path, so picking the nearest stays smooth
 * even at the slow end.
 */
export function settle<T>(frames: T[], time: number): { frames: T[]; time: number } {
  const count = frames.length;
  if (count < 3) return { frames, time };
  const total = Math.round((count - 1) * (1 + SETTLE)) + 1;
  // Normalised to the longer turn: the original pace, then a constant deceleration.
  const speed = 1 + SETTLE, cruise = (1 - SETTLE) / (1 + SETTLE);
  const braking = speed / (2 * (1 - cruise));
  return { time: time * (1 + SETTLE), frames: Array.from({ length: total }, (_, index) => {
    const at = index / (total - 1);
    const share = at <= cruise ? speed * at : 1 - braking * (1 - at) ** 2;
    return frames[Math.min(count - 1, Math.round(share * (count - 1)))];
  }) };
}

/** Milliseconds over which a landed page turn fades into the live page (see turnPage). */
const LANDING_FADE = 160;

/** Two read-only EPUB snapshots; the live document commits exactly once underneath. */
export class ReaderMotion {
  private allowed = true;
  private active: Transition | null = null;
  private readonly strip = new PageStrip();
  private stripKey = '';
  private revision = 0;
  private speed = 1;
  private standby: Standby | null = null;
  private standbyTimer = 0;
  private motionKey = '';
  private surface: HTMLElement | null = null;
  private poolSize = 0;

  /** Wheel input keeps every page transition, speeding up when more turns are waiting. */
  setSpeed(speed: number) {
    this.speed = speed;
    this.strip.setSpeed(speed);
    for (const animation of this.active?.animations ?? []) animation.updatePlaybackRate(speed);
  }

  async finished() { await this.strip.finished(); }

  setAllowed(value: boolean) { this.allowed = value; if (!value) this.cancel(); }
  enabled(effect: string) { return this.allowed && effect !== 'none'; }

  /**
   * Called once the live chapter's layout has settled. Slides and covers keep loaded copies of
   * it so in-chapter turns start immediately; `key` changes with chapter, layout or highlights.
   */
  prepare(element: HTMLElement, effect: string, key: string, spread = false) {
    const frame = element.querySelector<HTMLIFrameElement>('#book-frame');
    const size = poolSize(effect, spread);
    if (key !== this.motionKey || size !== this.poolSize || effect === 'none' || !this.allowed) this.dropStandby();
    this.motionKey = key; this.surface = element; this.poolSize = size;
    // In-chapter slides and covers keep their own loaded copies (the strip below).
    if (frame && this.allowed && effect !== 'none' && effect !== 'slide' && effect !== 'cover') this.scheduleStandby();
    if (!frame || !this.allowed || (effect !== 'slide' && effect !== 'cover')) { this.strip.invalidate(); return; }
    if (key !== this.stripKey && !this.strip.active) this.strip.invalidate();
    this.stripKey = key;
    this.strip.prepare(element, frame, key);
  }
  private cleanup(transaction: Transition) {
    if (transaction.cleaned) return;
    transaction.cleaned = true;
    for (const animation of transaction.animations) animation.cancel();
    transaction.disposeFlip?.();
    transaction.overlay.remove();
    transaction.frame.style.visibility = transaction.visibility;
    if (this.active === transaction) this.active = null;
  }
  /**
   * Every transition first covers the live page with a copy of it, and loading that copy (the whole
   * chapter again, its images decoded) was most of the pause between a click and the page moving.
   * Once the page has settled, a copy of it is loaded in the background into an invisible overlay;
   * the next transition takes it over if the page has not changed since.
   */
  private scheduleStandby() {
    clearTimeout(this.standbyTimer);
    this.standbyTimer = window.setTimeout(() => this.buildStandby(), 150);
  }
  private buildStandby() {
    const surface = this.surface, frame = surface?.querySelector<HTMLIFrameElement>('#book-frame');
    if (!surface || !frame || !this.allowed || this.active || !frame.isConnected) return;
    const view = frame.contentWindow, doc = frame.contentDocument;
    if (!view || !doc?.body) return;
    const current = this.standby;
    if (current && current.key === this.motionKey && current.revision === this.revision && current.doc === doc &&
      current.x === view.scrollX && current.y === view.scrollY) return;
    this.dropStandby();
    const overlay = document.createElement('div');
    overlay.className = 'page-motion-standby'; overlay.setAttribute('aria-hidden', 'true');
    // Invisible but laid out: hidden visibility would not hold, the loaded pane opts back in.
    overlay.style.opacity = '0';
    surface.append(overlay);
    const standby: Standby = { key: this.motionKey, revision: this.revision, doc, x: view.scrollX, y: view.scrollY,
      overlay, controller: new AbortController(), pane: null, pool: [] };
    this.standby = standby;
    const signal = standby.controller.signal, size = this.poolSize;
    // The covering copy first; the rest one at a time when the reader is idle. A turn takes whatever
    // is ready and loads the remainder itself.
    void (async () => {
      standby.pane = await this.snapshot(frame, overlay, signal);
      for (let index = 0; index < size && this.standby === standby; index++) {
        await idle();
        if (this.standby !== standby) return;
        const pane = await this.snapshot(frame, overlay, signal, false);
        standby.pool.push(pane);
      }
    })().catch(() => { if (this.standby === standby) this.dropStandby(); });
  }
  /** The ready copy, if it still shows exactly what the live frame does; it then belongs to the caller. */
  private takeStandby(frame: HTMLIFrameElement): Standby | null {
    const standby = this.standby, view = frame.contentWindow;
    const fresh = standby?.pane && view && standby.key === this.motionKey && standby.revision === this.revision &&
      standby.doc === frame.contentDocument && standby.x === view.scrollX && standby.y === view.scrollY;
    if (!fresh) { this.dropStandby(); return null; }
    this.standby = null;
    return standby;
  }
  private dropStandby() {
    clearTimeout(this.standbyTimer);
    this.standby?.controller.abort();
    this.standby?.overlay.remove();
    this.standby = null;
  }
  /**
   * Puts a copy of source (the live frame, or the snapshot of the page turned from) into parent.
   * Within a chapter every copy is of the same document at another scroll position, so a ready copy
   * from the pool is moved there and scrolled, instead of loading the chapter again. moveBefore keeps
   * the moved frame's document; appending would reload it. Otherwise it loads a fresh snapshot.
   * A copy that must wait for its moment (`shown` false) stays hidden: a turn awaits all its copies,
   * and one shown at once (a ready copy) showed for as long as the others took to load.
   */
  private async place(transaction: Transition, source: HTMLIFrameElement, parent: HTMLElement, signal: AbortSignal,
    shown = true) {
    const pool = transaction.pool, from = source.contentWindow;
    // The live frame qualifies only if the turn stayed in the chapter the copies were made of.
    const same = source !== transaction.frame || source.contentDocument === pool?.doc;
    const pane = same && from && 'moveBefore' in Element.prototype ? pool?.panes.pop() : undefined;
    if (pane) {
      try {
        pane.style.visibility = shown ? 'visible' : 'hidden';
        parent.moveBefore(pane, null);
        pane.querySelector('iframe')!.contentWindow!.scrollTo(from!.scrollX, from!.scrollY);
        return pane;
      } catch { pane.remove(); }
    }
    return this.snapshot(source, parent, signal, shown);
  }
  cancel() {
    this.dropStandby();
    this.revision++;
    this.strip.reset();
    if (this.active) {
      this.active.controller.abort();
      this.cleanup(this.active);
    }
  }
  private snapshot(source: HTMLIFrameElement, parent: HTMLElement, signal: AbortSignal, shown = true): Promise<HTMLDivElement> {
    const doc = source.contentDocument;
    if (!doc?.body) return Promise.reject(new DOMException('No page to capture', 'SnapshotError'));
    const html = '<!doctype html>' + doc.documentElement.outerHTML;
    const x = doc.defaultView!.scrollX, y = doc.defaultView!.scrollY;
    const pane = document.createElement('div'); pane.className = 'motion-page'; pane.style.visibility = 'hidden';
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-same-origin');
    frame.setAttribute('aria-hidden', 'true'); frame.tabIndex = -1;
    pane.append(frame);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
        frame.onload = null; frame.onerror = null;
        if (error) reject(error);
        else { if (shown) pane.style.visibility = 'visible'; resolve(pane); }
      };
      const abort = () => finish(new DOMException('Animation canceled', 'AbortError'));
      const timer = setTimeout(() => finish(new DOMException('Page snapshot timed out', 'SnapshotError')), 1800);
      signal.addEventListener('abort', abort, { once: true });
      frame.onerror = () => finish(new DOMException('Page snapshot failed', 'SnapshotError'));
      frame.onload = async () => {
        const target = frame.contentDocument;
        if (!target) return finish(new DOMException('Page snapshot failed', 'SnapshotError'));
        try {
          await target.fonts.ready;
          if (signal.aborted) return abort();
          target.defaultView!.scrollTo(x, y);
          copyHighlights(doc, target);
          requestAnimationFrame(() => finish());
        } catch { finish(new DOMException('Page snapshot failed', 'SnapshotError')); }
      };
      frame.srcdoc = html;
      parent.append(pane);
      if (signal.aborted) abort();
    });
  }

  private async turnPage(transaction: Transition, oldPage: HTMLDivElement,
    effect: string, duration: number, direction: number, corner: 'top' | 'bottom', spread = false) {
    // Keep the browser-only engine (StPageFlip, vendored in web/vendor/page-flip) out of Node-side
    // reader tests and non-turn loads.
    const { PageFlip } = await import('./vendor/page-flip/PageFlip.ts');
    const { overlay, controller } = transaction;
    const signal = controller.signal;
    const host = document.createElement('div');
    host.className = 'stpageflip-host';
    // Build the engine underneath the old snapshot; removing that snapshot reveals
    // the first frame of the turn. Visibility cannot hide it: the panes opt back in.
    overlay.prepend(host);
    const forward = direction > 0;
    const density = effect === 'turn-hard' ? 'hard' : 'soft';
    // In single-page mode StPageFlip turns back by sliding a flat sheet in from the
    // hidden left half. A real previous page instead uncurls from the edge, which
    // is a forward curl played backwards: previous page -> current page, reversed.
    // A two-page spread uses StPageFlip's own landscape book, which already turns both ways.
    const unturn = !spread && !forward && density === 'soft';
    const ahead = forward || unturn;
    const width = overlay.clientWidth, pageWidth = spread ? width / 2 : width;
    host.dataset.layout = spread ? 'double' : 'single';
    host.dataset.density = density;
    host.dataset.corner = corner;
    host.dataset.direction = forward ? 'forward' : 'backward';
    // Only a single-page soft curl needs a separate copy of the curling page for its flap.
    const copied = !spread && density === 'soft';
    const pages = Array.from({ length: spread ? 4 : copied ? 3 : 2 }, () => {
      const page = document.createElement('div');
      page.className = 'stpageflip-page';
      page.dataset.density = density;
      page.style.width = `${pageWidth}px`;
      page.style.height = `${overlay.clientHeight}px`;
      return page;
    });
    // Spreads: [left, right] of the spread turned from, then of the one turned to (in book order).
    const startPage = spread ? (forward ? 0 : 2) : ahead ? 0 : 1;
    const flip = new PageFlip(host, {
      width: pageWidth, height: overlay.clientHeight, size: 'fixed',
      usePortrait: !spread, autoSize: false, startPage,
      drawShadow: true, maxShadowOpacity: .32, flippingTime: duration,
      showCover: false, useMouseEvents: false, showPageCorners: false,
      mobileScrollSupport: false, clickEventForward: false,
    });
    transaction.disposeFlip = () => flip.destroy();
    const aborted = () => new DOMException('Page turn canceled', 'AbortError');
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(aborted());
      signal.addEventListener('abort', onAbort, { once: true });
      flip.on('init', () => { signal.removeEventListener('abort', onAbort); resolve(); });
      flip.loadFromHTML(pages);
      if (signal.aborted) onAbort();
    });
    if (signal.aborted) throw aborted();
    host.dataset.orientation = flip.getOrientation() ?? '';
    // Portrait lays out one full-width page even in a wide window; a spread needs two.
    if (flip.getOrientation() !== (spread ? 'landscape' : 'portrait')) throw new Error('无法初始化翻页');
    // Single: [resting page, page revealed under the curl, copy of the resting page for the flap].
    // Spread: book order, so a backward turn starts on the second spread and flips back.
    // The new page is copied straight from the live frame, which already shows it; the old one only
    // survives in its snapshot.
    const old = oldPage.querySelector('iframe')!, live = transaction.frame;
    const sources = spread ? (forward ? [old, old, live, live] : [live, live, old, old])
      : (forward ? [old, live, old] : [live, old, live]).slice(0, pages.length);
    // Load snapshots after StPageFlip has reparented the shells: moving an iframe resets its document.
    // The destination as it will look landed, laid flat over the engine and shown when it lands.
    const [landing, ...panes] = await Promise.all([this.place(transaction, live, overlay, signal, false),
      ...pages.map((page, index) => this.place(transaction, sources[index], page, signal))]);
    landing.style.visibility = 'hidden'; landing.style.zIndex = '2';
    if (signal.aborted) throw aborted();
    // Each half of a spread shows the whole spread snapshot, cropped by its half-width shell.
    if (spread) panes.forEach((pane, index) => {
      pane.style.right = 'auto';
      pane.style.width = `${width}px`;
      pane.style.left = index % 2 ? `${-pageWidth}px` : '0';
    });
    for (let index = 0; index < pages.length; index++) {
      const page = flip.getPage(index);
      page.setDensity(density);
      page.setDrawingDensity(density);
    }
    // StPageFlip shows the resting item with an inline display rule. Keep each
    // snapshot document at the real page viewport while hidden items are laid out.
    for (const frame of host.querySelectorAll<HTMLIFrameElement>('.motion-page iframe')) {
      // PageFlip temporarily collapses inactive page shells while it changes
      // spreads. Keep each captured document at the real viewport size so its
      // layout and horizontal scroll offset remain stable during the turn.
      frame.style.width = `${overlay.clientWidth}px`;
      frame.style.height = `${overlay.clientHeight}px`;
      frame.style.visibility = 'visible';
      frame.contentWindow?.dispatchEvent(new Event('resize'));
    }
    host.dataset.pageCount = String(flip.getPageCount());
    // Pages that will move (all but the resting page or spread at startPage) get their
    // own compositor layer now, while the old snapshot still covers the engine, so it is
    // rasterized before the first frame. Otherwise each one is promoted (and its page-sized
    // snapshot rasterized, ~25 ms in WebView2) mid-turn, or repainted on every frame,
    // dropping frames. The resting pages stay in the root layer and keep ClearType text.
    // StPageFlip rewrites each page's cssText as it draws, so drawFrame reapplies the hint.
    const resting = spread ? (forward ? [0, 1] : [2, 3]) : [startPage];
    const moving = [...host.querySelectorAll<HTMLElement>('.stf__item')].filter((_, index) => !resting.includes(index));
    const promote = () => { for (const item of moving) item.style.willChange = 'transform'; };
    promote();
    // Portrait soft flips normally clone a page synchronously. A ready copy preserves
    // the actual column offset, fonts and highlights instead of flashing a fresh iframe.
    // A hard page must keep the library's own copy (the page itself): a separate
    // copy swings back flat over the single visible page and then snaps away.
    if (copied) flip.getPage(0).newTemporaryCopy = () => flip.getPage(2);
    // StPageFlip picks frames by elapsed time and ends as soon as it passes the
    // last one, so the landing pose is never painted. A backward sheet then jumps
    // the last ~40px when the live page returns. Hold the final pose briefly.
    const render = flip.getRender();
    let landingShadowOpacity = 1;
    // A soft spread lands a fraction of a pixel short of the spine (see startAnimation): the page
    // being turned still stood there as a hairline through the hold and the landing fade, a white
    // line down the middle when that page was an illustration on a dark theme. It fades out as the
    // sheet comes down, when all that is left of it is that sliver.
    let frontOpacity = 1;
    const front = forward ? 1 : 2;
    // The spine copy that covered the old snapshot; it moves into the engine at the reveal.
    const spine = overlay.querySelector<HTMLElement>(':scope > .stpageflip-spine');
    // The engine records each frame's styles for the compositor; the spine fade is one of them.
    if (spine) render.track(spine);
    // StPageFlip positions pages and shadows with 3D transforms even when nothing
    // is rotated. Any 3D layer under a page drops its text from ClearType to
    // grayscale, so it thins as the turn starts and sharpens again when the live
    // page returns. Keep everything 2D except a page that is visibly turning.
    const drawFrame = render.drawFrame.bind(render);
    render.drawFrame = () => {
      drawFrame();
      promote();
      for (const item of host.querySelectorAll<HTMLElement>('.stf__item')) {
        const pose = /^translate3d\((\S+)px, (\S+)px, 0px\)(?: rotate\((\S+)rad\)| rotateY\((\S+)deg\))?$/
          .exec(item.style.transform);
        if (!pose) continue;
        // Tilts this small are invisible but still cost ClearType.
        const hinge = Number(pose[4] ?? 0) % 360;
        if (Math.abs(Number(pose[3] ?? 0)) > 1e-3 || Math.min(Math.abs(hinge), 360 - Math.abs(hinge)) > .5) continue;
        let x = Number(pose[1]), y = Number(pose[2]);
        // The landing pose stops a fraction of a pixel short; settle it on the page.
        if (Math.abs(x) < 1.5 && Math.abs(y) < 1.5) x = y = 0;
        item.style.transform = `translate(${x}px, ${y}px)`;
        // A hidden backface also forces a layer; a page facing forward does not need it.
        item.style.backfaceVisibility = 'visible';
      }
      if (spread && density === 'soft') {
        const sheet = host.querySelectorAll<HTMLElement>('.stf__item')[front];
        if (sheet) sheet.style.opacity = String(frontOpacity);
      }
      // Shadows only ever mirror (rotateY 180deg) around their own edge.
      for (const shadow of host.querySelectorAll<HTMLElement>(
        '.stf__outerShadow, .stf__innerShadow, .stf__hardShadow, .stf__hardInnerShadow')) {
        if (spread && density === 'soft') shadow.style.opacity = String(landingShadowOpacity);
        shadow.style.transform = shadow.style.transform
          .replace(/translate3d\((\S+), (\S+), 0px\)/, 'translate($1, $2)').replace('rotateY(180deg)', 'scaleX(-1)');
      }
    };
    const startAnimation = render.startAnimation.bind(render);
    let first: (() => void) | undefined;
    render.startAnimation = (frames, time, done) => {
      if (spread && density === 'soft') {
        // StPageFlip's exact edge endpoint degenerates its line intersections and
        // leaves the previous valid curl on screen. Land just inside the edge;
        // the flat-pose normalization above then aligns it with the live spread.
        const { pageWidth, height } = render.getRect();
        const margin = height / 10, inset = .1;
        const flipper = flip.getFlipController();
        frames = frames.map((_, index) => {
          const t = index / Math.max(1, frames.length - 1);
          return () => {
            const edge = margin + (inset - margin) * t;
            const x = pageWidth - margin + (inset - 2 * pageWidth + margin) * t;
            flipper.do({ x, y: corner === 'bottom' ? height - edge : edge });
            // The inner gradient has fixed opacity stops even when the library's
            // shadow strength reaches zero. Fade the whole shadow before cleanup.
            landingShadowOpacity = Math.min(1, (1 - t) / .1);
            frontOpacity = Math.min(1, (1 - t) / .05);
            // The soft flap slides over the spine instead of hinging on it. The crease
            // fades as the flap's free corner (x, relative to the spine) closes in, stays
            // hidden under it, and returns as the sheet settles, so it never pops.
            if (spine) spine.style.opacity = String(Math.max(0, Math.min(1, Math.max(x / SPINE_FADE, (t - .9) / .1))));
          };
        });
      }
      if (unturn) {
        // Retrace the library's forward path backwards. Its corner is held height/10
        // inside the page, which tilts the fold toward the chosen corner; a corner
        // sliding along the edge would fold straight down for top and bottom alike.
        // A last short leg settles the lifted corner onto the page instead of snapping.
        const { pageWidth, height } = render.getRect();
        const bottom = corner === 'bottom', margin = height / 10;
        const edge = (inset: number) => bottom ? height - inset : inset;
        // The fold calculation rejects points exactly on the page edge; such a frame
        // draws nothing and lets the resting previous page flash through.
        const path = [{ x: 1 - pageWidth, y: edge(1) }, { x: pageWidth - margin, y: edge(margin) },
          { x: pageWidth - 1, y: edge(1) }];
        const legs = [Math.hypot(path[1].x - path[0].x, path[1].y - path[0].y),
          Math.hypot(path[2].x - path[1].x, path[2].y - path[1].y)];
        const flipper = flip.getFlipController();
        frames = frames.map((_, index) => {
          let distance = index / Math.max(1, frames.length - 1) * (legs[0] + legs[1]);
          const leg = distance <= legs[0] ? 0 : 1;
          if (leg) distance -= legs[0];
          const t = legs[leg] ? distance / legs[leg] : 1;
          const point = { x: path[leg].x + (path[leg + 1].x - path[leg].x) * t,
            y: path[leg].y + (path[leg + 1].y - path[leg].y) * t };
          return () => flipper.do(point);
        });
      }
      ({ frames, time } = settle(frames, time));
      first = frames[0];
      const hold = Math.ceil(frames.length * 34 / Math.max(time, 1));
      // The moved pages keep their layers while the landing pose is held. Leaving them there
      // switched their text from grayscale to ClearType in a single frame, a visible jump in
      // stroke weight on a page that had just come to rest; the landing fade below eases it.
      const pose = frames.at(-1)!;
      startAnimation([...frames.slice(0, -1), pose, ...Array(hold).fill(pose)],
        time * (frames.length + hold) / frames.length, done);
    };
    await new Promise(resolve => requestAnimationFrame(resolve));
    if (signal.aborted) throw aborted();
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => finish(aborted());
      const timer = setTimeout(() => finish(new Error('翻页动画超时')), Math.max(2500, duration * 4));
      const finish = (error?: Error) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        flip.off('changeState');
        if (error) reject(error); else resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      flip.on('changeState', event => {
        host.dataset.state = String(event.data);
        if (event.data !== 'read') return;
        // The flip has landed and the engine's last frame shows the landing pose. Stop drawing:
        // its next frame would show the book's resting spread, which after an uncurl (a forward
        // flip replayed backwards) is the page being left. That page then showed through the
        // landing fade, flashing the old page after every backward single-page turn.
        render.stop();
        finish();
      });
      if (ahead) flip.flipNext(corner); else flip.flipPrev(corner);
      // The resting spread of an uncurl is the previous page. Pose the fully turned
      // first frame now so the paint that reveals the engine still shows the old page.
      if (unturn) { first?.(); render.drawFrame(); }
      // Same paint as the reveal: the spine stays on top of the engine's pages and shadows.
      if (spine) host.querySelector('.stf__block')?.append(spine);
      oldPage.remove();
      if (signal.aborted) onAbort();
    });
    // The landed pages still sit in the engine's layers at fractional offsets, resampled and a little
    // soft, and the landing fade blurred that into the sharp live page. A flat copy of the destination
    // takes their place, with the spine copy above it as the live spine is above the page.
    if (spine) { overlay.append(spine); spine.style.zIndex = '6'; }
    landing.style.visibility = 'visible';
    host.style.display = 'none';
    this.land(transaction);
  }

  /**
   * Landing: the turned pages are compositor layers, whose text Chromium draws in grayscale,
   * while the live page underneath has ClearType. Show the live page and fade the landed
   * sheet out over it, so the text eases into ClearType instead of jumping in stroke weight.
   */
  private land(transaction: Transition) {
    transaction.frame.style.visibility = transaction.visibility;
    const fade = transaction.overlay.animate([{ opacity: 1 }, { opacity: 0 }], { duration: LANDING_FADE, easing: 'ease-out', fill: 'forwards' });
    fade.updatePlaybackRate(this.speed);
    transaction.animations.push(fade);
  }

  /**
   * grabfold's fold (web/fold-turn.ts): the sheet folds along the perpendicular bisector of where
   * it was taken and where it is, and its other face is carried over the crease. The sheet's face
   * stays where it is, at the bottom. The page the fold uncovers and the folded face are each seen
   * through a window that turns with the crease (see fold-turn.ts), so both are fresh copies made
   * inside their windows: moving an iframe resets its document.
   * Single page: forward folds the page off over its left edge onto a blank back; backward
   * brings the previous page in over the spine and lays it flat, the fold run backwards.
   * Spread: the turning half carries a copy of the facing page it lands as. A corner turn takes the
   * sheet by the corner the pointer is nearest; an edge turn (`edge`) by the middle of its free edge.
   */
  private async foldPage(transaction: Transition, oldPage: HTMLDivElement,
    duration: number, direction: number, corner: 'top' | 'bottom', spread: boolean, edge: boolean) {
    const { overlay, controller, frame: live } = transaction;
    const signal = controller.signal;
    const aborted = () => new DOMException('Page turn canceled', 'AbortError');
    const { foldFrames } = await import('./fold-turn.ts');
    const forward = direction > 0;
    const width = overlay.clientWidth, height = overlay.clientHeight, pageWidth = spread ? width / 2 : width;
    // turnPage receives the duration at the current wheel speed. The keyframes run at speed 1 and the
    // playback rate carries the speed, so a later setSpeed retimes them like the other animations.
    const time = duration * this.speed;
    const plan = foldFrames({ width: pageWidth, height, spread, forward, corner, edge, duration: time });
    overlay.dataset.fold = spread ? 'spread' : plan.arriving ? 'arriving' : 'single';
    // Single backwards the arriving page is the sheet and the page on show is the one uncovered.
    // The live frame already shows the new page; the old one survives only in its snapshot.
    const oldSource = oldPage.querySelector('iframe')!;
    const underSource = plan.arriving ? oldSource : live;
    const layer = (className: string, parent: HTMLElement = overlay) => {
      const element = document.createElement('div');
      element.className = className;
      parent.append(element);
      return element;
    };
    const window = (parent: HTMLElement) => {
      const half = layer('fold-half', parent);
      half.style.width = half.style.height = `${plan.reach}px`;
      return { half, plane: layer('fold-plane', half) };
    };
    const box = (className: string) => {
      const element = layer(className);
      element.style.left = `${plan.left}px`; element.style.width = `${pageWidth}px`;
      // Until the animations hold them, the windows would show their pages unturned.
      element.style.opacity = '0';
      return element;
    };
    // The uncovered page, kept to the cell, with the shadow the standing fold throws on it.
    const uncoveredCell = box('fold-uncovered');
    const uncovered = window(uncoveredCell);
    const page = layer('fold-page', uncovered.plane);
    page.style.left = `${-plan.left}px`; page.style.width = `${width}px`; page.style.height = `${height}px`;
    const shadow = layer('fold-band fold-shadow', uncovered.half);
    shadow.style.width = `${plan.castSpan}px`; shadow.style.height = `${plan.reach}px`;
    shadow.style.backgroundImage = plan.castGradient;
    // The folded face, carried over the crease by a translate and a rotate.
    const cell = box('fold-cell');
    const folded = window(cell);
    const flap = layer('fold-flap', folded.plane);
    flap.style.width = `${pageWidth}px`; flap.style.height = `${height}px`;
    let lift: HTMLElement | null = null;
    let face: HTMLElement | null = null;
    if (spread) {
      // The face of the facing page the half lands as: the new spread's left half going forward,
      // its right half going back. The copy is the whole spread, cropped by the flap.
      face = layer('fold-face', flap);
      face.style.width = `${width}px`;
      face.style.left = forward ? '0' : `${-pageWidth}px`;
    } else {
      // A single page has no facing page: its back is blank paper, lightened as it lifts off the table.
      layer('motion-page fold-back', flap);
      lift = layer('fold-lift', flap);
    }
    const roll = layer('fold-band', flap);
    roll.style.width = `${plan.rollSpan}px`; roll.style.height = `${plan.reach}px`;
    roll.style.backgroundImage = plan.rollGradient;
    // Arriving, the sheet at the bottom is the new page, under the old one until the turn starts.
    const loads = await Promise.all([this.place(transaction, underSource, page, signal),
      face && this.place(transaction, live, face, signal), plan.arriving ? this.place(transaction, live, overlay, signal, false) : null]);
    if (signal.aborted) throw aborted();
    const sheet = loads[2];
    if (sheet) { sheet.style.zIndex = '1'; sheet.style.visibility = 'hidden'; }
    oldPage.style.zIndex = '1';
    // The spine copy stays above the pages, as the live spine does over the landed spread.
    overlay.querySelector<HTMLElement>(':scope > .stpageflip-spine')?.style.setProperty('z-index', '6');
    // Created in one task, the animations start on the same frame; their first keyframe is the
    // page on show (forward, the fold has not started; backward, the arriving page is folded away),
    // so the windows can replace the panes in the same task.
    const options: KeyframeAnimationOptions = { duration: time, easing: 'linear', fill: 'both' };
    const animations = [
      uncovered.half.animate(plan.uncoveredHalf, options), uncovered.plane.animate(plan.uncoveredPlane, options),
      shadow.animate(plan.cast, options), folded.half.animate(plan.flapHalf, options),
      folded.plane.animate(plan.flapPlane, options), flap.animate(plan.flap, options), roll.animate(plan.roll, options),
      ...lift ? [lift.animate(plan.lift, options)] : [],
    ];
    for (const animation of animations) animation.updatePlaybackRate(this.speed);
    transaction.animations.push(...animations);
    uncoveredCell.style.opacity = cell.style.opacity = '';
    // Arriving, the window now shows the old page and the new one lies under it; otherwise the old
    // page stays where it is as the sheet.
    if (sheet) { sheet.style.visibility = 'visible'; oldPage.style.visibility = 'hidden'; }
    await Promise.all(animations.map(animation => animation.finished));
    if (signal.aborted) throw aborted();
    // Landed, the destination was still drawn through the turned windows: two rotations that cancel
    // only to rounding, at fractional offsets, so its text was resampled and soft, and the landing
    // fade blurred it into the sharp live page. Lay the copy that shows it flat on the page instead,
    // moved out of its window (moveBefore keeps its document), and take the turning parts away. The
    // uncovered copy holds the whole destination (a spread's both halves); turning back on a single
    // page, the destination is the flat sheet already underneath.
    if (!plan.arriving && 'moveBefore' in Element.prototype) {
      try {
        overlay.moveBefore(page, null);
        page.style.left = '0'; page.style.zIndex = '5';
      } catch { /* Left in its window: the turned copy still shows the right page. */ }
    }
    if (plan.arriving || page.parentElement === overlay) { uncoveredCell.remove(); cell.remove(); }
    this.land(transaction);
  }
  async change(element: HTMLElement, effect: string, duration: number, direction: number, update: () => void | Promise<void>, retainPage = false,
    corner: 'top' | 'bottom' = 'top', spread = false) {
    const animated = this.enabled(effect);
    if (!animated && !retainPage) { await update(); return; }
    const frame = element.querySelector<HTMLIFrameElement>('#book-frame');
    if (!frame) { await update(); return; }
    // In-chapter slides and covers run on the resident strip: they start in the same frame and
    // a further turn retargets them instead of waiting for them to finish.
    const revision = this.revision, key = this.stripKey;
    const resident = (effect === 'slide' || effect === 'cover') && animated && !retainPage && !spread &&
      await this.strip.readyForTurn(element, frame, key);
    if (revision !== this.revision || key !== this.stripKey) return;
    if (resident) {
      if (this.active) { this.active.controller.abort(); this.cleanup(this.active); }
      await this.strip.turn(frame, effect, direction, duration, update);
      return;
    }
    const ready = this.takeStandby(frame);
    this.cancel();
    const overlay = ready?.overlay ?? document.createElement('div'); overlay.className = `page-motion page-motion-${effect}`;
    overlay.setAttribute('aria-hidden', 'true'); overlay.style.visibility = 'hidden'; overlay.style.opacity = '';
    if (!ready) element.append(overlay);
    const transaction: Transition = { controller: new AbortController(), overlay, frame,
      visibility: frame.style.visibility, animations: [], cleaned: false, pool: ready ? { doc: ready.doc, panes: ready.pool } : undefined };
    this.active = transaction;
    let committed: Promise<void> | undefined;
    const commit = () => committed ??= Promise.resolve().then(update);
    // A spread turn keeps the spine over the old snapshot until turnPage hands it to the pages.
    if (spread && effect.startsWith('turn')) {
      const spine = document.createElement('div');
      spine.className = 'stpageflip-spine';
      overlay.append(spine);
    }
    try {
      const oldPage = ready?.pane ?? await this.snapshot(frame, overlay, transaction.controller.signal);
      overlay.style.visibility = 'visible';
      frame.style.visibility = 'hidden';
      await commit();
      if (transaction.controller.signal.aborted) return;
      // Document replacement must stay covered even when turn animations are off.
      if (!animated) return;
      // Page turns copy the new page straight from the live frame into wherever they show it.
      if (effect.startsWith('turn')) {
        if (effect === 'turn-fold' || effect === 'turn-fold-edge')
          await this.foldPage(transaction, oldPage, duration / this.speed, direction, corner, spread, effect === 'turn-fold-edge');
        else await this.turnPage(transaction, oldPage, effect, duration / this.speed, direction, corner, spread);
        await Promise.all(transaction.animations.map(animation => animation.finished));
        return;
      }
      const newPage = await this.place(transaction, frame, overlay, transaction.controller.signal);
      if (transaction.controller.signal.aborted) return;
      const sign = direction < 0 ? -1 : 1;
      const options: KeyframeAnimationOptions = { duration, fill: 'both', easing: PAGE_EASING };
      const animate = (node: HTMLElement, keyframes: Keyframe[]) => {
        const animation = node.animate(keyframes, options);
        animation.updatePlaybackRate(this.speed);
        transaction.animations.push(animation); return animation;
      };
      if (effect === 'slide') {
        animate(oldPage, [{ transform: 'translateX(0)' }, { transform: `translateX(${-sign * 100}%)` }]);
        animate(newPage, [{ transform: `translateX(${sign * 100}%)` }, { transform: 'translateX(0)' }]);
      } else if (effect === 'cover') {
        // Earlier pages lie on top: forward slides the old page off, back slides the previous one in.
        const top = sign > 0 ? oldPage : newPage;
        top.style.zIndex = '1';
        animate(top, sign > 0 ? [{ transform: 'translateX(0)' }, { transform: 'translateX(-100%)' }]
          : [{ transform: 'translateX(-100%)' }, { transform: 'translateX(0)' }]);
      } else {
        animate(newPage, [{ opacity: 0 }, { opacity: 1 }]);
      }
      await Promise.all(transaction.animations.map(animation => animation.finished));
    } catch (error) {
      if (!committed) await commit();
      else await committed;
      if (!(error instanceof DOMException && ['AbortError', 'SnapshotError'].includes(error.name))) throw error;
    } finally {
      this.cleanup(transaction);
      // Ready for the next one once this page has settled.
      if (this.allowed && this.revision === revision + 1) this.scheduleStandby();
    }
  }
}
