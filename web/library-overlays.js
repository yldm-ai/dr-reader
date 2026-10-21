import { icon } from "./icons.ts";

export function createLibraryOverlays(onRemove) {
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
  const remove = document.createElement("button");
  remove.id = "book-menu-delete";
  remove.className = "danger-button";
  remove.setAttribute("role", "menuitem");
  remove.innerHTML = `${icon("delete")}<span>删除图书</span>`;
  menu.append(remove);
  document.body.append(tooltip, menu);

  let timer;
  let titleOwner = null;
  let menuOwner = null;
  let selectedBook = null;
  const isOpen = element => element.matches(":popover-open");
  function hideTitle() {
    clearTimeout(timer);
    tooltip.hidePopover();
    titleOwner?.removeAttribute("aria-describedby");
    titleOwner = null;
  }
  function dismiss() {
    hideTitle();
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
      if (!card.isConnected) return;
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
  function showMenu(event, card, book, keyboard = false) {
    event.preventDefault();
    dismiss();
    menuOwner = card;
    selectedBook = book;
    card.setAttribute("aria-expanded", "true");
    menu.showPopover();
    const rect = card.getBoundingClientRect();
    place(menu, keyboard ? rect.left + 12 : event.clientX,
      keyboard ? rect.top + 12 : event.clientY);
    remove.focus({ preventScroll: true });
  }
  menu.addEventListener("toggle", () => {
    if (!isOpen(menu)) menuOwner?.setAttribute("aria-expanded", "false");
  });
  remove.onclick = () => {
    const book = selectedBook;
    dismiss();
    if (book) onRemove(book);
  };
  menu.onkeydown = event => {
    if (["Escape", "Tab"].includes(event.key)) {
      event.preventDefault();
      dismiss();
      menuOwner?.focus({ preventScroll: true });
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      remove.focus();
    }
  };
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && isOpen(tooltip)) hideTitle();
  });
  document.addEventListener("scroll", dismiss, true);
  window.addEventListener("resize", dismiss);
  window.addEventListener("blur", dismiss);

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
      card.onfocus = () => showTitle(card, title, true);
      card.onblur = hideTitle;
      card.addEventListener("pointerdown", hideTitle);
    },
  };
}
