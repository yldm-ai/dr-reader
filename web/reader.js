import { call, bookUrl, $, escape, toast } from "./bridge.js";
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
    $("book-search-form").onsubmit = (e) => {
      e.preventDefault();
      this.search();
    };
    this.observer = new ResizeObserver(() => this.reflow());
    this.observer.observe($("book-frame"));
  }
  async open(book, settings) {
    await this.flush();
    this.book = book;
    this.settings = settings;
    this.chapter = 0;
    this.ratio = 0;
    $("reader-book-title").textContent = book.title;
    $("toc-panel").hidden = false;
    this.tab("toc");
    this.toc();
    this.marks();
    $("book-search-input").value = "";
    $("search-results").replaceChildren();
    const p = book.position || {};
    await this.load(p.chapter || 0, p.ratio || 0);
    if (book.warnings?.length)
      toast(
        `这本书有 ${book.warnings.length} 条兼容性提示，可查看本地 book.json。`,
      );
  }
  tab(name) {
    document
      .querySelectorAll("[data-tab]")
      .forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    for (const key of ["toc", "marks", "search"])
      $(
        key === "toc"
          ? "toc-content"
          : key === "marks"
            ? "marks-content"
            : "search-content",
      ).hidden = key !== name;
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
  updateMark() {
    if (!this.book) return;
    const exists = this.book.bookmarks.some(
      (m) =>
        m.chapter === this.chapter && Math.abs(m.ratio - this.ratio) < 0.02,
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
    } catch (e) {
      toast(e.message);
    }
  }
  async search() {
    const query = $("book-search-input").value.trim();
    if (!query) return;
    const root = $("search-results");
    root.textContent = "正在检索…";
    const id = this.book.id;
    try {
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
    } catch (e) {
      root.textContent = e.message;
    }
  }
  async navigate(href) {
    if (!this.book) return;
    const hash = href.indexOf("#"),
      path = hash < 0 ? href : href.slice(0, hash);
    const anchor = hash < 0 ? "" : decodeURIComponent(href.slice(hash + 1));
    const index = this.book.chapters.findIndex((c) => c.href === path);
    if (index >= 0) await this.load(index, 0, anchor);
    else toast("此链接指向附属文档，初版暂不支持打开。");
  }
  async load(chapter, ratio = 0, anchor = "", query = "") {
    if (!this.book) return;
    clearTimeout(this.saveTimer);
    await this.flush();
    const generation = ++this.generation;
    this.chapter = Math.max(
      0,
      Math.min(chapter, this.book.chapters.length - 1),
    );
    this.ratio = ratio;
    this.anchor = anchor;
    this.query = query;
    this.doc = null;
    this.loading = true;
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
      frame.onload = () => {
        if (generation !== this.generation) return;
        this.doc = frame.contentDocument;
        this.attach();
      };
      frame.srcdoc = html;
    } catch (e) {
      if (generation !== this.generation) return;
      this.loading = false;
      $("reader-loading").hidden = true;
      toast(e.message);
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
      for (const svg of doc.querySelectorAll("svg[viewBox]")) {
        svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
      }
    }
    doc.addEventListener("click", (e) => {
      const a = e.target.closest?.("a[href]");
      if (!a) return;
      e.preventDefault();
      try {
        const target = new URL(a.getAttribute("href"), doc.baseURI);
        const prefix = `/${this.book.id}/content/`;
        if (
          target.origin === "https://books.dr-reader.local" &&
          target.pathname.startsWith(prefix)
        )
          this.navigate(
            decodeURIComponent(target.pathname.slice(prefix.length)) +
              target.hash,
          );
        else toast("初版阅读器仅打开书内链接。");
      } catch {
        toast("无法打开这个链接");
      }
    });
    doc.addEventListener("keydown", (e) => {
      if (
        e.key === "Escape" ||
        (e.ctrlKey && ["o", "k"].includes(e.key.toLowerCase()))
      ) {
        e.preventDefault();
        document.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: e.key,
            ctrlKey: e.ctrlKey,
            bubbles: true,
          }),
        );
      } else this.key(e);
    });
    doc.defaultView.addEventListener("scroll", () => this.scrolled(), {
      passive: true,
    });
    for (const image of doc.images)
      image.addEventListener("load", () => this.reflow(), { once: true });
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
  apply(settings) {
    this.settings = settings;
    document.documentElement.style.setProperty(
      "--reading-width",
      `${settings.width}px`,
    );
    if (!this.doc || !this.style) return;
    const colors =
      settings.theme === "dark"
        ? ["#252923", "#dce1d5", "#abc296"]
        : settings.theme === "sepia"
          ? ["#fbf6e9", "#514737", "#776440"]
          : ["#ffffff", "#2e352d", "#56704c"];
    const paged = settings.mode === "paged";
    const family =
      settings.fontFamily === "sans-serif"
        ? "'Microsoft YaHei','Segoe UI',sans-serif"
        : "'Noto Serif CJK SC','SimSun','Georgia',serif";
    this.style.textContent = `html{background:${colors[0]}!important;color:${colors[1]}!important;overflow:${paged ? "hidden" : "auto"}!important;scroll-behavior:auto!important;height:${paged ? "100%" : "auto"}!important;direction:ltr!important}body{font-family:${family}!important;font-size:${settings.fontSize}px!important;line-height:${settings.lineHeight}!important;background:${colors[0]}!important;color:${colors[1]}!important;max-width:none!important;min-width:0!important;box-sizing:border-box!important;${paged ? "margin:38px 44px!important;padding:0!important;width:calc(100vw - 88px)!important;height:calc(100vh - 76px)!important;column-width:calc(100vw - 88px)!important;column-gap:88px!important;column-fill:auto!important;overflow:visible!important;" : "margin:0!important;padding:38px 44px 50px!important;height:auto!important;width:auto!important;column-count:auto!important;"}}body p,body li,body div{font-size:inherit!important;line-height:inherit!important;color:inherit!important}p{orphans:2;widows:2}img,svg,video{max-width:100%!important;max-height:${paged ? "calc(100vh - 90px)" : "85vh"}!important;object-fit:contain}table{max-width:100%!important}pre{white-space:pre-wrap!important;overflow-wrap:anywhere}a{color:${colors[2]}!important}h1,h2,h3,h4{color:inherit!important;break-after:avoid}*{scroll-behavior:auto!important}::-webkit-scrollbar{width:5px}::-webkit-scrollbar-thumb{background:${colors[2]}55;border-radius:4px}`;
    this.reflow();
  }
  measure() {
    if (!this.doc) return;
    const w = this.doc.defaultView;
    this.pages = Math.max(
      1,
      Math.ceil(
        (this.doc.documentElement.scrollWidth - 2) / Math.max(1, w.innerWidth),
      ),
    );
  }
  restore() {
    if (!this.doc) return;
    const doc = this.doc,
      w = doc.defaultView;
    const anchor = this.anchor && doc.getElementById(this.anchor);
    if (anchor) {
      anchor.scrollIntoView();
      this.anchor = "";
    } else if (this.query) {
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const pos = node.textContent.indexOf(this.query);
        if (pos >= 0) {
          const range = doc.createRange();
          range.setStart(node, pos);
          range.setEnd(node, pos + this.query.length);
          const rect = range.getBoundingClientRect();
          w.scrollTo(w.scrollX + rect.left, w.scrollY + rect.top - 40);
          break;
        }
      }
      this.query = "";
    } else if (this.settings.mode === "paged") {
      this.page = Math.round(this.ratio * (this.pages - 1));
      w.scrollTo(this.page * w.innerWidth, 0);
    } else
      w.scrollTo(
        0,
        this.ratio *
          Math.max(0, doc.documentElement.scrollHeight - w.innerHeight),
      );
  }
  reflow() {
    if (!this.doc) return;
    clearTimeout(this.reflowTimer);
    this.reflowTimer = setTimeout(() => {
      if (!this.doc) return;
      this.measure();
      this.restore();
      if (!this.loading) this.report();
    }, 100);
  }
  scrolled() {
    if (this.loading) return;
    this.report();
  }
  report() {
    if (!this.doc || !this.book) return;
    const doc = this.doc,
      w = doc.defaultView;
    if (this.settings.mode === "paged") {
      this.page = Math.round(w.scrollX / Math.max(1, w.innerWidth));
      this.ratio = this.pages <= 1 ? 0 : this.page / (this.pages - 1);
    } else
      this.ratio = Math.min(
        1,
        w.scrollY /
          Math.max(1, doc.documentElement.scrollHeight - w.innerHeight),
      );
    const progress = (this.chapter + this.ratio) / this.book.chapters.length;
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
    const id = this.book.id,
      position = { chapter: this.chapter, ratio: this.ratio };
    try {
      const book = await call("position", { id, position });
      if (this.book?.id === id) this.book = book;
      this.onUpdate(book);
    } catch (e) {
      toast(e.message);
    }
  }
  turn(direction) {
    if (!this.doc || this.loading) return;
    const w = this.doc.defaultView;
    if (this.settings.mode === "paged") {
      if (direction > 0 && this.page < this.pages - 1) {
        w.scrollTo((this.page + 1) * w.innerWidth, 0);
        this.report();
        return;
      }
      if (direction < 0 && this.page > 0) {
        w.scrollTo((this.page - 1) * w.innerWidth, 0);
        this.report();
        return;
      }
    } else {
      const max = this.doc.documentElement.scrollHeight - w.innerHeight;
      if (
        (direction > 0 && w.scrollY < max - 2) ||
        (direction < 0 && w.scrollY > 2)
      ) {
        w.scrollBy(0, direction * w.innerHeight * 0.85);
        return;
      }
    }
    const next = this.chapter + direction;
    if (next >= 0 && next < this.book.chapters.length)
      this.load(next, direction > 0 ? 0 : 1);
  }
  key(e) {
    if (e.ctrlKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      this.tab("search");
      $("toc-panel").hidden = false;
      return;
    }
    if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") {
      e.preventDefault();
      this.turn(1);
    } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
      e.preventDefault();
      this.turn(-1);
    }
  }
  async close() {
    await this.flush();
    ++this.generation;
    this.doc = null;
    this.book = null;
    $("book-frame").srcdoc = "";
  }
}
