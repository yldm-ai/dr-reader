export function bootstrapFixture() {
  const settings = {
    version: 2,
    application: { theme: 'light', shell: 'direct2d', animations: false,
      selectionActions: { highlight: true, underline: true, note: true, copy: true, search: true, dictionary: true },
      dictionaries: [{ id: 'one', name: '测试词典', url: 'https://example.com/?q={text}', enabled: true }] },
    reading: { theme: 'sepia', mode: 'paged', fontFamily: 'serif', fontSize: 20, fontWeight: 400,
      lineHeight: 1.9, paragraphSpacing: 1, letterSpacing: 0, textIndent: 0, alignment: 'justify',
      width: 760, paddingX: 44, paddingY: 38, paddingTop: 38, paddingBottom: 38, paddingLeft: 44, paddingRight: 44,
      showToolbar: true, showToc: true, showChapterTitle: true, showPagination: true, showProgress: true,
      fullBackground: false, fullWidth: false, animation: 'none', animationDuration: 220, publisherStyles: false },
  };
  const book = { id: 'fixture', title: '阅读与时光', author: '测试作者', addedAt: 1,
    lastRead: 0, progress: 0, chapters: [{ href: 'chapter.html', title: '第一章' }],
    toc: [{ href: 'chapter.html', title: '第一章', chapter: 0, children: [] }], bookmarks: [] };
  return { settings, defaults: structuredClone(settings), books: [book], dataPath: 'test-only',
    fonts: ['Microsoft YaHei', '宋体', 'Microsoft YaHei', ...Array.from({ length: 180 }, (_, i) => `Test Font ${i}`)] };
}
export function installNativeMock(data = bootstrapFixture()) {
  const messages = new EventTarget();
  const requests = [];
  window.chrome ||= {};
  window.chrome.webview = {
    addEventListener: (...args) => messages.addEventListener(...args),
    postMessage({ id, method, params }) {
      requests.push({ method, params });
      let result = true;
      if (method === 'bootstrap') result = structuredClone(data);
      if (method === 'annotations') result = [];
      if (method === 'open') result = structuredClone(data.books[0]);
      if (method === 'position') {
        data.books[0].position = params.position;
        data.books[0].lastRead = 1;
        result = structuredClone(data.books[0]);
      }
      if (method === 'fullscreen') {
        data.fullscreen = params?.enabled ?? !data.fullscreen;
        result = data.fullscreen;
        queueMicrotask(() => messages.dispatchEvent(new MessageEvent('message', { data: { event: 'fullscreen', enabled: result } })));
      }
      if (method === 'settings') {
        for (const group of ['reading', 'application']) if (params[group]) Object.assign(data.settings[group], params[group]);
        result = structuredClone(data.settings);
      }
      queueMicrotask(() => messages.dispatchEvent(new MessageEvent('message', { data: { id, result } })));
    },
  };
  return { requests, data };
}
