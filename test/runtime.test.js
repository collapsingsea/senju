import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, place, messageIds } from '../src/index.js';
import { gate, lastUser, makeRuntime, said, until } from './helpers.js';

test('fast path: first message starts a hand without a dispatch call', async () => {
  const { rt, model } = makeRuntime((req) => ({ text: `hi! (${lastUser(req).includes('hello') ? 'got it' : '?'})` }));
  const m = rt.receive({ text: 'hello' });
  await rt.idle();
  assert.equal(model.requests.filter((r) => r.meta.kind === 'dispatch').length, 0);
  assert.deepEqual(said(rt).map((e) => [e.kind, e.text]), [['final', 'hi! (got it)']]);
  const metric = rt.messageMetrics().find((x) => x.message === m.id);
  assert.equal(metric.path, 'fast');
  assert.equal(metric.placement.action, 'new');
  assert.ok(metric.firstResponseMs >= 0);
  assert.equal(rt.board({ includeFinished: true })[0].state, 'done');
});

test('messages typed in quick succession start one hand', async () => {
  const { rt } = makeRuntime((req) => ({ text: lastUser(req).split('\n').filter((l) => l.startsWith('[')).length + ' messages' }));
  rt.receive({ text: 'book a table' });
  rt.receive({ text: 'for two' });
  rt.receive({ text: 'at 7pm' });
  await rt.idle();
  assert.equal(rt.board({ includeFinished: true }).length, 1);
  assert.equal(said(rt)[0].text, '3 messages');
});

test('join: a message for a busy hand is read at its next step, not lost or duplicated', async () => {
  const g = gate();
  const tools = [{ name: 'render', description: 'render', parameters: { type: 'object' }, run: async () => { await g.wait(); return { ok: true }; } }];
  let handCalls = 0;
  const { rt, model } = makeRuntime((req) => {
    if (req.meta.kind === 'dispatch') {
      const [id] = messageIds(req);
      return place([{ message: id, action: 'join', hand: rt.board()[0].id }]);
    }
    handCalls++;
    if (handCalls === 1) return call('render');
    return { text: lastUser(req).includes('make it blue') ? 'rendered in blue' : 'rendered' };
  }, { tools });
  rt.receive({ text: 'draw a logo' });
  await until(() => rt.board()[0]?.state === 'running' && handCalls === 1, 2000, 'render running');
  rt.receive({ text: 'make it blue' });
  await until(() => rt.messageMetrics().every((m) => m.placedAt), 2000, 'placement');
  g.open();
  await rt.idle();
  assert.deepEqual(said(rt).map((e) => e.text), ['rendered in blue']);
  const hand = rt.board({ includeFinished: true })[0];
  assert.equal(hand.messages.length, 2);
  // the second message reached the transcript exactly once
  const last = model.requests.filter((r) => r.meta.kind === 'hand').at(-1);
  assert.equal(last.messages.filter((m) => m.role === 'user' && m.content.includes('make it blue')).length, 1);
});

test('new: an unrelated message runs in parallel; utterances carry labels while 2+ are live', async () => {
  const g = gate();
  const tools = [{ name: 'slow', description: 'slow', parameters: { type: 'object' }, run: () => g.wait() }];
  const { rt } = makeRuntime((req) => {
    if (req.meta.kind === 'dispatch') return place([{ message: messageIds(req)[0], action: 'new', title: 'weather', goal: 'weather today' }]);
    if (req.meta.title === 'weather') return { text: 'sunny' };
    return req.messages.some((m) => m.role === 'tool') ? { text: 'report ready' } : call('slow');
  }, { tools, labelPrefix: (label, text) => `[${label}] ${text}` });
  rt.receive({ text: 'write the report' });
  await until(() => rt.board()[0]?.state === 'running', 2000);
  rt.receive({ text: 'how is the weather?' });
  await until(() => said(rt).length === 1, 2000, 'weather answer');
  assert.deepEqual(said(rt)[0], { ...said(rt)[0], kind: 'final', label: 'weather', text: '[weather] sunny' });
  g.open();
  await rt.idle();
  const report = said(rt)[1];
  assert.equal(report.text, 'report ready'); // only one live hand by then: no label
  assert.equal(report.label, undefined);
});

