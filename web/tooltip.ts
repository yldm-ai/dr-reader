/**
 * Self-drawn hover tips, modelled on the MSIME settings window: they wait 500 ms on a control,
 * fade in over 120 ms while sliding 2 px down, sit centred 2 px below it and vanish as soon as
 * the pointer moves on or presses. Native title tooltips never appear: every `title` is moved
 * to `data-tooltip` (also when set later), keeping an accessible name via aria-label.
 */
const SHOW_DELAY = 500;

export class Tooltips {
  private readonly tip: HTMLDivElement;
  private target: Element | null = null;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(root: Document = document) {
    this.tip = root.createElement('div');
    this.tip.className = 'ui-tooltip';
    this.tip.setAttribute('role', 'tooltip');
    // A manual popover renders in the top layer, so tips also show above modal dialogs.
    this.tip.popover = 'manual';
    root.body.append(this.tip);
    this.adopt(root.body);
    new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'attributes') this.adoptOne(record.target as Element);
        else record.addedNodes.forEach(node => { if (node instanceof Element) this.adopt(node); });
      }
    }).observe(root.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });
    root.addEventListener('pointerover', event => this.over(event.target as Element), true);
    root.addEventListener('pointerout', event => {
      const next = event.relatedTarget as Element | null;
      if (this.target && !(next && this.target.contains(next))) this.hide();
    }, true);
    for (const type of ['pointerdown', 'keydown', 'wheel', 'scroll'])
      root.addEventListener(type, () => this.hide(), { capture: true, passive: true });
    window.addEventListener('blur', () => this.hide());
  }

  private adopt(scope: Element): void {
    if (scope.hasAttribute('title')) this.adoptOne(scope);
    scope.querySelectorAll('[title]').forEach(element => this.adoptOne(element));
  }

  private adoptOne(element: Element): void {
    const text = element.getAttribute('title');
    // An iframe's title names the frame for assistive technology; it is not a hover tip.
    if (text === null || element instanceof HTMLIFrameElement) return;
    element.removeAttribute('title');
    if (!text) { element.removeAttribute('data-tooltip'); return; }
    element.setAttribute('data-tooltip', text);
    if (!element.hasAttribute('aria-label') && !element.textContent?.trim()) element.setAttribute('aria-label', text);
    if (element === this.target && this.tip.matches(':popover-open')) this.place(element.getBoundingClientRect(), text);
  }

  private over(element: Element | null): void {
    const owner = element?.closest?.('[data-tooltip]') ?? null;
    if (owner === this.target) return;
    this.hide();
    if (!owner || (owner as HTMLButtonElement).disabled) return;
    this.target = owner;
    this.timer = setTimeout(() => {
      if (this.target === owner && owner.isConnected) this.show(owner.getBoundingClientRect(), owner.getAttribute('data-tooltip') ?? '');
    }, SHOW_DELAY);
  }

  /** Shows a tip under an anchor rectangle in viewport pixels; also used by the native caption. */
  show(anchor: DOMRect | { left: number; top: number; width: number; height: number }, text: string): void {
    if (!text) return;
    this.tip.classList.remove('visible');
    // Re-entering the top layer stacks the tip above whichever dialog opened last.
    if (this.tip.matches(':popover-open')) this.tip.hidePopover();
    this.tip.showPopover();
    this.place(anchor, text);
    requestAnimationFrame(() => this.tip.classList.add('visible'));
  }

  private place(anchor: { left: number; top: number; width: number; height: number }, text: string): void {
    this.tip.textContent = text;
    const { width, height } = this.tip.getBoundingClientRect();
    const margin = 4;
    const below = anchor.top + anchor.height + 2;
    const above = below + height > innerHeight - margin && anchor.top - height - 2 >= margin;
    const left = Math.max(margin, Math.min(anchor.left + (anchor.width - width) / 2, innerWidth - width - margin));
    this.tip.dataset.side = above ? 'above' : 'below';
    this.tip.style.left = `${Math.round(left)}px`;
    this.tip.style.top = `${Math.round(above ? anchor.top - height - 2 : below)}px`;
  }

  hide(): void {
    clearTimeout(this.timer);
    this.target = null;
    this.tip.classList.remove('visible');
    if (this.tip.matches(':popover-open')) this.tip.hidePopover();
  }
}
