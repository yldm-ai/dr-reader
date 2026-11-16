import { icon } from './icons.ts';

/** A reply from the host to a `call`, or an event it pushes (`event` set, no `id`). */
export interface HostMessage {
  id?: number;
  result?: unknown;
  error?: string;
  event?: string;
  [key: string]: unknown;
}
interface WebView {
  addEventListener(type: 'message', listener: (event: { data: HostMessage }) => void): void;
  postMessage(message: unknown): void;
  /** Posts DOM objects with the message; the host reads a File's native path. */
  postMessageWithAdditionalObjects(message: unknown, objects: ArrayLike<unknown>): void;
}
declare global {
  interface Window { chrome?: { webview?: WebView } }
}

interface Pending { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
let sequence = 0;
const pending = new Map<number, Pending>();
if (window.chrome?.webview)
  window.chrome.webview.addEventListener("message", ({ data }) => {
    const item = data.id === undefined ? undefined : pending.get(data.id);
    if (!item) return;
    pending.delete(data.id!);
    clearTimeout(item.timer);
    if (data.error) item.reject(new Error(data.error));
    else item.resolve(data.result);
  });
/** Subscribes to messages the host pushes with `event: name` (not replies to `call`). */
export function onHostEvent(name: string, handler: (message: HostMessage) => void): void {
  window.chrome?.webview?.addEventListener("message", ({ data }) => {
    if (data?.event === name) handler(data);
  });
}
/**
 * Calls a native method; `T` is the caller's view of the JSON result. Files (such as dropped
 * ones) travel as WebView2 additional objects, so the host gets their native paths.
 */
export function call<T = unknown>(method: string, params: object = {}, files?: readonly File[]): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (!window.chrome?.webview) {
      reject(new Error("请通过 DR Reader 桌面程序打开界面。"));
      return;
    }
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("处理超时，请稍后重试。"));
    }, 300000);
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
    if (files?.length) window.chrome.webview.postMessageWithAdditionalObjects({ id, method, params }, files);
    else window.chrome.webview.postMessage({ id, method, params });
  });
}
export function bookUrl(book: { id: string }, href: string): string {
  return `https://books.dr-reader.local/${book.id}/content/${href.split("/").map(encodeURIComponent).join("/")}`;
}
/** The element with this id; callers name the element type when they need more than HTMLElement. */
export const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
/** The message of a thrown value, which is an Error everywhere in this UI but typed `unknown`. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export function escape(value: unknown): string {
  const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(value ?? "").replace(/[&<>"']/g, (c) => entities[c]);
}
export type ToastKind = "info" | "success" | "error";
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let toastRevision = 0;
/** The countdown controls of the toast on screen; focus listeners are bound once per element. */
let toastFocus: { pause(): void; resume(): void } | undefined;
const toastFocusBound = new WeakSet<HTMLElement>();
export function toast(message: unknown, kind: ToastKind = "info"): void {
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
  element.querySelector('.toast-message')!.textContent = String(message);
  element.querySelector<HTMLButtonElement>('.toast-close')!.onclick = dismiss;
  element.hidden = false;
  // Manual popover keeps notifications above modal settings without taking focus.
  if (!element.matches(':popover-open')) element.showPopover();
  let remaining = kind === "error" ? 6000 : kind === "success" ? 2600 : 3600;
  let started: number | undefined;
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
  // Chromium has no onfocusin/onfocusout handler properties, so assigning them never fired;
  // keyboard focus on the close button only pauses the countdown through real listeners.
  toastFocus = { pause, resume };
  if (!toastFocusBound.has(element)) {
    toastFocusBound.add(element);
    element.addEventListener('focusin', () => toastFocus?.pause());
    element.addEventListener('focusout', () => queueMicrotask(() => toastFocus?.resume()));
  }
  resume();
}
export function busy(value: boolean, label = "正在处理电子书…"): void {
  $("busy-label").textContent = label;
  $("busy").hidden = !value;
}
