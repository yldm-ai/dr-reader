/**
 * Overlay scrollbar for panels with rounded corners. The native WebKit track spans the
 * whole scroll box, so at either end its thumb runs past the rounded corners; this track is
 * inset from both ends, drawn in a non-scrolling host and only shown while it is useful.
 *
 * `viewport` is the element that scrolls; `host` is a positioned ancestor that does not.
 * `inset` keeps the track clear of the viewport's ends; a function is re-read on every update, for
 * sticky headers and footers inside the viewport whose height changes. The track also never
 * reaches into the host's rounded right-hand corners.
 */
type Inset = { top: number; bottom: number };
/** Gap between the track and a rounded corner or a sticky edge. */
const CLEARANCE = 4;

export class OverlayScrollbar {
  private readonly viewport: HTMLElement;
  private readonly host: HTMLElement;
  private readonly inset: Inset | (() => Inset);
  private readonly track: HTMLDivElement;
  private readonly thumb: HTMLDivElement;
  private frame = 0;
  private fadeTimer?: ReturnType<typeof setTimeout>;
  private drag?: { pointer: number; y: number; scrollTop: number };

  constructor(viewport: HTMLElement, host: HTMLElement, inset: Inset | (() => Inset) = { top: 6, bottom: 6 }) {
    this.viewport = viewport;
    this.host = host;
    this.inset = inset;
    viewport.classList.add('overlay-scroll');
    this.track = document.createElement('div');
    this.track.className = 'overlay-scrollbar';
    this.track.setAttribute('aria-hidden', 'true');
    this.thumb = document.createElement('div');
    this.thumb.className = 'overlay-scrollbar-thumb';
    this.track.append(this.thumb);
    host.append(this.track);
    viewport.addEventListener('scroll', () => { this.reveal(); this.schedule(); }, { passive: true });
    host.addEventListener('pointerenter', () => { this.schedule(); this.reveal(); });
    host.addEventListener('pointerleave', () => this.conceal());
    new ResizeObserver(() => this.schedule()).observe(viewport);
    // Content growth changes scrollHeight without resizing the viewport itself.
    new MutationObserver(() => this.schedule()).observe(viewport, { childList: true, subtree: true });
    this.thumb.addEventListener('pointerdown', event => this.beginDrag(event));
    this.thumb.addEventListener('pointermove', event => this.moveDrag(event));
    this.thumb.addEventListener('pointerup', () => { this.drag = undefined; this.track.classList.remove('dragging'); });
    this.thumb.addEventListener('lostpointercapture', () => { this.drag = undefined; this.track.classList.remove('dragging'); });
    this.track.addEventListener('pointerdown', event => this.page(event));
    this.schedule();
  }

  /** Recomputes geometry on the next frame; scroll and resize bursts collapse into one update. */
  schedule(): void {
    if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.update(); });
  }

  /** Re-measure the sticky parts an inset function depends on, e.g. after they appear. */
  observe(...elements: Element[]): void {
    const observer = new ResizeObserver(() => this.schedule());
    for (const element of elements) observer.observe(element);
  }

  private update(): void {
    const { viewport, track, thumb } = this;
    const { clientHeight, scrollHeight, scrollTop } = viewport;
    const scrollable = scrollHeight - clientHeight > 1;
    track.hidden = !scrollable;
    if (!scrollable) return;
    // Layout offsets ignore transforms such as the sliding sidebar or the dialog entrance.
    let top = 0, left = 0;
    for (let node: HTMLElement | null = viewport; node && node !== this.host; node = node.offsetParent as HTMLElement | null) {
      top += node.offsetTop; left += node.offsetLeft;
    }
    const inset = typeof this.inset === 'function' ? { ...this.inset() } : { ...this.inset };
    // Keep the ends out of the host's rounded corners (offsets are measured inside its border).
    const style = getComputedStyle(this.host);
    const border = parseFloat(style.borderTopWidth) || 0;
    const below = this.host.clientHeight - top - clientHeight;
    inset.top = Math.max(inset.top, (parseFloat(style.borderTopRightRadius) || 0) - border + CLEARANCE - top);
    inset.bottom = Math.max(inset.bottom, (parseFloat(style.borderBottomRightRadius) || 0) - border + CLEARANCE - below);
    const length = Math.max(0, clientHeight - inset.top - inset.bottom);
    track.style.top = `${top + inset.top}px`;
    track.style.height = `${length}px`;
    track.style.left = `${left + viewport.offsetWidth - track.offsetWidth - 2}px`;
    const size = Math.max(28, length * clientHeight / scrollHeight);
    thumb.style.height = `${size}px`;
    thumb.style.transform = `translateY(${(length - size) * scrollTop / (scrollHeight - clientHeight)}px)`;
  }

  private reveal(): void {
    this.track.classList.add('visible');
    clearTimeout(this.fadeTimer);
    if (!this.host.matches(':hover')) this.fadeTimer = setTimeout(() => this.conceal(), 900);
  }

  private conceal(): void {
    if (this.drag) return;
    clearTimeout(this.fadeTimer);
    this.track.classList.remove('visible');
  }

  private beginDrag(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.thumb.setPointerCapture(event.pointerId);
    this.drag = { pointer: event.pointerId, y: event.clientY, scrollTop: this.viewport.scrollTop };
    this.track.classList.add('dragging');
  }

  private moveDrag(event: PointerEvent): void {
    if (!this.drag || event.pointerId !== this.drag.pointer) return;
    const { viewport, thumb, track } = this;
    const travel = track.clientHeight - thumb.offsetHeight;
    if (travel <= 0) return;
    viewport.scrollTop = this.drag.scrollTop +
      (event.clientY - this.drag.y) * (viewport.scrollHeight - viewport.clientHeight) / travel;
  }

  /** Clicking the track beside the thumb pages toward the pointer, as native scrollbars do. */
  private page(event: PointerEvent): void {
    if (event.target !== this.track || event.button !== 0) return;
    event.preventDefault();
    const thumb = this.thumb.getBoundingClientRect();
    const direction = event.clientY < thumb.top ? -1 : 1;
    this.viewport.scrollBy({ top: direction * this.viewport.clientHeight * 0.9 });
  }
}