test('reply: dispatch answers a status question directly without disturbing the hand', async () => {
  const g = gate();
  const tools = [{ name: 'slow', description: 'slow', parameters: { type: 'object' }, run: () => g.wait() }];
  const { rt, model } = makeRuntime((req) => {
    if (req.meta.kind === 'dispatch') return place([{ message: messageIds(req)[0], action: 'reply', text: 'still rendering, about a minute' }]);
    return req.messages.some((m) => m.role === 'tool') ? { text: 'done' } : call('slow');
  }, { tools });
  rt.receive({ text: 'render the video' });
  await until(() => rt.board()[0]?.state === 'running', 2000);
  const before = model.requests.length;
  const q = rt.receive({ text: 'how long?' });
  await until(() => said(rt).length === 1, 2000);
  assert.equal(said(rt)[0].kind, 'reply');
  assert.equal(model.requests.length, before + 1); // just the dispatch call
  assert.ok(rt.messageMetrics().find((m) => m.message === q.id).firstResponseMs >= 0);
  g.open();
  await rt.idle();
  assert.deepEqual(said(rt).map((e) => e.text), ['still rendering, about a minute', 'done']);
});

test('stop: aborts the hand mid-tool, releases its locks, acknowledges once', async () => {
  let aborted = false;
  const tools = [{
    name: 'type', description: 'type', parameters: { type: 'object' }, resources: () => ['pc.input'],
    run: (_a, { signal }) => new Promise((_r, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); })),
  }];
  const { rt } = makeRuntime((req) => {
    if (req.meta.kind === 'dispatch') return place([{ message: messageIds(req)[0], action: 'stop', hand: rt.board()[0].id, text: 'ok, stopped' }]);
    return call('type');
  }, { tools });
  rt.receive({ text: 'fill the form' });
  await until(() => rt.locks.holders()['pc.input'], 2000, 'lock held');
  rt.receive({ text: 'stop that' });
  await rt.idle();
  assert.ok(aborted);
  assert.deepEqual(rt.locks.holders(), {});
  const hand = rt.board({ includeFinished: true })[0];
  assert.equal(hand.state, 'stopped');
  assert.deepEqual(said(rt).map((e) => [e.kind, e.text]), [['note', 'stopped: fill the form'], ['reply', 'ok, stopped']]);
});

test('exclusive resources are serialized across hands and the wait is reported', async () => {
  let inUse = 0, maxInUse = 0;
  const tools = [{
    name: 'click', description: 'click', parameters: { type: 'object' }, resources: () => ['pc.input'],
    run: async () => { inUse++; maxInUse = Math.max(maxInUse, inUse); await new Promise((r) => setTimeout(r, 30)); inUse--; return 'clicked'; },
  }];
  const { rt } = makeRuntime((req) => {
    if (req.meta.kind === 'dispatch') return place([{ message: messageIds(req)[0], action: 'new', title: 'second' }]);
    return req.messages.some((m) => m.role === 'tool') ? { text: 'ok' } : call('click');
  }, { tools });
  rt.receive({ text: 'first' });
  await until(() => rt.board()[0]?.state === 'running', 2000);
  rt.receive({ text: 'second' });
  await rt.idle();
  assert.equal(maxInUse, 1);
  const waited = rt.board({ includeFinished: true }).reduce((s, h) => s + h.stats.lockWaitMs, 0);
  assert.ok(waited > 0);
});

test('ask: the question is answered by a reply (answer path, no dispatch call)', async () => {
  const { rt, model } = makeRuntime((req) => {
    const tool = req.messages.filter((m) => m.role === 'tool').at(-1);
    if (!tool) return call('ask', { question: 'Which colour?' });
    return { text: `painting it ${tool.content.includes('green') ? 'green' : '?'}` };
  });
  rt.receive({ text: 'paint the wall' });
  await rt.idle(); // asking hands do not keep the runtime busy
  const q = said(rt)[0];
  assert.equal(q.kind, 'ask');
  assert.equal(rt.board()[0].state, 'asking');
  assert.equal(rt.board()[0].question, 'Which colour?');
  rt.receive({ text: 'green', replyTo: q.id });
  await until(() => rt.board().length === 0, 2000);
  assert.equal(said(rt).at(-1).text, 'painting it green');
  assert.equal(model.requests.filter((r) => r.meta.kind === 'dispatch').length, 0);
  assert.equal(rt.messageMetrics().at(-1).path, 'answer');
});

