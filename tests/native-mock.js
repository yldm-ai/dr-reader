import { bootstrapFixture, installNativeMock } from './frontend-fixtures.js';
const fixture = bootstrapFixture();
if (new URL(import.meta.url).searchParams.has('system')) {
  fixture.settings.application.theme = 'system';
  fixture.settings.reading.theme = 'system';
}
const tocAnchors = new URL(import.meta.url).searchParams.has('toc');
if (tocAnchors) {
  fixture.books[0].toc = [
    { title: '作品集', href: 'chapter.html', depth: 0 },
    { title: '上卷', href: 'chapter.html', depth: 1 },
    ...Array.from({ length: 4 }, (_, i) => ({ title: `第 ${i + 1} 章`, href: `chapter.html#section${i + 1}`, depth: 2 })),
  ];
}
if (new URL(import.meta.url).searchParams.has('touchpad')) {
  fixture.settings.application.animations = true;
  fixture.settings.reading.animation = 'turn';
  fixture.settings.reading.turnDuration = 500;
}
if (new URL(import.meta.url).searchParams.has('menus')) {
  fixture.books[0].title = '一部书名非常长的原创测试图书，用来验证右键菜单不会闪现书名浮窗';
  fixture.shelves = [{ id: 'literature', name: '文学', bookIds: [] }, { id: 'history', name: '历史与人文', bookIds: ['fixture'] }];
}
const iconMode = new URL(import.meta.url).searchParams.get('icons');
if (iconMode) {
  fixture.annotations = [{ id: 'icon-tip', chapter: 0, href: 'chapter.html', start: 3, end: 5, quote: '阅读', note: '图标回退测试', style: 'note', color: '#ddedea' }];
  fixture.iconFonts = iconMode === 'none' ? {} : {
    'Segoe Fluent Icons': [],
    'Segoe MDL2 Assets': [0xe736, 0xe8f1, 0xe710, 0xe81c, 0xe8a4, 0xe73e, 0xe77b, 0xe76c, 0xe70d,
      0xe713, 0xe721, 0xe74c, 0xe8fd, 0xe74a, 0xe72b, 0xe72a, 0xe8d2, 0xe711, 0xe768, 0xe70f,
      0xe74d, 0xe718, 0xe8c8, 0xe70b, 0xe8dc, 0xe82d, 0xe82f, 0xe7e6],
  };
}
window.nativeProbe = installNativeMock(fixture);
window.runtimeErrors = [];
window.addEventListener('error', event => window.runtimeErrors.push(event.message));
window.addEventListener('unhandledrejection', event => window.runtimeErrors.push(String(event.reason)));
const originalFetch = window.fetch.bind(window);
window.chapterRequests = 0;
window.fetch = (url, ...args) => {
  if (String(url).startsWith('https://books.dr-reader.local/')) {
    window.chapterRequests++;
    if (tocAnchors) return Promise.resolve(new Response(
      `<html><head></head><body><h1>上卷</h1>${Array.from({ length: 4 }, (_, i) =>
        `<section style="break-before:column"><h2 id="section${i + 1}">第 ${i + 1} 章</h2>${'<p>这是原创的层级目录定位测试文字。</p>'.repeat(18)}</section>`).join('')}</body></html>`,
      { headers: { 'Content-Type': 'text/html' } }));

    return Promise.resolve(window.chapterGate).then(() => new Response(
    `<html><head></head><body><h1>第一章</h1>${'<p>阅读是一段安静的时光。这是原创的阅读测试文字，用来验证字体、布局与翻页。</p>'.repeat(window.shortFinalChapter && String(url).endsWith('second.html') ? 1 : 70)}</body></html>`,
    { headers: { 'Content-Type': 'text/html' } }));
  }
  return originalFetch(url, ...args);
};
