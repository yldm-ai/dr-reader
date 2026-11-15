import { icon } from "./icons.ts";
import type { Book, Shelf } from "./types.ts";

type BookAction = (book: Book) => unknown;
export interface LibraryActions {
  open?: BookAction;
  showInfo?: BookAction;
  shelves?: () => Shelf[];
  addToShelf?: (book: Book, shelfId: string) => unknown;
  createShelf?: BookAction;
  isHidden?: (book: Book) => boolean;
  hide?: BookAction;
  unhide?: BookAction;
  exportNotes?: BookAction;
  importNotes?: BookAction;
  /** Enters batch selection with this book already selected. */
  select?: BookAction;
}
export interface LibraryOverlays {
  dismiss(): void;
  bind(card: HTMLElement, book: Book): void;
}

export function createLibraryOverlays(onRemove: BookAction, actions: LibraryActions = {}): LibraryOverlays {
  const tooltip = document.createElement("div");
  tooltip.id = "book-title-tooltip";
  tooltip.className = "book-title-tooltip";
  tooltip.popover = "manual";
  tooltip.setAttribute("role", "tooltip");
  const menu = document.createElement("div");
  menu.id = "book-context-menu";
  menu.className = "book-context-menu";
  menu.popover = "auto";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "图书操作");
  const heading = document.createElement("div");
  heading.className = "book-menu-heading";
  menu.append(heading);
  const item = (root: HTMLElement, id: string, name: string, glyph: string) => {
    const button = document.createElement("button");
    button.id = id;
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.innerHTML = `${icon(glyph, "fluent")}<span class="book-menu-label"></span>`;
    button.querySelector(".book-menu-label")!.textContent = name;
    root.append(button);
    return button;
  };
  const open = item(menu, "book-menu-open", "打开阅读", "book");
  const details = item(menu, "book-menu-info", "查看信息", "book-info");
  const exportNotes = item(menu, "book-menu-export", "导出笔记与对话", "note");
  const importNotes = item(menu, "book-menu-import", "导入笔记与对话", "note");
  const category = item(menu, "book-menu-category", "添加至分类", "library");
  category.insertAdjacentHTML("beforeend", `<span class="book-menu-trailing">${icon("chevron", "fluent")}</span>`);
  category.setAttribute("aria-haspopup", "menu");
  category.setAttribute("aria-expanded", "false");
  category.setAttribute("aria-controls", "book-shelf-menu");
  const hide = item(menu, "book-menu-hide", "隐藏图书", "hide");
  const select = item(menu, "book-menu-select", "选择", "check");
  const divider = document.createElement("div");
  divider.className = "book-menu-divider";
  divider.setAttribute("role", "separator");
  menu.append(divider);
  const remove = item(menu, "book-menu-delete", "删除图书", "delete");
  remove.className = "danger-button";
  const submenu = document.createElement("div");
  submenu.id = "book-shelf-menu";
  submenu.className = "book-context-menu book-shelf-menu";
  submenu.popover = "manual";
  submenu.setAttribute("role", "menu");
  submenu.setAttribute("aria-label", "添加至分类");
  menu.append(submenu);
  document.body.append(tooltip, menu);

  let timer: ReturnType<typeof setTimeout> | undefined, submenuTimer: ReturnType<typeof setTimeout> | undefined;
  let titleOwner: HTMLElement | null = null, menuOwner: HTMLElement | null = null, selectedBook: Book | null = null;
  let pointerFocus = false;
  const isOpen = (element: Element) => element.matches(":popover-open");
  const buttons = (root: HTMLElement) =>
    [...root.children].filter((el): el is HTMLButtonElement => el.matches('button:not(:disabled)'));
  function hideTitle() {
    clearTimeout(timer);
    tooltip.hidePopover();
    titleOwner?.removeAttribute("aria-describedby");
    titleOwner = null;
  }
  function hideSubmenu() {
    clearTimeout(submenuTimer);
    submenu.hidePopover();
    category.setAttribute("aria-expanded", "false");
  }
  function dismiss() {
    hideTitle();
    hideSubmenu();
    menu.hidePopover();
  }
  function place(element: HTMLElement, x: number, y: number) {
    const bounds = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(x, innerWidth - bounds.width - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(y, innerHeight - bounds.height - 8))}px`;
  }
  function showTitle(card: HTMLElement, title: HTMLElement, immediate = false) {
    hideTitle();
    if (isOpen(menu) || title.scrollWidth <= title.clientWidth) return;
    timer = setTimeout(() => {
      // A focus-triggered timer may otherwise win the race with the contextmenu event.
      if (!card.isConnected || isOpen(menu)) return;
      titleOwner = card;
      tooltip.textContent = title.textContent;
      card.setAttribute("aria-describedby", tooltip.id);
      tooltip.showPopover();
      const rect = title.getBoundingClientRect();
      const bounds = tooltip.getBoundingClientRect();
      const y = rect.bottom + 8 + bounds.height <= innerHeight - 8
        ? rect.bottom + 8 : rect.top - bounds.height - 8;
      place(tooltip, rect.left + (rect.width - bounds.width) / 2, y);
    }, immediate ? 0 : 420);
  }
  function choose(action: BookAction | undefined) {
    const book = selectedBook;
    dismiss();
    if (book) action?.(book);
  }
  function showSubmenu(focus = false) {
    clearTimeout(submenuTimer);
    if (!isOpen(menu) || !selectedBook) return;
    if (!isOpen(submenu)) {
      submenu.replaceChildren();
      const shelves = actions.shelves?.() || [];
      if (!shelves.length) {
        const empty = document.createElement("div");
        empty.className = "book-menu-empty";
        empty.textContent = "还没有分类书架";
        submenu.append(empty);
      }
      for (const shelf of shelves) {
        const added = shelf.bookIds.includes(selectedBook.id);
        const button = item(submenu, "", shelf.name, added ? "check" : "library");
        button.dataset.shelfId = shelf.id;
        button.disabled = added;
        if (added) {
          const status = document.createElement("small");
          status.textContent = "已添加";
          button.append(status);
        }
        button.onclick = () => choose(book => actions.addToShelf?.(book, shelf.id));
      }
      const line = divider.cloneNode();
      submenu.append(line);
      item(submenu, "book-menu-new-shelf", "新建分类书架", "plus").onclick = () => choose(book => actions.createShelf?.(book));
      submenu.showPopover();
      category.setAttribute("aria-expanded", "true");
      const rect = category.getBoundingClientRect();
      const main = menu.getBoundingClientRect();
      const width = submenu.getBoundingClientRect().width;
      place(submenu, main.right + width + 4 <= innerWidth - 8 ? main.right + 4 : main.left - width - 4, rect.top - 5);
    }
    if (focus) buttons(submenu)[0]?.focus({ preventScroll: true });
  }
  function showMenu(event: MouseEvent | KeyboardEvent, card: HTMLElement, book: Book, keyboard = false) {
    event.preventDefault();
    dismiss();
    pointerFocus = true;
    menuOwner = card;
    selectedBook = book;
    heading.textContent = book.title;
    const hidden = Boolean(actions.isHidden?.(book));
    hide.querySelector(".book-menu-label")!.textContent = hidden ? "取消隐藏" : "隐藏图书";
    hide.querySelector(".ui-icon")!.outerHTML = icon(hidden ? "view" : "hide", "fluent");
    hide.dataset.hidden = String(hidden);
    card.setAttribute("aria-expanded", "true");
    menu.showPopover();
    const rect = card.getBoundingClientRect();
    const pointer = event as MouseEvent;
    place(menu, keyboard ? rect.left + 12 : pointer.clientX, keyboard ? rect.top + 12 : pointer.clientY);
    open.focus({ preventScroll: true });
  }
  menu.addEventListener("beforetoggle", event => {
    if (event.newState === "closed") {
      hideSubmenu();
      menuOwner?.setAttribute("aria-expanded", "false");
    }
  });
  open.onclick = () => choose(book => actions.open?.(book));
  details.onclick = () => choose(book => actions.showInfo?.(book));
  exportNotes.onclick = () => choose(book => actions.exportNotes?.(book));
  importNotes.onclick = () => choose(book => actions.importNotes?.(book));
  hide.onclick = () => choose(hide.dataset.hidden === "true" ? actions.unhide : actions.hide);
  select.onclick = () => choose(actions.select);
  remove.onclick = () => choose(onRemove);
  category.onclick = () => showSubmenu(true);
  category.onpointerenter = () => showSubmenu();
  category.onpointerleave = () => { submenuTimer = setTimeout(hideSubmenu, 220); };
  submenu.onpointerenter = () => clearTimeout(submenuTimer);
  submenu.onpointerleave = () => { submenuTimer = setTimeout(hideSubmenu, 220); };
  for (const button of [open, details, exportNotes, importNotes, hide, select, remove]) button.onpointerenter = hideSubmenu;
  menu.onkeydown = event => {
    const nested = submenu.contains(event.target as Node | null);
    if (event.key === "ArrowRight" && event.target === category) {
      event.preventDefault(); showSubmenu(true);
    } else if ((event.key === "Escape" || event.key === "ArrowLeft") && isOpen(submenu)) {
      event.preventDefault(); event.stopPropagation(); hideSubmenu(); category.focus();
    } else if (["Escape", "Tab"].includes(event.key)) {
      event.preventDefault(); dismiss(); menuOwner?.focus({ preventScroll: true });
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const items = buttons(nested ? submenu : menu);
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 :
        (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus({ preventScroll: true });
      if (!nested && document.activeElement !== category) hideSubmenu();
    }
  };
  document.addEventListener("pointerdown", () => { pointerFocus = true; hideTitle(); }, true);
  document.addEventListener("keydown", event => {
    if (event.key === "Tab") pointerFocus = false;
    if (event.key === "Escape" && isOpen(tooltip)) hideTitle();
  }, true);
  document.addEventListener("scroll", event => {
    if (!menu.contains(event.target as Node | null)) dismiss();
  }, true);
  window.addEventListener("resize", dismiss);

  return {
    dismiss,
    bind(card, book) {
      const title = card.querySelector("h3")!;
      card.setAttribute("aria-haspopup", "menu");
      card.setAttribute("aria-expanded", "false");
      card.oncontextmenu = event => showMenu(event, card, book);
      card.addEventListener("keydown", event => {
        if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
          showMenu(event, card, book, true);
      });
      title.onpointerenter = () => showTitle(card, title);
      title.onpointerleave = hideTitle;
      card.onfocus = () => { if (!pointerFocus) showTitle(card, title, true); };
      card.onblur = hideTitle;
    },
  };
}
