import { icon } from './icons.ts';
import { OverlayScrollbar } from './scrollbar.ts';
import type { Choice } from './fonts.ts';

/** Native select holds the saved value; the popover owns navigation and transient search. */
export class SelectControl {
  readonly select: HTMLSelectElement;
  readonly button: HTMLButtonElement;
  readonly popup: HTMLDivElement;
  readonly list: HTMLDivElement;
  readonly search?: HTMLInputElement;
  private label: HTMLSpanElement;
  private choices: Choice[] = [];
  private visible: Choice[] = [];
  private active = -1;
  private typeahead = '';
  private lastValue?: string;
  private typeTimer?: ReturnType<typeof setTimeout>;
  private observer: ResizeObserver;
  private pointerStart?: { x: number; y: number };

  constructor(select: HTMLSelectElement, searchable = false) {
    this.select = select;
    select.classList.add('select-source');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');
    const wrapper = document.createElement('div');
    wrapper.className = 'select-control';
    select.before(wrapper);
    wrapper.append(select);
    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.className = 'select-trigger';
    this.button.id = `${select.id}-trigger`;
    this.button.setAttribute('role', 'combobox');
    this.button.setAttribute('aria-haspopup', 'listbox');
    this.button.setAttribute('aria-expanded', 'false');
    this.button.setAttribute('aria-labelledby', `${select.id}-label ${this.button.id}-value`);
    this.label = document.createElement('span');
    this.label.id = `${this.button.id}-value`;
    this.button.append(this.label);
    this.button.insertAdjacentHTML('beforeend', icon('chevron-down'));
    wrapper.append(this.button);
    this.popup = document.createElement('div');
    this.popup.id = `${select.id}-popup`;
    this.popup.className = 'select-popup';
    this.popup.popover = 'auto';
    this.button.setAttribute('aria-controls', `${select.id}-options`);
    // Explicit invocation also works in WebView2 without CSS anchor positioning.
    this.button.onclick = () => this.isOpen ? this.close() : this.open();
    this.popup.addEventListener('toggle', () => {
      this.button.setAttribute('aria-expanded', String(this.isOpen));
      if (!this.isOpen) {
        this.button.removeAttribute('aria-activedescendant');
        this.search?.removeAttribute('aria-activedescendant');
      }
    });
    if (searchable) {
      const field = document.createElement('div');
      field.className = 'select-search';
      field.innerHTML = icon('search');
      this.search = document.createElement('input');
      this.search.type = 'search';
      this.search.placeholder = '搜索本机字体';
      this.search.setAttribute('aria-label', '搜索本机字体');
      this.search.setAttribute('role', 'combobox');
      this.search.setAttribute('aria-expanded', 'true');
      this.search.setAttribute('aria-controls', `${select.id}-options`);
      this.search.autocomplete = 'off';
      this.search.oninput = () => this.render(true);
      field.append(this.search);
      this.popup.append(field);
    }
    this.list = document.createElement('div');
    this.list.id = `${select.id}-options`;
    this.list.className = 'select-options';
    this.list.setAttribute('role', 'listbox');
    this.list.setAttribute('aria-labelledby', `${select.id}-label`);
    this.popup.append(this.list);
    wrapper.append(this.popup);
    new OverlayScrollbar(this.list, this.popup, { top: 4, bottom: 4 });
    this.button.addEventListener('keydown', event => this.key(event));
    this.popup.addEventListener('keydown', event => this.key(event));
    this.list.addEventListener('pointermove', event => {
      if (!event.movementX && !event.movementY) return;
      const option = (event.target as Element).closest<HTMLElement>('[data-index]');
      if (option) this.activate(Number(option.dataset.index), false);
    });
    this.list.addEventListener('pointerdown', event => {
      this.pointerStart = { x: event.clientX, y: event.clientY };
      // Keep keyboard/search focus stable, while touch scrolling remains available.
      if (event.pointerType === 'mouse') event.preventDefault();
    });
    this.list.addEventListener('click', event => {
      if (this.pointerStart && Math.hypot(event.clientX - this.pointerStart.x, event.clientY - this.pointerStart.y) > 8) return;
      const option = (event.target as Element).closest<HTMLElement>('[data-index]');
      if (option) this.commit(Number(option.dataset.index));
    });
    select.addEventListener('change', () => this.sync());
    this.popup.addEventListener('focusout', () => queueMicrotask(() => {
      if (document.hasFocus() && this.isOpen && !wrapper.contains(document.activeElement)) this.close(false);
    }));
    this.observer = new ResizeObserver(() => { if (this.isOpen) this.position(); });
    this.observer.observe(this.button);
    // Components live for the application lifetime, alongside SettingsPanel.
    window.addEventListener('resize', () => this.close(false));
    select.closest('dialog')?.addEventListener('close', () => this.close(false));
    select.closest('.settings-body')?.addEventListener('scroll', () => this.close(false), { passive: true });
    this.setChoices(Array.from(select.options, option => ({ value: option.value, label: option.text })));
  }

