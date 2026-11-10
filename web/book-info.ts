import { call, bookUrl, escape } from './bridge.ts';
import { icon } from './icons.ts';
import { dragDialog } from './drag-dialog.ts';

interface Book { id: string; title: string; author?: string; cover?: string }
interface Info {
  title: string; subtitle?: string; authors: string[]; contributors?: { name: string; role: string }[];
  series?: string; seriesIndex?: number; publisher?: string; published?: string; languages: string[];
  subjects: string[]; identifiers?: { scheme: string; value: string }[]; description?: string;
  format?: string; fileBytes?: number; addedAt?: number; lastRead?: number; progress?: number; chapters?: number;
  words: { cjk: number; words: number; punctuation: number; withPunctuation: number; withoutPunctuation: number };
}

const roles: Record<string, string> = { trl: '译者', edt: '编者', ill: '插画' };
const number = (value: number) => value.toLocaleString('zh-CN');
// Chinese readers think in 万 for book lengths: "128,640 字 · 约 12.9 万".
const words = (value: number) => `${number(value)} 字${value >= 10000 ? `<small>约 ${(value / 10000).toFixed(1)} 万</small>` : ''}`;
const size = (bytes: number) => bytes >= 1 << 20 ? `${(bytes / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const date = (seconds?: number) => seconds ? new Date(seconds * 1000).toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }) : '';
function language(code: string): string {
  try { return new Intl.DisplayNames(['zh-CN'], { type: 'language' }).of(code) ?? code; } catch { return code; }
}

/** Book details in the manner of calibre's Book details panel, plus word counts. */
export class BookInfo {
  private readonly dialog = document.createElement('dialog');
  private readonly body: HTMLDivElement;
  private request = 0;

  constructor() {
    const { dialog } = this;
    dialog.id = 'book-info-dialog';
    dialog.className = 'annotation-dialog book-info-dialog';
    dialog.setAttribute('aria-labelledby', 'book-info-title');
    dialog.innerHTML = `<form method="dialog"><div class="annotation-header"><h2 id="book-info-title">图书信息</h2>
      <button value="cancel" class="icon-button" aria-label="关闭图书信息" title="关闭">${icon('close')}</button></div>
      <div class="book-info-body" aria-live="polite"></div>
      <div class="annotation-actions"><span></span><button value="cancel" class="text-button">关闭</button></div></form>`;
    this.body = dialog.querySelector('.book-info-body')!;
    document.body.append(dialog);
    dragDialog(dialog, '.annotation-header');
    dialog.addEventListener('close', () => { this.request++; });
  }

  async show(book: Book): Promise<void> {
    const request = ++this.request;
    this.body.innerHTML = `${this.header(book, { title: book.title, authors: book.author ? [book.author] : [] })}<p class="book-info-status">正在读取图书信息与统计字数…</p>`;
    if (!this.dialog.open) this.dialog.showModal();
    try {
      const info = await call('book.info', { id: book.id }) as Info;
      if (request === this.request) this.render(book, info);
    } catch (error) {
      if (request !== this.request) return;
      const status = this.body.querySelector('.book-info-status')!;
      status.classList.add('error');
      status.textContent = `读取图书信息失败：${(error as Error).message}`;
    }
  }

  private header(book: Book, info: Pick<Info, 'title' | 'authors'> & { subtitle?: string }): string {
    const cover = book.cover
      ? `<img class="book-info-cover" src="${escape(bookUrl(book, book.cover))}" alt="">`
      : `<div class="book-info-cover cover-fallback">${escape(info.title)}</div>`;
    return `<div class="book-info-heading">${cover}<div><h3>${escape(info.title)}</h3>${info.subtitle ? `<p class="book-info-subtitle">${escape(info.subtitle)}</p>` : ''}<p class="book-info-authors">${escape(info.authors.join('、') || '未知作者')}</p></div></div>`;
  }

  private render(book: Book, info: Info): void {
    const rows: [string, string][] = [];
    const add = (label: string, value?: string) => { if (value) rows.push([label, value]); };
    const contributors = new Map<string, string[]>();
    for (const { name, role } of info.contributors ?? []) contributors.set(role, [...contributors.get(role) ?? [], name]);
    for (const [role, names] of contributors) add(roles[role] ?? role, escape(names.join('、')));
    if (info.series) add('系列', escape(info.series) + (info.seriesIndex !== undefined ? ` <small>第 ${escape(String(+info.seriesIndex.toFixed(2)))} 册</small>` : ''));
    add('出版社', escape(info.publisher ?? ''));
    add('出版日期', escape(info.published ?? ''));
    add('语言', escape(info.languages.map(language).join('、')));
    add('标签', info.subjects.map(tag => `<span class="book-info-tag">${escape(tag)}</span>`).join(''));
    for (const { scheme, value } of info.identifiers ?? []) add(scheme === 'isbn' ? 'ISBN' : scheme.toUpperCase(), escape(value));
    add('格式', escape([info.format || 'EPUB', info.fileBytes ? size(info.fileBytes) : ''].filter(Boolean).join(' · ')));
    add('章节', info.chapters ? `${number(info.chapters)} 个阅读单元` : '');
    add('添加时间', escape(date(info.addedAt)));
    add('最近阅读', info.lastRead ? escape(date(info.lastRead)) : '尚未开始');
    if (info.lastRead) add('阅读进度', `${info.progress! >= 1 ? 100 : Math.min(99, Math.round((info.progress ?? 0) * 100))}%`);
    const { words: counts } = info;
    const description = (info.description ?? '').split('\n').filter(Boolean).map(line => `<p>${escape(line)}</p>`).join('');
    this.body.innerHTML = `${this.header(book, info)}
      <section class="book-info-words" aria-label="字数统计">
        <div><span>字数（含标点）</span><strong>${words(counts.withPunctuation)}</strong></div>
        <div><span>字数（不含标点）</span><strong>${words(counts.withoutPunctuation)}</strong></div>
        <p>汉字与假名 ${number(counts.cjk)} · 外文单词与数字 ${number(counts.words)} · 标点符号 ${number(counts.punctuation)}</p>
      </section>
      <dl class="book-info-fields">${rows.map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`).join('')}</dl>
      ${description ? `<section class="book-info-description"><h4>简介</h4>${description}</section>` : ''}`;
  }
}
