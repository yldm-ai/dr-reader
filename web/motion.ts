import { copyHighlights } from './highlight-copy.ts';
import { PAGE_EASING, PageStrip } from './page-strip.ts';

type Transition = {
  controller: AbortController;
  overlay: HTMLDivElement;
  frame: HTMLIFrameElement;
  visibility: string;
  animations: Animation[];
  cleaned: boolean;
  disposeFlip?: () => void;
};

/** Distance (CSS px) over which the spread spine fades as a soft flap's corner reaches it. */
const SPINE_FADE = 36;
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
  prepare(element: HTMLElement, effect: string, key: string) {
    const frame = element.querySelector<HTMLIFrameElement>('#book-frame');
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
  cancel() {
    this.revision++;
    this.strip.reset();
    if (this.active) {
      this.active.controller.abort();
      this.cleanup(this.active);
    }
  }
  private snapshot(source: HTMLIFrameElement, parent: HTMLElement, signal: AbortSignal): Promise<HTMLDivElement> {
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
        else { pane.style.visibility = 'visible'; resolve(pane); }
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

  private async turnPage(transaction: Transition, oldPage: HTMLDivElement, newPage: HTMLDivElement,
    effect: string, duration: number, direction: number, corner: 'top' | 'bottom', spread = false) {
    // The new snapshot is only a source for StPageFlip's pages. Left visible it
    // covers the old page for the whole setup and flashes the destination.
    newPage.style.visibility = 'hidden';
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
    const sources = spread ? (forward ? [oldPage, oldPage, newPage, newPage] : [newPage, newPage, oldPage, oldPage])
      : (forward ? [oldPage, newPage, oldPage] : [newPage, oldPage, newPage]).slice(0, pages.length);
    // Load snapshots after StPageFlip has reparented the shells: moving an iframe resets its document.
    const panes = await Promise.all(pages.map((page, index) =>
      this.snapshot(sources[index].querySelector('iframe')!, page, signal)));
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
    // The spine copy that covered the old snapshot; it moves into the engine at the reveal.
    const spine = overlay.querySelector<HTMLElement>(':scope > .stpageflip-spine');
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
      oldPage.remove(); newPage.remove();
      if (signal.aborted) onAbort();
    });
    // Landing: the turned pages are compositor layers, whose text Chromium draws in grayscale,
    // while the live page underneath has ClearType. Show the live page and fade the landed
    // sheet out over it, so the text eases into ClearType instead of jumping in stroke weight.
    transaction.frame.style.visibility = transaction.visibility;
    const fade = overlay.animate([{ opacity: 1 }, { opacity: 0 }], { duration: LANDING_FADE, easing: 'ease-out', fill: 'forwards' });
    fade.updatePlaybackRate(this.speed);
    transaction.animations.push(fade);
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
    this.cancel();
    const overlay = document.createElement('div'); overlay.className = `page-motion page-motion-${effect}`;
    overlay.setAttribute('aria-hidden', 'true'); overlay.style.visibility = 'hidden';
    element.append(overlay);
    const transaction: Transition = { controller: new AbortController(), overlay, frame,
      visibility: frame.style.visibility, animations: [], cleaned: false };
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
      const oldPage = await this.snapshot(frame, overlay, transaction.controller.signal);
      overlay.style.visibility = 'visible';
      frame.style.visibility = 'hidden';
      await commit();
      if (transaction.controller.signal.aborted) return;
      // Document replacement must stay covered even when turn animations are off.
      if (!animated) return;
      const newPage = await this.snapshot(frame, overlay, transaction.controller.signal);
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
      } else if (effect.startsWith('turn')) {
        await this.turnPage(transaction, oldPage, newPage, effect, duration / this.speed, direction, corner, spread);
      } else {
        animate(newPage, [{ opacity: 0 }, { opacity: 1 }]);
      }
      await Promise.all(transaction.animations.map(animation => animation.finished));
    } catch (error) {
      if (!committed) await commit();
      else await committed;
      if (!(error instanceof DOMException && ['AbortError', 'SnapshotError'].includes(error.name))) throw error;
    } finally { this.cleanup(transaction); }
  }
}
