import { call, bookUrl, $, escape, toast, busy } from "./bridge.js";
import { icon, hydrate } from "./icons.js";
import { Reader } from "./reader.js";
hydrate();
let books = [],
  settings = {},
  filter = "all",
  author = "",
  listMode = false,
  settingsTimer;
const reader = new Reader((book) => {
  const index = books.findIndex((b) => b.id === book.id);
  if (index >= 0) books[index] = book;
});
window.chrome?.webview?.addEventListener("message", async ({ data }) => {
  if (data.event === "closing") {
    await reader.flush();
    call("close").catch(() => {});
  }
});
function cover(book, className = "cover-image") {
  return book.cover
    ? `<img class="${className}" src="${escape(bookUrl(book, book.cover))}" alt="${escape(book.title)}封面" loading="lazy">`
    : `<div class="cover-fallback">${escape(book.title)}<small>${escape(book.author)}</small></div>`;
}
function render() {
  const q = $("library-search").value.toLocaleLowerCase();
  let visible = books.filter(
    (b) =>
      (!author || b.author === author) &&
      (!q || `${b.title} ${b.author}`.toLocaleLowerCase().includes(q)) &&
      (filter === "recent"
        ? b.lastRead > 0
        : filter === "unread"
          ? !b.lastRead
          : filter === "finished"
            ? b.progress >= 0.99
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
  $("count-recent").textContent = books.filter((b) => b.lastRead).length;
  $("library-total").textContent = `${books.length} 本图书`;
  const grid = $("book-grid");
  grid.replaceChildren();
  grid.classList.toggle("list-mode", listMode);
  for (const book of visible) {
    const card = document.createElement("button");
    card.className = "book-card";
    card.setAttribute("aria-label", `阅读 ${book.title}`);
    card.innerHTML = `<div class="cover-wrap">${cover(book)}</div><h3>${escape(book.title)}</h3><div class="book-author">${escape(book.author)}</div><div class="book-status">${book.lastRead ? `<span class="progress-track"><i style="width:${Math.round(book.progress * 100)}%"></i></span><span>已读 ${Math.round(book.progress * 100)}%</span>` : '<span class="new-label">未读</span><span>EPUB</span>'}</div>`;
    card.onclick = () => openBook(book.id);
    grid.append(card);
  }
  $("empty-state").hidden = visible.length > 0;
  if (!visible.length) {
    $("empty-state").querySelector("h2").textContent =
      q || author || filter !== "all"
        ? "这里还没有图书"
        : "下一段故事，从这里开始";
    $("empty-state").querySelector("p").textContent = q
      ? "试试其他书名或作者。"
      : "添加一本 EPUB，建立属于自己的书架。";
  }
  const latest = books
    .filter((b) => b.lastRead && b.progress < 0.99)
    .sort((a, b) => b.lastRead - a.lastRead)[0];
  $("continue-section").hidden = !latest || filter !== "all" || !!q || !!author;
  if (latest) {
    $("continue-book").innerHTML =
      `${cover(latest, "continue-cover")}<div class="continue-info"><strong>${escape(latest.title)}</strong><small>${escape(latest.author)} · ${escape(latest.chapters[latest.position?.chapter || 0]?.title || "")}</small><div class="continue-progress"><span class="progress-track"><i style="width:${Math.round(latest.progress * 100)}%"></i></span><span>${Math.round(latest.progress * 100)}%</span></div></div><span class="continue-action">继续阅读 ${icon("arrow-right")}</span>`;
    $("continue-book").onclick = () => openBook(latest.id);
  }
  const authors = $("authors");
  authors.replaceChildren();
  for (const name of [...new Set(books.map((b) => b.author))].sort()) {
    const button = document.createElement("button");
    button.textContent = `${name} · ${books.filter((b) => b.author === name).length}`;
    button.onclick = () => {
      author = name;
      filter = "all";
      setNavigation();
      render();
    };
    authors.append(button);
  }
}
function setNavigation() {
  document
    .querySelectorAll("[data-filter]")
    .forEach((b) =>
      b.classList.toggle("active", !author && b.dataset.filter === filter),
    );
}
async function openBook(id) {
  busy(true, "正在打开电子书…");
  try {
    const book = await call("open", { id });
    $("library-view").hidden = true;
    document.querySelector(".sidebar").hidden = true;
    $("reader-view").hidden = false;
    await reader.open(book, settings);
  } catch (e) {
    toast(e.message);
  } finally {
    busy(false);
  }
}
async function importBooks() {
  busy(true, "正在导入 EPUB，C++ 正在解析与拆分章节…");
  try {
    const result = await call("import");
    books = result.books;
    render();
    if (result.errors.length) toast(result.errors.join("\n"));
    else toast("书库已更新");
  } catch (e) {
    toast(e.message);
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
function applySettings() {
  document.body.dataset.theme = settings.theme;
  reader.apply(settings);
  document.querySelectorAll("[data-theme]").forEach((b) => {
    if (b.tagName === "BUTTON")
      b.classList.toggle("selected", b.dataset.theme === settings.theme);
  });
  $("font-family").value = settings.fontFamily;
  $("font-size").value = settings.fontSize;
  $("font-size-value").value = settings.fontSize;
  $("line-height").value = settings.lineHeight;
  $("line-height-value").value = settings.lineHeight;
  $("reading-width").value = settings.width;
  $("reading-width-value").value = settings.width;
  $("reading-mode").value = settings.mode;
  document
    .querySelectorAll("[name=shell]")
    .forEach((input) => (input.checked = input.value === settings.shell));
}
function updateSettings(patch) {
  settings = { ...settings, ...patch };
  applySettings();
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(async () => {
    try {
      await call("settings", settings);
    } catch (e) {
      toast(e.message);
    }
  }, 200);
}
function openSettings() {
  applySettings();
  $("settings-dialog").showModal();
}
for (const id of ["import-side", "import-main", "import-empty"])
  $(id).onclick = importBooks;
$("library-nav").onclick = (e) => {
  const target = e.target.closest("[data-filter]");
  if (!target) return;
  filter = target.dataset.filter;
  author = "";
  setNavigation();
  render();
};
$("authors-toggle").onclick = () => {
  $("authors").hidden = !$("authors").hidden;
};
$("library-search").oninput = render;
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
$("open-settings").onclick = openSettings;
$("reader-settings").onclick = openSettings;
$("close-settings").onclick = () => $("settings-dialog").close();
$("settings-dialog").onclick = (e) => {
  if (
    e.target === $("settings-dialog") &&
    e.clientX < $("settings-dialog").getBoundingClientRect().left
  )
    $("settings-dialog").close();
};
document
  .querySelectorAll("button[data-theme]")
  .forEach(
    (b) => (b.onclick = () => updateSettings({ theme: b.dataset.theme })),
  );
for (const [id, key] of [
  ["font-size", "fontSize"],
  ["line-height", "lineHeight"],
  ["reading-width", "width"],
])
  $(id).oninput = () => updateSettings({ [key]: Number($(id).value) });
$("font-family").onchange = () =>
  updateSettings({ fontFamily: $("font-family").value });
$("reading-mode").onchange = () =>
  updateSettings({ mode: $("reading-mode").value });
document
  .querySelectorAll("[name=shell]")
  .forEach(
    (input) => (input.onchange = () => updateSettings({ shell: input.value })),
  );
document.addEventListener("keydown", (e) => {
  const editing = ["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName);
  if (e.ctrlKey && e.key.toLowerCase() === "o") {
    e.preventDefault();
    importBooks();
    return;
  }
  if (e.ctrlKey && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (!$("reader-view").hidden)
      returnLibrary().then(() => $("library-search").focus());
    else $("library-search").focus();
    return;
  }
  if ($("settings-dialog").open || editing) return;
  if (!$("reader-view").hidden) {
    if (e.key === "Escape") {
      e.preventDefault();
      returnLibrary();
    } else reader.key(e);
  }
});
busy(true, "正在打开本地书库…");
try {
  const data = await call("bootstrap");
  books = data.books;
  settings = data.settings;
  $("data-path").textContent = data.dataPath || "";
  applySettings();
  render();
  if (data.importErrors?.length) toast(data.importErrors.join("\n"));
} catch (e) {
  toast(e.message);
} finally {
  busy(false);
}
