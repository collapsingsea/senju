import { Emitter, clip, newId, systemClock } from './util.js';
import { LockManager } from './locks.js';
import { Timeline } from './timeline.js';
import { MemoryStore } from './store/memory.js';
import { CONTROL_TOOLS, FINISHED, Hand, LIVE } from './hand.js';
import { buildDispatchRequest, repairPlacements } from './dispatch.js';

export const HAND_INSTRUCTIONS = `You are handling one item of this conversation. Other items may be running at the same time; you only handle yours, the rest are taken care of.
- Talk to the user directly. Your final reply (a message without tool calls) ends this item, so make it the answer or the result.
- If this is just conversation or a question you can answer, reply right away without tools.
- During long work use say for a short progress update, ask when you need a decision from the user, and wait to pause.
- When the user sends more messages about this item they appear in your conversation as they arrive. Take them into account.`;

const DEFAULTS = {
  maxLive: 4,               // hands running at once; more are queued
  debounceMs: 250,          // collect messages typed in quick succession
  maxSteps: 40,             // model calls per hand before it must wrap up
  modelRetries: 2,
  retryDelayMs: 1000,
  maxWaitSeconds: 600,
  toolResultChars: 8000,
  tailLines: 8,             // timeline lines shown to dispatch and to new hands
  recentFinished: 3,        // finished hands shown to dispatch (they can be continued)
  reopenWindowMs: 10 * 60 * 1000,
  fastPath: true,           // nothing live or recently finished: skip the dispatch model call
  labelPrefix: null,        // (label, text) => text, applied while 2+ hands are live
};

export class Runtime extends Emitter {
  /**
   * @param {object} opts
   * @param {{complete: Function}} opts.model
   * @param {string} opts.persona
   * @param {Array<{name, description, parameters, run, resources?}>} [opts.tools]
   */
  constructor({ model, persona, tools = [], store = new MemoryStore(), clock = systemClock, handInstructions = HAND_INSTRUCTIONS, ...config }) {
    super();
    if (!model?.complete) throw new TypeError('model.complete is required');
    if (typeof persona !== 'string') throw new TypeError('persona must be a string');
    this.model = model;
    this.persona = persona;
    this.store = store;
    this.clock = clock;
    this.config = { ...DEFAULTS, ...config };
    this.locks = new LockManager();
    this.tools = new Map();
    for (const t of tools) {
      if (CONTROL_TOOLS.some((c) => c.name === t.name)) throw new Error(`tool name ${t.name} is reserved`);
      this.tools.set(t.name, t);
    }
    this.toolDefs = [...CONTROL_TOOLS, ...tools].map(({ name, description, parameters }) => ({ name, description, parameters }));
    this.handSystem = `${persona}\n\n${handInstructions}`;
    this.timeline = new Timeline(store);
    this.hands = new Map();
    this.metrics = new Map();
    this.pending = [];
    this.flushTimer = null;
    this.dispatching = Promise.resolve();
    this.dispatchBusy = 0;
    this.dispatchStats = { modelCalls: 0, input: 0, cached: 0, output: 0 };
    this.idleWaiters = [];
    this.closed = false;
  }

  /* ----------------------------------------------------------- public API */

  /** A user message arrives. Returns its timeline entry immediately. */
  receive({ text, id, replyTo, from } = {}) {
    if (this.closed) throw new Error('runtime is closed');
    const entry = this.timeline.append({ id: id ?? newId('m'), at: this.clock.now(), kind: 'user', text: String(text ?? ''), ...(replyTo && { replyTo }), ...(from && { from }) });
    this.#metric(entry.id, { message: entry.id, receivedAt: entry.at });
    this.pending.push(entry);
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.#flush(), this.config.debounceMs);
    this.emit('message', { entry });
    return entry;
  }

