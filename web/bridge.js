import { icon } from './icons.ts';

let sequence = 0;
const pending = new Map();
if (window.chrome?.webview)
  window.chrome.webview.addEventListener("message", ({ data }) => {
    const item = pending.get(data.id);
    if (!item) return;
    pending.delete(data.id);
    clearTimeout(item.timer);
    if (data.error) item.reject(new Error(data.error));
    else item.resolve(data.result);
  });
export function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    if (!window.chrome?.webview) {
      reject(new Error("请通过 DR Reader 桌面程序打开界面。"));
      return;
    }
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("处理超时，请稍后重试。"));
    }, 300000);
    pending.set(id, { resolve, reject, timer });
    window.chrome.webview.postMessage({ id, method, params });
  });
}
export function bookUrl(book, href) {
  return `https://books.dr-reader.local/${book.id}/content/${href.split("/").map(encodeURIComponent).join("/")}`;
}
export const $ = (id) => document.getElementById(id);
export function escape(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}
let toastTimer;
let toastRevision = 0;
export function toast(message, kind = "info") {
  const revision = ++toastRevision;
  const element = $("toast");
  clearTimeout(toastTimer);
  const dismiss = () => {
    if (revision !== toastRevision) return;
    clearTimeout(toastTimer);
    if (element.matches(':popover-open')) element.hidePopover();
    element.hidden = true;
  };
  // A popover outside a modal remains inert; place it inside the active modal.
  const modal = document.activeElement?.closest('dialog:modal') || [...document.querySelectorAll('dialog:modal')].at(-1);
  const host = modal || document.body;
  if (element.parentElement !== host) {
    if (element.matches(':popover-open')) element.hidePopover();
    host.append(element);
  }
  modal?.addEventListener('close', dismiss, { once: true });
  element.dataset.kind = kind;
  element.innerHTML = `<span class="toast-icon" aria-hidden="true">${icon(kind === "success" ? "check" : "info")}</span><span class="toast-message"></span><button type="button" class="toast-close" aria-label="关闭提示">${icon("close")}</button>`;
  element.querySelector('.toast-message').textContent = String(message);
  element.querySelector('.toast-close').onclick = dismiss;
  element.hidden = false;
  // Manual popover keeps notifications above modal settings without taking focus.
  if (!element.matches(':popover-open')) element.showPopover();
  let remaining = kind === "error" ? 6000 : kind === "success" ? 2600 : 3600;
  let started;
  const resume = () => {
    if (revision !== toastRevision) return;
    clearTimeout(toastTimer);
    if (element.matches(':hover') || element.contains(document.activeElement)) return;
    started = performance.now();
    toastTimer = setTimeout(dismiss, remaining);
  };
  const pause = () => {
    if (revision !== toastRevision) return;
    clearTimeout(toastTimer);
    if (started !== undefined) remaining = Math.max(0, remaining - (performance.now() - started));
    started = undefined;
  };
  element.onpointerenter = pause;
  element.onpointerleave = resume;
  element.onfocusin = pause;
  element.onfocusout = () => queueMicrotask(resume);
  resume();
}
export function busy(value, label = "正在处理电子书…") {
  $("busy-label").textContent = label;
  $("busy").hidden = !value;
}
