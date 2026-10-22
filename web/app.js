import { call, bookUrl, $, escape, toast, busy } from "./bridge.js";
import { hydrate } from "./icons.ts";
import { Reader } from "./reader.js";
import { SettingsPanel } from "./settings.js";
import { createLibraryOverlays } from "./library-overlays.js";
import { Tooltips } from "./tooltip.ts";
import { BookOpening } from "./book-opening.ts";

hydrate();
new SelectControl($("sort"));
const tooltips = new Tooltips();

let books = [];
let settings = null;
let filter = "all";
let author = "";
let listMode = false;
let pendingRemoval = null;
const libraryOverlays = createLibraryOverlays(book => {
  pendingRemoval = book;
  $("delete-book-title").textContent = `删除《${book.title}》？`;
  $("delete-book-dialog").showModal();
});

const reader = new Reader((book) => {
  const index = books.findIndex((item) => item.id === book.id);
  if (index >= 0) books[index] = book;
});

const settingsPanel = new SettingsPanel((value) => {
  settings = value;
  document.body.dataset.theme = value.application.theme;
  document.body.dataset.animations = String(value.application.animations);
  reader.apply(value);
  if (value.application.theme === "dark")
    document.documentElement.style.setProperty("color-scheme", "dark");
  else document.documentElement.style.removeProperty("color-scheme");
});
reader.onReadingSetting = patch => settingsPanel.update("reading", patch);
reader.onApplicationSetting = patch => settingsPanel.update("application", patch);
reader.onOpenSettings = () => settingsPanel.open("reading");

window.chrome?.webview?.addEventListener("message", async ({ data }) => {
  if (data.event === "fullscreen") document.body.dataset.fullscreen = String(data.enabled);
  if (data.event === "titlebar") document.body.dataset.titlebar = data.hidden ? "hidden" : "shown";
  // A Direct2D caption button's tip: the button ends at the top edge of the web content.
  if (data.event === "caption-tooltip") {
    if (data.text) tooltips.show({ left: data.left, width: data.width, top: -1, height: 1 }, data.text);
    else tooltips.hide();
  }
  if (data.event === "closing") {
    await Promise.allSettled([reader.flush(), settingsPanel.flush()]);
    call("close").catch(() => {});
  }
});

function cover(book, className = "cover-image") {
  return book.cover
    ? `<img class="${className}" src="${escape(bookUrl(book, book.cover))}" alt="${escape(book.title)}封面" loading="lazy">`
    : `<div class="cover-fallback ${className}">${escape(book.title)}<small>${escape(book.author)}</small></div>`;
}

function render() {
  libraryOverlays.dismiss();
  const query = $("library-search").value.toLocaleLowerCase();
  const visible = books.filter(
    (book) =>
      (!author || book.author === author) &&
      (!query ||
        `${book.title} ${book.author}`
          .toLocaleLowerCase()
          .includes(query)) &&
      (filter === "recent"
        ? book.lastRead > 0
        : filter === "unread"
          ? !book.lastRead
          : filter === "finished"
            ? book.progress >= 0.99
            : true),
  );
  const sort = $("sort").value;
  visible.sort((a, b) =>
    sort === "title"
      ? a.title.localeCompare(b.title, "zh-CN")
      : sort === "author"
        ? a.author.localeCompare(b.author, "zh-CN")
        : sort === "read"
          ? (b.lastRead || 0) - (a.lastRead || 0)
          : (b.addedAt || 0) - (a.addedAt || 0),
  );
  const titles = {
    all: "全部图书",
    recent: "最近阅读",
    unread: "尚未开始",
    finished: "已经读完",
  };
  $("library-heading").firstChild.textContent = author || titles[filter];
  $("heading-count").textContent = visible.length;
  $("count-all").textContent = books.length;
  $("count-recent").textContent = books.filter((book) => book.lastRead).length;
  $("library-total").textContent = `${books.length} 本图书`;

  const grid = $("book-grid");
  const cards = document.createDocumentFragment();
  grid.classList.toggle("list-mode", listMode);
  for (const book of visible) {
    const item = document.createElement("div");
    item.className = "book-item";
    const card = document.createElement("button");
    card.className = "book-card";
    card.setAttribute("aria-label", `阅读 ${book.title}`);
    card.innerHTML = `<div class="cover-wrap">${cover(book)}</div><h3>${escape(book.title)}</h3><div class="book-author">${escape(book.author)}</div><div class="book-status">${book.lastRead ? `<span class="progress-track"><i style="width:${Math.round(book.progress * 100)}%"></i></span><span>已读 ${Math.round(book.progress * 100)}%</span>` : '<span class="new-label">未读</span><span>EPUB</span>'}</div>`;
    card.onclick = () => openBook(book.id);
    libraryOverlays.bind(card, book);
    item.append(card);
    cards.append(item);
  }
  grid.replaceChildren(cards);

  $("empty-state").hidden = visible.length > 0;
  if (!visible.length) {
    $("empty-state").querySelector("h2").textContent =
      query || author || filter !== "all"
        ? "这里还没有图书"
        : "下一段故事，从这里开始";
    $("empty-state").querySelector("p").textContent = query
      ? "试试其他书名或作者。"
      : "添加一本 EPUB，建立属于自己的书架。";
  }

  const authors = $("authors");
  const authorCounts = new Map();
  for (const book of books) authorCounts.set(book.author, (authorCounts.get(book.author) || 0) + 1);
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
    .querySelectorAll("[data-filter]")
    .forEach((button) =>
      button.classList.toggle(
        "active",
        !author && button.dataset.filter === filter,
      ),
    );
  const active = $("library-nav").querySelector(".nav-item.active");
  const indicator = $("library-nav").querySelector(".library-nav-indicator");
  indicator.style.opacity = active ? "1" : "0";
  if (active) {
    indicator.style.height = `${active.offsetHeight / 2}px`;
    indicator.style.transform = `translate(-50%, ${active.offsetTop + active.offsetHeight / 4}px)`;
  }
}

