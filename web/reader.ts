import { call, bookUrl, $, escape, toast, errorMessage } from "./bridge.ts";
import {
  anchorFromRange,
  rangeForAnchor,
  textIndex,
} from "./anchors.ts";
import { AnnotationLayer } from "./annotations.ts";
import type { NoteMark, PointerLike } from "./annotations.ts";
import { WheelPaging } from "./wheel-paging.ts";
import { ReaderMotion } from "./motion.ts";
import { fontStack } from "./fonts.ts";
import { readingPalette } from "./reading-palette.ts";
import { sameReading } from "./settings-state.ts";
import { pageMargins, pageClickDirection, pageCorner } from "./reading-layout.ts";
import { ChapterCache } from "./chapter-cache.ts";
import { icon } from "./icons.ts";
import { OverlayScrollbar } from "./scrollbar.ts";
import { ColorPicker } from "./color-picker.ts";
import { bookPages, chapterTextLength } from "./book-pages.ts";
import { htmlFromXhtml } from "./xhtml.ts";
import { tocAnchor, tocSelectionIndex } from "./toc-selection.ts";
import { AgentChat } from "./agent-chat.ts";
import { excerptAround } from "./agent-prompt.ts";
import type { ReadingContext } from "./agent-prompt.ts";
import { shortTitle } from "./title.ts";
import { DEFAULT_PALETTE, normalizeColor, paint, pushColor } from "./highlight-colors.ts";
import type { ReadingSettings } from "./settings-state.ts";
import type { Annotation, AnnotationStyle, ApplicationSettings, Book, Dictionary, Settings, TextAnchor } from "./types.ts";

type Timer = ReturnType<typeof setTimeout>;
type Corner = "top" | "bottom";
type MarkStyle = Exclude<AnnotationStyle, "note">;
/** The passage the selection menu acts on: a live text selection or an existing annotation. */
interface Selection { range: Range; text: string; annotationId: string; pinned?: boolean }
interface BookStats { bookId: string; chars: (number | undefined)[]; exact: Map<number, number>; layout: string; failed?: boolean }
interface SearchResult { chapter: number; title: string; snippet: string }
type AnnotationValues = Partial<TextAnchor> & Partial<Pick<Annotation, "id" | "note" | "color" | "style">>;
/** Settings as `apply` accepts them: the full transport object, or just the reading group. */
type AppliedSettings = Settings | (ReadingSettings & { application?: undefined; reading?: undefined }) |
  { reading: ReadingSettings; application?: ApplicationSettings };
type ActivationTarget = Window & { drActivationTracked?: boolean };

export class Reader {
  onUpdate: (book: Book) => void;
  onReadingSetting?: (patch: Partial<ReadingSettings>) => void;
  onApplicationSetting?: (patch: Partial<ApplicationSettings>) => void;
  onOpenSettings?: () => void;
  book: Book | null = null;
  chapter = 0;
  ratio = 0;
  page = 0;
  pages = 1;
  generation = 0;
  /** Assigned by the first `apply`, which runs before any book opens. */
  settings!: ReadingSettings;
  appSettings!: ApplicationSettings;
  annotations: Annotation[] = [];
  doc: Document | null = null;
  style: HTMLStyleElement | null = null;
  annotationLayer: AnnotationLayer | null = null;
  annotationTheme?: string;
  annotationRevision = 0;
  appliedDocument: Document | null = null;
  appliedReading: ReadingSettings | null = null;
  layoutViewport = "";
  pageTail: HTMLElement | null = null;
  bookStats: BookStats | null = null;
  loading = false;
  loadError = "";
  reflowing = false;
  anchor = "";
  query = "";
  annotationFocus = "";
  tocTarget: { chapter: number; anchor?: string; position?: number } | null = null;
  tocPointer?: { x: number; y: number };
  turnQueue: Promise<void> = Promise.resolve();
  navigationRevision = 0;
  wheelPaging?: WheelPaging;
  wheelBacklog?: { revision: number; count: number };
  chapterCache = new ChapterCache();
  motion = new ReaderMotion();
  colorPicker: ColorPicker;
  chat: AgentChat;
  observer: ResizeObserver;
  titleObserver?: ResizeObserver;
  selection: Selection | null = null;
  editingAnnotation: Annotation | null = null;
  paletteStyle: MarkStyle | "" = "";
  paletteSignature?: string;
  dialogColor = "";
  notePeekId = "";
  footerDragging = false;
  inactive = false;
  activatedAt = -Infinity;
  tapDismissed = false;
  tapStart: { x: number; y: number; time: number; selected: boolean } | null = null;
  saveTimer?: Timer;
  tapTimer?: Timer;
  selectionTimer?: Timer;
  reflowTimer?: Timer;
  toolbarTimer?: Timer;
  peekTimer?: Timer;
  notePeekTimer?: Timer;
  tocHideTimer?: Timer;
  footerHideTimer?: Timer;
  cornerTimer?: Timer;

