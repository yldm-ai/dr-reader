import { call, escape, errorMessage, onHostEvent, toast } from './bridge.ts';
import { icon } from './icons.ts';
import { renderMarkdown } from './markdown.ts';
import { buildAgentPrompt, QUOTE_BUDGET } from './agent-prompt.ts';
import type { ChatTurn, ReadingContext } from './agent-prompt.ts';
import type { AgentChoice, AgentId } from './types.ts';

/** What the reader supplies: the passage being read and the configured agent. */
export interface AgentChatHost {
  context(): ReadingContext | null;
  agent(): { agent: AgentChoice; model: string };
}
interface AgentEventMessage { request?: string; type?: 'text' | 'status' | 'done' | 'error'; text?: string }
interface Active {
  request: string;
  question: string;
  quote: string;
  answer: string;
  label: string;
  turn: HTMLElement;
  body: HTMLElement;
  meta: HTMLElement;
  frame: number;
  stopped: boolean;
}

/**
 * The 问书 sidebar tab: a conversation about the open book, answered by a local agent CLI.
 * Each question sends the replayed conversation, the reader's selected passage and the chapter
 * text around the reading position; answers stream in as Markdown.
 */
export class AgentChat {
  readonly root: HTMLElement;
  private host: AgentChatHost;
  private thread: HTMLElement;
  private input: HTMLTextAreaElement;
  private send: HTMLButtonElement;
  private quoteBox: HTMLElement;
  private history: ChatTurn[] = [];
  private quote = '';
  private active: Active | null = null;

  constructor(root: HTMLElement, host: AgentChatHost) {
    this.root = root;
    this.host = host;
    root.classList.add('ask-panel');
    root.innerHTML = `<div class="ask-thread" aria-live="polite"></div>
<form class="ask-form">
  <div class="ask-quote" hidden><span class="ask-quote-text"></span><button type="button" class="icon-button ask-quote-remove" aria-label="移除引用的文字" title="移除引用">${icon('close')}</button></div>
  <textarea class="ask-input" rows="3" maxlength="4000" placeholder="问问这本书…" aria-label="向 AI 提问"></textarea>
  <div class="ask-actions"><button type="button" class="text-button ask-reset">新对话</button><span class="ask-hint" title="Shift+Enter 换行">Enter 发送</span><button type="submit" class="icon-button ask-send" aria-label="发送" title="发送">${icon('arrow-up')}</button></div>
</form>`;
    this.thread = root.querySelector('.ask-thread')!;
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
    root.querySelector<HTMLButtonElement>('.ask-reset')!.onclick = () => this.reset();
    onHostEvent('agent', message => this.receive(message as AgentEventMessage));
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

  /** Starts over: stops a running answer and forgets the conversation (a new book does this). */
  reset(): void {
    if (this.active) this.stop();
    this.history = [];
    this.attach('');
    this.renderEmpty();
  }

  private renderEmpty(): void {
    this.thread.innerHTML = '<p class="panel-hint">选中正文后点「问 AI」，或直接提问。<br>回答由本机的 Codex、Claude Code 或 opencode 生成，可在应用设置中选择。</p>';
  }

  async ask(question: string): Promise<void> {
    question = question.trim();
    if (!question || this.active) return;
    const context = this.host.context();
    if (!context) { toast('请先打开一本书'); return; }
    const quote = this.quote;
    const { agent, model } = this.host.agent();
    const prompt = buildAgentPrompt(context, this.history, question, quote);
    if (!this.history.length) this.thread.replaceChildren();
    this.thread.append(this.userTurn(question, quote));
    const turn = document.createElement('div');
    turn.className = 'ask-turn ask-answer';
    turn.innerHTML = '<div class="ask-answer-body markdown"></div><div class="ask-meta">正在思考…</div>';
    this.thread.append(turn);
    const request = crypto.randomUUID();
    this.active = { request, question, quote, answer: '', label: '', turn, frame: 0, stopped: false,
      body: turn.querySelector('.ask-answer-body')!, meta: turn.querySelector('.ask-meta')! };
    this.input.value = '';
    this.attach('');
    this.setBusy(true);
    this.reveal(turn);
    try {
      const started = await call<{ agent: AgentId; label: string }>('agent.ask', { request, agent, model, prompt });
      if (this.active?.request === request) {
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
    active.body.innerHTML = renderMarkdown(active.answer);
    this.active = null;
    this.setBusy(false);
    if (!active.answer.trim()) {
      // Nothing to keep: a stop before the first word leaves no turn behind.
      active.turn.previousElementSibling?.remove();
      active.turn.remove();
      if (!this.history.length) this.renderEmpty();
      return;
    }
    this.history.push({ role: 'user', text: active.question, quote: active.quote || undefined },
      { role: 'assistant', text: stopped ? `${active.answer}\n（回答被读者中途停止）` : active.answer });
    active.meta.replaceChildren();
    const label = document.createElement('span');
    label.textContent = `${active.label || 'AI'}${stopped ? ' · 已停止' : ''}`;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'text-button ask-copy';
    copy.textContent = '复制';
    copy.onclick = () => call('copy', { text: active.answer }).then(() => toast('已复制回答', 'success'), error => toast(errorMessage(error), 'error'));
    active.meta.append(label, copy);
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
      // The failed exchange never entered the history; ask it again in its place.
      active.turn.previousElementSibling?.remove();
      active.turn.remove();
      if (!this.history.length) this.renderEmpty();
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

  private setBusy(busy: boolean): void {
    this.send.innerHTML = icon(busy ? 'stop' : 'arrow-up');
    this.send.setAttribute('aria-label', busy ? '停止回答' : '发送');
    this.send.title = busy ? '停止回答' : '发送';
    this.root.dataset.busy = String(busy);
  }

  /** Keeps the newest answer in view while it streams, unless the reader scrolled up. */
  private reveal(turn: HTMLElement, streaming = false): void {
    const scroller = this.root.closest<HTMLElement>('.toc-scroll');
    if (!scroller) return;
    const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
    if (!streaming || nearBottom) turn.scrollIntoView({ block: 'nearest' });
  }
}
