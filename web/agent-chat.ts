import { call, escape, errorMessage, onHostEvent, toast } from './bridge.ts';
import { icon } from './icons.ts';
import { renderMarkdown } from './markdown.ts';
import { buildAgentPrompt, QUOTE_BUDGET } from './agent-prompt.ts';
import type { ChatTurn, ReadingContext } from './agent-prompt.ts';
import type { AgentChoice, AgentId } from './types.ts';

/** What the reader supplies: the passage being read and the configured agent. */
export interface AgentChatHost {
  context(): ReadingContext | null;
  agent(): { agent: AgentChoice; model: string; effort: string };
}
/** A saved turn; assistant turns record which CLI, model and effort answered. */
export interface ConversationMessage {
  role: 'user' | 'assistant';
  text: string;
  quote?: string;
  agent?: AgentId | '';
  label?: string;
  model?: string;
  effort?: string;
  stopped?: boolean;
  createdAt?: number;
}
export interface Conversation {
  id: string;
  bookId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount?: number;
  messages?: ConversationMessage[];
}
interface AgentEventMessage { request?: string; type?: 'text' | 'status' | 'done' | 'error'; text?: string }
interface Session { id: string; title: string; messages: ConversationMessage[] }
interface Active {
  request: string;
  bookId: string;
  session: Session;
  question: string;
  quote: string;
  answer: string;
  agent: AgentId | '';
  label: string;
  model: string;
  effort: string;
  turn: HTMLElement;
  body: HTMLElement;
  meta: HTMLElement;
  frame: number;
  stopped: boolean;
}

const newSession = (): Session => ({ id: crypto.randomUUID(), title: '', messages: [] });
/** The first question, on one line, names the conversation in the history list. */
const titleOf = (question: string) => {
  const line = question.replace(/\s+/g, ' ').trim();
  return line.length > 40 ? `${line.slice(0, 40)}…` : line;
};
function when(seconds: number): string {
  const date = new Date(seconds * 1000), now = new Date();
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (date.toDateString() === now.toDateString()) return `今天 ${time}`;
  const day = `${date.getMonth() + 1}月${date.getDate()}日`;
  return `${date.getFullYear() === now.getFullYear() ? day : `${date.getFullYear()}年${day}`} ${time}`;
}

/**
 * The 问书 sidebar tab: conversations about the open book, answered by a local agent CLI.
 * Each question sends the replayed conversation, the reader's selected passage and the chapter
 * text around the reading position; answers stream in as Markdown. Every finished answer saves
 * the conversation to the book's reading data (`conversation.save`); opening a book continues
 * its latest conversation, and 历史 lists, reopens or deletes earlier ones.
 */
export class AgentChat {
  readonly root: HTMLElement;
  readonly scroller: HTMLElement;
  private host: AgentChatHost;
  private thread: HTMLElement;
  private historyPanel: HTMLElement;
  private historyList: HTMLElement;
  private input: HTMLTextAreaElement;
  private send: HTMLButtonElement;
  private quoteBox: HTMLElement;
  private bookId: string | null = null;
  private session: Session = newSession();
  private quote = '';
  private active: Active | null = null;
  /** Ignores a slow load that a later book or session switch has replaced. */
  private loading = 0;