async function openBook(id) {
  libraryOverlays.dismiss();
  busy(true, "正在打开电子书…");
  const opening = new BookOpening($("busy"), settings?.application.animations !== false);
  try {
    const book = await call("open", { id });
    $("library-view").hidden = true;
    document.querySelector(".sidebar").hidden = true;
    $("reader-view").hidden = false;
    await reader.open(book, settings);
    await opening.finish();
  } catch (error) {
    opening.cancel();
    await returnLibrary();
    toast(`打开图书失败：${error.message}`);
    console.error(error);
  } finally {
    opening.cancel();
    busy(false);
  }
}

$("delete-book-dialog").addEventListener("close", () => { pendingRemoval = null; });
$("delete-book-confirm").onclick = async () => {
  const book = pendingRemoval;
  if (!book) return;
  $("delete-book-dialog").close();
  busy(true, "正在删除图书…");
  try {
    await call("book.delete", { id: book.id });
    books = books.filter(item => item.id !== book.id);
    if (author && !books.some(item => item.author === author)) {
      author = "";
      setNavigation();
    }
    render();
    toast("图书已从书库删除");
  } catch (error) {
    toast(`删除图书失败：${error.message}`);
  } finally {
    busy(false);
  }
};

async function importBooks() {
  busy(true, "正在导入 EPUB，C++ 正在解析与拆分章节…");
  try {
    const result = await call("import");
    books = result.books;
    render();
    if (result.errors.length) toast(result.errors.join("\n"));
    else toast("书库已更新");
  } catch (error) {
    toast(error.message);
  } finally {
    busy(false);
  }
}

async function returnLibrary() {
  await reader.close();
  $("reader-view").hidden = true;
  document.querySelector(".sidebar").hidden = false;
  $("library-view").hidden = false;
  render();
}

for (const id of ["import-side", "import-empty"])
  $(id).onclick = importBooks;
$("library-nav").onclick = (event) => {
  const target = event.target.closest("[data-filter]");
  if (!target) return;
  filter = target.dataset.filter;
  author = "";
  setNavigation();
  render();
};
$("authors-toggle").onclick = () => {
  $("authors").hidden = !$("authors").hidden;
};
let searchTimer;
$("library-search").onkeydown = (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  clearTimeout(searchTimer);
  render();
};
$("sort").onchange = render;
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
$("reader-settings").onclick = () => settingsPanel.open("reading");

document.addEventListener("keydown", (event) => {
  // Alt+Enter hides or restores the title bar; F11 toggles fullscreen.
  if ((event.altKey && event.key === "Enter") || event.key === "F11") {
    event.preventDefault();
    if (!event.repeat) call(event.key === "F11" ? "fullscreen" : "titlebar").catch(error => toast(error.message));
    return;
  }
  if (event.key === "F8" && reader.book && !settingsPanel.applicationOpen) {
    event.preventDefault(); settingsPanel.open("reading"); return;
  }
  if (settingsPanel.applicationOpen) {
    if (event.key === "Escape") {
      event.preventDefault();
      settingsPanel.closeApplication();
    }
    return;
  }
  if (event.defaultPrevented) return;
  if (event.key === "Escape" && document.body.dataset.fullscreen === "true" && !document.querySelector("dialog[open]")) {
    event.preventDefault(); call("fullscreen", { enabled: false }).catch(error => toast(error.message)); return;
  }
  const editing = ["INPUT", "SELECT", "TEXTAREA"].includes(
    event.target.tagName,
  );
  if (event.ctrlKey && event.key.toLowerCase() === "o") {
    event.preventDefault();
    importBooks();
    return;
  }
  if (event.ctrlKey && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (!$("reader-view").hidden)
      returnLibrary().then(() => $("library-search").focus());
    else $("library-search").focus();
    return;
  }
  if (document.querySelector("dialog[open]") || editing) return;
  if (!$("reader-view").hidden) {
    if (event.key === "Escape") {
      event.preventDefault();
      returnLibrary();
    } else reader.key(event);
  }
});

busy(true, "正在打开本地书库…");
try {
  const data = await call("bootstrap");
  books = data.books;
  settingsPanel.configure(data);
  render();
  if (data.importErrors?.length) toast(data.importErrors.join("\n"));
} catch (error) {
  toast(error.message);
} finally {
  busy(false);
}
