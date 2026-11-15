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
  /** Ends every agent answer with this error instead of success. */
  agentError?: string;
  /** Streams one chunk and then waits until the page cancels. */
  agentSlow?: boolean;
  /** Fails the model query of this agent with the message. */
  agentModelsError?: Record<string, string>;
  /** Saved AI conversations, like the reading database, keyed by conversation id. */
  conversations?: Record<string, { id: string; bookId: string; title: string; createdAt: number; updatedAt: number; messages: unknown[] }>;
}
export interface HostRequest { method: string; params: any }

export function bootstrapFixture(): Fixture {
  // The fixture leaves out settings and book fields the UI must tolerate missing.
  const settings = {
    version: 2,
    application: { theme: 'light', shell: 'direct2d', animations: false, bookOpeningEnabled: false, bookOpeningAnimation: 'circles',
      selectionActions: { highlight: true, underline: true, note: true, copy: true, search: true, dictionary: true, drDict: true, ask: true },
      dictionaries: [{ id: 'one', name: '测试词典', url: 'https://example.com/?q={text}', enabled: true }] },
    reading: { theme: 'sepia', background: 'plain', mode: 'paged', fontFamily: 'serif', fontSize: 20, fontWeight: 400,
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
      if (method === 'books.delete') {
        const deleted = data.books.filter(book => params.ids.includes(book.id)).map(book => book.id);
        data.books = data.books.filter(book => !deleted.includes(book.id));
        result = { deleted, errors: [] };
      }
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
      if (method === 'agent.detect') result = { codex: { path: 'C:/fake/codex.exe' }, claude: null, opencode: { path: 'C:/fake/opencode.cmd' } };
      if (method === 'agent.ask') {
        // A fake CLI: the answer streams in Markdown chunks, then ends like the native runner.
        const request = params.request;
        const agent = (event: Record<string, unknown>) => reply({ event: 'agent', request, ...event });
        const chunks = ['**要点**：这是', '原创的测试回答。', '\n\n- 第一条\n- 第二条'];
        chunks.slice(0, data.agentSlow ? 1 : chunks.length).forEach((text, index) => setTimeout(() => agent({ type: 'text', text }), 20 * (index + 1)));
        if (!data.agentSlow) setTimeout(() => agent(data.agentError ? { type: 'error', text: data.agentError } : { type: 'done', text: '' }), 100);
        result = { agent: 'codex', label: 'Codex' };
      }
      if (method === 'agent.models') {
        // Answers later, like a CLI that takes a moment to start.
        const failure = data.agentModelsError?.[params.agent];
        const models = params.agent === 'claude'
          ? [{ id: 'opus', name: 'Opus 5.5', description: '', default: true, efforts: ['low', 'medium', 'high'], defaultEffort: '' },
            { id: 'sonnet', name: 'Sonnet 5.5', description: '', default: false, efforts: ['low', 'max'], defaultEffort: '' }]
          : [{ id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', description: '', default: true, efforts: ['low', 'medium', 'high'], defaultEffort: 'low' },
            { id: 'gpt-6-astra', name: 'GPT-6-Astra', description: '', default: false, efforts: [], defaultEffort: '' }];
        setTimeout(() => reply(failure ? { id, error: failure } : { id, result: { models } }), 60);
        return;
      }
      if (method.startsWith('conversation')) {
        const store = data.conversations ??= {};
        const now = Math.floor(Date.now() / 1000);
        const tick = () => Object.values(store).reduce((latest, item) => Math.max(latest, item.updatedAt), now - 1) + 1;
        if (method === 'conversations')
          result = Object.values(store).filter(item => item.bookId === params.id).sort((a, b) => b.updatedAt - a.updatedAt)
            .map(({ messages, ...summary }) => ({ ...summary, messageCount: messages.length }));
        if (method === 'conversation') {
          const found = store[params.session];
          if (!found || found.bookId !== params.id) { reply({ id, error: '这段对话不存在或不属于当前书籍' }); return; }
          result = structuredClone({ ...found, messageCount: found.messages.length });
        }
        if (method === 'conversation.save') {
          const previous = store[params.session.id];
          // Strictly increasing times keep the newest-first order deterministic within a second.
          store[params.session.id] = { ...structuredClone(params.session), bookId: params.id, createdAt: previous?.createdAt ?? tick(), updatedAt: tick() };
          result = structuredClone(store[params.session.id]);
        }
        if (method === 'conversation.delete') { delete store[params.session]; result = true; }
      }
      if (method === 'agent.cancel') reply({ event: 'agent', request: params.request, type: 'error', text: '已停止回答' });
      if (method === 'settings') {
        for (const group of ['reading', 'application'] as const) if (params[group]) Object.assign(data.settings[group], params[group]);
        result = structuredClone(data.settings);
      }
      reply({ id, result });
    },
  };
  return { requests, data };
}
