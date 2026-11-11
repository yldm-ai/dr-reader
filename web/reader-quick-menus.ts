import { $ } from './bridge.ts';
import { icon } from './icons.ts';
import { readingPalette } from './reading-palette.ts';
import { backgroundImage, readingBackgrounds } from './reading-backgrounds.ts';
import { dismissPopoverOnOutsidePointer } from './popover-dismiss.ts';
import type { ReadingSettings } from './settings-state.ts';

type Patch = Partial<ReadingSettings>;
/** Paper colours in the panel's order: light papers, then dark ones, then the system choice. */
const papers: [ReadingSettings['theme'], string][] = [
  ['light', '明亮'], ['sepia', '纸张'], ['green', '豆绿'], ['gray', '雾灰'], ['dark', '黑暗'], ['night', '夜蓝'], ['system', '自动'],
];
const modes = {
  single: { icon: 'page-single', label: '单页' },
  double: { icon: 'page-double', label: '双页' },
  scroll: { icon: 'scroll', label: '滚动' },
};
/** Pointer paths from 翻页 into its submenu cross 滚动 diagonally; that should not close it. */
const SUBMENU_OPEN_DELAY = 120;
const SUBMENU_CLOSE_DELAY = 280;

/**
 * The reader toolbar's two quick flyouts: the reading-mode menu (翻页 ▸ 单页 / 双页, 滚动) and
 * the page theme panel (paper colours and background textures). Both are manual popovers so
 * that the submenu stays open inside its parent and clicks in the book frame can close them.
 */
export class QuickMenus {
  private readonly modeButton = $<HTMLButtonElement>('reading-mode-button');
  private readonly modeMenu = $('reading-mode-menu');
  private readonly layoutMenu = $('reading-layout-menu');
  private readonly pagedItem = this.modeMenu.querySelector<HTMLButtonElement>('[data-mode-item="paged"]')!;
  private readonly themeButton = $<HTMLButtonElement>('reading-theme-button');
  private readonly themePanel = $('reading-theme-panel');
  private settings?: ReadingSettings;
  private subTimer?: ReturnType<typeof setTimeout>;

  private readonly apply: (patch: Patch) => void;