  constructor(root: HTMLElement, host: AgentChatHost) {
    this.root = root;
    this.host = host;
    root.classList.add('ask-panel');
    root.innerHTML = `<div class="ask-body">
<div class="ask-thread" aria-live="polite"></div>
<div class="ask-history" hidden><div class="ask-history-head"><span>历史对话</span><button type="button" class="text-button ask-history-close">返回</button></div><div class="ask-history-list"></div></div>
</div>
<form class="ask-form">
  <div class="ask-quote" hidden><span class="ask-quote-text"></span><button type="button" class="icon-button ask-quote-remove" aria-label="移除引用的文字" title="移除引用">${icon('close')}</button></div>
  <textarea class="ask-input" rows="3" maxlength="4000" placeholder="问问这本书…" aria-label="向 AI 提问"></textarea>
  <div class="ask-actions"><button type="button" class="text-button ask-reset">新对话</button><button type="button" class="text-button ask-history-open" aria-pressed="false">历史</button><span class="ask-hint" title="Shift+Enter 换行">Enter 发送</span><button type="submit" class="icon-button ask-send" aria-label="发送" title="发送">${icon('arrow-up')}</button></div>
</form>`;
    this.scroller = root.querySelector('.ask-body')!;
    this.thread = root.querySelector('.ask-thread')!;
    this.historyPanel = root.querySelector('.ask-history')!;
    this.historyList = root.querySelector('.ask-history-list')!;
    this.input = root.querySelector('.ask-input')!;
    this.send = root.querySelector('.ask-send')!;
    this.quoteBox = root.querySelector('.ask-quote')!;
    this.renderEmpty();
    root.querySelector<HTMLFormElement>('.ask-form')!.onsubmit = event => {
      event.preventDefault();
      if (this.active) this.stop();
      else this.ask(this.input.value);
    };
    this.input.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      if (!this.active) this.ask(this.input.value);
    });
    root.querySelector<HTMLButtonElement>('.ask-quote-remove')!.onclick = () => this.attach('');
    root.querySelector<HTMLButtonElement>('.ask-reset')!.onclick = () => { this.reset(); this.focus(); };
    root.querySelector<HTMLButtonElement>('.ask-history-open')!.onclick = () => { if (this.historyPanel.hidden) this.showHistory(); else this.hideHistory(); };
    root.querySelector<HTMLButtonElement>('.ask-history-close')!.onclick = () => this.hideHistory();
    onHostEvent('agent', message => this.receive(message as AgentEventMessage));
  }

  /** Switches to a book and continues its most recent conversation, if any. */
  async open(bookId: string): Promise<void> {
    this.reset();
    this.bookId = bookId;
    const token = this.loading;
    try {
      const sessions = await call<Conversation[]>('conversations', { id: bookId });
      if (token !== this.loading || !sessions.length) return;
      await this.load(sessions[0].id, token);
    } catch (error) {
      if (token === this.loading) toast(`无法读取 AI 对话：${errorMessage(error)}`, 'error');
    }
  }

  /** The book closed: stop answering and forget it. */
  close(): void {
    this.reset();
    this.bookId = null;
  }

  /** Attaches the passage the next question is about; empty removes it. */
  attach(quote: string): void {
    this.quote = quote.trim().slice(0, QUOTE_BUDGET);
    this.quoteBox.hidden = !this.quote;
    this.quoteBox.querySelector('.ask-quote-text')!.textContent = this.quote;
  }

  focus(): void {
    this.input.focus({ preventScroll: true });
  }

  /** Starts a new conversation; the current one stays saved in the history. */
  reset(): void {
    if (this.active) this.stop();
    ++this.loading;
    this.session = newSession();
    this.attach('');
    this.hideHistory();
    this.renderEmpty();
  }

  private renderEmpty(): void {
    this.thread.innerHTML = '<p class="panel-hint">选中正文后点「问 AI」，或直接提问。<br>回答由本机的 Codex、Claude Code 或 opencode 生成，可在应用设置中选择。对话保存在这本书的阅读数据中，可在「历史」中找回。</p>';
  }

  /** Opens a saved conversation of the current book. */
  private async load(id: string, token = ++this.loading): Promise<void> {
    if (!this.bookId) return;
    const saved = await call<Conversation>('conversation', { id: this.bookId, session: id });
    if (token !== this.loading) return;
    if (this.active) this.stop();
    this.session = { id: saved.id, title: saved.title, messages: saved.messages ?? [] };
    this.thread.replaceChildren(...this.session.messages.map(message =>
      message.role === 'user' ? this.userTurn(message.text, message.quote ?? '') : this.answerTurn(message)));
    if (!this.session.messages.length) this.renderEmpty();
    this.hideHistory();
    this.scroller.scrollTop = this.scroller.scrollHeight;
  }

  private async showHistory(): Promise<void> {
    if (!this.bookId) { toast('请先打开一本书'); return; }
    this.historyPanel.hidden = false;
    this.thread.hidden = true;
    this.scroller.scrollTop = 0;
    this.root.querySelector('.ask-history-open')!.setAttribute('aria-pressed', 'true');
    if (!this.historyList.childElementCount) this.historyList.innerHTML = '<p class="panel-hint">正在读取…</p>';
    try {
      const sessions = await call<Conversation[]>('conversations', { id: this.bookId });
      if (!this.historyPanel.hidden) this.renderHistory(sessions);
    } catch (error) {
      this.historyList.innerHTML = `<p class="panel-hint">${escape(errorMessage(error))}</p>`;
    }
  }

  private hideHistory(): void {
    this.historyPanel.hidden = true;
    this.thread.hidden = false;
    this.scroller.scrollTop = this.scroller.scrollHeight;
    this.root.querySelector('.ask-history-open')?.setAttribute('aria-pressed', 'false');
  }

  private renderHistory(sessions: Conversation[]): void {
    if (!sessions.length) {
      this.historyList.innerHTML = '<p class="panel-hint">这本书还没有保存的对话。</p>';
      return;
    }
    this.historyList.replaceChildren(...sessions.map(session => {
      const row = document.createElement('div');
      row.className = 'ask-history-row';
      row.dataset.session = session.id;
      if (session.id === this.session.id) row.dataset.current = 'true';
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'ask-history-item';
      const title = document.createElement('span');
      title.textContent = session.title || '未命名对话';
      const meta = document.createElement('small');
      meta.textContent = `${Math.ceil((session.messageCount ?? 0) / 2)} 问 · ${when(session.updatedAt)}`;
      open.append(title, meta);
      open.onclick = () => { this.load(session.id).catch(error => toast(`无法打开对话：${errorMessage(error)}`, 'error')); };
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'icon-button ask-history-delete';
      remove.title = '删除对话';
      remove.setAttribute('aria-label', `删除对话：${title.textContent}`);
      remove.innerHTML = icon('delete');
      remove.onclick = () => this.remove(session.id);
      row.append(open, remove);
      return row;
    }));
  }

  private async remove(id: string): Promise<void> {
    if (!this.bookId) return;
    try {
      await call('conversation.delete', { id: this.bookId, session: id });
      if (id === this.session.id) {
        if (this.active) this.stop();
        this.session = newSession();
        this.renderEmpty();
      }
      toast('已删除对话', 'success');
      await this.showHistory();
    } catch (error) {
      toast(`删除对话失败：${errorMessage(error)}`, 'error');
    }
  }

  async ask(question: string): Promise<void> {
    question = question.trim();
    if (!question || this.active) return;
    const context = this.host.context();
    if (!context || !this.bookId) { toast('请先打开一本书'); return; }
    this.hideHistory();
    const quote = this.quote;
    const { agent, model, effort } = this.host.agent();
    const prompt = buildAgentPrompt(context, this.turns(), question, quote);
    if (!this.session.messages.length) this.thread.replaceChildren();
    this.thread.append(this.userTurn(question, quote));
    const turn = document.createElement('div');
    turn.className = 'ask-turn ask-answer';
    turn.innerHTML = '<div class="ask-answer-body markdown"></div><div class="ask-meta">正在思考…</div>';
    this.thread.append(turn);
    const request = crypto.randomUUID();
    this.active = { request, bookId: this.bookId, session: this.session, question, quote, answer: '', agent: '', label: '', model, effort,
      turn, frame: 0, stopped: false, body: turn.querySelector('.ask-answer-body')!, meta: turn.querySelector('.ask-meta')! };
    this.input.value = '';
    this.attach('');
    this.setBusy(true);
    this.reveal(turn);
    try {
      const started = await call<{ agent: AgentId; label: string }>('agent.ask', { request, agent, model, effort, prompt });
      if (this.active?.request === request) {
        this.active.agent = started.agent;
        this.active.label = started.label;
        if (!this.active.answer) this.active.meta.textContent = `${started.label} 正在思考…`;
      }
    } catch (error) {
      if (this.active?.request === request) this.fail(errorMessage(error));
    }
  }

  stop(): void {
    const active = this.active;
    if (!active) return;
    active.stopped = true;
    call('agent.cancel', { request: active.request }).catch(() => {});
    this.complete(active, true);
  }

  /** The conversation so far as prompt turns; a stopped answer says so. */
  private turns(): ChatTurn[] {
    return this.session.messages.map((message): ChatTurn => message.role === 'user'
      ? { role: 'user', text: message.text, quote: message.quote || undefined }
      : { role: 'assistant', text: message.stopped ? `${message.text}\n（回答被读者中途停止）` : message.text });
  }

  private receive(message: AgentEventMessage): void {
    const active = this.active;
    if (!active || message.request !== active.request) return;
    const text = String(message.text ?? '');
    if (message.type === 'text') {
      active.answer += text;
      // Re-render once per frame however fast the deltas arrive.
      active.frame ||= requestAnimationFrame(() => {
        active.frame = 0;
        active.body.innerHTML = renderMarkdown(active.answer);
        active.meta.textContent = `${active.label || 'AI'} 正在回答…`;
        this.reveal(active.turn, true);
      });
    } else if (message.type === 'status') active.meta.textContent = text;
    else if (message.type === 'done') this.complete(active, false);
    else if (message.type === 'error') this.fail(text);
  }

  private complete(active: Active, stopped: boolean): void {
    cancelAnimationFrame(active.frame);
    this.active = null;
    this.setBusy(false);
    if (!active.answer.trim()) {
      // Nothing to keep: a stop before the first word leaves no turn behind.
      active.turn.previousElementSibling?.remove();
      active.turn.remove();
      if (!this.session.messages.length && this.session === active.session) this.renderEmpty();
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    const answer: ConversationMessage = { role: 'assistant', text: active.answer, agent: active.agent, label: active.label,
      model: active.model, effort: active.effort, stopped, createdAt: now };
    const session = active.session;
    session.messages.push({ role: 'user', text: active.question, quote: active.quote || undefined, createdAt: now }, answer);
    session.title ||= titleOf(active.question);
    active.turn.replaceWith(this.answerTurn(answer));
    call('conversation.save', { id: active.bookId, session: { id: session.id, title: session.title, messages: session.messages } })
      .catch(error => toast(`对话未能保存：${errorMessage(error)}`, 'error'));
  }

  private fail(message: string): void {
    const active = this.active;
    if (!active) return;
    cancelAnimationFrame(active.frame);
    this.active = null;
    this.setBusy(false);
    if (active.stopped) return;
    active.body.innerHTML = active.answer ? renderMarkdown(active.answer) : '';
    active.turn.classList.add('ask-failed');
    active.meta.innerHTML = `<span class="ask-error">${escape(message || '没有得到回答')}</span>`;
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'text-button';
    retry.textContent = '重试';
    retry.onclick = () => {
      // The failed exchange was never saved; ask it again in its place.
      active.turn.previousElementSibling?.remove();
      active.turn.remove();
      if (!this.session.messages.length) this.renderEmpty();
      this.attach(active.quote);
      this.ask(active.question);
    };
    active.meta.append(retry);
  }

  private userTurn(question: string, quote: string): HTMLElement {
    const turn = document.createElement('div');
    turn.className = 'ask-turn ask-user';
    if (quote) {
      const passage = document.createElement('blockquote');
      passage.className = 'ask-turn-quote';
      passage.textContent = quote;
      turn.append(passage);
    }
    const text = document.createElement('p');
    text.textContent = question;
    turn.append(text);
    return turn;
  }

  /** A finished answer: its Markdown, which CLI wrote it, and a copy button. */
  private answerTurn(message: ConversationMessage): HTMLElement {
    const turn = document.createElement('div');
    turn.className = 'ask-turn ask-answer';
    const body = document.createElement('div');
    body.className = 'ask-answer-body markdown';
    body.innerHTML = renderMarkdown(message.text);
    const meta = document.createElement('div');
    meta.className = 'ask-meta';
    const label = document.createElement('span');
    label.textContent = `${message.label || 'AI'}${message.stopped ? ' · 已停止' : ''}`;
    if (message.model || message.effort) label.title = [message.model, message.effort].filter(Boolean).join(' · ');
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'text-button ask-copy';
    copy.textContent = '复制';
    copy.onclick = () => call('copy', { text: message.text }).then(() => toast('已复制回答', 'success'), error => toast(errorMessage(error), 'error'));
    meta.append(label, copy);
    turn.append(body, meta);
    return turn;
  }

  private setBusy(busy: boolean): void {
    this.send.innerHTML = icon(busy ? 'stop' : 'arrow-up');
    this.send.setAttribute('aria-label', busy ? '停止回答' : '发送');
    this.send.title = busy ? '停止回答' : '发送';
    this.root.dataset.busy = String(busy);
  }

  /** Keeps the newest answer in view while it streams, unless the reader scrolled up. */
  private reveal(turn: HTMLElement, streaming = false): void {
    const scroller = this.scroller;
    const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
    if (!streaming || nearBottom) turn.scrollIntoView({ block: 'nearest' });
  }
}
