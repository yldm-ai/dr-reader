const COLORS = ['#95dfd9', '#1b9ee0', '#66c3f1', '#15a6e2', '#8f75df'];
// mt19937(7), uniform_real_distribution<float>(4, 20), in stroke-width units.
const DASHES = [[5.220933, 7.637425, 16.478701, 9.103556], [11.014548, 19.651566, 15.575443, 11.289359],
  [19.647832, 8.928204, 12.615934, 8.221933], [12.017927, 5.387895, 5.152818, 10.709955],
  [8.295024, 4.254566, 11.99812, 12.444237]];

interface OpeningCover {
  image?: string;
  title?: string;
  author?: string;
  ratio?: number;
  rect?: { left: number; top: number; width: number; height: number };
}

/** UIAnimation's accelerate/decelerate profile, with a constant-speed middle if needed. */
function transition(time: number, acceleration: number, deceleration: number): number {
  const t = Math.max(0, Math.min(1, time));
  const velocity = 2 / (2 - acceleration - deceleration);
  if (t < acceleration) return velocity * t * t / (2 * acceleration);
  if (t > 1 - deceleration) return 1 - velocity * (1 - t) ** 2 / (2 * deceleration);
  return velocity * (t - acceleration / 2);
}

/** Five overlapping circles from the supplied SoundControlAnimation, drawn in the app's layer. */
export class BookOpening {
  private cover?: HTMLDivElement;
  private board?: HTMLDivElement;
  private coverIntro?: Animation;
  private book?: HTMLDivElement;
  private sheets: Animation[] = [];
  private fade?: Animation;
  private finishing = false;
  private canvas?: HTMLCanvasElement;
  private context?: CanvasRenderingContext2D;
  private resize?: ResizeObserver;
  private frame = 0;
  private readonly created = performance.now();
  private started = this.created;
  /** The clock starts once frames arrive steadily (see draw). */
  private running = false;
  private steadyFrames = 0;
  private lastFrame?: number;
  private closeRequested = false;
  private endingAt?: number;
  private resolve?: () => void;
  private completion: Promise<void>;
  private reduced = matchMedia('(prefers-reduced-motion: reduce)');
  private stopOnReduced = () => { if (this.reduced.matches) this.cancel(); };

  private host: HTMLElement;

  constructor(host: HTMLElement, enabled: boolean, effect = 'circles', cover: OpeningCover = {}) {
    this.host = host;
    this.completion = new Promise(resolve => { this.resolve = resolve; });
    if (!enabled || effect === 'none' || this.reduced.matches) { this.resolve?.(); return; }
    if (effect === 'cover') { this.openCover(cover); return; }
    if (effect === 'board') { this.closedBoard(cover); return; }
    if (effect === 'book') { this.openBook(); return; }
    const canvas = document.createElement('canvas');
    canvas.className = 'book-opening';
    canvas.setAttribute('aria-hidden', 'true');
    const context = canvas.getContext('2d');
    if (!context) { this.resolve?.(); return; }
    this.canvas = canvas;
    this.context = context;
    host.classList.add('book-opening-active');
    host.prepend(canvas);
    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(canvas);
    this.reduced.addEventListener('change', this.stopOnReduced);
    this.fit();
    this.draw(this.started);
  }

  /** Let the fill expand even for cached books, then collapse when the chapter is ready. */
  finish(): Promise<void> {
    if (this.cover && !this.finishing) {
      this.finishing = true;
      void this.slideCover(this.cover);
    }
    if (this.board && !this.finishing) {
      this.finishing = true;
      void this.swingBoard(this.board);
    }
    if (this.book && !this.finishing) {
      this.finishing = true;
      void this.fadeBook(this.book);
    }
    // The collapse time is fixed in draw, once the clock has started.
    if (this.canvas) this.closeRequested = true;
    return this.completion;
  }

  /** Whether an opaque opening animation covers the window (so views can switch beneath it). */
  get covering(): boolean {
    return Boolean(this.canvas || this.cover || this.book || this.board);
  }

