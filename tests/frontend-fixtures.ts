import type { HostMessage } from '../web/bridge.ts';
import type { Annotation, Book, Bootstrap, Settings, Shelf } from '../web/types.ts';

/** Bootstrap data plus the switches a test uses to steer the mock host. */
export interface Fixture extends Bootstrap {
  annotations?: Annotation[];
  shelves?: Shelf[];
  exportError?: string;
  exportResult?: unknown;
  notesImportError?: string;
  notesImportResult?: unknown;
  fullscreen?: boolean;
  titlebarHidden?: boolean;
}
export interface HostRequest { method: string; params: any }

export function bootstrapFixture(): Fixture {
  // The fixture leaves out settings and book fields the UI must tolerate missing.
  const settings = {
    version: 2,
    application: { theme: 'light', shell: 'direct2d', animations: false, bookOpeningEnabled: false, bookOpeningAnimation: 'circles',
      selectionActions: { highlight: true, underline: true, note: true, copy: true, search: true, dictionary: true },
      dictionaries: [{ id: 'one', name: '测试词典', url: 'https://example.com/?q={text}', enabled: true }] },
    reading: { theme: 'sepia', mode: 'paged', fontFamily: 'serif', fontSize: 20, fontWeight: 400,
      lineHeight: 1.9, paragraphSpacing: 1, letterSpacing: 0, textIndent: 0, alignment: 'justify',
      width: 760, paddingX: 44, paddingY: 38, paddingTop: 38, paddingBottom: 38, paddingLeft: 44, paddingRight: 44,
      showToolbar: true, showToc: true, showChapterTitle: true, showPagination: true, showProgress: true,
      fullBackground: false, fullWidth: false, animation: 'none', animationDuration: 220, turnDuration: 800, layout: 'single', doubleAnimation: 'turn',publisherStyles: false },
  } as Settings;
  const book = { id: 'fixture', title: '阅读与时光', author: '测试作者', addedAt: 1,
    lastRead: 0, progress: 0, chapters: [{ href: 'chapter.html', title: '第一章' }, { href: 'second.html', title: '第二章' }],
    toc: [{ href: 'chapter.html', title: '第一章', chapter: 0, children: [] as never[] },
      { href: 'second.html', title: '第二章', chapter: 1, children: [] as never[] }], bookmarks: [] as Book['bookmarks'] };
  return { settings, defaults: structuredClone(settings), books: [book as Book], dataPath: 'test-only',
    fonts: ['Microsoft YaHei', '宋体', 'Microsoft YaHei', ...Array.from({ length: 180 }, (_, i) => `Test Font ${i}`)] };
}
export function installNativeMock(data: Fixture = bootstrapFixture()) {
  const messages = new EventTarget();
  const requests: HostRequest[] = [];
  const reply = (message: HostMessage) => queueMicrotask(() => messages.dispatchEvent(new MessageEvent('message', { data: message })));
  window.chrome ||= {};
  window.chrome.webview = {
    addEventListener: (type, listener) => messages.addEventListener(type, listener as unknown as EventListener),
    postMessage(message) {
      const { id, method, params } = message as { id: number } & HostRequest;
      requests.push({ method, params });
      let result: unknown = true;
      if (method === 'notes.export') {
        if (data.exportError) {
          reply({ id, error: data.exportError });
          return;
        }
        result = data.exportResult || { saved: true };
      }
      if (method === 'notes.import') {
        if (data.notesImportError) {
          reply({ id, error: data.notesImportError });
          return;
        }
        result = data.notesImportResult || { imported: 2, skipped: 1 };
      }

      if (method === 'shelves.save') { data.shelves = structuredClone(params.shelves); result = structuredClone(data.shelves); }
      if (method === 'bootstrap') result = structuredClone(data);
      if (method === 'import') result = { books: structuredClone(data.books), errors: data.importErrors || [] };
      data.annotations ||= [];
      if (method === 'annotations') result = structuredClone(data.annotations);
      if (method === 'annotation.save') {
        const saved = { ...params.annotation, id: params.annotation.id || `note-${data.annotations.length + 1}` };
        data.annotations = [...data.annotations.filter(item => item.id !== saved.id), saved];
        result = structuredClone(saved);
      }
      if (method === 'annotation.delete') data.annotations = data.annotations.filter(item => item.id !== params.annotationId);
      if (method === 'book.delete') data.books = data.books.filter(book => book.id !== params.id);
      if (method === 'open') result = structuredClone(data.books[0]);
      if (method === 'position') {
        data.books[0].position = params.position;
        data.books[0].lastRead = 1;
        data.books[0].progress = params.position.chapter === data.books[0].chapters.length ? 1 :
          Math.min(.999, (params.position.chapter + params.position.ratio) / data.books[0].chapters.length);
        result = structuredClone(data.books[0]);
      }
      if (method === 'fullscreen') {
        const enabled = data.fullscreen = params?.enabled ?? !data.fullscreen;
        result = enabled;
        reply({ event: 'fullscreen', enabled });
      }
      if (method === 'book.stats') result = { chars: data.books[0].chapters.map(() => 2400) };
      if (method === 'book.info') {
        const book = data.books.find(item => item.id === params.id);
        result = {
          title: book.title, subtitle: '', authors: [book.author], contributors: [{ name: '测试译者', role: 'trl' }],
          series: '测试系列', seriesIndex: 2, publisher: '原创出版社', published: '2024-05-01', languages: ['zh'],
          subjects: ['小说', '测试'], identifiers: [{ scheme: 'isbn', value: '9787536692930' }],
          description: '第一段简介\n第二段 <b>不是标签</b>', format: 'EPUB', fileBytes: 2.5 * 1024 * 1024,
          addedAt: 1700000000, lastRead: 0, progress: 0, chapters: book.chapters.length,
          words: { cjk: 123456, words: 789, punctuation: 4321, withPunctuation: 128566, withoutPunctuation: 124245 },
        };
      }
      if (method === 'titlebar') {
        const hidden = data.titlebarHidden = params?.hidden ?? !data.titlebarHidden;
        result = hidden;
        reply({ event: 'titlebar', hidden });
      }
      if (method === 'settings') {
        for (const group of ['reading', 'application'] as const) if (params[group]) Object.assign(data.settings[group], params[group]);
        result = structuredClone(data.settings);
      }
      reply({ id, result });
    },
  };
  return { requests, data };
}
