import { clip, newId, safeJson, sleep } from './util.js';

export const LIVE = new Set(['queued', 'running', 'asking', 'waiting']);
export const FINISHED = new Set(['done', 'failed', 'stopped']);

/** Control tools every hand has. Their effects live in Hand#control. */
export const CONTROL_TOOLS = [
  {
    name: 'say',
    description: 'Tell the user something now (a short progress update) and keep working. Your final reply (a message with no tool calls) ends this item, so do not use say for the final answer.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'ask',
    description: 'Ask the user a question you need answered to continue. You will get their answer as the result of this call.',
    parameters: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
  },
  {
    name: 'wait',
    description: 'Pause this item for up to `seconds` (for example while something external finishes). A new message from the user about this item ends the wait early.',
    parameters: { type: 'object', properties: { seconds: { type: 'number' }, reason: { type: 'string' } }, required: ['seconds'] },
  },
];
const CONTROL = new Set(CONTROL_TOOLS.map((t) => t.name));

export class Hand {
  /** @param {object} init  @param {object} rt  runtime services (see Runtime#services) */
  constructor(init, rt) {
    this.rt = rt;
    this.id = init.id ?? newId('h');
    this.title = init.title;
    this.goal = init.goal ?? '';
    this.state = init.state ?? 'queued';
    this.transcript = init.transcript ?? [];
    this.inbox = init.inbox ?? [];            // delivered user messages not yet read: [{id, text}]
    this.question = init.question ?? null;    // {id, text} while asking
    this.createdAt = init.createdAt ?? rt.clock.now();
    this.startedAt = init.startedAt ?? null;
    this.endedAt = init.endedAt ?? null;
    this.lastText = init.lastText ?? '';
    this.lastActiveAt = init.lastActiveAt ?? this.createdAt;
    this.error = init.error ?? null;
    this.messages = init.messages ?? [];      // user message ids placed in this hand
    this.stats = init.stats ?? { modelCalls: 0, toolCalls: 0, lockWaitMs: 0, input: 0, cached: 0, output: 0 };
    this.abort = new AbortController();
    this.wake = null;
    this.running = null;
  }

  view() {
    return {
      id: this.id, title: this.title, goal: this.goal, state: this.state,
      lastText: this.lastText, question: this.question?.text ?? null,
      createdAt: this.createdAt, startedAt: this.startedAt, endedAt: this.endedAt,
      lastActiveAt: this.lastActiveAt, error: this.error, messages: [...this.messages],
      stats: { ...this.stats },
    };
  }

  record() {
    return { ...this.view(), transcript: this.transcript, inbox: this.inbox, question: this.question };
  }

  /** Queue user messages for this hand; they are read at the next step boundary (invariant 5). */
  deliver(messages) {
    for (const m of messages) {
      this.inbox.push({ id: m.id, text: m.text });
      if (!this.messages.includes(m.id)) this.messages.push(m.id);
    }
    this.lastActiveAt = this.rt.clock.now();
    this.rt.persist(this);
    this.wake?.();
  }

  stop(reason = 'stopped by the user') {
    if (FINISHED.has(this.state)) return false;
    this.error = reason;
    this.abort.abort(new Error(reason));
    this.wake?.();
    if (this.state === 'queued') this.#finish('stopped');
    return true;
  }

  /** A finished hand can be continued with its transcript (and cache) intact. */
  reopen() {
    if (!FINISHED.has(this.state)) return;
    this.abort = new AbortController();
    this.error = null;
    this.endedAt = null;
    this.state = 'queued';
  }

  start() {
    if (this.running) return this.running;
    this.running = this.#loop().finally(() => { this.running = null; });
    return this.running;
  }

