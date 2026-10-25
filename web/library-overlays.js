import { icon } from "./icons.ts";

export function createLibraryOverlays(onRemove, actions = {}) {
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
  const item = (root, id, name, glyph) => {
    const button = document.createElement("button");
    button.id = id;
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.innerHTML = `${icon(glyph, "fluent")}<span class="book-menu-label"></span>`;
    button.querySelector(".book-menu-label").textContent = name;
    root.append(button);
    return button;
  };
  const open = item(menu, "book-menu-open", "打开阅读", "book");
  const details = item(menu, "book-menu-info", "查看信息", "book-info");
  const exportNotes = item(menu, "book-menu-export", "导出笔记", "note");
  const importNotes = item(menu, "book-menu-import", "导入笔记", "note");
  const category = item(menu, "book-menu-category", "添加至分类", "library");
  category.insertAdjacentHTML("beforeend", `<span class="book-menu-trailing">${icon("chevron", "fluent")}</span>`);
  category.setAttribute("aria-haspopup", "menu");
  category.setAttribute("aria-expanded", "false");
  category.setAttribute("aria-controls", "book-shelf-menu");
  const hide = item(menu, "book-menu-hide", "隐藏图书", "hide");
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

  let timer, submenuTimer;
  let titleOwner = null, menuOwner = null, selectedBook = null;
  let pointerFocus = false;
  const isOpen = element => element.matches(":popover-open");
  const buttons = root => [...root.children].filter(el => el.matches('button:not(:disabled)'));
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
  function place(element, x, y) {
    const bounds = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(x, innerWidth - bounds.width - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(y, innerHeight - bounds.height - 8))}px`;
  }
  function showTitle(card, title, immediate = false) {
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
  function choose(action) {
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
  function showMenu(event, card, book, keyboard = false) {
    event.preventDefault();
    dismiss();
    pointerFocus = true;
    menuOwner = card;
    selectedBook = book;
    heading.textContent = book.title;
    const hidden = Boolean(actions.isHidden?.(book));
    hide.querySelector(".book-menu-label").textContent = hidden ? "取消隐藏" : "隐藏图书";
    hide.querySelector(".ui-icon").outerHTML = icon(hidden ? "view" : "hide", "fluent");
    hide.dataset.hidden = String(hidden);
    card.setAttribute("aria-expanded", "true");
    menu.showPopover();
    const rect = card.getBoundingClientRect();
    place(menu, keyboard ? rect.left + 12 : event.clientX, keyboard ? rect.top + 12 : event.clientY);
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
  remove.onclick = () => choose(onRemove);
  category.onclick = () => showSubmenu(true);
  category.onpointerenter = () => showSubmenu();
  category.onpointerleave = () => { submenuTimer = setTimeout(hideSubmenu, 220); };
  submenu.onpointerenter = () => clearTimeout(submenuTimer);
  submenu.onpointerleave = () => { submenuTimer = setTimeout(hideSubmenu, 220); };
  for (const button of [open, details, exportNotes, importNotes, hide, remove]) button.onpointerenter = hideSubmenu;
  menu.onkeydown = event => {
    const nested = submenu.contains(event.target);
    if (event.key === "ArrowRight" && event.target === category) {
      event.preventDefault(); showSubmenu(true);
    } else if ((event.key === "Escape" || event.key === "ArrowLeft") && isOpen(submenu)) {
      event.preventDefault(); event.stopPropagation(); hideSubmenu(); category.focus();
    } else if (["Escape", "Tab"].includes(event.key)) {
      event.preventDefault(); dismiss(); menuOwner?.focus({ preventScroll: true });
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const items = buttons(nested ? submenu : menu);
      const index = items.indexOf(document.activeElement);
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
    if (!menu.contains(event.target)) dismiss();
  }, true);
  window.addEventListener("resize", dismiss);

  return {
    dismiss,
    bind(card, book) {
      const title = card.querySelector("h3");
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
