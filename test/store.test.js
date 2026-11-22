import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlStore, Runtime, scripted, call, messageIds, place } from '../src/index.js';
import { said, until } from './helpers.js';

const persona = 'You are Tess.';

test('jsonl store round-trips timeline, hands and metrics (last write wins)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mh-'));
  const rt = new Runtime({ model: scripted(() => ({ text: 'hi' })), persona, store: new JsonlStore(dir), debounceMs: 1 });
  rt.receive({ text: 'hello' });
  await rt.idle();
  appendFileSync(join(dir, 'timeline.jsonl'), '{"torn":'); // a crash mid-write
  const data = new JsonlStore(dir).load();
  assert.deepEqual(data.timeline.map((e) => e.kind), ['user', 'final']);
  assert.equal(data.hands.length, 1);
  assert.equal(data.hands[0].state, 'done');
  assert.ok(data.metrics[0].firstResponseAt);
});

test('restore resumes an interrupted hand; dangling tool calls get a result first', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mh-'));
  const never = new Promise(() => {});
  const tools = [{ name: 'deploy', description: 'deploy', parameters: { type: 'object' }, run: () => never }];
  const a = new Runtime({ model: scripted(() => call('deploy')), persona, tools, store: new JsonlStore(dir), debounceMs: 1 });
  a.receive({ text: 'deploy the site' });
  await until(() => a.board()[0]?.stats.toolCalls === 1, 2000);
  // simulate a crash: drop runtime `a` without closing it

  const model = scripted((req) => {
    const last = req.messages.at(-1);
    return { text: last.role === 'tool' && last.content.includes('interrupted') ? 'the deploy was interrupted; checking and redoing it' : '?' };
  });
  const b = new Runtime({ model, persona, tools, store: new JsonlStore(dir), debounceMs: 1 });
  await b.restore();
  await b.idle();
  assert.equal(said(b).at(-1).text, 'the deploy was interrupted; checking and redoing it');
  const req = model.requests[0];
  const asst = req.messages.findIndex((m) => m.tool_calls);
  assert.equal(req.messages[asst + 1].role, 'tool'); // never sends unanswered tool calls
  assert.equal(b.board({ includeFinished: true })[0].state, 'done');
});

test('restore keeps an asking hand waiting; the answer reaches it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mh-'));
  const a = new Runtime({ model: scripted(() => call('ask', { question: 'which day?' })), persona, store: new JsonlStore(dir), debounceMs: 1 });
  a.receive({ text: 'book a flight' });
  await until(() => a.board()[0]?.state === 'asking', 2000);

  const model = scripted((req) => {
    if (req.meta.kind === 'dispatch') return place([{ message: messageIds(req)[0], action: 'join', hand: b.board()[0].id }]);
    const t = req.messages.filter((m) => m.role === 'tool').at(-1);
    return { text: t?.content.includes('friday') ? 'booked for friday' : '?' };
  });
  const b = new Runtime({ model, persona, store: new JsonlStore(dir), debounceMs: 1 });
  await b.restore();
  assert.equal(b.board()[0].state, 'asking');
  const q = said(b).find((e) => e.kind === 'ask');
  b.receive({ text: 'friday', replyTo: q.id });
  await until(() => b.board().length === 0, 2000);
  assert.equal(said(b).at(-1).text, 'booked for friday');
});
