import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDispatchRequest, repairPlacements, messageIds } from '../src/index.js';

const msgs = [{ id: 'm1', text: 'also make it blue' }, { id: 'm2', text: 'what is the weather' }, { id: 'm3', text: 'cancel the report' }];
const hands = [
  { id: 'h1', title: 'draw logo', state: 'running', lastActiveAt: 2 },
  { id: 'h2', title: 'report', state: 'running', lastActiveAt: 1 },
  { id: 'h3', title: 'old', state: 'done', lastActiveAt: 0 },
];

test('valid placements pass through', () => {
  const { placements, repaired } = repairPlacements([
    { message: 'm1', action: 'join', hand: 'h1' },
    { message: 'm2', action: 'new', title: 'weather', goal: 'today' },
    { message: 'm3', action: 'stop', hand: 'h2', text: 'ok, stopped' },
  ], { messages: msgs, hands, fallbackHand: hands[0] });
  assert.deepEqual(repaired, []);
  assert.deepEqual(placements.map((p) => p.action), ['join', 'new', 'stop']);
  assert.equal(placements[2].text, 'ok, stopped');
});

test('every message gets exactly one placement, in message order', () => {
  const { placements, repaired } = repairPlacements([
    { message: 'm3', action: 'reply', text: 'hi' },
    { message: 'm3', action: 'new', title: 'dup' },
    { message: 'zz', action: 'new' },
  ], { messages: msgs, hands, fallbackHand: hands[0] });
  assert.deepEqual(placements.map((p) => p.message), ['m1', 'm2', 'm3']);
  assert.equal(placements[2].action, 'reply');
  assert.deepEqual(placements.slice(0, 2).map((p) => [p.action, p.hand]), [['join', 'h1'], ['join', 'h1']]);
  assert.deepEqual(repaired.map((r) => r.kind).sort(), ['duplicate', 'missing', 'missing', 'unknown-message']);
});

test('missing placements become new work when nothing is live', () => {
  const { placements } = repairPlacements(null, { messages: msgs.slice(0, 1), hands: [], fallbackHand: null });
  assert.equal(placements[0].action, 'new');
  assert.equal(placements[0].goal, 'also make it blue');
});

test('unknown hands and empty replies are repaired', () => {
  const { placements, repaired } = repairPlacements([
    { message: 'm1', action: 'join', hand: 'nope' },
    { message: 'm2', action: 'reply', text: '  ' },
    { message: 'm3', action: 'stop', hand: 'nope', text: 'stopped' },
  ], { messages: msgs, hands, fallbackHand: hands[0] });
  assert.deepEqual(placements.map((p) => [p.action, p.hand]), [['join', 'h1'], ['join', 'h1'], ['reply', undefined]]);
  assert.deepEqual(repaired.map((r) => r.kind), ['unknown-hand', 'empty-reply', 'unknown-hand']);
});

test('stopping a finished hand becomes a reply; bad actions fall back', () => {
  const { placements } = repairPlacements([
    { message: 'm1', action: 'stop', hand: 'h3', text: 'already done' },
    { message: 'm2', action: 'explode' },
  ], { messages: msgs.slice(0, 2), hands, fallbackHand: null });
  assert.deepEqual(placements.map((p) => p.action), ['reply', 'new']);
});

test('dispatch request shows board, finished items, conversation and new messages', () => {
  const req = buildDispatchRequest({
    persona: 'P',
    board: [{ id: 'h1', title: 'draw logo', state: 'asking', goal: 'a logo', question: 'which colour?', startedAt: 0, createdAt: 0 }],
    recent: [{ id: 'h3', title: 'old', state: 'done', lastText: 'finished it', createdAt: 0 }],
    tail: [{ id: 'm0', kind: 'user', text: 'draw a logo' }, { id: 'u1', kind: 'ask', hand: 'h1', text: 'which colour?' }],
    messages: [{ id: 'm1', text: 'blue', replyTo: 'u1' }, { id: 'm2', text: 'and lunch?' }],
    now: 5000,
  });
  assert.ok(req.system.startsWith('P\n\n'));
  assert.deepEqual(req.toolChoice, { name: 'place' });
  const body = req.messages[0].content;
  for (const s of ['h1 | draw logo | asking for 5s', 'asked the user: which colour?', 'h3 | old | done', 'user [m0]: draw a logo', '(reply to u1) blue']) {
    assert.ok(body.includes(s), `missing ${s}\n${body}`);
  }
  assert.deepEqual(messageIds(req), ['m1', 'm2']);
});