test('join to a finished hand continues it with its transcript', async () => {
  let n = 0;
  const { rt, model } = makeRuntime((req) => {
    if (req.meta.kind === 'dispatch') return place([{ message: messageIds(req)[0], action: 'join', hand: rt.board({ includeFinished: true })[0].id }]);
    return { text: `answer ${++n}` };
  });
  rt.receive({ text: 'translate this' });
  await rt.idle();
  rt.receive({ text: 'shorter please' });
  await rt.idle();
  const hands = rt.board({ includeFinished: true });
  assert.equal(hands.length, 1);
  assert.equal(hands[0].state, 'done');
  const reqs = model.requests.filter((r) => r.meta.kind === 'hand');
  assert.equal(reqs[1].messages[0].content, reqs[0].messages[0].content); // same transcript head
  assert.deepEqual(said(rt).map((e) => e.text), ['answer 1', 'answer 2']);
});

test('hand transcripts are append-only across calls (cache-friendly)', async () => {
  let k = 0;
  const tools = [{ name: 'step', description: 'step', parameters: { type: 'object' }, run: () => ({ k }) }];
  const { rt, model } = makeRuntime(() => (++k < 4 ? { text: 'working…', calls: [{ name: 'step' }] } : { text: 'done' }), { tools });
  rt.receive({ text: 'do four steps' });
  await rt.idle();
  const reqs = model.requests.filter((r) => r.meta.kind === 'hand');
  assert.equal(reqs.length, 4);
  for (let i = 1; i < reqs.length; i++) {
    assert.equal(reqs[i].system, reqs[0].system);
    assert.deepEqual(reqs[i].messages.slice(0, reqs[i - 1].messages.length), reqs[i - 1].messages);
  }
  assert.deepEqual(said(rt).map((e) => e.kind), ['say', 'say', 'say', 'final']);
});

test('dispatch model failure still places every message', async () => {
  const { rt } = makeRuntime((req) => {
    if (req.meta.kind === 'dispatch') throw new Error('provider down');
    return { text: 'ok' };
  }, { reopenWindowMs: 0 });
  rt.receive({ text: 'one' });
  await rt.idle();
  // reopenWindowMs: 0 → no recent hands → fast path again
  rt.receive({ text: 'two' });
  await rt.idle();
  assert.equal(rt.board({ includeFinished: true }).length, 2);
  const errors = [];
  rt.on('error', (e) => errors.push(e.where));
  rt.config.reopenWindowMs = 60000;
  rt.receive({ text: 'three' });
  await rt.idle();
  assert.deepEqual(errors, ['dispatch-model']);
  const m3 = rt.messageMetrics().at(-1);
  assert.equal(m3.placement.action, 'new'); // nothing live to fall back to
  assert.deepEqual(m3.repaired, ['missing']);
  assert.equal(rt.board({ includeFinished: true }).length, 3);
});

test('model errors are retried, then the hand fails with a reason', async () => {
  let calls = 0;
  const { rt } = makeRuntime(() => { calls++; throw new Error('503'); }, { modelRetries: 2 });
  const errors = [];
  rt.on('error', (e) => errors.push(e.where));
  rt.receive({ text: 'go' });
  await rt.idle();
  assert.equal(calls, 3);
  const h = rt.board({ includeFinished: true })[0];
  assert.equal(h.state, 'failed');
  assert.equal(h.error, '503');
  assert.deepEqual(errors, ['hand']);
});

test('step budget forces a final reply', async () => {
  const tools = [{ name: 'spin', description: 'spin', parameters: { type: 'object' }, run: () => 'again' }];
  const { rt, model } = makeRuntime((req) => (req.toolChoice === 'none' ? { text: 'stopping here: partly done' } : call('spin')), { tools, maxSteps: 3 });
  rt.receive({ text: 'loop forever' });
  await rt.idle();
  assert.equal(said(rt).at(-1).text, 'stopping here: partly done');
  assert.equal(model.requests.length, 4);
});

