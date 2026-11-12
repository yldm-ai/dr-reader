import { call, bookUrl, $, escape, toast, busy, errorMessage } from "./bridge.ts";
import type { HostMessage } from "./bridge.ts";
import { hydrate, configureIconFonts } from "./icons.ts";
import { Reader } from "./reader.ts";
import { SettingsPanel } from "./settings.ts";
import { createLibraryOverlays } from "./library-overlays.ts";
import { Tooltips } from "./tooltip.ts";
import { BookOpening } from "./book-opening.ts";
import { LibraryBackToTop } from "./back-to-top.ts";
import { SelectControl } from "./select-control.ts";
import { Shelves, PRIVATE_SHELF } from "./shelves.ts";
import { readingPalette, resolveTheme } from "./reading-palette.ts";
import { BookInfo } from "./book-info.ts";
import type { ApplicationSettings, Book, Bootstrap, LibrarySort, Settings } from "./types.ts";

type Filter = "all" | "recent" | "unread" | "finished" | "shelves";
const input = (id: string) => $<HTMLInputElement>(id);
const dialog = (id: string) => $<HTMLDialogElement>(id);

hydrate();
const bookInfo = new BookInfo();
const sortControl = new SelectControl($<HTMLSelectElement>("sort"));
const tooltips = new Tooltips();
new LibraryBackToTop($("library-view"), $<HTMLButtonElement>("library-back-to-top"), $("library-heading"));

let books: Book[] = [];
let settings: Settings | null = null;
let filter: Filter = "all";
let author = "";
let listMode = false;
let pendingRemoval: Book | null = null;
const shelves = new Shelves(() => books, render);
const libraryOverlays = createLibraryOverlays(book => {
  pendingRemoval = book;
  $("delete-book-title").textContent = `删除《${book.title}》？`;
  dialog("delete-book-dialog").showModal();
}, {
  open: book => openBook(book.id),
  showInfo: book => bookInfo.show(book),
  shelves: () => shelves.items,
  addToShelf: async (book, id) => {
    try { await shelves.addBook(book.id, id); toast("已添加至分类书架", "success"); }
    catch (error) { toast(errorMessage(error), "error"); }
  },
  createShelf: book => shelves.edit(null, book.id),
  isHidden: book => shelves.hiddenIds().has(book.id),
  hide: async book => {
    try { await shelves.addBook(book.id, PRIVATE_SHELF); toast("已隐藏，可在分类书架的隐私书架中找到", "success"); }
    catch (error) { toast(`隐藏失败：${errorMessage(error)}`, "error"); }
  },
  unhide: async book => {
    try { await shelves.removeBook(book.id, PRIVATE_SHELF); toast("已取消隐藏", "success"); }
    catch (error) { toast(`取消隐藏失败：${errorMessage(error)}`, "error"); }
  },
  exportNotes: async book => {
    try {
      const result = await call<{ empty?: boolean; saved?: boolean }>("notes.export", { id: book.id });
      if (result.empty) toast("这本书还没有笔记、标注或 AI 对话");
      else if (result.saved) toast("笔记与对话已导出", "success");
    } catch (error) { toast(`导出失败：${errorMessage(error)}`, "error"); }
  },
  importNotes: async book => {
    busy(true, "正在导入阅读笔记…");
    try {
      const result = await call<{ cancelled?: boolean; imported?: number; skipped?: number; conversationsImported?: number; conversationsSkipped?: number }>("notes.import", { id: book.id });
      if (!result.cancelled) {
        const skipped = result.skipped ? `，跳过 ${result.skipped} 条已有笔记（保留本地版本）` : "";
        // Only backups that carry conversations report them.
        const conversations = result.conversationsImported === undefined ? ""
          : `；AI 对话导入 ${result.conversationsImported} 段${result.conversationsSkipped ? `，跳过 ${result.conversationsSkipped} 段已有对话` : ""}`;
        toast(`已导入 ${result.imported} 条笔记或标注${skipped}${conversations}`, "success");
      }
    } catch (error) { toast(`导入笔记失败：${errorMessage(error)}`, "error"); }
    finally { busy(false); }
  },
});

const reader = new Reader((book) => {
  const index = books.findIndex((item) => item.id === book.id);
  if (index >= 0) books[index] = book;
});

