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
export function toast(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 5000);
}
export function busy(value, label = "正在处理电子书…") {
  $("busy-label").textContent = label;
  $("busy").hidden = !value;
}