test('maxLive queues extra hands and starts them when a slot frees', async () => {
  const g = gate();
  const tools = [{ name: 'slow', description: 'slow', parameters: { type: 'object' }, run: () => g.wait() }];
  const { rt } = makeRuntime((req) => {
    if (req.meta.kind === 'dispatch') return place(messageIds(req).map((id, i) => ({ message: id, action: 'new', title: `t${Date.now()}${i}` })));
    return req.messages.some((m) => m.role === 'tool') ? { text: 'done' } : call('slow');
  }, { tools, maxLive: 1 });
  rt.receive({ text: 'a' });
  await until(() => rt.board()[0]?.state === 'running', 2000);
  rt.receive({ text: 'b' });
  await until(() => rt.board().length === 2, 2000);
  assert.deepEqual(rt.board().map((h) => h.state).sort(), ['queued', 'running']);
  g.open();
  await rt.idle();
  assert.deepEqual(rt.board({ includeFinished: true }).map((h) => h.state), ['done', 'done']);
});

test('control tools: say publishes and continues; wait is woken early by a message', async () => {
  const { rt } = makeRuntime((req) => {
    if (req.meta.kind === 'dispatch') return place([{ message: messageIds(req)[0], action: 'join', hand: rt.board()[0].id }]);
    const tools = req.messages.filter((m) => m.role === 'tool');
    if (tools.length === 0) return call('say', { text: 'starting the download' });
    if (tools.length === 1) return call('wait', { seconds: 30 });
    return { text: tools[1].content.startsWith('woken early') ? 'you said go, so done' : 'timeout' };
  });
  rt.receive({ text: 'download it' });
  await until(() => rt.board()[0]?.state === 'waiting', 2000);
  rt.receive({ text: 'go ahead' });
  await rt.idle();
  assert.deepEqual(said(rt).map((e) => e.text), ['starting the download', 'you said go, so done']);
});

test('unknown tools and bad JSON come back to the model as errors', async () => {
  const { rt, model } = makeRuntime((req) => {
    const t = req.messages.filter((m) => m.role === 'tool');
    if (!t.length) return { calls: [{ name: 'nope' }, { name: 'say', arguments: '{bad' }] };
    return { text: 'recovered' };
  });
  rt.receive({ text: 'x' });
  await rt.idle();
  const tool = model.requests.at(-1).messages.filter((m) => m.role === 'tool').map((m) => m.content);
  assert.match(tool[0], /no tool named nope/);
  assert.match(tool[1], /not valid JSON/);
  assert.equal(said(rt).at(-1).text, 'recovered');
});

test('reserved tool names are rejected', () => {
  assert.throws(() => makeRuntime(() => ({}), { tools: [{ name: 'ask', run() {} }] }), /reserved/);
});

test('dispatch model failure while a hand is live joins the most recently active one', async () => {
  const g = gate();
  const tools = [{ name: 'slow', description: 'slow', parameters: { type: 'object' }, run: () => g.wait() }];
  const { rt, model } = makeRuntime((req) => {
    if (req.meta.kind === 'dispatch') return { text: 'I think it is new' }; // no tool call at all
    return req.messages.some((m) => m.role === 'tool') ? { text: lastUser(req).includes('also') ? 'done, with the extra' : 'done' } : call('slow');
  }, { tools });
  rt.receive({ text: 'clean the folder' });
  await until(() => rt.board()[0]?.state === 'running', 2000);
  rt.receive({ text: 'also empty the bin' });
  await until(() => rt.messageMetrics().every((m) => m.placedAt), 2000);
  g.open();
  await rt.idle();
  assert.equal(rt.board({ includeFinished: true }).length, 1);
  assert.equal(said(rt).at(-1).text, 'done, with the extra');
  assert.deepEqual(rt.messageMetrics().at(-1).repaired, ['missing']);
  assert.equal(model.requests.filter((r) => r.meta.kind === 'dispatch').length, 1);
});