function applySettings(value: Settings) {
  // An application theme resolves to one of its own fixed themes.
  const resolved: Settings = {
    ...value,
    application: { ...value.application, theme: resolveTheme(value.application.theme) as ApplicationSettings["theme"] },
    reading: { ...value.reading, theme: resolveTheme(value.reading.theme) },
  };
  settings = resolved;
  const sort = settings.application.librarySort || "added";
  if ($<HTMLSelectElement>("sort").value !== sort) {
    $<HTMLSelectElement>("sort").value = sort;
    sortControl.sync();
    render();
  }
  document.body.dataset.theme = settings.application.theme;
  document.body.dataset.animations = String(settings.application.animations);
  reader.apply(settings);
  document.documentElement.style.setProperty("color-scheme", settings.application.theme === "dark" ? "dark" : "light");
}
const settingsPanel = new SettingsPanel(applySettings);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (!settingsPanel.value) return;
  settingsPanel.sync();
  applySettings(settingsPanel.value);
});
reader.onReadingSetting = patch => settingsPanel.update("reading", patch);
reader.onApplicationSetting = patch => settingsPanel.update("application", patch);
reader.onOpenSettings = () => settingsPanel.open("reading");

window.chrome?.webview?.addEventListener("message", async ({ data }: { data: HostMessage }) => {
  if (data.event === "fullscreen") document.body.dataset.fullscreen = String(data.enabled);
  if (data.event === "titlebar") document.body.dataset.titlebar = data.hidden ? "hidden" : "shown";
  // A native caption button's tip, under the button: a Direct2D button ends at the top edge
  // of the web content, a WebView2 one is the page's own caption strip.
  if (data.event === "caption-tooltip") {
    if (data.text) tooltips.show({ left: Number(data.left), width: Number(data.width), top: Number(data.top ?? -1), height: Number(data.height ?? 1) }, String(data.text));
    else tooltips.hide();
  }
  if (data.event === "caption") showCaption(data);
  if (data.event === "closing") {
    await Promise.allSettled([reader.flush(), settingsPanel.flush()]);
    call("close").catch(() => {});
  }
});

/** Draws the WebView2 title bar from the native window's caption state. */
function showCaption(state: HostMessage) {
  const root = document.documentElement;
  const visible = Boolean(state.visible);
  if (visible) root.dataset.caption = "web";
  else delete root.dataset.caption;
  root.style.setProperty("--caption-height", `${visible ? Number(state.height) || 0 : 0}px`);
  const caption = $("web-caption");
  if (!visible) return;
  caption.style.setProperty("--caption-button-width", `${Number(state.buttonWidth) || 46}px`);
  caption.querySelector(".web-caption-title")!.textContent = String(state.title || "DR Reader");
  caption.querySelectorAll<HTMLElement>("[data-caption-button]").forEach(button => {
    button.toggleAttribute("data-hot", button.dataset.captionButton === state.hot);
  });
  // Segoe Fluent Icons ChromeMaximize / ChromeRestore, as the Direct2D caption draws them.
  caption.querySelector('[data-caption-button="maximize"]')!.textContent = state.maximized ? "" : "";
}

function cover(book: Book, className = "cover-image") {
  return book.cover
    ? `<img class="${className}" src="${escape(bookUrl(book, book.cover))}" alt="${escape(book.title)}封面" loading="lazy">`
    : `<div class="cover-fallback ${className}">${escape(book.title)}<small>${escape(book.author)}</small></div>`;
}

