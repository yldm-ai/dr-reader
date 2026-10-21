import { call, bookUrl, $, escape, toast } from "./bridge.js";
import {
  anchorFromRange,
  rangeForAnchor,
} from "./anchors.js";
import { AnnotationLayer } from "./annotations.js";
import { ReaderMotion } from "./motion.js";
import { fontStack } from "./settings.js";

export class Reader {
  constructor(onUpdate) {
    this.onUpdate = onUpdate;
    this.book = null;
    this.chapter = 0;
    this.ratio = 0;
    this.page = 0;
    this.pages = 1;
    this.generation = 0;
    this.saveTimer = null;
    this.turnQueue = Promise.resolve();
    this.motion = new ReaderMotion();
    this.selection = null;
    this.editingAnnotation = null;
    document.addEventListener("reader-dismiss-selection", () => this.hideSelection());
    document.addEventListener("pointerdown", (event) => {
      if (!event.target.closest("#selection-menu")) this.hideSelection();
    }, true);
    document.addEventListener("scroll", () => this.hideSelection(), true);
    window.addEventListener("resize", () => this.hideSelection());
    window.addEventListener("blur", () => this.hideSelection());
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.dismissSelection()) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);

    $("page-surface").addEventListener("wheel", (event) => this.wheel(event), { passive: false });
    $("prev-page").onclick = () => this.turn(-1);
    $("next-page").onclick = () => this.turn(1);
    $("toggle-toc").onclick = () => {
      $("toc-panel").hidden = !$("toc-panel").hidden;
      this.reflow();
    };
    $("add-bookmark").onclick = () => this.bookmark();
    $("reading-progress").onchange = () => {
      if (!this.book) return;
      const value =
        (Number($("reading-progress").value) / 1000) *
        this.book.chapters.length;
      const chapter = Math.min(
        this.book.chapters.length - 1,
        Math.floor(value),
      );
      this.load(chapter, Math.min(1, value - chapter));
    };
    document
      .querySelectorAll("[data-tab]")
      .forEach(
        (button) => (button.onclick = () => this.tab(button.dataset.tab)),
      );
    $("book-search-form").onsubmit = (event) => {
      event.preventDefault();
      this.search();
    };
    $("selection-menu").addEventListener("pointerdown", (event) => {
      if (event.target.closest("button")) event.preventDefault();
    });
    document
      .querySelectorAll("[data-color]")
      .forEach(
        (button) => (button.onclick = () => this.chooseHighlightColor(button.dataset.color)),
      );
    $("selection-underline").onclick = () => {
      const existing = this.annotations.find(
        (annotation) => annotation.id === this.selection?.annotationId,
      );
      this.saveSelection(existing?.color || "yellow", "underline");
    };
    $("selection-note").onclick = () => this.openAnnotationDialog();
    $("selection-copy").onclick = () => this.copySelection();
    $("selection-search").onclick = () => this.searchSelection();
    $("selection-dictionary").onclick = () => this.lookupSelection();
    document
      .querySelectorAll("[data-annotation-color]")
      .forEach(
        (button) =>
          (button.onclick = () => {
            this.dialogColor = button.dataset.annotationColor;
            this.syncDialogColors();
          }),
      );
    $("annotation-form").addEventListener("submit", (event) => {
      if (event.submitter?.id !== "annotation-save") return;
      event.preventDefault();
      this.saveFromDialog();
    });
    $("annotation-delete").onclick = () => this.deleteFromDialog();
    this.observer = new ResizeObserver(() => this.reflow());
    this.observer.observe($("book-frame"));
  }

  async open(book, settings) {
    await this.flush();
    this.book = book;
    this.motion.setAllowed(settings.application?.animations ?? true);
    this.chapter = 0;
    this.ratio = 0;
    $("reader-book-title").textContent = book.title;
    $("toc-panel").hidden = false;
    this.tab("toc");
    this.toc();
    this.marks();
    $("book-search-input").value = "";
    $("search-results").replaceChildren();
    try {
      this.annotations = await call("annotations", { id: book.id });
    } catch (error) {
      this.annotations = [];
      toast(error.message);
    }
    this.notes();
    this.apply(settings);
    const position = book.position || {};
    await this.load(position.chapter || 0, position.ratio || 0);
    if (!this.doc) {
      this.book = null;
      throw new Error(this.loadError || "章节没有完成载入");
    }
    this.motion.open($("reader-view"));
    if (book.warnings?.length)
      toast(
        `这本书有 ${book.warnings.length} 条兼容性提示，可查看本地 book.json。`,
      );
  }

  tab(name) {
    document
      .querySelectorAll("[data-tab]")
      .forEach((button) =>
        button.classList.toggle("active", button.dataset.tab === name),
      );
    for (const key of ["toc", "marks", "notes", "search"])
      $(`${key}-content`).hidden = key !== name;
    if (name === "notes") this.notes();
    if (name === "search") $("book-search-input").focus();
  }

  toc() {
    const root = $("toc-content");
    root.replaceChildren();
    for (const item of this.book.toc) {
      const button = document.createElement("button");
      button.className = "toc-entry";
      button.textContent = item.title;
      button.style.paddingLeft = `${12 + Math.min(item.depth, 5) * 13}px`;
      button.dataset.href = item.href;
      button.onclick = () => this.navigate(item.href);
      root.append(button);
    }
    this.activeToc();
  }

  activeToc() {
    if (!this.book) return;
    const href = this.book.chapters[this.chapter].href;
    let active = null;
    for (const button of $("toc-content").children) {
      button.classList.toggle(
        "active",
        button.dataset.href.split("#")[0] === href,
      );
      if (!active && button.classList.contains("active")) active = button;
    }
    active?.scrollIntoView({ block: "nearest" });
  }

  marks() {
    const root = $("marks-content");
    root.replaceChildren();
    for (const mark of this.book.bookmarks) {
      const button = document.createElement("button");
      button.className = "mark-entry";
      button.textContent =
        mark.title || this.book.chapters[mark.chapter]?.title || "书签";
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
        b.updatedAt - a.updatedAt,
    );
    for (const annotation of ordered) {
      const card = document.createElement("button");
      card.className = "note-entry";
      card.innerHTML = `<span class="note-color ${escape(annotation.color)}"></span><span class="note-copy"><strong>${escape(annotation.quote)}</strong>${annotation.note ? `<small>${escape(annotation.note)}</small>` : ""}<em>${escape(this.book.chapters[annotation.chapter]?.title || "")}</em></span>`;
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
    const exists = this.book.bookmarks.some(
      (mark) =>
        mark.chapter === this.chapter &&
        Math.abs(mark.ratio - this.ratio) < 0.02,
    );
    $("add-bookmark").classList.toggle("selected", exists);
  }

  async bookmark() {
    if (!this.book) return;
    try {
      this.book = await call("bookmark", {
        id: this.book.id,
        mark: {
          chapter: this.chapter,
          ratio: this.ratio,
          title: this.book.chapters[this.chapter].title,
        },
      });
      this.marks();
      this.onUpdate(this.book);
      toast("书签已更新");
    } catch (error) {
      toast(error.message);
    }
  }

  async search() {
    const query = $("book-search-input").value.trim();
    if (!query) return;
    const root = $("search-results");
    root.textContent = "正在检索…";
    const id = this.book.id;
    try {
      this.hideSelection();
      const results = await call("search", { id, query });
      if (this.book.id !== id) return;
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
      root.textContent = error.message;
    }
  }

  async navigate(href) {
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
    chapter,
    ratio = 0,
    anchor = "",
    query = "",
    annotationId = "",
    direction = 0,
  ) {
    if (!this.book) return;
    clearTimeout(this.saveTimer);
    await this.flush();
    this.hideSelection();
    const generation = ++this.generation;
    this.chapter = Math.max(
      0,
      Math.min(chapter, this.book.chapters.length - 1),
    );
    this.ratio = ratio;
    this.anchor = anchor;
    this.query = query;
    this.annotationFocus = annotationId;
    this.loading = true;
    this.loadError = "";
    const item = this.book.chapters[this.chapter];
    $("chapter-label").textContent = item.title;
    $("reader-loading").hidden = false;
    this.activeToc();
    try {
      const response = await fetch(bookUrl(this.book, item.href));
      if (!response.ok) throw new Error("无法加载章节文件");
      let html = await response.text();
      if (generation !== this.generation) return;
      const base = bookUrl(this.book, item.href);
      html = html.replace(
        /<head(?:\s[^>]*)?>/i,
        (match) => `${match}<base href="${escape(base)}">`,
      );
      const frame = $("book-frame");
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("章节载入超时")), 8000);
        frame.onload = () => {
          clearTimeout(timeout);
          if (generation !== this.generation) {
            resolve();
            return;
          }
          this.doc = frame.contentDocument;
          this.attach();
          resolve();
        };
        frame.onerror = () => {
          clearTimeout(timeout);
          reject(new Error("章节载入失败"));
        };
        const update = () => {
          frame.srcdoc = html;
        };
        if (direction)
          this.motion
            .change(
              $("page-surface"),
              this.settings.animation,
              this.settings.animationDuration,
              direction,
              update,
            )
            .then(resolve, reject);
        else update();
      });
    } catch (error) {
      if (generation !== this.generation) return;
      this.loading = false;
      this.loadError = error.message;
      $("reader-loading").hidden = true;
      toast(error.message);
    }
  }

  attach() {
    const doc = this.doc;
    if (!doc?.body) {
      this.loading = false;
      $("reader-loading").hidden = true;
      toast("章节缺少正文");
      return;
    }
    let style = doc.getElementById("dr-reader-style");
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
      this.lastClick = {
        clientX: event.clientX,
        clientY: event.clientY,
      };
      const annotation = this.annotationLayer?.rangeAtPoint(event);
      if (annotation) {
        this.showSelectionMenu(annotation.range, annotation.id);
        return;
      }
      const link = event.target.closest?.("a[href]");
      if (!link) return;
      event.preventDefault();
      try {
        const target = new URL(link.getAttribute("href"), doc.baseURI);
        const prefix = `/${this.book.id}/content/`;
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
    doc.addEventListener("pointerdown", () => this.hideSelection());
    doc.addEventListener("wheel", (event) => this.wheel(event), { passive: false });
    doc.addEventListener("touchmove", () => this.hideSelection(), { passive: true });
    doc.addEventListener("selectionchange", () => {
      if (doc.getSelection()?.isCollapsed) this.hideSelection();
    });
    doc.addEventListener("mouseup", (event) => {
      if (event.target.closest?.("a")) return;
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
    doc.defaultView.addEventListener("scroll", () => this.scrolled(), {
      passive: true,
    });
    for (const image of doc.images)
      image.addEventListener("load", () => this.reflow(), { once: true });
    this.annotationLayer = new AnnotationLayer(doc);
    this.refreshAnnotations();
    this.apply(this.settings);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (doc !== this.doc) return;
        this.measure();
        this.restore();
        this.loading = false;
        $("reader-loading").hidden = true;
        this.report();
      }),
    );
    doc.fonts?.ready.then(() => {
      if (doc === this.doc) this.reflow();
    });
  }

  refreshAnnotations() {
    if (!this.doc || !this.annotationLayer) return;
    const chapter = this.chapter;
    const current = (this.annotations || []).filter(
      (annotation) =>
        annotation.chapter === chapter &&
        annotation.href === this.book.chapters[chapter].href,
    );
    this.annotationLayer.set(current, (annotation) =>
      rangeForAnchor(this.doc, annotation),
    );
  }

  apply(settings) {
    this.appSettings = settings.application || this.appSettings || {
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
    };
    this.hideSelection();
    this.settings = settings.reading || settings;
    this.motion.setAllowed(this.appSettings.animations);
    document.documentElement.style.setProperty(
      "--reading-width",
      `${this.settings.width}px`,
    );
    if (!this.doc || !this.style) return;
    this.reflowing = true;
    const reading = this.settings;
    const colors =
      reading.theme === "dark"
        ? ["#252923", "#dce1d5", "#abc296"]
        : reading.theme === "sepia"
          ? ["#fbf6e9", "#514737", "#776440"]
          : ["#ffffff", "#2e352d", "#56704c"];
    const paged = reading.mode === "paged";
    const spacing = reading.publisherStyles
      ? ""
      : `body p,body div,body li{margin-top:0!important;margin-bottom:${reading.paragraphSpacing}em!important}`;
    const paragraph = reading.publisherStyles
      ? ""
      : `body p{text-indent:${reading.textIndent}em!important;text-align:${reading.alignment}!important}`;
    const margin = paged
      ? `padding:0!important;column-count:auto!important;margin:${reading.paddingY}px ${reading.paddingX}px!important;width:calc(var(--dr-page-width,100vw) - ${reading.paddingX * 2}px)!important;height:calc(100vh - ${reading.paddingY * 2}px)!important;column-width:calc(var(--dr-page-width,100vw) - ${reading.paddingX * 2}px)!important;column-gap:${reading.paddingX * 2}px!important;column-fill:auto!important;overflow:visible!important;`
      : `margin:0!important;padding:${reading.paddingY}px ${reading.paddingX}px 60px!important;height:auto!important;width:auto!important;column-count:auto!important;column-width:auto!important;column-gap:normal!important;overflow:visible!important;`;
    this.style.textContent = `html{background:${colors[0]}!important;color:${colors[1]}!important;overflow:${paged ? "hidden" : "auto"}!important;scroll-behavior:auto!important;height:${paged ? "100%" : "auto"}!important;direction:ltr!important}body{font-family:${fontStack(reading.fontFamily)}!important;font-size:${reading.fontSize}px!important;font-weight:${reading.fontWeight}!important;line-height:${reading.lineHeight}!important;letter-spacing:${reading.letterSpacing}px!important;background:${colors[0]}!important;color:${colors[1]}!important;max-width:none!important;min-width:0!important;box-sizing:border-box!important;${margin}}body p,body li,body div{font-family:inherit!important;font-size:inherit!important;font-weight:inherit!important;line-height:inherit!important;color:inherit!important;overflow-wrap:anywhere}p{orphans:2;widows:2}${spacing}${paragraph}img,svg,video{max-width:100%!important;max-height:${paged ? "calc(100vh - 90px)" : "85vh"}!important;object-fit:contain}table{max-width:100%!important}pre{white-space:pre-wrap!important;overflow-wrap:anywhere}a{color:${colors[2]}!important}h1,h2,h3,h4{color:inherit!important;break-after:avoid}*{scroll-behavior:auto!important}::selection{background:#8dac7855!important}::-webkit-scrollbar{width:5px}::-webkit-scrollbar-thumb{background:${colors[2]}55;border-radius:4px}`;
    this.reflow();
  }

  measure() {
    if (!this.doc) return;
    const doc = this.doc;
    const view = doc.defaultView;
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
  }

  restore() {
    if (!this.doc) return;
    const doc = this.doc;
    const view = doc.defaultView;
    const anchor = this.anchor && doc.getElementById(this.anchor);
    if (anchor) {
      this.revealRect(anchor.getBoundingClientRect());
      this.anchor = "";
    } else if (this.query) {
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const position = node.textContent.indexOf(this.query);
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

  revealRect(rect) {
    const view = this.doc.defaultView;
    if (this.settings.mode === "paged") {
      const page = Math.max(0, Math.min(this.pages - 1,
        Math.floor((view.scrollX + rect.left - this.settings.paddingX + 1) / Math.max(1, view.innerWidth))));
      view.scrollTo(page * view.innerWidth, 0);
    } else view.scrollTo(0, view.scrollY + rect.top - 40);
  }

  reflow() {
    if (!this.doc || $("app").hidden) return;
    clearTimeout(this.reflowTimer);
    this.reflowTimer = setTimeout(() => {
      if (!this.doc || $("app").hidden) return;
      this.measure();
      this.refreshAnnotations();
      this.restore();
      this.reflowing = false;
      if (!this.loading) this.report();
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
    const view = doc.defaultView;
    if (this.settings.mode === "paged") {
      this.page = Math.round(view.scrollX / Math.max(1, view.innerWidth));
      this.ratio = this.pages <= 1 ? 0 : this.page / (this.pages - 1);
    } else
      this.ratio = Math.min(
        1,
        view.scrollY /
          Math.max(1, doc.documentElement.scrollHeight - view.innerHeight),
      );
    const progress =
      (this.chapter + this.ratio) / this.book.chapters.length;
    $("page-indicator").textContent =
      this.settings.mode === "paged"
        ? `${this.page + 1} / ${this.pages}`
        : `本节 ${Math.round(this.ratio * 100)}%`;
    $("reader-location").textContent =
      `第 ${this.chapter + 1} / ${this.book.chapters.length} 节`;
    $("reader-percent").textContent = `${Math.round(progress * 100)}%`;
    $("reading-progress").value = Math.round(progress * 1000);
    $("prev-page").disabled = this.chapter === 0 && this.ratio <= 0;
    $("next-page").disabled =
      this.chapter === this.book.chapters.length - 1 && this.ratio >= 0.999;
    this.updateMark();
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 450);
  }

  async flush() {
    clearTimeout(this.saveTimer);
    if (!this.book || !this.doc || this.loading) return;
    const id = this.book.id;
    const position = { chapter: this.chapter, ratio: this.ratio };
    try {
      const book = await call("position", { id, position });
      if (this.book?.id === id) this.book = book;
      this.onUpdate(book);
    } catch (error) {
      toast(error.message);
    }
  }

  wheel(event) {
    this.hideSelection();
    if (this.settings?.mode !== "paged" || event.ctrlKey || event.metaKey) return;
    const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    if (!delta) return;
    event.preventDefault();
    if (this.loading || this.reflowing) return;
    // Each wheel event advances one page, independent of the OS scroll distance.
    // Serializing turns also lets consecutive notches finish their animations.
    return this.turn(delta > 0 ? 1 : -1);
  }

  turn(direction) {
    const doc = this.doc;
    const generation = this.generation;
    const mode = this.settings?.mode;
    this.turnQueue = this.turnQueue.then(() => {
      if (doc !== this.doc || generation !== this.generation || mode !== this.settings?.mode ||
          $("app").hidden || document.querySelector("dialog[open]")) return;
      return this.turnPage(direction);
    }).catch((error) => toast(error.message));
    return this.turnQueue;
  }

  async turnPage(direction) {
    if (!this.doc || this.loading) return;
    this.hideSelection();
    const view = this.doc.defaultView;
    if (this.settings.mode === "paged") {
      if (direction > 0 && this.page < this.pages - 1) {
        await this.animatePageChange(direction, () =>
          view.scrollTo((this.page + 1) * view.innerWidth, 0),
        );
        this.report();
        return;
      }
      if (direction < 0 && this.page > 0) {
        await this.animatePageChange(direction, () =>
          view.scrollTo((this.page - 1) * view.innerWidth, 0),
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
        await this.animatePageChange(direction, () =>
          view.scrollBy(0, direction * view.innerHeight * 0.85),
        );
        return;
      }
    }
    const next = this.chapter + direction;
    if (next >= 0 && next < this.book.chapters.length)
      await this.load(next, direction > 0 ? 0 : 1, "", "", "", direction);
  }

  async animatePageChange(direction, update) {
    if (!this.settings.animation || this.settings.animation === "none") {
      update();
      return;
    }
    await this.motion.change(
      $("page-surface"),
      this.settings.animation,
      this.settings.animationDuration,
      direction,
      update,
    );
  }

  key(event) {
    if (event.ctrlKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      this.tab("search");
      $("toc-panel").hidden = false;
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

  showSelectionMenu(range, annotationId = "") {
    const rect =
      this.annotationLayer?.rect(range) || range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return;
    const text = range.toString().trim();
    if (!text) return;
    this.selection = {
      range: range.cloneRange(),
      text,
      annotationId,
    };
    const actions = this.appSettings.selectionActions;
    $("selection-highlight").hidden =
      !actions.highlight && !actions.underline;
    $("selection-underline").hidden = !actions.underline;
    $("selection-note").hidden = !actions.note;
    $("selection-copy").hidden = !actions.copy;
    $("selection-search").hidden = !actions.search;
    const dictionaries =
      this.appSettings.dictionaries?.filter(
        (dictionary) => dictionary.enabled,
      ) || [];
    $("selection-dictionary").hidden =
      !actions.dictionary || !dictionaries.length;
    $("selection-preview").textContent =
      text.length > 48 ? `${text.slice(0, 48)}…` : text;
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
    if (!$("annotation-dialog").open) this.selection = null;
  }

  selectionAnchor() {
    if (!this.selection) return null;
    return anchorFromRange(this.doc, this.selection.range);
  }

  async saveSelection(color = "yellow", style = "highlight") {
    if (!this.selection || !this.book) return;
    const existing = this.annotations.find(
      (annotation) => annotation.id === this.selection.annotationId,
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
      this.doc.getSelection()?.removeAllRanges();
      toast(style === "underline" ? "已添加下划线" : "已添加高亮");
    } catch (error) {
      toast(error.message);
    }
  }

  chooseHighlightColor(color) {
    const hit = this.annotationLayer?.colorAtPoint(this.lastClick);
    this.saveSelection(color, hit?.kind || "highlight");
  }

  async saveAnnotation(values) {
    const annotation = {
      id: values.id || "",
      chapter: this.chapter,
      href: this.book.chapters[this.chapter].href,
      start: values.start,
      end: values.end,
      quote: values.quote,
      prefix: values.prefix || "",
      suffix: values.suffix || "",
      note: values.note || "",
      color: values.color || "yellow",
      style: values.style || "highlight",
    };
    const saved = await call("annotation.save", {
      id: this.book.id,
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

  openAnnotationDialog() {
    if (!this.selection) return;
    this.editingAnnotation =
      this.annotations.find(
        (annotation) => annotation.id === this.selection.annotationId,
      ) || null;
    this.dialogColor = this.editingAnnotation?.color || "yellow";
    $("annotation-quote").textContent =
      this.editingAnnotation?.quote || this.selection.text;
    $("annotation-note").value = this.editingAnnotation?.note || "";
    $("annotation-style").value =
      this.editingAnnotation?.style || "highlight";
    $("annotation-delete").hidden = !this.editingAnnotation;
    $("annotation-title").textContent = this.editingAnnotation
      ? "编辑标注"
      : "记笔记";
    this.syncDialogColors();
    $("selection-menu").hidden = true;
    $("annotation-dialog").showModal();
    setTimeout(() => $("annotation-note").focus(), 0);
  }

  syncDialogColors() {
    document
      .querySelectorAll("[data-annotation-color]")
      .forEach((button) =>
        button.classList.toggle(
          "selected",
          button.dataset.annotationColor === this.dialogColor,
        ),
      );
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
        note: $("annotation-note").value.trim(),
        color: this.dialogColor,
        style: $("annotation-style").value,
      });
      this.doc.getSelection()?.removeAllRanges();
      this.selection = null;
      $("annotation-dialog").close();
      toast("笔记已保存");
    } catch (error) {
      toast(error.message);
    }
  }

  async deleteFromDialog() {
    if (!this.editingAnnotation) return;
    try {
      await call("annotation.delete", {
        id: this.book.id,
        annotationId: this.editingAnnotation.id,
      });
      this.annotations = this.annotations.filter(
        (annotation) => annotation.id !== this.editingAnnotation.id,
      );
      this.editingAnnotation = null;
      $("annotation-dialog").close("cancel");
      this.refreshAnnotations();
      this.notes();
      toast("标注已删除");
    } catch (error) {
      toast(error.message);
    }
  }

  async copySelection() {
    if (!this.selection) return;
    try {
      await call("copy", { text: this.selection.text });
      this.hideSelection();
      this.doc.getSelection()?.removeAllRanges();
      toast("已复制选中文字");
    } catch (error) {
      toast(error.message);
    }
  }

  searchSelection() {
    if (!this.selection) return;
    const query = this.selection.text.replace(/\s+/g, " ").slice(0, 256);
    this.hideSelection();
    $("toc-panel").hidden = false;
    this.tab("search");
    $("book-search-input").value = query;
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
    const dictionary =
      dictionaries.length === 1
        ? dictionaries[0]
        : await this.chooseDictionary(dictionaries);
    if (!dictionary) return;
    try {
      await call("lookup", { dictionaryId: dictionary.id, text });
      this.hideSelection();
    } catch (error) {
      toast(error.message);
    }
  }

  chooseDictionary(dictionaries) {
    return new Promise((resolve) => {
      const dialog = document.createElement("dialog");
      dialog.className = "dictionary-picker";
      dialog.innerHTML = `<div class="annotation-header"><div><span class="eyebrow">LOOK UP</span><h2>选择查词网站</h2></div></div><div class="dictionary-picker-list"></div>`;
      const root = dialog.querySelector(".dictionary-picker-list");
      for (const dictionary of dictionaries) {
        const button = document.createElement("button");
        button.className = "dictionary-choice";
        button.textContent = dictionary.name;
        button.onclick = () => dialog.close(dictionary.id);
        root.append(button);
      }
      dialog.addEventListener("cancel", (event) => {
        event.preventDefault();
        dialog.close();
      });
      dialog.addEventListener("close", () => {
        const selected =
          dictionaries.find((item) => item.id === dialog.returnValue) || null;
        dialog.remove();
        resolve(selected);
      });
      document.body.append(dialog);
      dialog.showModal();
    });
  }

  async close() {
    await this.flush();
    ++this.generation;
    this.hideSelection();
    this.annotationLayer?.clear();
    this.annotationLayer = null;
    this.doc = null;
    this.book = null;
    this.annotations = [];
    $("book-frame").srcdoc = "";
  }
}