  cancel(): void {
    cancelAnimationFrame(this.frame);
    this.resize?.disconnect();
    this.reduced.removeEventListener('change', this.stopOnReduced);
    this.canvas?.remove();
    this.canvas = undefined;
    for (const animation of this.sheets) animation.cancel();
    this.sheets = [];
    this.fade?.cancel();
    this.book?.remove();
    this.book = undefined;
    this.cover?.remove();
    this.cover = undefined;
    this.board?.remove();
    this.board = undefined;
    this.host.style.removeProperty('background-color');
    this.host.style.removeProperty('opacity');
    this.host.classList.remove('book-opening-active', 'book-opening-cover-active');
    this.resolve?.();
  }

  /** Layered cover and paper turns inspired by missarray's CodePen oQmgzW. */
  private openBook(): void {
    const book = document.createElement('div');
    book.className = 'book-opening book-opening-book';
    book.setAttribute('aria-hidden', 'true');
    book.innerHTML = `<div class="opening-book-scene"><span class="opening-book-cover"></span>
      <span class="opening-book-paper"></span>
      ${Array.from({ length: 6 }, () => '<span class="opening-book-paper opening-book-turn"></span>').join('')}
      <span class="opening-book-cover opening-book-turn"></span></div>`;
    this.book = book;
    this.host.classList.add('book-opening-active');
    this.host.prepend(book);
    this.reduced.addEventListener('change', this.stopOnReduced);
    const angles = [180, 180, 180, -150, -30, -55, -180];
    const delays = [0, 60, 120, 180, 240, 280, 0];
    book.querySelectorAll<HTMLElement>('.opening-book-turn').forEach((sheet, index) => {
      const animation = sheet.animate([
        { transform: 'rotateY(0deg)', zIndex: 2 },
        { transform: `rotateY(${angles[index] * .3}deg)`, zIndex: 20, offset: .3 },
        { transform: `rotateY(${angles[index]}deg)`, zIndex: index === 6 ? 1 : 20 },
      ], { duration: index < 3 || index === 6 ? 900 : 700, delay: delays[index], fill: 'both', easing: 'ease' });
      // Cancellation is also possible before finish() is called (failed loading/reduced motion).
      void animation.finished.catch(() => {});
      this.sheets.push(animation);
    });
  }