function render() {
  libraryOverlays.dismiss();
  const browsingShelves = filter === "shelves";
  input("library-search").placeholder = browsingShelves && !shelves.selected ? "搜索书架…" : "搜索书名、作者…";
  $("library-search").setAttribute("aria-label", browsingShelves && !shelves.selected ? "搜索书架" : "搜索书库");
  document.querySelector<HTMLElement>(".toolbar-right")!.hidden = browsingShelves && !shelves.selected;
  $("shelf-grid").hidden = !browsingShelves || Boolean(shelves.selected);
  $("shelf-actions").hidden = !browsingShelves || !shelves.selected;
  $("book-grid").hidden = browsingShelves && !shelves.selected;
  const query = input("library-search").value.trim().toLocaleLowerCase();
  // Hidden books appear only inside the private shelf: not in lists, counts, authors or search.
  const hidden = shelves.hiddenIds();
  const listed = books.filter(book => !hidden.has(book.id));
  const visible = (browsingShelves && shelves.isPrivate(shelves.selected) ? books : listed).filter(
    (book) =>
      (!browsingShelves || !shelves.selected || shelves.selected!.bookIds.includes(book.id)) &&
      (!author || book.author === author) &&
      (!query ||
        `${book.title} ${book.author}`
          .toLocaleLowerCase()
          .includes(query)) &&
      (filter === "recent"
        ? (book.lastRead ?? 0) > 0
        : filter === "unread"
          ? !book.lastRead
          : filter === "finished"
            ? book.progress >= 1
            : true),
  );
  const sort = $<HTMLSelectElement>("sort").value as LibrarySort;
  visible.sort((a, b) =>
    sort === "title"
      ? a.title.localeCompare(b.title, "zh-CN")
      : sort === "author"
        ? a.author.localeCompare(b.author, "zh-CN")
        : sort === "read"
          ? (b.lastRead || 0) - (a.lastRead || 0)
          : (b.addedAt || 0) - (a.addedAt || 0),
  );
  const titles: Record<Filter, string> = {
    all: "全部图书",
    recent: "最近阅读",
    unread: "尚未开始",
    finished: "已经读完",
    shelves: "分类书架",
  };
  $("library-heading").firstChild!.textContent = author || (browsingShelves && shelves.selected ? shelves.selected.name : titles[filter]);
  $("heading-count").textContent = String(visible.length);
  $("count-all").textContent = String(listed.length);
  $("count-shelves").textContent = String(shelves.items.length);
  $("count-recent").textContent = String(listed.filter((book) => book.lastRead).length);
  $("count-finished").textContent = String(listed.filter((book) => book.progress >= 1).length);
  $("count-unread").textContent = String(listed.filter((book) => !book.lastRead).length);

  if (browsingShelves && !shelves.selected) {
    shelves.render(query);
    $("empty-state").hidden = true;
    return;
  }
  const grid = $("book-grid");
  const cards = document.createDocumentFragment();
  grid.classList.toggle("list-mode", listMode);
  for (const book of visible) {
    const item = document.createElement("div");
    item.className = "book-item";
    const card = document.createElement("button");
    card.className = "book-card";
    card.setAttribute("aria-label", `阅读 ${book.title}`);
    card.innerHTML = `<div class="cover-wrap">${cover(book)}</div><h3>${escape(book.title)}</h3><div class="book-author">${escape(book.author)}</div><div class="book-status">${book.lastRead ? `<span class="progress-track"><i style="width:${(book.progress >= 1 ? 100 : Math.min(99, Math.round(book.progress * 100)))}%"></i></span><span>已读 ${(book.progress >= 1 ? 100 : Math.min(99, Math.round(book.progress * 100)))}%</span>` : '<span class="new-label">未读</span><span>EPUB</span>'}</div>`;
    card.onclick = () => openBook(book.id, card.querySelector<HTMLElement>(".cover-image"));
    libraryOverlays.bind(card, book);
    item.append(card);
    cards.append(item);
  }
  if (filter === "all" && !author) {
    const item = document.createElement("div");
    item.className = "book-item";
    const add = document.createElement("button");
    add.id = "book-add";
    add.className = "shelf-card shelf-add book-add";
    add.innerHTML = '<div class="cover-wrap"><span data-icon="plus"></span></div><strong>添加新书</strong><small>选择 EPUB 文件</small>';
    add.onclick = importBooks;
    item.append(add);
    cards.append(item);
  }
  grid.replaceChildren(cards);
  if ($("book-add")) hydrate($("book-add"));

  $("empty-state").hidden = visible.length > 0;
  if (!visible.length) {
    $("empty-state").querySelector("h2")!.textContent =
      query || author || filter !== "all"
        ? "这里还没有图书"
        : "下一段故事，从这里开始";
    $("empty-state").querySelector("p")!.textContent = query
      ? "试试其他书名或作者。"
      : "添加一本 EPUB，建立属于自己的书架。";
  }

  const authors = $("authors");
  const authorCounts = new Map<string, number>();
  for (const book of listed) authorCounts.set(book.author, (authorCounts.get(book.author) || 0) + 1);
  const authorButtons = document.createDocumentFragment();
  for (const name of [...authorCounts.keys()].sort()) {
    const button = document.createElement("button");
    button.textContent = `${name} · ${authorCounts.get(name)}`;
    button.onclick = () => {
      author = name;
      filter = "all";
      setNavigation();
      render();
    };
    authorButtons.append(button);
  }
  authors.replaceChildren(authorButtons);
}