  constructor(apply: (patch: Patch) => void) {
    this.apply = apply;
    this.buildThemePanel();
    this.modeButton.onclick = () => this.isOpen(this.modeMenu) ? this.closeMode() : this.openMode(false);
    this.themeButton.onclick = () => this.isOpen(this.themePanel) ? this.closeTheme() : this.openTheme(false);
    for (const [button, open] of [[this.modeButton, () => this.openMode(true)], [this.themeButton, () => this.openTheme(true)]] as const)
      button.addEventListener('keydown', event => {
        if (!['ArrowDown', 'Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        open();
      });
    dismissPopoverOnOutsidePointer(this.modeMenu, () => this.closeMode(false));
    dismissPopoverOnOutsidePointer(this.themePanel, () => this.closeTheme(false));
    window.addEventListener('resize', () => this.closeAll());
    window.addEventListener('blur', () => this.closeAll());
    this.bindModeMenu();
  }

  /** Reflects saved settings in both buttons and both flyouts. */
  sync(settings: ReadingSettings): void {
    this.settings = settings;
    const mode = settings.mode === 'scroll' ? 'scroll' : settings.layout === 'double' ? 'double' : 'single';
    $('reading-mode-icon').innerHTML = icon(modes[mode].icon);
    $('reading-mode-label').textContent = modes[mode].label;
    this.modeButton.title = `阅读方式：${settings.mode === 'scroll' ? '上下滚动' : `左右翻页，${modes[mode].label}`}`;
    this.pagedItem.dataset.selected = String(settings.mode === 'paged');
    this.modeMenu.querySelector('[data-mode-item="scroll"]')!.setAttribute('aria-checked', String(settings.mode === 'scroll'));
    for (const item of this.layoutMenu.querySelectorAll<HTMLElement>('[data-layout-item]'))
      item.setAttribute('aria-checked', String(settings.mode === 'paged' && item.dataset.layoutItem === settings.layout));
    const palette = readingPalette(settings.theme);
    const swatch = $('reading-theme-swatch');
    swatch.dataset.theme = settings.theme;
    swatch.style.backgroundColor = palette.paper;
    swatch.style.backgroundImage = backgroundImage(settings.background, palette.dark, 2);
    const themeName = `页面主题：${papers.find(([value]) => value === settings.theme)?.[1] ?? ''}，${readingBackgrounds.find(([value]) => value === settings.background)?.[1] ?? '纯色'}背景`;
    this.themeButton.title = themeName;
    this.themeButton.setAttribute('aria-label', themeName);
    for (const button of this.themePanel.querySelectorAll<HTMLElement>('[data-paper]')) {
      const checked = button.dataset.paper === settings.theme;
      button.setAttribute('aria-checked', String(checked));
      button.tabIndex = checked ? 0 : -1;
    }
    // Texture previews follow the chosen paper, as the page will look.
    for (const button of this.themePanel.querySelectorAll<HTMLElement>('[data-texture]')) {
      const checked = button.dataset.texture === (settings.background ?? 'plain');
      button.setAttribute('aria-checked', String(checked));
      button.tabIndex = checked ? 0 : -1;
      const sample = button.querySelector<HTMLElement>('.theme-texture-sample')!;
      sample.style.backgroundColor = palette.paper;
      sample.style.backgroundImage = backgroundImage(button.dataset.texture, palette.dark, 2.2);
      sample.style.setProperty('--swatch-text', palette.text);
    }
  }

  /** Closes any open flyout; true when one was open, so the press that closed it does nothing else. */
  closeAll(): boolean {
    const open = this.isOpen(this.modeMenu) || this.isOpen(this.themePanel);
    this.closeMode(false);
    this.closeTheme(false);
    return open;
  }

  private isOpen(element: HTMLElement): boolean { return element.matches(':popover-open'); }

  private buildThemePanel(): void {
    $('theme-panel-papers').innerHTML = papers.map(([value, label]) => {
      const palette = readingPalette(value);
      // Dark papers carry a moon in their link colour; the label shows each paper's own ink.
      const glyph = value === 'system' ? icon('theme-system') : palette.dark ? `<span class="theme-moon" style="color:${palette.link}">${icon('moon')}</span>` : '';
      const style = value === 'system' ? '' : ` style="background-color:${palette.paper};color:${palette.text}"`;
      return `<button type="button" class="theme-paper" role="radio" data-paper="${value}" aria-checked="false" aria-label="${label}" tabindex="-1"${style}>${glyph}<span>${label}</span></button>`;
    }).join('');
    $('theme-panel-textures').innerHTML = readingBackgrounds.map(([value, label]) =>
      `<button type="button" class="theme-texture" role="radio" data-texture="${value}" aria-checked="false" tabindex="-1"><span class="theme-texture-sample"></span><span>${label}</span></button>`).join('');
    for (const button of this.themePanel.querySelectorAll<HTMLElement>('[data-paper]'))
      button.onclick = () => this.apply({ theme: button.dataset.paper as ReadingSettings['theme'] });
    for (const button of this.themePanel.querySelectorAll<HTMLElement>('[data-texture]'))
      button.onclick = () => this.apply({ background: button.dataset.texture as ReadingSettings['background'] });
    this.themePanel.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.closeTheme(); return; }
      const group = (event.target as Element).closest<HTMLElement>('[role="radiogroup"]');
      if (!group) return;
      const items = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
      const index = items.indexOf(event.target as HTMLButtonElement);
      // The colour grid has four columns, so up and down move by a row there.
      const row = group.id === 'theme-panel-papers' ? 4 : items.length;
      let next: number;
      if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = items.length - 1;
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') next = (index + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length;
      else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        next = index + (event.key === 'ArrowDown' ? row : -row);
        if (next < 0 || next >= items.length) next = index;
      } else return;
      event.preventDefault();
      if (next === index) return;
      items[next].focus();
      items[next].click();
    });
    // Tab leaving the panel closes it, like a menu. A task, not a microtask: between one swatch's
    // blur and the next one's focus the active element is briefly the body.
    this.themePanel.addEventListener('focusout', () => setTimeout(() => {
      if (document.hasFocus() && this.isOpen(this.themePanel) && document.activeElement !== document.body &&
        !this.themePanel.contains(document.activeElement) && document.activeElement !== this.themeButton)
        this.closeTheme(false);
    }));
  }

  private openTheme(keyboard: boolean): void {
    this.closeMode(false);
    this.themePanel.showPopover();
    this.themeButton.setAttribute('aria-expanded', 'true');
    this.place(this.themePanel, this.themeButton.getBoundingClientRect(), 'center');
    const checked = this.themePanel.querySelector<HTMLElement>('[data-paper][aria-checked="true"]') ?? this.themePanel.querySelector<HTMLElement>('[data-paper]');
    if (keyboard || document.activeElement === this.themeButton) checked?.focus({ preventScroll: true });
  }

  private closeTheme(returnFocus = true): void {
    if (!this.isOpen(this.themePanel)) return;
    const focused = this.themePanel.contains(document.activeElement);
    this.themePanel.hidePopover();
    this.themeButton.setAttribute('aria-expanded', 'false');
    if (returnFocus || focused) this.themeButton.focus({ preventScroll: true });
  }

  private bindModeMenu(): void {
    const items = (menu: HTMLElement) => [...menu.querySelectorAll<HTMLButtonElement>(':scope > .reader-menu-item')];
    for (const menu of [this.modeMenu, this.layoutMenu]) {
      // Hover moves the keyboard focus too, so the arrow keys continue from where the pointer is.
      menu.addEventListener('pointermove', event => {
        const item = (event.target as Element).closest<HTMLButtonElement>('.reader-menu-item');
        if (item && item.parentElement === menu && document.activeElement !== item) item.focus({ preventScroll: true });
      });
      menu.addEventListener('keydown', event => {
        if (event.target instanceof Element && event.target.closest('.reader-menu') !== menu) return;
        const list = items(menu);
        const index = list.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          list[(index + (event.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length].focus();
        } else if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault();
          list[event.key === 'Home' ? 0 : list.length - 1].focus();
        } else if (event.key === 'Escape' || (event.key === 'ArrowLeft' && menu === this.layoutMenu)) {
          event.preventDefault();
          event.stopPropagation();
          if (menu === this.layoutMenu) { this.closeLayout(); this.pagedItem.focus(); } else this.closeMode();
        } else if (event.key === 'ArrowRight' && document.activeElement === this.pagedItem) {
          event.preventDefault();
          this.openLayout(true);
        } else if (event.key === 'Tab') this.closeMode(false);
      });
    }
    this.pagedItem.addEventListener('pointerenter', () => { clearTimeout(this.subTimer); this.subTimer = setTimeout(() => this.openLayout(false), SUBMENU_OPEN_DELAY); });
    this.pagedItem.onclick = event => { clearTimeout(this.subTimer); this.openLayout(event.detail === 0); };
    const scroll = this.modeMenu.querySelector<HTMLButtonElement>('[data-mode-item="scroll"]')!;
    scroll.addEventListener('pointerenter', () => {
      clearTimeout(this.subTimer);
      if (this.isOpen(this.layoutMenu)) this.subTimer = setTimeout(() => this.closeLayout(), SUBMENU_CLOSE_DELAY);
    });
    scroll.onclick = () => this.choose({ mode: 'scroll' });
    this.layoutMenu.addEventListener('pointerenter', () => clearTimeout(this.subTimer));
    for (const item of this.layoutMenu.querySelectorAll<HTMLButtonElement>('[data-layout-item]'))
      item.onclick = () => this.choose({ mode: 'paged', layout: item.dataset.layoutItem as ReadingSettings['layout'] });
  }

  private choose(patch: Patch): void {
    this.closeMode();
    const current = this.settings;
    if (current && Object.entries(patch).every(([key, value]) => current[key as keyof ReadingSettings] === value)) return;
    this.apply(patch);
  }

  private openMode(keyboard: boolean): void {
    this.closeTheme(false);
    this.modeMenu.showPopover();
    this.modeButton.setAttribute('aria-expanded', 'true');
    this.place(this.modeMenu, this.modeButton.getBoundingClientRect(), 'start');
    const current = this.settings?.mode === 'scroll' ? this.modeMenu.querySelector<HTMLElement>('[data-mode-item="scroll"]') : this.pagedItem;
    if (keyboard || document.activeElement === this.modeButton) current?.focus({ preventScroll: true });
  }

  private closeMode(returnFocus = true): void {
    clearTimeout(this.subTimer);
    this.closeLayout();
    if (!this.isOpen(this.modeMenu)) return;
    const focused = this.modeMenu.contains(document.activeElement);
    this.modeMenu.hidePopover();
    this.modeButton.setAttribute('aria-expanded', 'false');
    if (returnFocus || focused) this.modeButton.focus({ preventScroll: true });
  }

  private openLayout(focus: boolean): void {
    if (!this.isOpen(this.modeMenu)) return;
    if (!this.isOpen(this.layoutMenu)) {
      this.layoutMenu.showPopover();
      this.pagedItem.setAttribute('aria-expanded', 'true');
      this.placeSubmenu();
    }
    if (focus) (this.layoutMenu.querySelector<HTMLElement>('[aria-checked="true"]') ?? this.layoutMenu.querySelector<HTMLElement>('.reader-menu-item'))!.focus({ preventScroll: true });
  }

  private closeLayout(): void {
    if (!this.isOpen(this.layoutMenu)) return;
    this.layoutMenu.hidePopover();
    this.pagedItem.setAttribute('aria-expanded', 'false');
  }

  /** Below the button, aligned to its start or centred on it, kept inside the window. */
  private place(popup: HTMLElement, anchor: DOMRect, align: 'start' | 'center'): void {
    const width = popup.offsetWidth;
    const left = align === 'start' ? anchor.left : anchor.left + anchor.width / 2 - width / 2;
    popup.style.left = `${Math.round(Math.max(8, Math.min(left, innerWidth - width - 8)))}px`;
    popup.style.top = `${Math.round(anchor.bottom + 6)}px`;
  }

  /** Beside 翻页, its first item level with the parent item; flips left near the window edge. */
  private placeSubmenu(): void {
    const item = this.pagedItem.getBoundingClientRect();
    const menu = this.modeMenu.getBoundingClientRect();
    const width = this.layoutMenu.offsetWidth;
    const inset = parseFloat(getComputedStyle(this.layoutMenu).paddingTop) + parseFloat(getComputedStyle(this.layoutMenu).borderTopWidth);
    const right = menu.right + 2;
    const left = right + width + 8 <= innerWidth ? right : menu.left - width - 2;
    this.layoutMenu.style.left = `${Math.round(Math.max(8, left))}px`;
    this.layoutMenu.style.top = `${Math.round(item.top - inset)}px`;
  }
}
