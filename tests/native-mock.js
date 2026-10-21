import { installNativeMock } from './frontend-fixtures.js';
window.nativeProbe = installNativeMock();
window.runtimeErrors = [];
window.addEventListener('error', event => window.runtimeErrors.push(event.message));
window.addEventListener('unhandledrejection', event => window.runtimeErrors.push(String(event.reason)));
const originalFetch = window.fetch.bind(window);
window.chapterRequests = 0;
window.fetch = (url, ...args) => {
  if (String(url).startsWith('https://books.dr-reader.local/')) {
    window.chapterRequests++;
    return Promise.resolve(window.chapterGate).then(() => new Response(
    `<html><head></head><body><h1>第一章</h1>${'<p>阅读是一段安静的时光。这是原创的阅读测试文字，用来验证字体、布局与翻页。</p>'.repeat(70)}</body></html>`,
    { headers: { 'Content-Type': 'text/html' } }));
  }
  return originalFetch(url, ...args);
};