  /** Start a hand directly (host-initiated work, or spawning from a tool). */
  spawn({ title, goal = '', messages = [] }) {
    const hand = new Hand({ title: clip(title || goal || 'task', 40), goal }, this.#services());
    this.hands.set(hand.id, hand);
    hand.transcript.push({ role: 'user', content: this.#brief(hand, messages) });
    for (const m of messages) {
      hand.messages.push(m.id);
      this.#metric(m.id, { placedAt: this.clock.now(), placement: { action: 'new', hand: hand.id } });
    }
    this.persist(hand);
    this.emit('hand', { hand: hand.view(), event: 'created' });
    this.#schedule(hand);
    return hand.view();
  }

  stop(handId, reason) {
    const hand = this.hands.get(handId);
    if (!hand) return false;
    const ok = hand.stop(reason);
    if (ok) {
      this.#note(`stopped: ${hand.title}`, hand);
      this.#firstResponse(hand.messages);
    }
    return ok;
  }

  board({ includeFinished = false } = {}) {
    return [...this.hands.values()].filter((h) => includeFinished || LIVE.has(h.state)).map((h) => h.view());
  }

  hand(id) { return this.hands.get(id)?.view() ?? null; }

  /** Per-message latency and placement records. */
  messageMetrics() { return [...this.metrics.values()].map((m) => ({ ...m })); }

  usage() {
    const total = { ...this.dispatchStats, handModelCalls: 0 };
    for (const h of this.hands.values()) {
      total.handModelCalls += h.stats.modelCalls;
      total.input += h.stats.input; total.cached += h.stats.cached; total.output += h.stats.output;
    }
    total.dispatchModelCalls = this.dispatchStats.modelCalls;
    delete total.modelCalls;
    return total;
  }

  /** Resolves when nothing is pending, dispatching or live. */
  idle() {
    if (this.#isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Reload timeline, hands and metrics from the store and resume unfinished hands. */
  async restore() {
    const data = await this.store.load();
    this.timeline = new Timeline(this.store, data.timeline ?? []);
    for (const m of data.metrics ?? []) this.metrics.set(m.message, m);
    for (const rec of data.hands ?? []) {
      const hand = new Hand(rec, this.#services());
      this.hands.set(hand.id, hand);
    }
    for (const hand of this.hands.values()) {
      if (hand.state === 'asking') hand.start(); // waits for the user's answer, which dispatch joins to it
      else if (LIVE.has(hand.state)) { hand.state = 'queued'; this.#schedule(hand); }
    }
  }

  async close() {
    this.closed = true;
    clearTimeout(this.flushTimer);
    for (const h of this.hands.values()) h.stop('runtime closed');
    await Promise.allSettled([...this.hands.values()].map((h) => h.running));
  }

  /* ------------------------------------------------------------ dispatch */

  #flush() {
    if (!this.pending.length) return;
    const batch = this.pending.splice(0);
    this.dispatchBusy++;
    this.dispatching = this.dispatching
      .then(() => this.#dispatch(batch))
      .catch((error) => this.emit('error', { where: 'dispatch', error }))
      .finally(() => { this.dispatchBusy--; this.#checkIdle(); });
  }

  async #dispatch(messages) {
    const now = this.clock.now();
    const live = [...this.hands.values()].filter((h) => LIVE.has(h.state));
    const recent = [...this.hands.values()]
      .filter((h) => FINISHED.has(h.state) && now - (h.endedAt ?? 0) < this.config.reopenWindowMs)
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
      .slice(0, this.config.recentFinished);

    // Answer path: an explicit reply to an open question.
    if (messages.length === 1 && messages[0].replyTo) {
      const asker = live.find((h) => h.question?.id === messages[0].replyTo);
      if (asker) return this.#apply([{ message: messages[0].id, action: 'join', hand: asker.id }], messages, { path: 'answer' });
    }
    // Fast path: nothing to relate to, so it is new work (or plain conversation the hand answers).
    if (this.config.fastPath && !live.length && !recent.length) {
      return this.#apply(this.#groupNew(messages), messages, { path: 'fast' });
    }

    const req = buildDispatchRequest({
      persona: this.persona,
      board: live.map((h) => h.view()),
      recent: recent.map((h) => h.view()),
      tail: this.timeline.tail(this.config.tailLines + messages.length).filter((e) => !messages.some((m) => m.id === e.id)).slice(-this.config.tailLines),
      messages,
      now,
    });
    let raw = [];
    try {
      const res = await this.model.complete({ ...req, signal: AbortSignal.timeout(60000), meta: { kind: 'dispatch' } });
      this.dispatchStats.modelCalls++;
      this.dispatchStats.input += res.usage?.input ?? 0;
      this.dispatchStats.cached += res.usage?.cached ?? 0;
      this.dispatchStats.output += res.usage?.output ?? 0;
      const call = (res.calls ?? []).find((c) => c.name === 'place');
      const args = typeof call?.arguments === 'string' ? JSON.parse(call.arguments || '{}') : call?.arguments;
      raw = args?.placements ?? [];
    } catch (error) {
      this.emit('error', { where: 'dispatch-model', error });
    }
    const fallbackHand = [...live].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0] ?? null;
    const { placements, repaired } = repairPlacements(raw, { messages, hands: [...live, ...recent], fallbackHand });
    return this.#apply(placements, messages, { path: 'model', repaired });
  }

  #groupNew(messages) {
    const title = clip(messages[0].text, 40);
    return messages.map((m) => ({ message: m.id, action: 'new', title, goal: '', group: 'fast' }));
  }

  #apply(placements, messages, { path, repaired = [] }) {
    const byId = new Map(messages.map((m) => [m.id, m]));
    const now = this.clock.now();
    for (const p of placements) {
      this.#metric(p.message, {
        placedAt: now, path,
        placement: { action: p.action, ...(p.hand && { hand: p.hand }) },
        repaired: repaired.filter((r) => r.message === p.message).map((r) => r.kind),
      });
    }
    this.emit('placement', { placements, path, repaired });

    // new: merge messages that start the same new item (same title, or the fast path's single group)
    const groups = new Map();
    for (const p of placements.filter((x) => x.action === 'new')) {
      const key = p.group ?? p.title;
      if (!groups.has(key)) groups.set(key, { title: p.title, goal: p.goal, messages: [] });
      groups.get(key).messages.push(byId.get(p.message));
    }
    for (const g of groups.values()) {
      const view = this.spawn({ title: g.title, goal: g.goal, messages: g.messages });
      for (const m of g.messages) this.#metric(m.id, { placement: { action: 'new', hand: view.id } });
    }
    // join: deliver (continue finished ones)
    const joins = new Map();
    for (const p of placements.filter((x) => x.action === 'join')) {
      if (!joins.has(p.hand)) joins.set(p.hand, []);
      joins.get(p.hand).push(byId.get(p.message));
    }
    for (const [handId, msgs] of joins) {
      const hand = this.hands.get(handId);
      if (FINISHED.has(hand.state)) {
        hand.reopen();
        hand.deliver(msgs);
        this.emit('hand', { hand: hand.view(), event: 'reopened' });
        this.#schedule(hand);
      } else {
        hand.deliver(msgs);
      }
    }
    for (const p of placements.filter((x) => x.action === 'stop')) {
      this.stop(p.hand, 'stopped by the user');
      if (p.text) this.#utter(null, 'reply', p.text, [p.message]);
      else this.#firstResponse([p.message]);
    }
    for (const p of placements.filter((x) => x.action === 'reply')) this.#utter(null, 'reply', p.text, [p.message]);
  }

  /* --------------------------------------------------------------- hands */

  #brief(hand, messages) {
    const tail = this.timeline.tail(this.config.tailLines + messages.length).filter((e) => !messages.some((m) => m.id === e.id)).slice(-this.config.tailLines);
    const parts = [];
    if (tail.length) parts.push('Recent conversation:\n' + Timeline.render(tail));
    parts.push(`You are now handling: "${hand.title}" (item ${hand.id}).`);
    if (hand.goal) parts.push(`Goal: ${hand.goal}`);
    if (messages.length) parts.push((messages.length === 1 ? 'Message from the user' : 'Messages from the user') + ':\n' + messages.map((m) => `[${m.id}] ${m.text}`).join('\n'));
    return parts.join('\n\n');
  }

  #schedule(hand) {
    if (hand.state !== 'queued') return;
    // a hand holds a slot while its loop runs, except while it waits for the user's answer
    const running = [...this.hands.values()].filter((h) => h !== hand && h.running && LIVE.has(h.state) && h.state !== 'asking').length;
    if (running >= this.config.maxLive) return; // started by #startQueued when a slot frees
    hand.start();
  }

  #startQueued() {
    for (const hand of [...this.hands.values()].filter((h) => h.state === 'queued').sort((a, b) => a.createdAt - b.createdAt)) this.#schedule(hand);
  }