  get isOpen(): boolean { return this.popup.matches(':popover-open'); }
  setChoices(choices: Choice[]): void {
    this.choices = choices;
    const value = this.select.value;
    this.select.replaceChildren(...choices.map(choice => new Option(choice.label, choice.value)));
    if (choices.some(choice => choice.value === value)) this.select.value = value;
    this.lastValue = undefined;
    this.sync();
  }
  sync(): void {
    if (this.lastValue === this.select.value) return;
    this.lastValue = this.select.value;
    this.label.textContent = this.choices.find(choice => choice.value === this.select.value)?.label ?? this.select.value;
    if (this.isOpen) this.render();
  }
  open(): void {
    if (this.search) this.search.value = '';
    this.render();
    this.popup.showPopover();
    this.button.setAttribute('aria-expanded', 'true');
    this.position();
    (this.search ?? this.button).focus({ preventScroll: true });
    this.activate(this.active);
  }
  close(returnFocus = true): void {
    if (!this.isOpen) return;
    this.popup.hidePopover();
    this.button.setAttribute('aria-expanded', 'false');
    if (returnFocus) this.button.focus({ preventScroll: true });
  }
  private position(): void {
    const rect = this.button.getBoundingClientRect();
    const width = Math.min(rect.width, window.innerWidth - 16);
    const below = window.innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const down = below >= 180 || below >= above;
    const available = Math.max(80, Math.min(340, down ? below : above));
    this.popup.style.width = `${width}px`;
    this.popup.style.maxHeight = `${available}px`;
    this.popup.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
    const height = this.popup.getBoundingClientRect().height;
    this.popup.style.top = `${down ? rect.bottom + 5 : Math.max(8, rect.top - height - 5)}px`;
  }
  private render(filtered = false): void {
    const query = (this.search?.value ?? '').trim().toLocaleLowerCase();
    const matches = this.choices.filter(choice => !query || `${choice.label} ${choice.value}`.toLocaleLowerCase().includes(query));
    // Bound DOM/font-list cost even with thousands of installed fonts.
    this.visible = matches.slice(0, 80);
    const selected = this.choices.find(choice => choice.value === this.select.value);
    if (!query && selected && !this.visible.includes(selected)) this.visible.unshift(selected);
    const fragment = document.createDocumentFragment();
    this.visible.forEach((choice, index) => {
      const row = document.createElement('div');
      row.className = 'select-option';
      row.id = `${this.select.id}-option-${index}`;
      row.dataset.index = String(index);
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(choice.value === this.select.value));
      const label = document.createElement('span');
      label.textContent = choice.label;
      row.append(label);
      if (choice.value === this.select.value) row.insertAdjacentHTML('beforeend', icon('check'));
      fragment.append(row);
    });
    if (!matches.length || matches.length > this.visible.length) {
      const hint = document.createElement('p');
      hint.className = 'select-hint';
      hint.setAttribute('role', 'status');
      hint.textContent = matches.length ? `${matches.length} 款字体，输入名称缩小范围` : '未找到字体，请尝试其他名称';
      fragment.append(hint);
    }
    this.list.replaceChildren(fragment);
    const selectedIndex = this.visible.findIndex(choice => choice.value === this.select.value);
    this.active = filtered ? (this.visible.length ? 0 : -1) : Math.max(0, selectedIndex);
    this.activate(this.active, false);
    if (this.isOpen) this.position();
  }
  private activate(index: number, scroll = true): void {
    this.active = Math.max(-1, Math.min(index, this.visible.length - 1));
    this.list.querySelectorAll<HTMLElement>('[data-index]').forEach(row => {
      row.classList.toggle('active', Number(row.dataset.index) === this.active);
    });
    const row = this.list.querySelector<HTMLElement>(`[data-index="${this.active}"]`);
    const field = this.search ?? this.button;
    if (row) {
      field.setAttribute('aria-activedescendant', row.id);
      if (scroll) row.scrollIntoView({ block: 'nearest' });
    } else field.removeAttribute('aria-activedescendant');
  }
  private commit(index: number): void {
    const choice = this.visible[index];
    if (!choice) return;
    const changed = this.select.value !== choice.value;
    this.select.value = choice.value;
    this.close();
    this.sync();
    if (changed) this.select.dispatchEvent(new Event('change', { bubbles: true }));
  }
  private key(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.isOpen) {
      event.preventDefault(); event.stopPropagation(); this.close(); return;
    }
    if (event.key === 'Tab') { this.close(false); return; }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      if (!this.isOpen) { this.open(); event.preventDefault(); return; }
      if (this.search && event.target === this.search && ['Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      this.activate(event.key === 'Home' ? 0 : event.key === 'End' ? this.visible.length - 1 :
        this.active + (event.key === 'ArrowDown' ? 1 : -1));
    } else if (event.key === 'Enter' || (event.key === ' ' && event.target === this.button)) {
      event.preventDefault();
      if (this.isOpen) this.commit(this.active); else this.open();
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && event.target === this.button) {
      event.preventDefault();
      if (!this.isOpen) this.open();
      if (this.search) { this.search.value = event.key; this.render(true); }
      else {
        this.typeahead += event.key.toLocaleLowerCase();
        clearTimeout(this.typeTimer);
        this.typeTimer = setTimeout(() => { this.typeahead = ''; }, 650);
        const match = this.visible.findIndex(choice => choice.label.toLocaleLowerCase().startsWith(this.typeahead));
        if (match >= 0) this.activate(match);
      }
    }
  }
}