function setNavigation() {
  document
    .querySelectorAll<HTMLElement>("[data-filter]")
    .forEach((button) =>
      button.classList.toggle(
        "active",
        !author && button.dataset.filter === filter,
      ),
    );
  const active = $("library-nav").querySelector<HTMLElement>(".nav-item.active");
  const indicator = $("library-nav").querySelector<HTMLElement>(".library-nav-indicator")!;
  indicator.style.opacity = active ? "1" : "0";
  if (active) {
    indicator.style.height = `${active.offsetHeight / 2}px`;
    indicator.style.transform = `translate(-50%, ${active.offsetTop + active.offsetHeight / 4}px)`;
  }
}

async function openBook(id: string, coverElement: HTMLElement | null = null) {
  libraryOverlays.dismiss();
  const selected = books.find(book => book.id === id);
  const paper = readingPalette(settings?.reading.theme || "light");
  $("busy").style.setProperty("--opening-background", paper.paper);
  $("busy").style.setProperty("--opening-ink", paper.text);
  busy(true, "正在打开电子书…");
  const rect = coverElement?.getBoundingClientRect();
  const showReader = () => {
    $("library-view").hidden = true;
    document.querySelector<HTMLElement>(".sidebar")!.hidden = true;
    $("reader-view").hidden = false;
  };
  const opening = new BookOpening($("busy"), settings?.application.bookOpeningEnabled ?? settings?.application.animations ?? true, settings?.application.bookOpeningAnimation, {
    title: selected?.title, author: selected?.author,
    image: selected?.cover ? bookUrl(selected, selected.cover) : undefined,
    ratio: coverElement instanceof HTMLImageElement && coverElement.naturalHeight
      ? coverElement.naturalWidth / coverElement.naturalHeight : rect?.height ? rect.width / rect.height : undefined,
    rect: rect?.width && rect?.height ? rect : undefined,
  });
  // Under an opaque opening, switch views before the animation starts: with a cold GPU
  // shader cache the reader's first raster stalls a frame, which BookOpening absorbs before
  // its clock starts instead of freezing the expanding circles.
  if (opening.covering) showReader();
  try {
    const book = await call<Book>("open", { id });
    showReader();
    await reader.open(book, settings!);
    await opening.finish();
  } catch (error) {
    opening.cancel();
    await returnLibrary();
    toast(`打开图书失败：${errorMessage(error)}`, "error");
    console.error(error);
  } finally {
    opening.cancel();
    busy(false);
  }
}

dialog("delete-book-dialog").addEventListener("close", () => { pendingRemoval = null; });
$("delete-book-confirm").onclick = async () => {
  const book = pendingRemoval;
  if (!book) return;
  dialog("delete-book-dialog").close();
  busy(true, "正在删除图书…");
  try {
    await call("book.delete", { id: book.id });
    books = books.filter(item => item.id !== book.id);
    if (author && !books.some(item => item.author === author)) {
      author = "";
      setNavigation();
    }
    render();
    toast("图书已从书库删除", "success");
  } catch (error) {
    toast(`删除图书失败：${errorMessage(error)}`, "error");
  } finally {
    busy(false);
  }
};

async function importBooks() {
  busy(true, "正在导入 EPUB，C++ 正在解析与拆分章节…");
  try {
    const result = await call<{ books: Book[]; errors: string[] }>("import");
    books = result.books;
    render();
    if (result.errors.length) toast(result.errors.join("\n"), "error");
    else toast("书库已更新", "success");
  } catch (error) {
    toast(errorMessage(error), "error");
  } finally {
    busy(false);
  }
}