  #setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.lastActiveAt = this.rt.clock.now();
    this.rt.persist(this);
    this.rt.changed(this);
  }

  #finish(state) {
    this.endedAt = this.rt.clock.now();
    this.question = null;
    this.#setState(state);
  }

  #drainInbox() {
    if (!this.inbox.length) return [];
    const items = this.inbox.splice(0);
    const text = items.length === 1
      ? `New message from the user [${items[0].id}]: ${items[0].text}`
      : 'New messages from the user:\n' + items.map((m) => `[${m.id}] ${m.text}`).join('\n');
    this.transcript.push({ role: 'user', content: text });
    return items;
  }

  /** Resolves when a message is delivered, the timeout passes or the hand is stopped. */
  #waitForInbox(ms) {
    if (this.inbox.length || this.abort.signal.aborted) return Promise.resolve('message');
    return new Promise((resolve) => {
      const timer = Number.isFinite(ms) ? setTimeout(() => { this.wake = null; resolve('timeout'); }, ms) : null;
      this.wake = () => { if (timer) clearTimeout(timer); this.wake = null; resolve('message'); };
    });
  }

  async #loop() {
    const { config } = this.rt;
    this.startedAt ??= this.rt.clock.now();
    let nudged = false;
    try {
      await this.#repairDangling();
      this.#setState('running');
      for (;;) {
        this.#throwIfStopped();
        this.#drainInbox();
        const budgetLeft = config.maxSteps - this.stats.modelCalls;
        if (budgetLeft <= 0) {
          this.transcript.push({ role: 'user', content: 'Step budget reached. Give your final reply to the user now, without tools: what is done, what is not.' });
        }
        const res = await this.#callModel(budgetLeft <= 0 ? 'none' : 'auto');
        const calls = budgetLeft <= 0 ? [] : (res.calls ?? []);
        this.transcript.push({
          role: 'assistant',
          content: res.text || null,
          ...(calls.length && {
            tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {}) } })),
          }),
        });
        this.rt.persist(this); // a crash from here on leaves a dangling call that #repairDangling answers
        if (calls.length) {
          if (res.text?.trim()) this.rt.publish(this, 'say', res.text.trim());
          for (const call of calls) {
            const content = await this.#runTool(call);
            this.transcript.push({ role: 'tool', tool_call_id: call.id, content });
            this.rt.persist(this);
            this.#throwIfStopped();
          }
          continue;
        }
        if (res.text?.trim()) {
          this.rt.publish(this, 'final', res.text.trim());
        } else if (!nudged && !this.inbox.length) {
          nudged = true;
          this.transcript.push({ role: 'user', content: 'You ended without saying anything. Reply to the user now.' });
          continue;
        }
        if (this.inbox.length) continue; // messages arrived while it was answering
        this.#finish('done');
        return;
      }
    } catch (error) {
      if (this.abort.signal.aborted) {
        this.#finish('stopped');
      } else {
        this.error = error?.message ?? String(error);
        this.#finish('failed');
        this.rt.failed(this, error);
      }
    }
  }

  /** After a restart the transcript may end in tool calls without results; never send that to a model. */
  async #repairDangling() {
    const last = this.transcript.at(-1);
    if (last?.role !== 'assistant' || !last.tool_calls?.length) {
      // a restart mid-batch can leave some results missing
      const idx = this.transcript.findLastIndex((m) => m.role === 'assistant' && m.tool_calls?.length);
      if (idx < 0) return;
      const done = new Set(this.transcript.slice(idx + 1).filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
      const missing = this.transcript[idx].tool_calls.filter((c) => !done.has(c.id));
      if (!missing.length || this.transcript.slice(idx + 1).some((m) => m.role !== 'tool')) return;
      return this.#answerDangling(missing);
    }
    return this.#answerDangling(last.tool_calls);
  }

  async #answerDangling(calls) {
    for (const c of calls) {
      let content = 'interrupted by a restart; check the current state before retrying';
      if (c.function?.name === 'ask' && this.state === 'asking') {
        await this.#waitForInbox(Infinity);
        this.#throwIfStopped();
        const answers = this.inbox.splice(0);
        this.question = null;
        content = 'The user answered: ' + answers.map((m) => `[${m.id}] ${m.text}`).join('\n');
      }
      this.transcript.push({ role: 'tool', tool_call_id: c.id, content });
    }
  }

  #throwIfStopped() {
    if (this.abort.signal.aborted) throw this.abort.signal.reason ?? new Error('stopped');
  }

  async #callModel(toolChoice) {
    const { config, model } = this.rt;
    let lastError;
    for (let attempt = 0; attempt <= config.modelRetries; attempt++) {
      this.#throwIfStopped();
      try {
        const res = await model.complete({
          system: this.rt.handSystem,
          messages: this.transcript,
          tools: this.rt.toolDefs,
          toolChoice,
          signal: this.abort.signal,
          meta: { kind: 'hand', hand: this.id, title: this.title },
        });
        this.stats.modelCalls++;
        this.stats.input += res.usage?.input ?? 0;
        this.stats.cached += res.usage?.cached ?? 0;
        this.stats.output += res.usage?.output ?? 0;
        this.lastActiveAt = this.rt.clock.now();
        return res;
      } catch (error) {
        if (this.abort.signal.aborted) throw error;
        lastError = error;
        if (attempt < config.modelRetries) await sleep(config.retryDelayMs * (attempt + 1), this.abort.signal);
      }
    }
    throw lastError;
  }

  async #runTool(call) {
    this.stats.toolCalls++;
    let args = call.arguments;
    if (typeof args === 'string') {
      try { args = args.trim() ? JSON.parse(args) : {}; } catch { return safeJson({ error: `arguments are not valid JSON: ${clip(args, 200)}` }); }
    }
    args ??= {};
    if (CONTROL.has(call.name)) return this.#control(call.name, args);
    const tool = this.rt.tools.get(call.name);
    if (!tool) return safeJson({ error: `no tool named ${call.name}` });
    const names = (() => { try { return tool.resources?.(args) ?? []; } catch { return []; } })();
    let lock;
    try {
      lock = await this.rt.locks.acquire(names, this.id, this.abort.signal);
    } catch (error) {
      this.#throwIfStopped();
      return safeJson({ error: `could not get ${names.join(', ')}: ${error.message}` });
    }
    this.stats.lockWaitMs += lock.waitedMs;
    let out;
    try {
      out = await tool.run(args, {
        hand: this.view(),
        signal: this.abort.signal,
        say: (text) => this.rt.publish(this, 'say', String(text)),
      });
    } catch (error) {
      this.#throwIfStopped();
      out = { error: error?.message ?? String(error) };
    } finally {
      lock.release();
    }
    let content = clip(safeJson(out ?? { ok: true }), this.rt.config.toolResultChars);
    if (lock.waitedMs > 1000) content = `(waited ${Math.round(lock.waitedMs / 1000)}s for ${names.join(', ')}, another item was using it)\n` + content;
    return content;
  }

  async #control(name, args) {
    if (name === 'say') {
      this.rt.publish(this, 'say', String(args.text ?? ''));
      return 'said';
    }
    if (name === 'ask') {
      const entry = this.rt.publish(this, 'ask', String(args.question ?? ''));
      this.question = { id: entry.id, text: entry.text };
      this.#setState('asking');
      await this.#waitForInbox(Infinity);
      this.#throwIfStopped();
      const answers = this.inbox.splice(0);
      this.question = null;
      this.#setState('running');
      return 'The user answered: ' + answers.map((m) => `[${m.id}] ${m.text}`).join('\n');
    }
    if (name === 'wait') {
      const ms = Math.max(0, Math.min(Number(args.seconds) || 0, this.rt.config.maxWaitSeconds)) * 1000;
      this.#setState('waiting');
      const why = await this.#waitForInbox(ms);
      this.#throwIfStopped();
      this.#setState('running');
      return why === 'message' ? 'woken early: the user sent a message about this item' : `waited ${ms / 1000}s`;
    }
    return safeJson({ error: `unknown control tool ${name}` });
  }
}