  constructor(onUpdate: (book: Book) => void) {
    this.onUpdate = onUpdate;
    this.attachTocHover();
    this.attachTocAutoHide();
    this.attachFooterAutoHide();
    this.trackActivation(window);
    document.addEventListener("reader-dismiss-selection", () => this.hideSelection());
    document.addEventListener("pointerdown", (event) => {
      if ((event.target as Element).closest(".reading-area")) this.beginPageTap(event);
      // The custom colour picker belongs to the menu that opened it.
      if (!(event.target as Element).closest("#selection-menu, .color-picker")) this.hideSelection();
      if (!(event.target as Element).closest("#note-peek")) this.hideNotePeek();
    }, true);
    document.addEventListener("scroll", (event) => {
      if ((event.target as Element | null)?.closest?.("#note-peek")) return;
      this.hideSelection();
      this.hideNotePeek();
    }, true);
    window.addEventListener("resize", () => this.hideSelection());
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.dismissSelection()) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);

    $("page-surface").addEventListener("wheel", (event) => this.wheel(event), { passive: false });
    for (const button of document.querySelectorAll<HTMLElement>("[data-quick-mode]"))
      button.onclick = () => this.onReadingSetting?.({ mode: button.dataset.quickMode as ReadingSettings["mode"] });
    for (const button of document.querySelectorAll<HTMLElement>("[data-quick-theme]")) {
      const palette = readingPalette(button.dataset.quickTheme!);
      button.style.setProperty("--swatch-paper", palette.paper);
      button.style.setProperty("--swatch-text", palette.text);
      button.onclick = () => this.onReadingSetting?.({ theme: button.dataset.quickTheme as ReadingSettings["theme"] });
    }
    $<HTMLButtonElement>("font-smaller").onclick = () => this.stepFontSize(-1);
    $<HTMLButtonElement>("font-larger").onclick = () => this.stepFontSize(1);
    $("reader-search").onclick = () => this.openSearch();
    new OverlayScrollbar($("toc-scroll"), $("toc-panel"));
    $<HTMLButtonElement>("collapse-toolbar").onclick = () => this.setToolbarVisible(false);
    $<HTMLButtonElement>("expand-toolbar").onclick = () => this.setToolbarVisible(true);
    $("reader-fullscreen").onclick = () => call("fullscreen").catch(error => toast(errorMessage(error), "error"));
    $<HTMLButtonElement>("prev-page").onclick = () => this.turn(-1);
    $<HTMLButtonElement>("next-page").onclick = () => this.turn(1);
    $("toggle-toc").onclick = () => {
      if (this.settings?.showToc !== false && !this.settings?.tocPinned) {
        this.setTocExpanded($("toc-panel").dataset.expanded !== "true");
        return;
      }
      const showToc = $("toc-panel").hidden === true;
      if (this.onReadingSetting) this.onReadingSetting({ showToc });
      else $("toc-panel").hidden = !showToc;
      this.reflow();
    };
    $("corner-library").onclick = () => $("back-library").click();
    $("corner-settings").onclick = () => $("reader-settings").click();
    $("reader-view").addEventListener("pointermove", event => this.trackCorners(event.clientX, event.clientY));
    $("reader-view").addEventListener("pointerleave", () => this.trackCorners(-1, -1));
    $("page-surface").addEventListener("click", event => { if ((event.target as Element).id === "page-surface") this.pageTap(event, $("page-surface").clientWidth, $("page-surface").getBoundingClientRect().left); });
    const area = document.querySelector<HTMLElement>(".reading-area")!;
    area.addEventListener("click", event => this.consumeDismissedTap(event), true);
    area.addEventListener("click", event => { if (event.target === area) this.pageTap(event, area.clientWidth, area.getBoundingClientRect().left); });
    $<HTMLButtonElement>("add-bookmark").onclick = () => this.bookmark();
    $<HTMLInputElement>("reading-progress").onchange = () => {
      if (!this.book) return;
      const value =
        (Number($<HTMLInputElement>("reading-progress").value) / 1000) *
        this.book.chapters.length;
      const chapter = Math.min(
        this.book.chapters.length,
        Math.floor(value),
      );
      this.load(chapter, Math.min(1, value - chapter));
    };
    document
      .querySelectorAll<HTMLElement>("[data-tab]")
      .forEach(
        (button) => (button.onclick = () => this.tab(button.dataset.tab!)),
      );
    $("book-search-form").onsubmit = (event) => {
      event.preventDefault();
      this.search();
    };
    $("selection-menu").addEventListener("pointerdown", (event) => {
      if ((event.target as Element).closest("button")) event.preventDefault();
    });
    this.colorPicker = new ColorPicker();
    for (const id of ["highlight-color", "underline-color"])
      $(id).onclick = (event) => this.toggleMarkPalette(event.currentTarget as HTMLElement);
    $("highlight-swatches").onclick = (event) => {
      const button = (event.target as Element).closest("button");
      const style = this.paletteStyle;
      if (!button || !style) return;
      if (button.dataset.color) this.pickMarkColor(style, button.dataset.color);
      else this.colorPicker.open(button, this.markColor(style), (color) => this.pickMarkColor(style, color, true));
    };
    $("selection-highlight").onclick = () => this.toggleMark("highlight");
    $("selection-underline").onclick = () => this.toggleMark("underline");
    $("selection-note-delete").onclick = () => this.deleteNote();
    $("selection-note").onclick = () => this.openAnnotationDialog();
    const peek = $("note-peek");
    peek.addEventListener("pointerenter", () => clearTimeout(this.notePeekTimer));
    peek.addEventListener("pointerleave", () => this.scheduleNotePeekHide());
    $("selection-copy").onclick = () => this.copySelection();
    $("selection-search").onclick = () => this.searchSelection();
    $("selection-dictionary").onclick = () => this.lookupSelection();
    $("selection-ask").onclick = () => this.askSelection();
    this.chat = new AgentChat($("ask-content"), {
      context: () => this.readingContext(),
      agent: () => {
        const agent = this.appSettings?.agent ?? "auto";
        // 自动选择 uses each CLI's own defaults.
        if (agent === "auto") return { agent, model: "", effort: "" };
        return { agent, model: this.appSettings?.agentModels?.[agent] ?? "", effort: this.appSettings?.agentEfforts?.[agent] ?? "" };
      },
    });
    $("annotation-swatches").onclick = (event) => {
      const button = (event.target as Element).closest("button");
      if (!button) return;
      if (button.dataset.color) {
        this.dialogColor = button.dataset.color;
        this.syncDialogColors();
      } else this.colorPicker.open(button, this.dialogColor, (color) => {
        this.dialogColor = color;
        this.rememberColor(color);
        this.syncDialogColors();
      });
    };
    $("annotation-style").onchange = () => this.syncDialogColors();
    $("annotation-form").addEventListener("submit", (event) => {
      if (event.submitter?.id !== "annotation-save") return;
      event.preventDefault();
      this.saveFromDialog();
    });
    $("annotation-delete").onclick = () => this.deleteFromDialog();
    this.attachAnnotationDrag();
    this.observer = new ResizeObserver(() => { this.motion.cancel(); this.reflow(); this.updateTocIndicator(); });
    this.observer.observe($<HTMLIFrameElement>("book-frame"));
  }

  attachTocHover() {
    const panel = $("toc-panel");
    panel.addEventListener("scroll", () => { panel.dataset.scrolling = "true"; }, { passive: true, capture: true });
    panel.addEventListener("pointermove", (event) => {
      if (event.movementX || event.movementY) delete panel.dataset.scrolling;
    });
    panel.addEventListener("pointerleave", () => { delete panel.dataset.scrolling; });
  }

  attachTocAutoHide() {
    const panel = $("toc-panel");
    const reveal = (event: PointerEvent) => {
      if (panel.dataset.expanded !== "true" && !this.tocCornerProtected(event.clientX, event.clientY))
        this.setTocExpanded(true);
    };
    $("toc-reveal-zone").addEventListener("pointerenter", reveal);
    // Entering the edge inside the protected corner must still allow reveal further down.
    $("toc-reveal-zone").addEventListener("pointermove", reveal);
    $("toc-reveal-zone").addEventListener("pointerleave", () => this.scheduleTocHide());
    panel.addEventListener("pointerenter", reveal);
    panel.addEventListener("pointerleave", () => this.scheduleTocHide());
    panel.addEventListener("focusin", () => this.setTocExpanded(true));
    panel.addEventListener("focusout", () => this.scheduleTocHide());
    $("pin-toc").onclick = () => {
      const tocPinned = !this.settings?.tocPinned;
      this.setTocExpanded(true);
      if (this.onReadingSetting) this.onReadingSetting({ tocPinned });
      else { this.settings = { ...this.settings, tocPinned }; this.syncChrome(); }
      if (!tocPinned && !panel.matches(":hover")) this.scheduleTocHide();
    };
    document.addEventListener("pointermove", event => this.trackTocPointer(event.clientX, event.clientY));
  }

  tocCornerProtected(x: number, y: number): boolean {
    if (this.settings?.showToolbar !== false) return false;
    const rect = $("reader-view").getBoundingClientRect();
    return x >= rect.left && x < rect.left + 180 && y >= rect.top && y < rect.top + 88;
  }

  trackTocPointer(x: number, y: number): void {
    this.tocPointer = { x, y };
    const panel = $("toc-panel");
    if (!this.book || this.settings?.tocPinned || panel.hidden || panel.dataset.expanded !== "true") return;
    const rect = panel.getBoundingClientRect();
    const edge = $("toc-reveal-zone").getBoundingClientRect();
    if (x >= edge.left && x <= edge.right && y >= edge.top && y <= edge.bottom && !this.tocCornerProtected(x, y)) {
      clearTimeout(this.tocHideTimer); this.tocHideTimer = undefined; return;
    }
    if ((this.tocCornerProtected(x, y) && !panel.matches(":hover")) ||
        x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) this.scheduleTocHide();
    else { clearTimeout(this.tocHideTimer); this.tocHideTimer = undefined; }
  }

  /** Hides the auto-hide panel 500ms after the pointer leaves it, so sweeping along the edge cannot make it flicker. */
  scheduleTocHide() {
    if (this.tocHideTimer) return;
    this.tocHideTimer = setTimeout(() => {
      this.tocHideTimer = undefined;
      const panel = $("toc-panel");
      const pointer = this.tocPointer;
      const overEdge = $("toc-reveal-zone").matches(":hover") &&
        !(pointer && this.tocCornerProtected(pointer.x, pointer.y));
      if (!panel.matches(":hover") && !overEdge && !panel.querySelector(":focus-visible"))
        this.setTocExpanded(false);
    }, 500);
  }

  setTocExpanded(expanded: boolean): void {
    clearTimeout(this.tocHideTimer);
    this.tocHideTimer = undefined;
    const panel = $("toc-panel");
    panel.dataset.expanded = String(expanded);
    panel.inert = !this.settings?.tocPinned && !expanded;
    if (expanded) this.updateTocIndicator();
  }

  attachFooterAutoHide() {
    const footer = document.querySelector<HTMLElement>('.reader-footer')!;
    const zone = $('footer-reveal-zone');
    for (const element of [footer, zone]) {
      element.addEventListener('pointerenter', () => this.setFooterExpanded(true));
      element.addEventListener('pointerleave', () => this.scheduleFooterHide());
    }
    footer.addEventListener('focusout', () => this.scheduleFooterHide());
    footer.addEventListener('pointerdown', () => { this.footerDragging = true; });
    for (const type of ['pointerup', 'pointercancel']) document.addEventListener(type, () => {
      if (!this.footerDragging) return;
      this.footerDragging = false;
      this.scheduleFooterHide();
    }, true);
    window.addEventListener('blur', () => { this.footerDragging = false; this.scheduleFooterHide(); });
  }

  setFooterExpanded(expanded: boolean): void {
    clearTimeout(this.footerHideTimer);
    this.footerHideTimer = undefined;
    document.querySelector<HTMLElement>('.reader-footer')!.dataset.expanded = String(expanded);
  }

  scheduleFooterHide() {
    if (this.footerHideTimer || !this.settings?.autoHideProgress) return;
    this.footerHideTimer = setTimeout(() => {
      this.footerHideTimer = undefined;
      const footer = document.querySelector<HTMLElement>('.reader-footer')!;
      if (!this.footerDragging && !footer.matches(':hover') && !footer.querySelector(':focus-visible') && !$('footer-reveal-zone').matches(':hover'))
        this.setFooterExpanded(false);
    }, 450);
  }

  async open(book: Book, settings: Settings): Promise<void> {
    await this.flush();
    this.book = book;
    this.motion.setAllowed(settings.application?.animations ?? true);
    this.chapter = 0;
    this.ratio = 0;
    const title = $("reader-book-title");
    const displayTitle = shortTitle(book.title);
    title.textContent = /《[^》]*》/u.test(book.title) ? displayTitle : `《${displayTitle}》`;
    // Only a shortened or ellipsised title gets a hover tip (tooltip.ts) with the full name;
    // the toolbar can narrow later, so the check is repeated whenever the title resizes.
    const shortened = displayTitle !== book.title.trim();
    const syncTitleTip = () => {
      title.title = shortened || title.scrollWidth > title.clientWidth ? book.title : "";
    };
    this.titleObserver?.disconnect();
    this.titleObserver = new ResizeObserver(syncTitleTip);
    this.titleObserver.observe(title);
    syncTitleTip();
    this.setTocExpanded(false);
    $("toc-panel").hidden = false;
    this.tab("toc");
    void this.chat?.open(book.id);
    this.toc();
    this.marks();
    $<HTMLInputElement>("book-search-input").value = "";
    $("search-results").replaceChildren();
    try {
      this.annotations = await call<Annotation[]>("annotations", { id: book.id });
    } catch (error) {
      this.annotations = [];
      toast(errorMessage(error), "error");
    }
    this.notes();
    this.loadBookStats(book);
    this.apply(settings);
    const position = book.position;
    await this.load(position?.chapter || 0, position?.ratio || 0);
    if (!this.doc) {
      this.book = null;
      throw new Error(this.loadError || "章节没有完成载入");
    }
    if (book.warnings?.length)
      toast(
        `这本书有 ${book.warnings.length} 条兼容性提示，可查看本地 book.json。`,
      );
  }

  tab(name: string): void {
    document
      .querySelectorAll<HTMLElement>("[data-tab]")
      .forEach((button) =>
        button.classList.toggle("active", button.dataset.tab === name),
      );
    for (const key of ["toc", "marks", "notes", "search", "ask"])
      $(`${key}-content`).hidden = key !== name;
    if (name === "notes") this.notes();
    if (name === "search") $<HTMLInputElement>("book-search-input").focus();
    if (name === "ask") this.chat.focus();
    if (name === "toc") this.updateTocIndicator();
  }

  toc() {
    const root = $("toc-content");
    const indicator = document.createElement("span");
    indicator.className = "toc-active-indicator";
    indicator.setAttribute("aria-hidden", "true");
    root.replaceChildren(indicator);
    const stack: { depth: number; row: HTMLDivElement; button: HTMLButtonElement; children: HTMLDivElement; toggle?: HTMLButtonElement }[] = [];
    for (const [index, item] of this.book!.toc.entries()) {
      const depth = Math.max(0, Number(item.depth) || 0);
      while (stack.length && stack.at(-1)!.depth >= depth) stack.pop();
      const parent = stack.at(-1);
      const node = document.createElement("div");
      node.className = "toc-node";
      const row = document.createElement("div");
      row.className = "toc-row";
      row.style.setProperty("--toc-depth", String(Math.min(stack.length, 5)));
      const button = document.createElement("button");
      button.className = "toc-entry";
      button.textContent = item.title;
      button.dataset.href = item.href;
      button.dataset.tocIndex = String(index);
      button.onclick = () => this.navigate(item.href);
      const children = document.createElement("div");
      children.className = "toc-children";
      children.id = `toc-children-${index}`;
      children.hidden = true;
      row.append(button);
      node.append(row, children);
      (parent?.children ?? root).append(node);
      if (parent && !parent.toggle) {
        const toggle = document.createElement("button");
        toggle.className = "toc-toggle";
        toggle.innerHTML = icon("chevron");
        toggle.setAttribute("aria-expanded", "false");
        toggle.setAttribute("aria-controls", parent.children.id);
        const label = parent.button.textContent;
        toggle.setAttribute("aria-label", `展开 ${label}`);
        toggle.onclick = () => {
          const expanded = toggle.getAttribute("aria-expanded") !== "true";
          toggle.setAttribute("aria-expanded", String(expanded));
          toggle.setAttribute("aria-label", `${expanded ? "收起" : "展开"} ${label}`);
          parent.children.hidden = !expanded;
          this.activeToc(false);
        };
        parent.row.prepend(toggle);
        parent.toggle = toggle;
      }
      stack.push({ depth, row, button, children });
    }
    this.activeToc();
  }

  activeToc(scroll = true) {
    if (!this.book) return;
    const href = this.book.chapters[this.chapter]?.href;
    const root = $("toc-content");
    const previous = root.querySelector<HTMLElement>(".toc-entry.active");
    const view = this.doc?.defaultView;
    const paged = this.settings?.mode === "paged";
    const position = view ? (paged ? Math.round(view.scrollX / Math.max(1, view.innerWidth)) : Math.round(view.scrollY)) : 0;
    let target = this.tocTarget;
    if (target && (target.chapter !== this.chapter || (!this.loading && target.position !== undefined && target.position !== position)))
      this.tocTarget = target = null;
    if (target && !this.loading && target.position === undefined) target.position = position;
    let positions: Map<number, number> | undefined, offset: number | undefined;
    // The Node navigation tests stub the chapter document without element lookups.
    if (view && !this.loading && typeof this.doc!.getElementById === "function") {
      positions = new Map();
      const columnWidth = Math.max(1, view.innerWidth / (this.isDouble() ? 2 : 1));
      offset = paged ? Math.round(view.scrollX / columnWidth) * view.innerHeight + (this.settings?.paddingTop ?? 0) + 2
        : view.scrollY + 42;
      for (const [index, item] of this.book.toc.entries()) {
        if (item.href.split("#")[0] !== href) continue;
        const anchor = tocAnchor(item.href);
        if (!anchor) { positions.set(index, -Infinity); continue; }
        const node = this.doc!.getElementById(anchor) || this.doc!.getElementsByName(anchor)[0];
        if (!node || !node.getClientRects().length) continue;
        const rect = node.getClientRects()[0];
        positions.set(index, paged ? Math.floor((rect.left + view.scrollX + 2) / columnWidth) * view.innerHeight + rect.top
          : rect.top + view.scrollY);
      }
    }
    const selected = tocSelectionIndex(this.book.toc, href, { anchor: target?.anchor, positions, offset });
    if (previous?.dataset.tocIndex === String(selected)) {
      this.updateTocIndicator();
      return;
    }
    root.querySelectorAll(".toc-row").forEach(row => row.classList.remove("contains-active"));
    let active: HTMLElement | null = null;
    for (const [index, button] of [...root.querySelectorAll<HTMLElement>(".toc-entry")].entries()) {
      button.classList.toggle("active", index === selected);
      if (index === selected) { active = button; button.setAttribute("aria-current", "location"); }
      else button.removeAttribute("aria-current");
    }
    for (let node = active?.closest(".toc-node"); node; node = node.parentElement!.closest(".toc-node"))
      node.firstElementChild!.classList.add("contains-active");
    if (scroll && active !== previous && active?.offsetHeight) active.scrollIntoView({ block: "nearest" });
    this.updateTocIndicator();
  }

  updateTocIndicator() {
    const root = $("toc-content");
    const indicator = root.querySelector<HTMLElement>(".toc-active-indicator");
    const active = root.querySelector<HTMLElement>(".toc-entry.active");
    // Wait for the final heading/layout instead of fading through an intermediate parent.
    if (!indicator || this.loading) return;
    const leaf = active && !active.parentElement!.querySelector(":scope > .toc-toggle");
    const visible = Boolean(leaf && active.offsetHeight);
    indicator.style.opacity = visible ? "1" : "0";
    if (!visible || !active) return;
    if (!indicator.dataset.ready) indicator.style.transition = "none";
    const rect = active.getBoundingClientRect(), bounds = root.getBoundingClientRect();
    indicator.style.removeProperty("left");
    indicator.style.height = `${rect.height / 2}px`;
    // A single 2D transform gives x and y exactly the same interpolation progress.
    indicator.style.transform = `translate(${rect.left - bounds.left}px, ${rect.top - bounds.top + rect.height / 4}px) translateX(-50%)`;
    if (!indicator.dataset.ready) {
      void indicator.offsetHeight;
      indicator.dataset.ready = "true";
      indicator.style.removeProperty("transition");
    }
  }

  marks() {
    const book = this.book!;
    const root = $("marks-content");
    root.replaceChildren();
    for (const mark of book.bookmarks) {
      const button = document.createElement("button");
      button.className = "mark-entry";
      button.textContent =
        mark.title || book.chapters[mark.chapter]?.title || "书签";
      button.onclick = () => this.load(mark.chapter, mark.ratio);
      root.append(button);
    }
    if (!root.children.length)
      root.innerHTML =
        '<p class="panel-hint">把喜欢的地方留下来。<br>点击右上角书签按钮即可保存。</p>';
    this.updateMark();
  }

  notes() {
    if (!this.book) return;
    const root = $("notes-content");
    root.replaceChildren();
    const ordered = [...(this.annotations || [])].sort(
      (a, b) =>
        a.chapter - b.chapter ||
        a.start - b.start ||
        (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
    );
    for (const annotation of ordered) {
      const card = document.createElement("button");
      card.className = "note-entry";
      card.innerHTML = `<span class="note-color" style="--note-color:${paint(annotation.color, "#ffffff", false).ink}"></span><span class="note-copy"><strong>${escape(annotation.quote)}</strong>${annotation.note ? `<small>${escape(annotation.note)}</small>` : ""}<em>${escape(this.book.chapters[annotation.chapter]?.title || "")}</em></span>`;
      card.onclick = () =>
        this.load(annotation.chapter, 0, "", "", annotation.id);
      root.append(card);
    }
    if (!ordered.length)
      root.innerHTML =
        '<p class="panel-hint">选中正文后，可以高亮或写下笔记。<br>所有标注保存在本地 SQLite 数据库。</p>';
  }

  updateMark() {
    if (!this.book) return;
    $<HTMLButtonElement>("add-bookmark").disabled = this.atEnd();
    const exists = this.book.bookmarks.some(
      (mark) =>
        mark.chapter === this.chapter &&
        Math.abs(mark.ratio - this.ratio) < 0.02,
    );
    $<HTMLButtonElement>("add-bookmark").classList.toggle("selected", exists);
  }

  async bookmark() {
    if (!this.book || this.atEnd()) return;
    try {
      this.book = await call<Book>("bookmark", {
        id: this.book.id,
        mark: {
          chapter: this.chapter,
          ratio: this.ratio,
          title: this.book.chapters[this.chapter].title,
        },
      });
      this.marks();
      this.onUpdate(this.book!);
      toast("书签已更新", "success");
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  }

  async search() {
    const query = $<HTMLInputElement>("book-search-input").value.trim();
    if (!query) return;
    const root = $("search-results");
    root.textContent = "正在检索…";
    const id = this.book!.id;
    try {
      this.hideSelection();
      const results = await call<SearchResult[]>("search", { id, query });
      if (this.book?.id !== id) return;
      root.replaceChildren();
      for (const result of results) {
        const button = document.createElement("button");
        button.className = "search-result";
        button.innerHTML = `<strong>${escape(result.title)}</strong><p>${escape(result.snippet)}</p>`;
        button.onclick = () => this.load(result.chapter, 0, "", query);
        root.append(button);
      }
      if (!results.length)
        root.innerHTML = '<p class="panel-hint">没有找到相关文字。</p>';
    } catch (error) {
      this.hideSelection();
      root.textContent = errorMessage(error);
    }
  }

  async navigate(href: string): Promise<void> {
    if (!this.book) return;
    const hash = href.indexOf("#");
    const path = hash < 0 ? href : href.slice(0, hash);
    const anchor = hash < 0 ? "" : decodeURIComponent(href.slice(hash + 1));
    const index = this.book.chapters.findIndex(
      (chapter) => chapter.href === path,
    );
    if (index >= 0) await this.load(index, 0, anchor);
    else toast("此链接指向附属文档，初版暂不支持打开。");
  }

  async load(
    chapter: number,
    ratio = 0,
    anchor = "",
    query = "",
    annotationId = "",
    direction = 0,
    corner: Corner = "top",
  ): Promise<void> {
    if (!this.book) return;
    // Explicit navigation invalidates old input; a queued page turn across chapters does not.
    if (!direction) this.navigationRevision = (this.navigationRevision ?? 0) + 1;
    clearTimeout(this.saveTimer);
    clearTimeout(this.tapTimer);
    await this.flush();
    this.hideSelection();
    const generation = ++this.generation;
    this.chapter = Math.max(
      0,
      Math.min(chapter, this.book.chapters.length),
    );
    this.ratio = ratio;
    this.anchor = anchor;
    this.tocTarget = anchor ? { chapter: this.chapter, anchor } : null;
    this.query = query;
    this.annotationFocus = annotationId;
    this.loading = true;
    this.loadError = "";
    const item = this.book.chapters[this.chapter] || { title: "完", href: "__dr_end__" };
    const retainPage = Boolean(this.doc?.body);
    $("chapter-label").textContent = item.title;
    $("reader-loading").hidden = retainPage;
    this.activeToc();
    try {
      const url = bookUrl(this.book, item.href);
      let html = this.atEnd() ? '<!doctype html><html><head><title>完</title></head><body><span id="dr-end">完</span></body></html>' : this.chapterCache.get(url);
      if (html === undefined) {
        const response = await fetch(url);
        if (!response.ok) throw new Error("无法加载章节文件");
        html = await response.text();
        this.chapterCache.put(url, html);
      }
      if (generation !== this.generation) return;
      const base = bookUrl(this.book, item.href);
      // Books imported before the engine wrote HTML-safe chapters still contain e.g. <title/>.
      const initialPaper = readingPalette(this.settings?.theme || "light");
      html = htmlFromXhtml(html).replace(
        /<head(?:\s[^>]*)?>/i,
        (match) => `${match}<style id="dr-loading-paper">html,body{background:${initialPaper.paper}!important;color:${initialPaper.text}!important}</style><base href="${escape(base)}">`,
      );
      const frame = $<HTMLIFrameElement>("book-frame");
      frame.style.backgroundColor = initialPaper.paper;
      const update = () => new Promise<void>((resolve, reject) => {
        if (generation !== this.generation) { resolve(); return; }
        const timeout = setTimeout(() => reject(new Error("章节载入超时")), 8000);
        frame.onload = async () => {
          if (generation !== this.generation) { clearTimeout(timeout); resolve(); return; }
          try {
            this.doc = frame.contentDocument;
            await this.attach();
            // Let restored pagination/scroll position reach the compositor before uncovering it.
            await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
            clearTimeout(timeout);
            resolve();
          } catch (error) { clearTimeout(timeout); reject(error); }
        };
        frame.onerror = () => { clearTimeout(timeout); reject(new Error("章节载入失败")); };
        frame.srcdoc = html;
      });
      if (retainPage) await this.motion.change($("page-surface"),
        direction && this.settings.mode === "paged" ? this.pageEffect() : "none",
        this.motionDuration(), direction, update, true, corner, this.isDouble());
      else await update();
    } catch (error) {
      if (generation !== this.generation) return;
      this.loading = false;
      this.loadError = errorMessage(error);
      $("reader-loading").hidden = true;
      toast(errorMessage(error), "error");
    }
  }

  async attach() {
    const doc = this.doc;
    if (!doc?.body) {
      this.loading = false;
      $("reader-loading").hidden = true;
      toast("章节缺少正文");
      return;
    }
    let style = doc.getElementById("dr-reader-style") as HTMLStyleElement | null;
    if (!style) {
      style = doc.createElement("style");
      style.id = "dr-reader-style";
      doc.head.append(style);
    }
    this.style = style;
    if (doc.querySelector('meta[name="calibre:cover"][content="true"]')) {
      for (const svg of doc.querySelectorAll("svg[viewBox]"))
        svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    }
    doc.addEventListener("click", (event) => {
      if (this.consumeDismissedTap(event)) return;
      // A note tip opens its note for editing.
      const tip = (event.target as Element | null)?.closest?.<HTMLElement>(".dr-note-tip");
      const tipped = tip && this.annotationLayer?.ranges.get(tip.dataset.id!);
      if (tipped) {
        this.hideNotePeek();
        this.showSelectionMenu(tipped, tip.dataset.id);
        this.openAnnotationDialog();
        return;
      }
      const annotation = this.annotationLayer?.rangeAtPoint(event);
      if (annotation) {
        this.hideNotePeek();
        this.showSelectionMenu(annotation.range, annotation.id);
        // Opened by a click, not a text selection: the click's collapsed caret must not close it.
        if (this.selection) this.selection.pinned = true;
        return;
      }
      const link = (event.target as Element | null)?.closest?.("a[href]");
      if (!link) { this.pageTap(event, doc.defaultView!.innerWidth); return; }
      event.preventDefault();
      try {
        const target = new URL(link.getAttribute("href")!, doc.baseURI);
        const prefix = `/${this.book!.id}/content/`;
        if (
          target.origin === "https://books.dr-reader.local" &&
          target.pathname.startsWith(prefix)
        )
          this.navigate(
            decodeURIComponent(target.pathname.slice(prefix.length)) +
              target.hash,
          );
        else toast("阅读器仅打开书内链接。");
      } catch {
        toast("无法打开这个链接");
      }
    });
    this.trackActivation(doc.defaultView!);
    doc.addEventListener("pointerdown", event => { this.beginPageTap(event); this.hideSelection(); this.hideNotePeek(); });
    doc.addEventListener("pointermove", event => {
      const rect = $<HTMLIFrameElement>("book-frame").getBoundingClientRect();
      this.trackCorners(rect.left + event.clientX, rect.top + event.clientY);
      this.trackTocPointer(rect.left + event.clientX, rect.top + event.clientY);
      this.hoverNote(event);
    });
    doc.addEventListener("pointerleave", () => this.scheduleNotePeekHide());
    doc.addEventListener("wheel", (event) => { this.hideNotePeek(); this.wheel(event); }, { passive: false });
    doc.addEventListener("touchmove", () => this.hideSelection(), { passive: true });
    doc.addEventListener("selectionchange", () => {
      if (doc.getSelection()?.isCollapsed && !this.selection?.pinned) this.hideSelection();
    });
    doc.addEventListener("mouseup", (event) => {
      if (this.tapDismissed) return;
      if ((event.target as Element | null)?.closest?.("a")) return;
      this.selectionTimer = setTimeout(() => this.readSelection(), 0);
    });
    doc.addEventListener("keyup", (event) => {
      if (event.shiftKey || event.key === "Shift") this.readSelection();
    });
    doc.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.dismissSelection()) {
        event.preventDefault();
        return;
      }
      if (
        event.key === "Escape" ||
        (event.ctrlKey && ["o", "k"].includes(event.key.toLowerCase()))
      ) {
        event.preventDefault();
        document.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: event.key,
            ctrlKey: event.ctrlKey,
            bubbles: true,
          }),
        );
      } else this.key(event);
    });
    doc.defaultView!.addEventListener("scroll", () => { this.hideNotePeek(); this.scrolled(); }, {
      passive: true,
    });
    for (const image of doc.images)
      image.addEventListener("load", () => this.reflow(), { once: true });
    this.annotationLayer = new AnnotationLayer(doc);
    this.refreshAnnotations();
    this.apply(this.settings);
    await doc.fonts?.ready;
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    if (doc !== this.doc) return;
    // apply() above scheduled a reflow for this document; the measurement below supersedes it.
    // Left pending, it fired just after loading ended and restored the old position under the
    // reader's first page turn, so a turn made right after a chapter opened was lost. A changed
    // viewport still needs that reflow to re-apply the layout.
    const view = doc.defaultView!;
    if (this.layoutViewport === `${view.innerWidth}x${view.innerHeight}`) clearTimeout(this.reflowTimer);
    this.measure();
    this.restore();
    this.loading = false;
    this.reflowing = false;
    $("reader-loading").hidden = true;
    this.report();
  }

  refreshAnnotations() {
    if (!this.doc || !this.annotationLayer) return;
    const chapter = this.chapter;
    const current = (this.annotations || []).filter(
      (annotation) =>
        annotation.chapter === chapter &&
        annotation.href === this.book?.chapters[chapter]?.href,
    );
    const doc = this.doc;
    const index = current.length ? textIndex(doc) : undefined;
    this.annotationTheme = this.settings?.theme;
    this.annotationLayer.set(current, (annotation) =>
      rangeForAnchor(doc, annotation, index),
      readingPalette(this.settings?.theme),
    );
    // Snapshot layers for page motion copy highlights, so they must reload after a change.
    this.annotationRevision = (this.annotationRevision ?? 0) + 1;
    this.prepareMotion();
  }

  /** Lets slides and covers keep ready copies of this chapter under its current layout. */
  prepareMotion() {
    const surface = $("page-surface");
    if (!this.doc || this.settings?.mode !== "paged") { this.motion.prepare(surface, "none", ""); return; }
    const view = this.doc.defaultView!;
    this.motion.prepare(surface, this.pageEffect(),
      `${this.generation}|${this.chapter}|${view.innerWidth}x${view.innerHeight}|${JSON.stringify(this.settings)}|${this.annotationRevision ?? 0}`);
  }

  apply(settings: AppliedSettings): void {
    this.appSettings = settings.application || this.appSettings || ({
      animations: true,
      selectionActions: {
        highlight: true,
        underline: true,
        note: true,
        copy: true,
        search: true,
        dictionary: true,
      },
      dictionaries: [],
    } as unknown as ApplicationSettings);
    this.hideSelection();
    this.settings = settings.reading || (settings as ReadingSettings);
    this.motion.setAllowed(this.appSettings.animations);
    this.syncChrome();
    this.renderHighlightPalette();
    // Fills and underline inks follow the paper, so a theme change repaints highlights.
    if (this.annotationLayer && this.annotationTheme !== this.settings.theme) this.refreshAnnotations();
    if (this.appliedDocument === this.doc && sameReading(this.appliedReading ?? undefined, this.settings)) return;
    this.appliedDocument = this.doc;
    this.appliedReading = { ...this.settings };
    // The width limit is per page, so a two-page spread may grow to twice as wide.
    const spreadRequested = this.settings.mode === "paged" && this.settings.layout === "double";
    document.documentElement.style.setProperty(
      "--reading-width",
      `${this.settings.width * (spreadRequested ? 2 : 1)}px`,
    );
    if (!this.doc || !this.style) return;
    this.reflowing = true;
    this.layoutViewport = `${this.doc.defaultView!.innerWidth}x${this.doc.defaultView!.innerHeight}`;
    const reading = this.settings;
    const colors = readingPalette(reading.theme);
    const paged = reading.mode === "paged";
    const spacing = reading.publisherStyles
      ? ""
      : `body p,body div,body li{margin-top:0!important;margin-bottom:${reading.paragraphSpacing}em!important}`;
    const paragraph = reading.publisherStyles
      ? ""
      : `body p{text-indent:${reading.textIndent}em!important;text-align:${reading.alignment}!important}`;
    const edges = pageMargins(reading, this.doc.defaultView!.innerWidth, this.doc.defaultView!.innerHeight);
    const horizontal = edges.left + edges.right;
    const vertical = edges.top + edges.bottom;
    // A spread holds two columns per viewport, each with the page margins on both sides: two
    // columns and one gap fill the body, and overflow columns continue spread by spread. An
    // explicit count avoids a width-derived count rounding down to a single column.
    const double = this.isDouble();
    if ($("reader-view")) $("reader-view").dataset.layout = double ? "double" : "single";
    const columns = double
      ? "column-count:2!important;column-width:auto!important;"
      : `column-count:auto!important;column-width:calc(var(--dr-page-width,100vw) - ${horizontal}px)!important;`;
    const margin = paged
      ? `padding:0!important;${columns}margin:${edges.top}px ${edges.right}px ${edges.bottom}px ${edges.left}px!important;width:calc(var(--dr-page-width,100vw) - ${horizontal}px)!important;height:calc(100vh - ${vertical}px)!important;column-gap:${horizontal}px!important;column-fill:auto!important;overflow:visible!important;`
      : `margin:0!important;padding:${edges.top}px ${edges.right}px ${edges.bottom}px ${edges.left}px!important;height:auto!important;width:auto!important;column-count:auto!important;column-width:auto!important;column-gap:normal!important;overflow:visible!important;`;
    // The chosen size is also the root size, as calibre's viewer applies its base font size to the
    // document element (src/pyj/read_book/settings.pyj, apply_font_size): books that size text in
    // rem, such as Kindle conversions, then scale with it instead of staying at the 16px default
    // while only the inherited line height grows.
    this.style.textContent = `html{font-size:${reading.fontSize}px!important;background:${colors.paper}!important;color:${colors.text}!important;overflow:${paged ? "hidden" : "auto"}!important;scroll-behavior:auto!important;height:${paged ? "100%" : "auto"}!important;direction:ltr!important}body{font-family:${fontStack(reading.fontFamily)}!important;font-size:${reading.fontSize}px!important;font-weight:${reading.fontWeight}!important;line-height:${reading.lineHeight}!important;letter-spacing:${reading.letterSpacing}px!important;background:${colors.paper}!important;color:${colors.text}!important;max-width:none!important;min-width:0!important;box-sizing:border-box!important;${margin}}body p,body li,body div{font-family:inherit!important;font-size:inherit!important;font-weight:inherit!important;line-height:inherit!important;color:inherit!important;overflow-wrap:anywhere}p{orphans:2;widows:2}${spacing}${paragraph}img,svg,video{max-width:100%!important;max-height:${paged ? `calc(100vh - ${vertical}px)` : "100vh"}!important;object-fit:contain}table{max-width:100%!important}pre{white-space:pre-wrap!important;overflow-wrap:anywhere}a{color:${colors.link}!important}h1,h2,h3,h4{color:inherit!important;break-after:avoid}*{scroll-behavior:auto!important}::selection{background:${colors.selection}!important}::-webkit-scrollbar{width:5px}::-webkit-scrollbar-thumb{background:${colors.link}55;border-radius:1px}`;
    if (this.atEnd()) this.style.textContent += `html{height:100%!important;overflow:hidden!important}body{display:flex!important;align-items:center!important;justify-content:center!important;margin:0!important;padding:0!important;width:100vw!important;height:100vh!important;columns:auto!important;user-select:none!important}#dr-end{font-family:"Microsoft YaHei","微软雅黑",sans-serif!important;font-size:clamp(64px,12vmin,120px)!important;font-weight:400!important;line-height:1!important;letter-spacing:0!important}`;
    this.reflow();
  }

  atEnd() { return Boolean(this.book && this.chapter === this.book.chapters.length); }

  syncChrome() {
    const root = $("reader-view");
    if (!root || !this.settings) return;
    const r = this.settings;
    const toolbar = String(r.showToolbar !== false);
    if (root.dataset.toolbar && root.dataset.toolbar !== toolbar) this.animateToolbar();
    $<HTMLButtonElement>("collapse-toolbar").setAttribute("aria-expanded", toolbar);
    $<HTMLButtonElement>("expand-toolbar").setAttribute("aria-expanded", toolbar);
    for (const [key, setting] of [["toolbar", "showToolbar"], ["chapterTitle", "showChapterTitle"],
      ["pagination", "showPagination"], ["progress", "showProgress"]])
      root.dataset[key] = String(r[setting as keyof ReadingSettings] !== false);
    root.dataset.bookPages = String(r.showBookPages !== false && r.mode === "paged");
    const footerAutoHide = Boolean(r.autoHideProgress && (r.showProgress !== false || root.dataset.bookPages === 'true'));
    if (root.dataset.footerAutoHide !== String(footerAutoHide)) this.setFooterExpanded(false);
    root.dataset.footerAutoHide = String(footerAutoHide);
    $('footer-reveal-zone').hidden = !footerAutoHide;
    this.reportBookPages();
    root.dataset.fullBackground = String(Boolean(r.fullBackground));
    root.dataset.fullWidth = String(Boolean(r.fullWidth));
    root.style.setProperty("--reading-paper", readingPalette(r.theme).paper);
    root.style.setProperty("--reading-text", readingPalette(r.theme).text);
    $("toc-panel").hidden = r.showToc === false;
    const panel = $("toc-panel");
    panel.dataset.pinned = String(Boolean(r.tocPinned));
    panel.inert = !r.tocPinned && panel.dataset.expanded !== "true";
    $("toc-reveal-zone").hidden = r.showToc === false || Boolean(r.tocPinned);
    const pin = $("pin-toc");
    pin.setAttribute("aria-pressed", String(Boolean(r.tocPinned)));
    const pinLabel = r.tocPinned ? "取消固定侧边栏" : "固定侧边栏";
    pin.dataset.tooltip = pinLabel;
    pin.setAttribute("aria-label", pinLabel);
    for (const button of document.querySelectorAll<HTMLElement>("[data-quick-mode]"))
      button.setAttribute("aria-checked", String(button.dataset.quickMode === r.mode));
    for (const button of document.querySelectorAll<HTMLElement>("[data-quick-theme]"))
      button.setAttribute("aria-checked", String(button.dataset.quickTheme === r.theme));
    $<HTMLOutputElement>("quick-font-size").value = String(r.fontSize);
    $<HTMLButtonElement>("font-smaller").disabled = r.fontSize <= 10;
    $<HTMLButtonElement>("font-larger").disabled = r.fontSize >= 56;
    requestAnimationFrame(() => this.updateTocIndicator());
    if (r.showToolbar !== false) this.showCorners("");
  }

  /** The collapse buttons share the 顶部工具栏 preference, so the drawer switch stays in sync. */
  setToolbarVisible(visible: boolean): void {
    if (this.onReadingSetting) this.onReadingSetting({ showToolbar: visible });
    else { this.settings = { ...this.settings, showToolbar: visible }; this.syncChrome(); }
    // Keep keyboard focus on the control that undoes the action once it appears.
    requestAnimationFrame(() => $(visible ? "collapse-toolbar" : "expand-toolbar").focus({ preventScroll: true }));
  }

  /**
   * The toolbar slides by animating its margin. The book frame keeps its height meanwhile,
   * otherwise the EPUB would repaginate on every frame; it relayouts once when the motion ends.
   */
  animateToolbar() {
    if (this.appSettings?.animations === false) return;
    const root = $("reader-view"), frame = $<HTMLIFrameElement>("book-frame");
    if (!root.classList.contains("toolbar-moving")) frame.style.height = `${frame.getBoundingClientRect().height}px`;
    root.classList.add("toolbar-moving");
    clearTimeout(this.toolbarTimer);
    this.toolbarTimer = setTimeout(() => {
      frame.style.height = "";
      root.classList.remove("toolbar-moving");
    }, 300); // just past the 260 ms --toolbar-motion slide
  }

  /** A centre tap reveals both corner buttons briefly, for touch and for discovering them. */
  peekControls() {
    if (this.settings?.showToolbar !== false || !this.book) return;
    this.showCorners("both");
    clearTimeout(this.peekTimer);
    this.peekTimer = setTimeout(() => this.showCorners(""), 2500);
  }

  /**
   * With the toolbar collapsed, the top-left corner reveals 书库 and the top-right corner 阅读设置
   * and the expand button; they fade out shortly after the pointer leaves. x and y are window pixels.
   * The top-right trigger is a 6px strip under the title bar, as wide as the 阅读设置 and expand
   * buttons, so reaching for the page does not flash them; once shown, they stay while the
   * pointer is over them.
   */
  trackCorners(x: number, y: number): void {
    if (this.settings?.showToolbar !== false || !this.book) return;
    const shown = $("reader-view").dataset.corner ?? "";
    const overEnd = ["end", "both"].includes(shown) && ["corner-settings", "expand-toolbar"].some(id => {
      const r = $(id).getBoundingClientRect();
      return x >= r.left - 6 && x <= r.right + 6 && y >= r.top - 6 && y <= r.bottom + 6;
    });
    // Hidden buttons keep their layout box, so the strip follows the label's real width.
    const endStrip = y >= 0 && y < 6 && x >= $("corner-settings").getBoundingClientRect().left;
    const corner = y >= 0 && y < 72 && x < 180 ? "start" : endStrip || overEnd ? "end" : "";
    if (corner) {
      clearTimeout(this.peekTimer);
      this.showCorners(corner);
    } else if ($("reader-view").dataset.corner && !this.cornerTimer) {
      this.cornerTimer = setTimeout(() => { this.cornerTimer = undefined; this.showCorners(""); }, 400);
    }
  }

  showCorners(corner: "" | "start" | "end" | "both"): void {
    clearTimeout(this.cornerTimer);
    this.cornerTimer = undefined;
    $("reader-view").dataset.corner = corner;
  }

  /**
   * Remembers when the app loses and regains focus. Window.cpp eats the activating click through
   * WM_MOUSEACTIVATE, but WebView2's own child window may answer that message without asking us,
   * so the page also ignores the press that brought the app back to the foreground.
   * Both the shell and each chapter frame report blur/focus; focus moving between them keeps
   * document.hasFocus() true and is not a deactivation.
   */
  trackActivation(target: ActivationTarget | null): void {
    if (!target || target.drActivationTracked) return;
    target.drActivationTracked = true;
    target.addEventListener("blur", () => setTimeout(() => {
      if (!document.hasFocus()) this.inactive = true;
    }, 0));
    target.addEventListener("focus", () => {
      if (!this.inactive) return;
      this.inactive = false;
      this.activatedAt = performance.now();
    });
  }

  /** True for the first press after the app comes back to the foreground; it is consumed. */
  takeActivationPress() {
    const activating = this.inactive || performance.now() - (this.activatedAt ?? -Infinity) < 400;
    this.inactive = false;
    this.activatedAt = -Infinity;
    return activating;
  }

  beginPageTap(event: PointerEvent): void {
    clearTimeout(this.tapTimer);
    if (event.button === 0 && this.takeActivationPress()) {
      // Activation only: no page turn, link, note or selection menu from this press.
      this.tapDismissed = true;
      this.tapStart = null;
      return;
    }
    const tip = (event.target as Element | null)?.closest?.<HTMLElement>(".dr-note-tip");
    const editsNote = Boolean(tip && this.annotationLayer?.ranges.has(tip.dataset.id!));
    const dismissed = event.button === 0 && event.isPrimary !== false && this.dismissPagePopups();
    // A note icon is an explicit edit action, even when its hover preview is open.
    this.tapDismissed = dismissed && !editsNote;
    if (dismissed || editsNote) {
      event.preventDefault();
      this.tapStart = null;
      return;
    }
    this.tapStart = event.button === 0 && event.isPrimary !== false
      ? { x: event.clientX, y: event.clientY, time: performance.now(), selected: Boolean(this.doc?.getSelection()?.toString()) }
      : null;
  }

  /** A press on the page closes the whole floating stack and consumes that click. */
  dismissPagePopups() {
    const panel = $("toc-panel");
    const sidebarOpen = !this.settings?.tocPinned && !panel.hidden && panel.dataset.expanded === "true";
    const open = this.colorPicker?.isOpen || !$("selection-menu").hidden ||
      !$("mark-palette").hidden || !$("note-peek").hidden || sidebarOpen;
    if (!open) return false;
    this.colorPicker?.close(false);
    this.hideSelection();
    this.hideNotePeek();
    if (sidebarOpen) this.setTocExpanded(false);
    this.doc?.getSelection()?.removeAllRanges();
    return true;
  }

  consumeDismissedTap(event: Event): boolean {
    if (!this.tapDismissed) return false;
    this.tapDismissed = false;
    event.preventDefault();
    event.stopImmediatePropagation();
    return true;
  }

  pageTap(event: MouseEvent, width: number, offsetX = 0): void {
    const start = this.tapStart;
    this.tapStart = null;
    if (!start || this.settings?.mode !== "paged" || this.loading || this.reflowing || event.button !== 0 ||
        event.ctrlKey || event.altKey || event.shiftKey || event.metaKey || event.detail > 1 ||
        Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6 || performance.now() - start.time > 500 ||
        start.selected || this.doc?.getSelection()?.toString() ||
        (event.target as Element | null)?.closest?.("a,button,input,select,textarea,[contenteditable]")) return;
    const direction = pageClickDirection(event.clientX - offsetX, width);
    const corner = this.cornerAt(event);
    // A second press cancels the pending tap before double-click word selection.
    const doc = this.doc, generation = this.generation;
    if (direction) this.tapTimer = setTimeout(() => {
      if (doc === this.doc && generation === this.generation && !this.doc?.getSelection()?.toString()) this.turn(direction, corner);
    }, 220);
    else this.peekControls();
  }

  measure() {
    if (!this.doc) return;
    // Note tips sit in document coordinates: they must not widen the page count, and they move
    // with the text whenever the layout changes.
    this.annotationLayer?.hideTips();
    this.measurePages();
    this.annotationLayer?.placeTips();
  }

  measurePages() {
    const doc = this.doc!;
    const view = doc.defaultView!;
    if (!this.pageTail || this.pageTail.ownerDocument !== doc) {
      this.pageTail = doc.createElement("div");
      this.pageTail.setAttribute("aria-hidden", "true");
      // Outside body: this spacer must not become another column or text anchor.
      this.pageTail.style.cssText = "position:absolute!important;top:0!important;width:1px!important;height:1px!important;margin:0!important;padding:0!important;border:0!important;visibility:hidden!important;pointer-events:none!important";
      doc.documentElement.append(this.pageTail);
    }
    const paged = this.settings.mode === "paged";
    this.pageTail.style.setProperty("display", paged ? "block" : "none", "important");
    this.pageTail.style.left = "0px";
    if (!paged) {
      this.pages = 1;
      return;
    }
    const width = Math.max(1, view.innerWidth);
    doc.documentElement.style.setProperty("--dr-page-width", `${width}px`);
    this.pages = Math.max(1, Math.ceil((doc.documentElement.scrollWidth - 2) / width));
    // Column overflow omits the last outer margin. Reserve the complete last
    // viewport so scrollTo(lastPage * width) cannot be clamped to a partial page.
    this.pageTail.style.left = `${this.pages * width - 1}px`;
    this.recordChapterPages();
  }

  /** Remembers this chapter's exact page count; any layout change starts the counts afresh. */
  recordChapterPages() {
    const stats = this.bookStats;
    if (!stats || !this.doc) return;
    const view = this.doc.defaultView!;
    const layout = `${view.innerWidth}x${view.innerHeight}|${JSON.stringify(this.settings)}`;
    if (stats.layout !== layout) { stats.layout = layout; stats.exact.clear(); stats.exact.set(this.book!.chapters.length, 1); }
    // A spread is two book pages; the whole-book count stays in printed pages.
    stats.exact.set(this.chapter, this.atEnd() ? 1 : this.pages * (this.isDouble() ? 2 : 1));
    stats.chars[this.chapter] ??= chapterTextLength(this.doc.body.innerHTML);
  }

  /** Characters a full page holds, from the line box and the type size, before any measurement. */
  fallbackPerPage() {
    if (!this.doc) return 600;
    const view = this.doc.defaultView!, s = this.settings;
    const edges = pageMargins(s, view.innerWidth, view.innerHeight);
    const line = s.fontSize * s.lineHeight, glyph = s.fontSize + s.letterSpacing;
    return Math.max(1, Math.floor((view.innerHeight - edges.top - edges.bottom) / line) *
      Math.floor((view.innerWidth - edges.left - edges.right) / Math.max(1, glyph)));
  }

  /** Chapter text lengths come from the engine's search text, without loading the chapters. */
  async loadBookStats(book: Book): Promise<void> {
    const stats: BookStats = { bookId: book.id, chars: Array<number | undefined>(book.chapters.length).fill(undefined).concat(0), exact: new Map([[book.chapters.length, 1]]), layout: "" };
    this.bookStats = stats;
    try {
      const { chars } = await call<{ chars?: number[] }>("book.stats", { id: book.id });
      if (this.bookStats !== stats || !Array.isArray(chars)) return;
      chars.forEach((length, index) => { stats.chars[index] ??= length; });
      this.reportBookPages();
    } catch {
      if (this.bookStats === stats) { stats.failed = true; this.reportBookPages(); }
    }
  }

  reportBookPages() {
    const element = $("book-pages");
    if (!element) return;
    const stats = this.bookStats;
    const show = this.settings?.showBookPages !== false && this.settings?.mode === "paged" && Boolean(stats && this.book && stats.bookId === this.book.id);
    const double = this.isDouble();
    const value = show && stats ? bookPages({ chars: stats.chars, exact: stats.exact, chapter: this.chapter,
      page: this.page * (double ? 2 : 1), fallbackPerPage: this.fallbackPerPage() / (double ? 2 : 1) }) : null;
    element.hidden = !show;
    if (!value) { element.textContent = stats?.failed ? "全书页码暂不可用" : "全书页码统计中…"; return; }
    element.textContent = `全书 ${value.current} / ${value.estimated ? "约 " : ""}${value.total} 页`;
    element.dataset.tooltip = value.estimated ? "未读章节按当前排版估算，读过的章节会更准确" : "按当前排版统计";
  }

  restore(): void {
    if (!this.doc) return;
    const doc = this.doc;
    const view = doc.defaultView!;
    const anchor = this.anchor && doc.getElementById(this.anchor);
    if (anchor) {
      this.revealRect(anchor.getBoundingClientRect());
      this.anchor = "";
    } else if (this.query) {
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const position = node.textContent!.indexOf(this.query);
        if (position >= 0) {
          const range = doc.createRange();
          range.setStart(node, position);
          range.setEnd(node, position + this.query.length);
          const rect = range.getBoundingClientRect();
          this.revealRect(rect);
          break;
        }
      }
      this.query = "";
    } else if (this.annotationFocus) {
      const range = this.annotationLayer?.ranges.get(this.annotationFocus);
      const rect = range?.getBoundingClientRect();
      if (rect) this.revealRect(rect);
      this.annotationFocus = "";
    } else if (this.settings.mode === "paged") {
      this.page = Math.round(this.ratio * (this.pages - 1));
      view.scrollTo(this.page * view.innerWidth, 0);
    } else
      view.scrollTo(
        0,
        this.ratio *
          Math.max(0, doc.documentElement.scrollHeight - view.innerHeight),
      );
  }

  revealRect(rect: DOMRect): void {
    const view = this.doc!.defaultView!;
    if (this.settings.mode === "paged") {
      const page = Math.max(0, Math.min(this.pages - 1,
        Math.floor((view.scrollX + rect.left - pageMargins(this.settings, view.innerWidth, view.innerHeight).left + 1) / Math.max(1, view.innerWidth))));
      view.scrollTo(page * view.innerWidth, 0);
    } else view.scrollTo(0, view.scrollY + rect.top - 40);
  }

  reflow() {
    if (!this.doc || $("app").hidden) return;
    clearTimeout(this.reflowTimer);
    const doc = this.doc, generation = this.generation;
    this.reflowTimer = setTimeout(() => {
      // Loading restores its own anchor after fonts/layout are ready. An old resize timer
      // must not consume that anchor in the outgoing document.
      if (doc !== this.doc || generation !== this.generation || this.loading || $("app").hidden) return;
      if (this.layoutViewport !== `${this.doc.defaultView!.innerWidth}x${this.doc.defaultView!.innerHeight}`) {
        this.appliedReading = null; this.apply({ reading: this.settings, application: this.appSettings }); return;
      }
      this.measure();
      // CSS Highlight ranges track layout automatically; keep their text anchors intact.
      this.restore();
      this.reflowing = false;
      if (!this.loading) this.report();
      this.prepareMotion();
    }, 100);
  }

  scrolled() {
    this.hideSelection();
    if (this.loading || this.reflowing) return;
    this.report();
  }

  report() {
    if (!this.doc || !this.book) return;
    const doc = this.doc;
    const view = doc.defaultView!;
    if (this.settings.mode === "paged") {
      this.page = Math.round(view.scrollX / Math.max(1, view.innerWidth));
      this.ratio = this.pages <= 1 ? 0 : this.page / (this.pages - 1);
    } else
      this.ratio = Math.min(
        1,
        view.scrollY /
          Math.max(1, doc.documentElement.scrollHeight - view.innerHeight),
      );
    if (this.atEnd()) this.ratio = 1;
    this.activeToc();
    const progress = this.atEnd() ? 1 : Math.min(.999,
      (this.chapter + this.ratio) / this.book.chapters.length);
    $("page-indicator").textContent =
      this.settings.mode === "paged"
        ? `${this.page + 1} / ${this.pages}`
        : `本节 ${Math.round(this.ratio * 100)}%`;
    $("reader-location").textContent =
      this.atEnd() ? "全书完" : `第 ${this.chapter + 1} / ${this.book.chapters.length} 节`;
    $("reader-percent").textContent = `${this.atEnd() ? 100 : Math.min(99, Math.round(progress * 100))}%`;
    $<HTMLInputElement>("reading-progress").value = String(Math.round(progress * 1000));
    $<HTMLButtonElement>("prev-page").disabled = this.chapter === 0 && this.ratio <= 0;
    $<HTMLButtonElement>("next-page").disabled =
      this.atEnd();
    this.updateMark();
    this.reportBookPages();
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 450);
  }

  async flush() {
    clearTimeout(this.saveTimer);
    if (!this.book || !this.doc || this.loading) return;
    const id = this.book.id;
    const position = { chapter: this.chapter, ratio: this.ratio };
    try {
      const book = await call<Book>("position", { id, position });
      if (this.book?.id === id) this.book = book;
      this.onUpdate(book);
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  }

  wheel(event: WheelEvent): Promise<void> | undefined {
    this.hideSelection();
    if (this.settings?.mode !== "paged" || event.ctrlKey || event.metaKey) return;
    const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    if (!delta) return;
    event.preventDefault();
    this.wheelPaging ??= new WheelPaging();
    const direction = this.wheelPaging.accept(event);
    if (this.reflowing || !direction) return;
    return this.turn(direction, this.cornerAt(event), true);
  }

  /** Book-page half under a pointer event, from the shell or from inside the book frame. */
  cornerAt(event: MouseEvent): Corner {
    const frame = $<HTMLIFrameElement>("book-frame");
    const y = event.clientY + (event.view === frame.contentWindow ? frame.getBoundingClientRect().top : 0);
    const page = $("page-surface").getBoundingClientRect();
    return pageCorner(y - page.top, page.height);
  }

  turn(direction: number, corner: Corner = "top", wheel = false): Promise<void> {
    const revision = this.navigationRevision;
    const bookId = this.book?.id;
    const mode = this.settings?.mode;
    let backlog: { revision: number; count: number } | undefined;
    if (wheel) {
      if (this.wheelBacklog?.revision !== revision)
        this.wheelBacklog = { revision, count: 0 };
      backlog = this.wheelBacklog;
      // Even an unusually fast wheel must not build an unbounded animation backlog.
      if (backlog.count >= 8) return this.turnQueue;
      backlog.count++;
      this.motion?.setSpeed(Math.min(10, 1 + (backlog.count - 1) * .6));
    }
    this.turnQueue = this.turnQueue.then(async () => {
      try {
        if (revision !== this.navigationRevision || bookId !== this.book?.id || mode !== this.settings?.mode ||
            $("app").hidden || document.querySelector("dialog[open]")) return;
        await this.turnPage(direction, corner);
        // Resident turns resolve as soon as they start. Wheel notches must wait for the
        // visible turn to finish so every queued page gets its own animation.
        if (wheel) await this.motion?.finished();
      } finally {
        if (backlog) {
          backlog.count--;
          if (this.wheelBacklog === backlog)
            this.motion?.setSpeed(Math.min(10, 1 + Math.max(0, backlog.count - 1) * .6));
        }
      }
    }).catch((error) => toast(errorMessage(error), "error"));
    return this.turnQueue;
  }

  async turnPage(direction: number, corner: Corner = "top"): Promise<void> {
    if (!this.doc || this.loading) return;
    this.hideSelection();
    const view = this.doc.defaultView!;
    if (this.settings.mode === "paged") {
      if (direction > 0 && this.page < this.pages - 1) {
        await this.animatePageChange(direction, () =>
          view.scrollTo((this.page + 1) * view.innerWidth, 0), corner,
        );
        this.report();
        return;
      }
      if (direction < 0 && this.page > 0) {
        await this.animatePageChange(direction, () =>
          view.scrollTo((this.page - 1) * view.innerWidth, 0), corner,
        );
        this.report();
        return;
      }
    } else {
      const maximum =
        this.doc.documentElement.scrollHeight - view.innerHeight;
      if (
        (direction > 0 && view.scrollY < maximum - 2) ||
        (direction < 0 && view.scrollY > 2)
      ) {
        view.scrollBy({ top: direction * view.innerHeight * .85,
          behavior: this.motion.enabled(this.settings.animation) ? "smooth" : "instant" });
        return;
      }
    }
    const next = this.chapter + direction;
    if (next >= 0 && next <= this.book!.chapters.length)
      await this.load(next, direction > 0 ? 0 : 1, "", "", "", direction, corner);
  }

  /** Two pages side by side need room; a narrow window falls back to one page. */
  isDouble() {
    return this.settings?.mode === "paged" && this.settings.layout === "double" &&
      ($<HTMLIFrameElement>("book-frame")?.clientWidth ?? 0) >= 640;
  }

  /** Spreads only turn like a book, so they keep their own animation setting. */
  pageEffect() {
    return (this.isDouble() ? this.settings.doubleAnimation : this.settings.animation) || "none";
  }

  /** Page curls use their own, longer duration; slides and fades keep the short one. */
  motionDuration() {
    return this.pageEffect().startsWith("turn")
      ? this.settings.turnDuration ?? 800
      : this.settings.animationDuration;
  }

  async animatePageChange(direction: number, update: () => void, corner: Corner = "top"): Promise<void> {
    const effect = this.pageEffect();
    if (effect === "none") {
      update();
      return;
    }
    await this.motion.change(
      $("page-surface"),
      effect,
      this.motionDuration(),
      direction,
      update,
      false,
      corner,
      this.isDouble(),
    );
  }

  key(event: KeyboardEvent): void {
    if (event.key === "F8") { event.preventDefault(); this.onOpenSettings?.(); return; }
    if ((event.altKey && event.key === "Enter") || event.key === "F11") {
      event.preventDefault();
      if (!event.repeat) call(event.key === "F11" ? "fullscreen" : "titlebar").catch(error => toast(errorMessage(error), "error"));
      return;
    }
    if (event.ctrlKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      this.openSearch();
      return;
    }
    if (
      event.key === "ArrowRight" ||
      event.key === "PageDown" ||
      event.key === " "
    ) {
      event.preventDefault();
      this.turn(1);
    } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
      event.preventDefault();
      this.turn(-1);
    }
  }

  dismissSelection() {
    if (this.colorPicker?.isOpen) {
      this.colorPicker.close();
      return true;
    }
    // Let the active dialog handle Escape before touching the menu underneath it.
    if (document.querySelector("dialog[open]")) return false;
    if (!$("mark-palette").hidden) {
      $("mark-palette").hidden = true;
      this.paletteStyle = "";
      return true;
    }
    if (!$("note-peek").hidden) {
      this.hideNotePeek();
      return true;
    }
    if ($("selection-menu").hidden) return false;
    this.hideSelection();
    this.doc?.getSelection()?.removeAllRanges();
    return true;
  }

  readSelection() {
    if (!this.doc) return;
    const selection = this.doc.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (range.toString().trim()) this.showSelectionMenu(range);
  }

  showSelectionMenu(range: Range, annotationId = ""): void {
    const rect =
      this.annotationLayer?.rect(range) || range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return;
    const text = range.toString().trim();
    if (!text) return;
    this.hideNotePeek();
    if (!annotationId) {
      for (const [id, candidate] of this.annotationLayer?.ranges || []) {
        if (range.compareBoundaryPoints(Range.START_TO_START, candidate) === 0 &&
            range.compareBoundaryPoints(Range.END_TO_END, candidate) === 0) {
          annotationId = id;
          break;
        }
      }
    }
    const existing = this.annotations.find((annotation) => annotation.id === annotationId);
    this.selection = {
      range: range.cloneRange(),
      text,
      annotationId,
    };
    this.syncMarkButtons();
    $("mark-palette").hidden = true;
    this.paletteStyle = "";
    const actions = this.appSettings.selectionActions;
    $("selection-highlight-group").hidden = !actions.highlight;
    $("selection-underline-group").hidden = !actions.underline;
    $("selection-note").hidden = !actions.note;
    $("selection-note-label").textContent = existing?.note ? "编辑笔记" : "记笔记";
    $("selection-note-delete").hidden = !existing?.note;
    $("selection-copy").hidden = !actions.copy;
    $("selection-search").hidden = !actions.search;
    $("selection-ask").hidden = !actions.ask;
    const dictionaries =
      this.appSettings.dictionaries?.filter(
        (dictionary) => dictionary.enabled,
      ) || [];
    $("selection-dictionary").hidden =
      !actions.dictionary || !dictionaries.length;
    const menu = $("selection-menu");
    menu.hidden = false;
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const left = Math.max(12, Math.min(rect.left, innerWidth - width - 12));
    let top = rect.top - height - 10;
    if (top < 8) top = Math.min(innerHeight - height - 12, rect.bottom + 10);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  hideSelection() {
    clearTimeout(this.selectionTimer);
    $("selection-menu").hidden = true;
    $("mark-palette").hidden = true;
    this.paletteStyle = "";
    if (!$<HTMLDialogElement>("annotation-dialog").open) this.selection = null;
  }

  selectedAnnotation() {
    return this.annotations.find((annotation) => annotation.id === this.selection?.annotationId);
  }

  /** The colour each mark applies next: the passage's own colour if it carries that mark. */
  markColor(style: MarkStyle): string {
    const existing = this.selectedAnnotation();
    if (existing && existing.style === style) return normalizeColor(existing.color);
    return style === "underline"
      ? normalizeColor(this.appSettings?.underlineColor || "#ddebf1")
      : this.palette()[0];
  }

  /** Pressed buttons show which mark the passage carries; each dot shows the colour it applies. */
  syncMarkButtons() {
    const existing = this.selectedAnnotation();
    const dark = document.body.dataset.theme === "dark";
    for (const style of ["highlight", "underline"] as const) {
      $(`selection-${style}`).setAttribute("aria-pressed", String(existing?.style === style));
      $(`selection-${style}`).title = existing?.style === style
        ? `移除${style === "underline" ? "下划线" : "高亮"}` : "";
      const colors = paint(this.markColor(style), dark ? "#191919" : "#ffffff", dark);
      const shown = style === "underline" ? colors.ink : colors.fill;
      $(`${style}-color`).style.setProperty("--swatch", shown);
      $(`selection-${style}`).style.setProperty("--mark", shown);
    }
  }

  toggleMarkPalette(dot: HTMLElement): void {
    const palette = $("mark-palette");
    const style = dot.dataset.style as MarkStyle;
    if (!palette.hidden && this.paletteStyle === style) {
      palette.hidden = true;
      this.paletteStyle = "";
      return;
    }
    this.paletteStyle = style;
    const current = this.markColor(style);
    palette.querySelectorAll<HTMLElement>("[data-color]").forEach((button) =>
      button.classList.toggle("selected", button.dataset.color === current));
    palette.hidden = false;
    // Absolute offsets start inside the menu border; leave 1px between the two borders.
    const menuElement = $("selection-menu");
    const menu = menuElement.getBoundingClientRect();
    const rect = dot.getBoundingClientRect();
    palette.style.left = `${Math.max(4, rect.left - menu.left - 8)}px`;
    palette.style.top = `${menu.height + 1 - menuElement.clientTop}px`;
  }

  /** Applies the mark in the picked colour; the colour becomes that mark's default. */
  async pickMarkColor(style: MarkStyle, color: string, custom = false): Promise<void> {
    color = normalizeColor(color);
    $("mark-palette").hidden = true;
    this.paletteStyle = "";
    // Save with the selection first: storing a setting re-applies settings, which dismisses
    // the selection menu.
    await this.saveSelection(color, style);
    if (style === "underline") {
      this.appSettings = { ...this.appSettings, underlineColor: color };
      this.onApplicationSetting?.({ underlineColor: color });
      if (custom) this.rememberColor(color);
    } else this.rememberColor(color);
  }

  /** Marks the passage, or removes the mark when it already carries it (a note stays behind). */
  async toggleMark(style: MarkStyle): Promise<void> {
    const existing = this.selectedAnnotation();
    if (!existing || existing.style !== style) {
      await this.saveSelection(this.markColor(style), style);
      return;
    }
    try {
      if (existing.note) await this.saveAnnotation({ ...existing, style: "note" });
      else await this.removeAnnotation(existing);
      this.doc?.getSelection()?.removeAllRanges();
    } catch (error) { toast(errorMessage(error), "error"); }
  }

  /** Deletes the note; a passage that was only kept for its note disappears with it. */
  async deleteNote() {
    const existing = this.selectedAnnotation();
    if (!existing?.note) return;
    try {
      if (existing.style === "note") await this.removeAnnotation(existing);
      else await this.saveAnnotation({ ...existing, note: "" });
      this.doc?.getSelection()?.removeAllRanges();
      toast("笔记已删除", "success");
    } catch (error) { toast(errorMessage(error), "error"); }
  }

  /** Resting on a noted passage (or its tip) shows the note after a short pause. */
  hoverNote(event: PointerEvent): void {
    if (event.buttons || !$("selection-menu").hidden) return;
    const note = this.annotationLayer?.noteAtPoint(event);
    if (note?.id === this.notePeekId) { clearTimeout(this.notePeekTimer); if (!$("note-peek").hidden) return; }
    if (!note) { if (this.notePeekId) this.scheduleNotePeekHide(); return; }
    clearTimeout(this.notePeekTimer);
    this.notePeekId = note.id;
    this.notePeekTimer = setTimeout(() => this.showNotePeek(note), $("note-peek").hidden ? 350 : 0);
  }

  showNotePeek(note: NoteMark): void {
    const rect = this.annotationLayer?.rect(note.range);
    if (!rect || !$("selection-menu").hidden) return;
    const peek = $("note-peek");
    $("note-peek-text").textContent = note.note;
    peek.style.setProperty("--note-ink", note.ink);
    peek.hidden = false;
    $("note-peek-text").scrollTop = 0;
    const width = peek.offsetWidth;
    const height = peek.offsetHeight;
    const left = Math.max(12, Math.min(rect.left, innerWidth - width - 12));
    let top = rect.bottom + 8;
    if (top + height > innerHeight - 12) top = Math.max(8, rect.top - height - 8);
    peek.style.left = `${left}px`;
    peek.style.top = `${top}px`;
  }

  scheduleNotePeekHide() {
    clearTimeout(this.notePeekTimer);
    this.notePeekTimer = setTimeout(() => this.hideNotePeek(), 200);
  }

  hideNotePeek() {
    clearTimeout(this.notePeekTimer);
    this.notePeekId = "";
    if ($("note-peek")) $("note-peek").hidden = true;
  }

  selectionAnchor() {
    if (!this.selection) return null;
    return anchorFromRange(this.doc!, this.selection.range);
  }

  async saveSelection(color = this.palette()[0], style: MarkStyle = "highlight"): Promise<void> {
    if (!this.selection || !this.book) return;
    const selection = this.selection;
    const existing = this.annotations.find(
      (annotation) => annotation.id === selection.annotationId,
    );
    const anchor = this.selectionAnchor();
    if (!anchor) {
      toast("这段文字无法稳定定位，请缩小选择范围。");
      return;
    }
    try {
      await this.saveAnnotation({
        ...anchor,
        id: existing?.id || "",
        note: existing?.note || "",
        color,
        style,
      });
      this.doc?.getSelection()?.removeAllRanges();
      if (style !== "underline") toast("已添加高亮", "success");
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  }

  /** The five most recent highlight colours (Notion backgrounds by default). */
  palette() {
    const colors = this.appSettings?.highlightColors;
    return (Array.isArray(colors) && colors.length ? colors : DEFAULT_PALETTE).map(normalizeColor);
  }

  /** A newly picked colour takes the first slot and pushes the oldest one out. */
  rememberColor(color: string): void {
    const highlightColors = pushColor(this.palette(), color);
    this.appSettings = { ...this.appSettings, highlightColors };
    this.renderHighlightPalette();
    this.onApplicationSetting?.({ highlightColors });
  }

  renderHighlightPalette() {
    const palette = this.palette();
    const dark = document.body.dataset.theme === "dark";
    const signature = `${palette.join()}|${dark}`;
    if (signature === this.paletteSignature) return;
    this.paletteSignature = signature;
    const dots = palette.map((color) => {
      const swatch = dark ? paint(color, "#191919", true).fill : color;
      return `<button type="button" class="color-dot" data-color="${color}" style="--swatch:${swatch}" title="${color}" aria-label="高亮颜色 ${color}"></button>`;
    }).join("");
    const custom = `<button type="button" class="color-dot color-custom" title="自定义颜色" aria-label="自定义颜色"></button>`;
    for (const id of ["highlight-swatches", "annotation-swatches"]) if ($(id)) $(id).innerHTML = dots + custom;
    this.syncDialogColors();
  }

  async saveAnnotation(values: AnnotationValues): Promise<Annotation> {
    const book = this.book!;
    const annotation = {
      id: values.id || "",
      chapter: this.chapter,
      href: book.chapters[this.chapter]?.href,
      start: values.start,
      end: values.end,
      quote: values.quote,
      prefix: values.prefix || "",
      suffix: values.suffix || "",
      note: values.note || "",
      color: normalizeColor(values.color || this.palette()[0]),
      style: values.style || "highlight",
    };
    const saved = await call<Annotation>("annotation.save", {
      id: book.id,
      annotation,
    });
    const index = this.annotations.findIndex((item) => item.id === saved.id);
    if (index >= 0) this.annotations[index] = saved;
    else this.annotations.push(saved);
    this.hideSelection();
    this.refreshAnnotations();
    this.notes();
    this.selection = null;
    return saved;
  }

  attachAnnotationDrag() {
    const dialog = $<HTMLDialogElement>("annotation-dialog");
    const header = dialog.querySelector<HTMLElement>(".annotation-header")!;
    let drag: { id: number; x: number; y: number; left: number; top: number } | null = null;
    const position = (left: number, top: number) => {
      dialog.style.inset = "auto";
      dialog.style.margin = "0";
      dialog.style.left = `${Math.max(8, Math.min(left, innerWidth - dialog.offsetWidth - 8))}px`;
      dialog.style.top = `${Math.max(8, Math.min(top, innerHeight - dialog.offsetHeight - 8))}px`;
    };
    const finish = () => {
      if (drag && header.hasPointerCapture(drag.id)) header.releasePointerCapture(drag.id);
      drag = null;
      delete dialog.dataset.dragging;
    };
    header.addEventListener("pointerdown", event => {
      if (event.button !== 0 || (event.target as Element).closest("button")) return;
      event.preventDefault();
      this.colorPicker.close(false);
      const rect = dialog.getBoundingClientRect();
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
      header.setPointerCapture(event.pointerId);
      dialog.dataset.dragging = "true";
    });
    header.addEventListener("pointermove", event => {
      if (!drag || event.pointerId !== drag.id) return;
      position(drag.left + event.clientX - drag.x, drag.top + event.clientY - drag.y);
    });
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) header.addEventListener(type, finish);
    dialog.addEventListener("close", () => { finish(); this.colorPicker.close(false); });
    window.addEventListener("resize", () => {
      if (dialog.open && dialog.style.left) position(parseFloat(dialog.style.left), parseFloat(dialog.style.top));
    });
  }

  openAnnotationDialog() {
    if (!this.selection) return;
    const selection = this.selection;
    this.editingAnnotation =
      this.annotations.find(
        (annotation) => annotation.id === selection.annotationId,
      ) || null;
    this.dialogColor = normalizeColor(this.editingAnnotation?.color || this.palette()[0]);
    const quote = document.createElement("span");
    quote.textContent = this.editingAnnotation?.quote || this.selection.text;
    $("annotation-quote").replaceChildren(quote);
    $<HTMLTextAreaElement>("annotation-note").value = this.editingAnnotation?.note || "";
    const style = this.editingAnnotation?.style || "highlight";
    for (const radio of document.getElementsByName("annotation-style") as NodeListOf<HTMLInputElement>) radio.checked = radio.value === style;
    $("annotation-delete").hidden = !this.editingAnnotation;
    $("annotation-title").textContent = this.editingAnnotation
      ? "编辑标注"
      : "记笔记";
    this.syncDialogColors();
    $("selection-menu").hidden = true;
    const dialog = $<HTMLDialogElement>("annotation-dialog");
    for (const property of ["inset", "margin", "left", "top"]) dialog.style.removeProperty(property);
    dialog.showModal();
    setTimeout(() => $<HTMLTextAreaElement>("annotation-note").focus(), 0);
  }

  dialogStyle(): AnnotationStyle {
    return (document.querySelector<HTMLInputElement>("[name=annotation-style]:checked")?.value || "highlight") as AnnotationStyle;
  }

  /** Marks the chosen swatch and paints the quoted passage the way it will appear in the book. */
  syncDialogColors() {
    const current = this.dialogColor && normalizeColor(this.dialogColor);
    const swatches = $("annotation-swatches");
    if (!swatches) return;
    swatches.querySelectorAll<HTMLElement>("[data-color]")
      .forEach((button) => button.classList.toggle("selected", button.dataset.color === current));
    const style = this.dialogStyle();
    const quote = $("annotation-quote");
    quote.dataset.style = style;
    const dark = document.body.dataset.theme === "dark";
    if (current) {
      // Same colours as the selection menu: highlights use the fill, underlines the ink.
      const colors = paint(current, dark ? "#191919" : "#ffffff", dark);
      quote.style.setProperty("--mark", style === "underline" ? colors.ink : colors.fill);
    }
    // A note without a mark has no colour to choose.
    swatches.closest(".annotation-color-row")!.toggleAttribute("data-disabled", style === "note");
    swatches.querySelectorAll("button").forEach((button) => (button.disabled = style === "note"));
  }

  async saveFromDialog() {
    const existing = this.editingAnnotation;
    const anchor = existing
      ? {
          id: existing.id,
          start: existing.start,
          end: existing.end,
          quote: existing.quote,
          prefix: existing.prefix,
          suffix: existing.suffix,
        }
      : this.selectionAnchor();
    if (!anchor) {
      toast("这段文字无法稳定定位，请重新选择。");
      return;
    }
    try {
      await this.saveAnnotation({
        ...anchor,
        note: $<HTMLTextAreaElement>("annotation-note").value.trim(),
        color: this.dialogColor,
        style: this.dialogStyle(),
      });
      this.doc?.getSelection()?.removeAllRanges();
      this.selection = null;
      $<HTMLDialogElement>("annotation-dialog").close();
      toast("笔记已保存", "success");
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  }

  async removeAnnotation(annotation: Annotation): Promise<void> {
    const bookId = this.book!.id;
    await call("annotation.delete", { id: bookId, annotationId: annotation.id });
    if (this.book?.id !== bookId) return;
    this.annotations = this.annotations.filter((item) => item.id !== annotation.id);
    if (this.editingAnnotation?.id === annotation.id) this.editingAnnotation = null;
    this.hideSelection();
    this.doc?.getSelection()?.removeAllRanges();
    this.refreshAnnotations();
    this.notes();
  }

  async deleteFromDialog() {
    if (!this.editingAnnotation) return;
    const existing = this.editingAnnotation;
    try {
      await this.removeAnnotation(existing);
      $<HTMLDialogElement>("annotation-dialog").close("cancel");
      this.selection = null;
      if (existing.style !== "underline") toast("标注已删除", "success");
    } catch (error) { toast(errorMessage(error), "error"); }
  }

  async copySelection() {
    if (!this.selection) return;
    try {
      await call("copy", { text: this.selection.text });
      this.hideSelection();
      this.doc?.getSelection()?.removeAllRanges();
      toast("已复制选中文字", "success");
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  }

  openSearch() {
    this.tab("search");
    $("toc-panel").hidden = false;
    this.onReadingSetting?.({ showToc: true });
    this.setTocExpanded(true);
    $<HTMLInputElement>("book-search-input").focus();
  }

  /** Toolbar font stepper; the engine clamps the same 10-56 px range. */
  stepFontSize(delta: number): void {
    const size = Math.min(56, Math.max(10, (this.settings?.fontSize ?? 20) + delta));
    if (size !== this.settings?.fontSize) this.onReadingSetting?.({ fontSize: size });
  }

  /** The book, chapter and chapter text around the reading position, for a question to an agent. */
  readingContext(): ReadingContext | null {
    if (!this.book) return null;
    const chapter = this.book.chapters[this.chapter];
    const text = this.doc?.body && !this.atEnd() ? textIndex(this.doc).text : "";
    const { text: excerpt, partial } = excerptAround(text, this.ratio);
    return { title: this.book.title, author: this.book.author, chapterTitle: chapter?.title, excerpt, partial };
  }

  /** 问 AI: opens the 问书 tab with the selected passage attached to the next question. */
  askSelection() {
    if (!this.selection) return;
    const quote = this.selection.text;
    this.hideSelection();
    this.doc?.getSelection()?.removeAllRanges();
    $("toc-panel").hidden = false;
    this.onReadingSetting?.({ showToc: true });
    this.setTocExpanded(true);
    this.tab("ask");
    this.chat.attach(quote);
  }

  searchSelection() {
    if (!this.selection) return;
    const query = this.selection.text.replace(/\s+/g, " ").slice(0, 256);
    this.hideSelection();
    $("toc-panel").hidden = false;
    this.onReadingSetting?.({ showToc: true });
    this.setTocExpanded(true);
    this.tab("search");
    $<HTMLInputElement>("book-search-input").value = query;
    this.search();
  }

  async lookupSelection() {
    if (!this.selection) return;
    const dictionaries =
      this.appSettings.dictionaries?.filter(
        (dictionary) => dictionary.enabled,
      ) || [];
    if (!dictionaries.length) return;
    const text = this.selection.text.slice(0, 8192);
    this.hideSelection();
    const dictionary =
      dictionaries.length === 1
        ? dictionaries[0]
        : await this.chooseDictionary(dictionaries);
    if (!dictionary) return;
    try {
      await call("lookup", { dictionaryId: dictionary.id, text });
      this.hideSelection();
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  }

  chooseDictionary(dictionaries: Dictionary[]): Promise<Dictionary | null> {
    return new Promise((resolve) => {
      const dialog = document.createElement("dialog");
      this.hideSelection();
      dialog.className = "dictionary-picker";
      dialog.setAttribute("aria-label", "选择查词网站");
      dialog.innerHTML = `<div class="dictionary-picker-header"><h2>选择查词网站</h2><button type="button" class="icon-button" aria-label="关闭查词窗口" title="关闭">${icon("close")}</button></div><div class="dictionary-picker-list"></div>`;
      let settled = false;
      const finish = (id = "") => {
        if (settled) return;
        settled = true;
        const selected = dictionaries.find((item) => item.id === id) || null;
        dialog.close(id);
        dialog.remove();
        resolve(selected);
      };
      dialog.querySelector<HTMLButtonElement>(".dictionary-picker-header button")!.onclick = () => finish();
      const outside = (event: MouseEvent) => {
        const rect = dialog.getBoundingClientRect();
        return event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right ||
          event.clientY < rect.top || event.clientY > rect.bottom);
      };
      let backdropPressed = false;
      dialog.addEventListener("pointerdown", (event) => { backdropPressed = outside(event); });
      dialog.addEventListener("click", (event) => {
        if (backdropPressed && outside(event)) finish();
        backdropPressed = false;
      });
      const root = dialog.querySelector(".dictionary-picker-list")!;
      for (const dictionary of dictionaries) {
        const button = document.createElement("button");
        button.className = "dictionary-choice";
        button.textContent = dictionary.name;
        button.onclick = () => finish(dictionary.id);
        root.append(button);
      }
      dialog.addEventListener("cancel", (event) => {
        event.preventDefault();
        finish();
      });
      dialog.addEventListener("close", () => finish(dialog.returnValue));
      document.body.append(dialog);
      dialog.showModal();
    });
  }

  async close() {
    this.navigationRevision = (this.navigationRevision ?? 0) + 1;
    await this.flush();
    ++this.generation;
    this.motion.cancel();
    clearTimeout(this.tapTimer);
    clearTimeout(this.peekTimer);
    this.footerDragging = false;
    this.setFooterExpanded(false);
    this.showCorners("");
    this.hideSelection();
    this.hideNotePeek();
    this.annotationLayer?.clear();
    this.annotationLayer = null;
    this.doc = null;
    this.style = null;
    this.pageTail = null;
    this.appliedDocument = null;
    this.appliedReading = null;
    this.book = null;
    this.annotations = [];
    this.chat?.close();
    $<HTMLIFrameElement>("book-frame").srcdoc = "";
  }
}