  private async fadeBook(book: HTMLDivElement): Promise<void> {
    if (this.book !== book) return;
    // The ready document can interrupt the paper turns; keep moving while fading out.
    this.fade = this.host.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: 450, easing: 'ease-in-out', fill: 'forwards',
    });
    await this.fade.finished.catch(() => {});
    if (this.book === book) this.cancel();
  }

  private openCover(source: OpeningCover): void {
    const root = document.createElement('div');
    root.className = 'book-opening book-opening-cover';
    root.setAttribute('aria-hidden', 'true');
    const backdrop = document.createElement('div');
    backdrop.className = 'opening-cover-backdrop';
    const card = document.createElement('div');
    card.className = 'opening-cover-card';
    const title = document.createElement('strong');
    title.textContent = source.title || 'DR Reader';
    const author = document.createElement('small');
    author.textContent = source.author || '';
    card.append(title, author);
    if (source.image) {
      const image = document.createElement('img');
      image.alt = '';
      image.src = source.image;
      image.addEventListener('error', () => image.remove(), { once: true });
      card.append(image);
    }
    root.append(backdrop, card);
    this.cover = root;
    this.host.classList.add('book-opening-active', 'book-opening-cover-active');
    this.host.prepend(root);
    this.reduced.addEventListener('change', this.stopOnReduced);
    const height = innerHeight, width = height * (source.ratio || 2 / 3);
    const left = (innerWidth - width) / 2;
    card.style.width = `${width}px`;
    card.style.left = `${left}px`;
    const from = source.rect;
    const transform = from
      ? `translate(${from.left - left}px, ${from.top}px) scale(${from.width / width}, ${from.height / height})`
      : 'translateY(18px) scale(.88)';
    this.coverIntro = card.animate([{ transform, opacity: from ? 1 : 0 }, { transform: 'none', opacity: 1 }], {
      duration: 600, easing: 'cubic-bezier(.16, 1, .3, 1)', fill: 'forwards',
    });
    void this.coverIntro.finished.catch(() => {});
    this.sheets.push(this.coverIntro);
  }

  private async slideCover(root: HTMLDivElement): Promise<void> {
    await this.coverIntro?.finished.catch(() => {});
    if (this.cover !== root) return;
    const card = root.querySelector<HTMLElement>('.opening-cover-card')!;
    const distance = innerWidth / 2 + card.offsetWidth / 2 + 32;
    const slide = card.animate([{ transform: 'none' }, { transform: `translateX(${distance}px)` }], {
      duration: 700, easing: 'cubic-bezier(.65, 0, .35, 1)', fill: 'forwards',
    });
    this.host.style.backgroundColor = 'transparent';
    const backdrop = root.querySelector('.opening-cover-backdrop')!;
    const reveal = backdrop.animate([{ opacity: 1 }, { opacity: 0 }], {
      delay: 100, duration: 600, easing: 'ease-in-out', fill: 'forwards',
    });
    this.sheets.push(slide, reveal);
    await Promise.all([slide.finished.catch(() => {}), reveal.finished.catch(() => {})]);
    if (this.cover === root) this.cancel();
  }

  /**
   * A closed hardback that opens like grabfold's cover (https://github.com/javocsoft/grabfold, MIT;
   * see web/vendor/grabfold/README.md). The library cover flies to a closed book centred in the
   * window. Once the chapter is ready the cover swings open about the spine as a rigid board
   * (grabfold src/board.ts RigidSheet: perspective six page widths away, each face darkening as
   * it turns edge-on, a shadow thrown on the page it lifts off), while the book slides from
   * centred-closed to centred-open (src/physics.ts closedShift), then the reader fades in.
   */
  private closedBoard(source: OpeningCover): void {
    const ratio = source.ratio || 2 / 3;
    const height = Math.min(innerHeight * .8, innerWidth * .86 / (2 * ratio)), width = height * ratio;
    const root = document.createElement('div');
    root.className = 'book-opening book-opening-cover book-opening-board';
    root.setAttribute('aria-hidden', 'true');
    root.style.setProperty('--board-width', `${width}px`);
    root.style.setProperty('--board-height', `${height}px`);
    root.innerHTML = `<div class="opening-cover-backdrop"></div><div class="opening-board">
      <div class="opening-board-shift"><div class="opening-board-page"><span class="opening-board-cast"></span></div>
      <div class="opening-board-leaf"><div class="opening-board-face opening-board-front"><span class="opening-board-shade"></span></div>
      <div class="opening-board-face opening-board-back"><span class="opening-board-shade"></span></div></div></div></div>`;
    const front = root.querySelector<HTMLElement>('.opening-board-front')!;
    const title = document.createElement('strong');
    title.textContent = source.title || 'DR Reader';
    const author = document.createElement('small');
    author.textContent = source.author || '';
    front.prepend(title, author);
    if (source.image) {
      const image = document.createElement('img');
      image.alt = '';
      image.src = source.image;
      image.addEventListener('error', () => image.remove(), { once: true });
      title.before(image);
    }
    this.board = root;
    this.host.classList.add('book-opening-active', 'book-opening-cover-active');
    this.host.prepend(root);
    this.reduced.addEventListener('change', this.stopOnReduced);
    // Closed, the book is one page wide and sits in the middle of the window.
    const left = (innerWidth - width) / 2, top = (innerHeight - height) / 2;
    const book = root.querySelector<HTMLElement>('.opening-board')!;
    book.style.left = `${left}px`;
    book.style.top = `${top}px`;
    const from = source.rect;
    const transform = from
      ? `translate(${from.left - left}px, ${from.top - top}px) scale(${from.width / width}, ${from.height / height})`
      : 'translateY(18px) scale(.88)';
    this.coverIntro = book.animate([{ transform, opacity: from ? 1 : 0 }, { transform: 'none', opacity: 1 }], {
      duration: 600, easing: 'cubic-bezier(.16, 1, .3, 1)', fill: 'forwards',
    });
    void this.coverIntro.finished.catch(() => {});
    this.sheets.push(this.coverIntro);
  }

  private async swingBoard(root: HTMLDivElement): Promise<void> {
    await this.coverIntro?.finished.catch(() => {});
    if (this.board !== root) return;
    const width = root.querySelector<HTMLElement>('.opening-board')!.offsetWidth;
    // grabfold's settle: a cubic ease-out (src/model.ts easeOut), sampled per 60 Hz frame so the
    // shading, which follows sin(pi * progress), stays exact.
    const duration = 900, count = Math.round(duration / (1000 / 60)) + 1;
    const leaf: Keyframe[] = [], shift: Keyframe[] = [], shade: Keyframe[] = [], cast: Keyframe[] = [];
    for (let index = 0; index < count; index++) {
      const progress = 1 - (1 - index / (count - 1)) ** 3, standing = Math.sin(Math.PI * progress);
      leaf.push({ transform: `rotateY(${(-180 * progress).toFixed(2)}deg)` });
      shift.push({ transform: `translateX(${(width / 2 * progress).toFixed(2)}px)` });
      shade.push({ opacity: (.4 * .9 * standing).toFixed(4) });
      // Only while the board is over the page it lifts off (grabfold switches it off at half way;
      // it fades over the last few degrees here so it does not blink out).
      cast.push({ opacity: (standing * Math.min(1, Math.max(0, (.5 - progress) / .06))).toFixed(4),
        transform: `scaleX(${Math.max(standing, 1e-4).toFixed(4)})` });
    }
    const options: KeyframeAnimationOptions = { duration, easing: 'linear', fill: 'forwards' };
    const animations = [
      root.querySelector('.opening-board-leaf')!.animate(leaf, options),
      root.querySelector('.opening-board-shift')!.animate(shift, options),
      root.querySelector('.opening-board-cast')!.animate(cast, options),
      ...[...root.querySelectorAll('.opening-board-shade')].map(element => element.animate(shade, options)),
    ];
    this.sheets.push(...animations);
    await Promise.all(animations.map(animation => animation.finished.catch(() => {})));
    if (this.board !== root) return;
    // The open book gives way to the first page of the text.
    this.fade = this.host.animate([{ opacity: 1 }, { opacity: 0 }], {
      delay: 120, duration: 450, easing: 'ease-in-out', fill: 'forwards',
    });
    await this.fade.finished.catch(() => {});
    if (this.board === root) this.cancel();
  }

  private fit(): void {
    if (!this.canvas) return;
    const size = Math.max(1, Math.round(this.canvas.getBoundingClientRect().width * devicePixelRatio));
    if (this.canvas.width !== size) this.canvas.width = this.canvas.height = size;
  }

  private draw = (now: number): void => {
    const canvas = this.canvas, ctx = this.context;
    if (!canvas || !ctx) return;
    // Hold the first pose until three frames in a row arrive on time (at most 400 ms).
    // With a cold GPU shader cache (first run, or after a WebView2 or driver update) the
    // first frames compile the canvas, drop-shadow and reader programs and stall for
    // 60–120 ms; a running clock would freeze the expanding circles and then jump ahead.
    if (!this.running) {
      this.steadyFrames = this.lastFrame !== undefined && now - this.lastFrame < 25 ? this.steadyFrames + 1 : 0;
      this.lastFrame = now;
      if (this.steadyFrames >= 3 || now - this.created > 400) { this.running = true; this.started = now; }
    }
    if (this.running && this.closeRequested && this.endingAt === undefined)
      this.endingAt = Math.max(now, this.started + 900);
    const elapsed = this.running ? (now - this.started) / 1000 : 0;
    const closing = this.endingAt !== undefined && now >= this.endingAt;
    const exit = closing ? 1 - transition((now - this.endingAt!) / 650, .3, .7) : 1;
    if (closing) this.host.style.opacity = String(exit);
    if (exit <= 0) { this.cancel(); return; }
    const fill = .4 + .6 * transition(elapsed / .45, .2, .8);
    const angle = elapsed * 6 * transition(elapsed / 10, .2, .8);
    ctx.resetTransform();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.scale(canvas.width / 600, canvas.height / 600);
    for (let i = 0; i < COLORS.length; i++) {
      const radius = (250 - 25 * i) * exit;
      ctx.save();
      ctx.translate(300, 300);
      ctx.rotate(angle * (1.7 + .5 * i) * Math.PI / 180);
      ctx.globalAlpha = closing ? exit : .98;
      ctx.fillStyle = ctx.strokeStyle = COLORS[i];
      // Keep stroke and dash widths fixed during collapse, as in the native reference.
      ctx.lineWidth = 12.5;
      ctx.setLineDash(DASHES[i].map(value => value * 12.5));
      ctx.beginPath(); ctx.arc(0, 0, radius, 0, 2 * Math.PI); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, radius * fill, 0, 2 * Math.PI); ctx.fill();
      ctx.restore();
    }
    this.frame = requestAnimationFrame(this.draw);
  };
}
