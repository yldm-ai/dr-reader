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
    "M19.21 9.02L19.60 10.25L21.88 10.44L21.88 13.56L19.60 13.75L19.21 14.98L18.61 16.13L20.09 17.88L17.88 20.09L16.13 18.61L14.98 19.21L13.75 19.60L13.56 21.88L10.44 21.88L10.25 19.60L9.02 19.21L7.87 18.61L6.12 20.09L3.91 17.88L5.39 16.13L4.79 14.98L4.40 13.75L2.12 13.56L2.12 10.44L4.40 10.25L4.79 9.02L5.39 7.87L3.91 6.12L6.12 3.91L7.87 5.39L9.02 4.79L10.25 4.40L10.44 2.12L13.56 2.12L13.75 4.40L14.98 4.79L16.13 5.39L17.88 3.91L20.09 6.12L18.61 7.87ZM15.2 12a3.2 3.2 0 1 1-6.4 0 3.2 3.2 0 0 1 6.4 0Z",
  search: "m21 21-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z",
  grid: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.1M3 12h.1M3 18h.1",
  "arrow-up": "m5 12 7-7 7 7M12 5v15",
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
