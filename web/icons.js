const paths = {
  book: "M12 5c-3-2-7-2-10-1v15c3-1 7-1 10 1m0-15c3-2 7-2 10-1v15c-3-1-7-1-10 1V5Z",
  library: "M4 4v16M8 4v16M12 4v16m4-15 4 14M3 20h18",
  plus: "M12 5v14M5 12h14",
  clock: "M12 8v5l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z",
  bookmark: "M6 3h12v18l-6-4-6 4V3Z",
  check: "m5 12 4 4L19 6",
  user: "M20 21v-2a7 7 0 0 0-14 0v2M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  chevron: "m9 5 7 7-7 7",
  settings:
    "m10 3-1 3-3 1-3-1-2 4 2 2v3l-2 2 2 4 3-1 3 1 1 3h4l1-3 3-1 3 1 2-4-2-2v-3l2-2-2-4-3 1-3-1-1-3h-4ZM16 13a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  search: "m21 21-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z",
  grid: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.1M3 12h.1M3 18h.1",
  "arrow-left": "m12 5-7 7 7 7M5 12h15",
  "arrow-right": "m12 5 7 7-7 7M4 12h15",
  type: "M4 5h16M12 5v15M8 20h8",
  close: "m6 6 12 12M6 18 18 6",
  play: "m9 5 10 7-10 7V5Z",
};
export function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] || paths.book}"/></svg>`;
}
export function hydrate(root = document) {
  root
    .querySelectorAll("[data-icon]")
    .forEach((el) => (el.innerHTML = icon(el.dataset.icon)));
}