  #services() {
    const rt = this;
    return {
      get clock() { return rt.clock; },
      get config() { return rt.config; },
      get model() { return rt.model; },
      get tools() { return rt.tools; },
      get toolDefs() { return rt.toolDefs; },
      get handSystem() { return rt.handSystem; },
      get locks() { return rt.locks; },
      persist: (hand) => rt.persist(hand),
      publish: (hand, kind, text) => rt.#utter(hand, kind, text),
      changed: (hand) => {
        rt.emit('hand', { hand: hand.view(), event: 'state' });
        if (FINISHED.has(hand.state) || hand.state === 'asking') rt.#startQueued();
        if (FINISHED.has(hand.state) || hand.state === 'asking') rt.#checkIdle();
      },
      failed: (hand, error) => rt.emit('error', { where: 'hand', hand: hand.id, error }),
    };
  }

  persist(hand) { this.store.putHand(hand.record()); }

  /* ------------------------------------------------------------ speaking */

  #utter(hand, kind, text, messageIds) {
    const liveCount = [...this.hands.values()].filter((h) => LIVE.has(h.state)).length;
    const label = hand && liveCount > 1 ? hand.title : undefined;
    const shown = label && this.config.labelPrefix ? this.config.labelPrefix(label, text) : text;
    const entry = this.timeline.append({
      id: newId(kind === 'ask' ? 'q' : 'u'), at: this.clock.now(), kind, text: shown,
      ...(hand && { hand: hand.id }), ...(label && { label }),
    });
    if (hand) { hand.lastText = text; hand.lastActiveAt = entry.at; this.persist(hand); }
    this.#firstResponse(messageIds ?? hand?.messages ?? [], entry.at);
    this.emit('utterance', { entry });
    return entry;
  }

  #note(text, hand) {
    const entry = this.timeline.append({ id: newId('n'), at: this.clock.now(), kind: 'note', text, ...(hand && { hand: hand.id }) });
    this.emit('utterance', { entry });
  }

  #firstResponse(messageIds, at = this.clock.now()) {
    for (const id of messageIds) {
      const m = this.metrics.get(id);
      if (m && m.firstResponseAt == null) this.#metric(id, { firstResponseAt: at, firstResponseMs: at - m.receivedAt });
    }
  }

  #metric(id, patch) {
    const next = { ...(this.metrics.get(id) ?? { message: id }), ...patch };
    this.metrics.set(id, next);
    this.store.putMetric(next);
  }

  /* ---------------------------------------------------------------- idle */

  #isIdle() {
    return !this.pending.length && !this.dispatchBusy && ![...this.hands.values()].some((h) => LIVE.has(h.state) && h.state !== 'asking');
  }

  #checkIdle() {
    if (!this.#isIdle()) return;
    for (const r of this.idleWaiters.splice(0)) r();
  }
}

export function createRuntime(opts) {
  return new Runtime(opts);
}
