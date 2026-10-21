type Transition = {
  controller: AbortController;
  overlay: HTMLDivElement;
  frame: HTMLIFrameElement;
  visibility: string;
  animations: Animation[];
  cleaned: boolean;
};

function pathTo(node: Node, root: Node): number[] | null {
  const path: number[] = [];
  while (node !== root) {
    const parent = node.parentNode;
    if (!parent) return null;
    path.unshift(Array.prototype.indexOf.call(parent.childNodes, node));
    node = parent;
  }
  return path;
}
function nodeAt(root: Node, path: number[]): Node | undefined {
  let node: Node | undefined = root;
  for (const index of path) node = node?.childNodes[index];
  return node;
}
function copyHighlights(source: Document, target: Document) {
  const from = source.defaultView?.CSS.highlights;
  const to = target.defaultView?.CSS.highlights;
  const HighlightClass = target.defaultView?.Highlight;
  if (!from || !to || !HighlightClass) return;
  for (const [name, highlight] of from) {
    const ranges: Range[] = [];
    for (const range of highlight) {
      const startPath = pathTo(range.startContainer, source.documentElement);
      const endPath = pathTo(range.endContainer, source.documentElement);
      if (!startPath || !endPath) continue;
      const start = nodeAt(target.documentElement, startPath), end = nodeAt(target.documentElement, endPath);
      if (!start || !end) continue;
      try {
        const clone = target.createRange();
        clone.setStart(start, range.startOffset); clone.setEnd(end, range.endOffset);
        ranges.push(clone);
      } catch { /* An EPUB parser repair may change a node path; keep the page usable. */ }
    }
    to.set(name, new HighlightClass(...ranges));
  }
}

/** Two read-only EPUB snapshots; the live document commits exactly once underneath. */
export class ReaderMotion {
  private allowed = true;
  private active: Transition | null = null;
  private opening: Animation | null = null;
  private reduced = matchMedia('(prefers-reduced-motion: reduce)');

  constructor() { this.reduced.addEventListener('change', () => { if (this.reduced.matches) this.cancel(); }); }
  setAllowed(value: boolean) { this.allowed = value; if (!value) this.cancel(); }
  enabled(effect: string) { return this.allowed && !this.reduced.matches && effect !== 'none'; }
  private cleanup(transaction: Transition) {
    if (transaction.cleaned) return;
    transaction.cleaned = true;
    for (const animation of transaction.animations) animation.cancel();
    transaction.overlay.remove();
    transaction.frame.style.visibility = transaction.visibility;
    if (this.active === transaction) this.active = null;
  }
  cancel() {
    this.opening?.cancel(); this.opening = null;
    if (this.active) {
      this.active.controller.abort();
      this.cleanup(this.active);
    }
  }
  open(element: HTMLElement) {
    if (!this.enabled('open')) return;
    this.cancel();
    this.opening = element.animate([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }],
      { duration: 240, easing: 'cubic-bezier(.1,.9,.2,1)' });
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

  async change(element: HTMLElement, effect: string, duration: number, direction: number, update: () => void | Promise<void>) {
    if (!this.enabled(effect)) { await update(); return; }
    const frame = element.querySelector<HTMLIFrameElement>('#book-frame');
    if (!frame) { await update(); return; }
    this.cancel();
    const overlay = document.createElement('div'); overlay.className = `page-motion page-motion-${effect}`;
    overlay.setAttribute('aria-hidden', 'true'); overlay.style.visibility = 'hidden';
    element.append(overlay);
    const transaction: Transition = { controller: new AbortController(), overlay, frame,
      visibility: frame.style.visibility, animations: [], cleaned: false };
    this.active = transaction;
    let committed: Promise<void> | undefined;
    const commit = () => committed ??= Promise.resolve().then(update);
    try {
      const oldPage = await this.snapshot(frame, overlay, transaction.controller.signal);
      overlay.style.visibility = 'visible';
      frame.style.visibility = 'hidden';
      await commit();
      if (transaction.controller.signal.aborted) return;
      const newPage = await this.snapshot(frame, overlay, transaction.controller.signal);
      if (transaction.controller.signal.aborted) return;
      const sign = direction < 0 ? -1 : 1;
      const options: KeyframeAnimationOptions = { duration, fill: 'both', easing: 'cubic-bezier(.33,0,.67,1)' };
      const animate = (node: HTMLElement, keyframes: Keyframe[]) => {
        const animation = node.animate(keyframes, options); transaction.animations.push(animation); return animation;
      };
      if (effect === 'slide') {
        animate(oldPage, [{ transform: 'translateX(0)' }, { transform: `translateX(${-sign * 100}%)` }]);
        animate(newPage, [{ transform: `translateX(${sign * 100}%)` }, { transform: 'translateX(0)' }]);
      } else if (effect === 'turn') {
        const turning = direction < 0 ? newPage : oldPage;
        const underneath = direction < 0 ? oldPage : newPage;
        underneath.style.zIndex = '0';
        const sheet = document.createElement('div'); sheet.className = 'motion-sheet'; sheet.style.zIndex = '1';
        const front = document.createElement('div'); front.className = 'motion-front';
        const back = document.createElement('div'); back.className = 'motion-back';
        const shade = document.createElement('div'); shade.className = 'motion-shade';
        front.append(turning, shade); sheet.append(front, back); overlay.append(sheet);
        overlay.style.perspectiveOrigin = 'left center';
        animate(sheet, [{ transform: `rotateY(${direction < 0 ? -180 : 0}deg)` },
          { transform: `rotateY(${direction < 0 ? 0 : -180}deg)` }]);
        animate(shade, [{ opacity: 0 }, { opacity: .6, offset: .5 }, { opacity: 0 }]);
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
