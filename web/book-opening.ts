const COLORS = ['#95dfd9', '#1b9ee0', '#66c3f1', '#15a6e2', '#8f75df'];
// mt19937(7), uniform_real_distribution<float>(4, 20), in stroke-width units.
const DASHES = [[5.220933, 7.637425, 16.478701, 9.103556], [11.014548, 19.651566, 15.575443, 11.289359],
  [19.647832, 8.928204, 12.615934, 8.221933], [12.017927, 5.387895, 5.152818, 10.709955],
  [8.295024, 4.254566, 11.99812, 12.444237]];

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
  private canvas?: HTMLCanvasElement;
  private context?: CanvasRenderingContext2D;
  private resize?: ResizeObserver;
  private frame = 0;
  private started = performance.now();
  private endingAt?: number;
  private resolve?: () => void;
  private completion: Promise<void>;
  private reduced = matchMedia('(prefers-reduced-motion: reduce)');
  private stopOnReduced = () => { if (this.reduced.matches) this.cancel(); };

  constructor(private host: HTMLElement, enabled: boolean) {
    this.completion = new Promise(resolve => { this.resolve = resolve; });
    if (!enabled || this.reduced.matches) { this.resolve?.(); return; }
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
    if (this.canvas && this.endingAt === undefined)
      this.endingAt = Math.max(performance.now(), this.started + 900);
    return this.completion;
  }

  cancel(): void {
    cancelAnimationFrame(this.frame);
    this.resize?.disconnect();
    this.reduced.removeEventListener('change', this.stopOnReduced);
    this.canvas?.remove();
    this.canvas = undefined;
    this.host.classList.remove('book-opening-active');
    this.resolve?.();
  }

  private fit(): void {
    if (!this.canvas) return;
    const size = Math.max(1, Math.round(this.canvas.getBoundingClientRect().width * devicePixelRatio));
    if (this.canvas.width !== size) this.canvas.width = this.canvas.height = size;
  }

  private draw = (now: number): void => {
    const canvas = this.canvas, ctx = this.context;
    if (!canvas || !ctx) return;
    const elapsed = (now - this.started) / 1000;
    const closing = this.endingAt !== undefined && now >= this.endingAt;
    const exit = closing ? 1 - transition((now - this.endingAt!) / 650, .3, .7) : 1;
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