async function returnLibrary() {
  await reader.close();
  $("reader-view").hidden = true;
  document.querySelector<HTMLElement>(".sidebar")!.hidden = false;
  $("library-view").hidden = false;
  render();
}

for (const id of ["import-side", "import-empty"])
  $(id).onclick = importBooks;
$("library-nav").onclick = (event) => {
  const target = (event.target as Element).closest<HTMLElement>("[data-filter]");
  if (!target) return;
  shelves.selected = null;
  input("library-search").value = "";
  filter = target.dataset.filter as Filter;
  author = "";
  setNavigation();
  render();
};
$("authors-toggle").onclick = () => {
  $("authors").hidden = !$("authors").hidden;
};
let searchTimer: ReturnType<typeof setTimeout> | undefined;
$("library-search").oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(render, 120);
};
$("library-search").onkeydown = (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  clearTimeout(searchTimer);
  render();
};
$("sort").onchange = () => {
  render();
  settingsPanel.update("application", { librarySort: $<HTMLSelectElement>("sort").value as LibrarySort });
};
$("grid-view").onclick = () => {
  listMode = false;
  $("grid-view").classList.add("selected");
  $("list-view").classList.remove("selected");
  render();
};
$("list-view").onclick = () => {
  listMode = true;
  $("list-view").classList.add("selected");
  $("grid-view").classList.remove("selected");
  render();
};
$("back-library").onclick = returnLibrary;
$("open-settings").onclick = () => settingsPanel.open("application");
$("reader-app-settings").onclick = () => settingsPanel.open("application");
$("reader-book-info").onclick = () => { if (reader.book) bookInfo.show(reader.book); };
$("reader-settings").onclick = () => settingsPanel.open("reading");

document.addEventListener("keydown", (event) => {
  // Alt+Enter hides or restores the title bar; F11 toggles fullscreen.
  if ((event.altKey && event.key === "Enter") || event.key === "F11") {
    event.preventDefault();
    if (!event.repeat) call(event.key === "F11" ? "fullscreen" : "titlebar").catch(error => toast(errorMessage(error), "error"));
    return;
  }
  // Library shortcuts wait for the library (window shortcuts above already work).
  if (document.body.classList.contains("booting")) return;
  if (event.key === "F8" && reader.book && !settingsPanel.applicationOpen) {
    event.preventDefault(); settingsPanel.open("reading"); return;
  }
  if (event.defaultPrevented) return;
  if (settingsPanel.applicationOpen) {
    if (event.key === "Escape") {
      event.preventDefault();
      settingsPanel.closeApplication();
    }
    return;
  }
  if (event.key === "Escape" && document.body.dataset.fullscreen === "true" && !document.querySelector("dialog[open]")) {
    event.preventDefault(); call("fullscreen", { enabled: false }).catch(error => toast(errorMessage(error), "error")); return;
  }
  const editing = ["INPUT", "SELECT", "TEXTAREA"].includes(
    (event.target as Element).tagName,
  );
  if (event.ctrlKey && event.key.toLowerCase() === "o") {
    event.preventDefault();
    importBooks();
    return;
  }
  if (event.ctrlKey && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (!$("reader-view").hidden)
      reader.openSearch();
    else $("library-search").focus();
    return;
  }
  if (document.querySelector("dialog[open]") || editing) return;
  if (!$("reader-view").hidden) {
    if (event.key === "Escape") {
      event.preventDefault();
    } else reader.key(event);
  }
});

// The page starts with placeholder cards (index.html) instead of a loading overlay; render()
// replaces them with the library.
try {
  const data = await call<Bootstrap>("bootstrap");
  configureIconFonts(data.iconFonts);
  books = data.books;
  shelves.items = data.shelves || [];
  settingsPanel.configure(data);
  render();
  if (data.importErrors?.length) toast(data.importErrors.join("\n"), "error");
} catch (error) {
  $("book-grid").replaceChildren();
  toast(errorMessage(error), "error");
} finally {
  $("book-grid").removeAttribute("aria-busy");
  document.body.classList.remove("booting");
  // The window draws a native placeholder behind the (transparent) view until this point.
  call("ready").catch(() => {});
}
