#!/usr/bin/env node
/**
 * Architecture benchmark: senju vs. a classic single-loop agent.
 *
 * Both sides get the same simulated model (fixed latency per call, an oracle
 * policy that always does the right thing) and the same simulated tools, so
 * the numbers isolate what the *architecture* costs: how long a message waits
 * before it is answered, and how long a burst of work takes end to end.
 * Placement accuracy of a real model is measured separately, on a real host.
 *
 * The baseline is the strongest common single-loop design: one turn at a time,
 * new messages are queued and absorbed at the next tool-round boundary
 * ("steer" mode), a stop request takes effect at that boundary.
 *
 *   node bench/run.js [--model-ms 600] [--dispatch-ms 400] [--scale 1] [--json out.json]
 */
import { writeFileSync } from 'node:fs';
import { Runtime, call, messageIds, place } from '../src/index.js';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const SCALE = Number(arg('scale', 1));
const MODEL_MS = Number(arg('model-ms', 600)) * SCALE;
const DISPATCH_MS = Number(arg('dispatch-ms', 400)) * SCALE;
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
});

/* Scenarios. Each message: {at (ms), text, kind, task?, dur? (tool ms)}.
   kind: task (needs a tool of `dur` ms) | chat (answer directly) | more (supplement to task) | stop (cancel task) */
const s = (ms) => ms * SCALE;
const SCENARIOS = [
  {
    name: 'question during a long task',
    msgs: [
      { at: 0, text: 'export the report', kind: 'task', task: 'A', dur: s(8000) },
      { at: s(1500), text: 'what time is it in Tokyo?', kind: 'chat' },
    ],
  },
  {
    name: 'supplement during a long task',
    msgs: [
      { at: 0, text: 'clean up the downloads folder', kind: 'task', task: 'A', dur: s(8000) },
      { at: s(1500), text: 'keep the PDFs', kind: 'more', task: 'A' },
    ],
  },
  {
    name: 'two independent tasks',
    msgs: [
      { at: 0, text: 'render the video', kind: 'task', task: 'A', dur: s(8000) },
      { at: s(1000), text: 'back up the photos', kind: 'task', task: 'B', dur: s(6000) },
    ],
  },
  {
    name: 'cancel a long task',
    msgs: [
      { at: 0, text: 'download the dataset', kind: 'task', task: 'A', dur: s(10000) },
      { at: s(2000), text: 'never mind, stop', kind: 'stop', task: 'A' },
    ],
  },
  {
    name: 'mixed burst',
    msgs: [
      { at: 0, text: 'translate the contract', kind: 'task', task: 'A', dur: s(6000) },
      { at: s(1000), text: 'and summarise it too', kind: 'more', task: 'A' },
      { at: s(1500), text: 'book a table for tonight', kind: 'task', task: 'B', dur: s(4000) },
      { at: s(2500), text: 'thanks!', kind: 'chat' },
    ],
  },
];

/* --------------------------------------------------------------- senju */

async function runSenju(sc) {
  const byText = new Map(sc.msgs.map((m) => [m.text, m]));
  const idOf = new Map();
  const handOfTask = new Map();
  const tools = [{
    name: 'work', description: 'do the work', parameters: { type: 'object', properties: { ms: { type: 'number' } } },
    run: async ({ ms }, { signal }) => { await sleep(ms, signal); return 'finished'; },
  }];
  let rt;
  const model = {
    async complete(req) {
      if (req.meta.kind === 'dispatch') {
        await sleep(DISPATCH_MS, req.signal);
        const ids = messageIds(req);
        const text = req.messages[0].content;
        return {
          text: '',
          calls: [{
            id: 'd', name: 'place', arguments: {
              placements: ids.map((id) => {
                const line = text.split('\n').find((l) => l.startsWith(`[${id}]`));
                const m = byText.get(line.slice(id.length + 3));
                if ((m.kind === 'more' || m.kind === 'stop') && handOfTask.has(m.task)) {
                  return { message: id, action: m.kind === 'more' ? 'join' : 'stop', hand: handOfTask.get(m.task), text: 'ok, stopped' };
                }
                if (m.kind === 'chat') return { message: id, action: 'new', title: m.text, goal: m.text };
                return { message: id, action: 'new', title: m.text, goal: m.text };
              }),
            },
          }],
          usage: {},
        };
      }
      await sleep(MODEL_MS, req.signal);
      const first = req.messages[0].content;
      const m = sc.msgs.find((x) => first.includes(`] ${x.text}`));
      if (m.kind === 'task' && !handOfTask.has(m.task)) handOfTask.set(m.task, req.meta.hand);
      const toolDone = req.messages.some((x) => x.role === 'tool');
      if (m.kind === 'task' && !toolDone) return { text: '', calls: [{ id: `w${Math.random()}`, name: 'work', arguments: { ms: m.dur } }], usage: {} };
      return { text: `done: ${m.text}`, calls: [], usage: {} };
    },
  };
  rt = new Runtime({ model, persona: 'bench', tools, debounceMs: 150 * SCALE });
  const t0 = Date.now();
  for (const m of sc.msgs) {
    await sleep(Math.max(0, m.at - (Date.now() - t0)));
    idOf.set(m.text, rt.receive({ text: m.text }).id);
  }
  await rt.idle();
  const end = Date.now() - t0;
  const metrics = new Map(rt.messageMetrics().map((x) => [x.message, x]));
  const u = rt.usage();
  return {
    first: sc.msgs.map((m) => metrics.get(idOf.get(m.text)).firstResponseMs),
    stopMs: stopLatency(sc, rt, t0),
    wall: end,
    calls: u.dispatchModelCalls + u.handModelCalls,
  };
}

function stopLatency(sc, rt, t0) {
  const stop = sc.msgs.find((m) => m.kind === 'stop');
  if (!stop) return null;
  const note = rt.timeline.all().find((e) => e.kind === 'note' && e.text.startsWith('stopped'));
  return note ? note.at - t0 - stop.at : null;
}

/* ---------------------------------------------------------------- baseline */

async function runBaseline(sc) {
  // One conversation loop. A turn: model call → (tool → model call)* → reply.
  // Messages that arrive during a turn are absorbed at the next round boundary.
  const t0 = Date.now();
  const now = () => Date.now() - t0;
  const first = new Array(sc.msgs.length).fill(null);
  const queue = [];
  let calls = 0;
  let stopMs = null;
  let wake;
  const arrivals = (async () => {
    for (let i = 0; i < sc.msgs.length; i++) {
      await sleep(Math.max(0, sc.msgs[i].at - now()));
      queue.push(i);
      wake?.();
    }
  })();
  let delivered = 0;
  const answer = (idxs) => { for (const i of idxs) if (first[i] == null) first[i] = now() - sc.msgs[i].at; };
  while (delivered < sc.msgs.length || queue.length) {
    if (!queue.length) { await new Promise((r) => { wake = r; }); wake = null; continue; }
    // start a turn with everything queued
    const inTurn = queue.splice(0);
    delivered += inTurn.length;
    const tasks = new Map(); // task -> remaining tool ms
    const absorb = (idxs) => {
      for (const i of idxs) {
        const m = sc.msgs[i];
        if (m.kind === 'task') tasks.set(m.task, m.dur);
        if (m.kind === 'stop') { tasks.delete(m.task); stopMs = now() - m.at; } // seen only at a round boundary
      }
    };
    absorb(inTurn);
    const pendingAnswer = [...inTurn];
    for (;;) {
      await sleep(MODEL_MS); calls++;
      const extra = queue.splice(0); delivered += extra.length; // absorbed at the round boundary
      if (extra.length) { absorb(extra); pendingAnswer.push(...extra); }
      const next = [...tasks.entries()][0];
      if (!next) break; // reply to everything in this turn
      // the model calls one tool per round (sequential tools, as in a single loop)
      await sleep(next[1]);
      tasks.delete(next[0]);
    }
    answer(pendingAnswer);
  }
  await arrivals;
  return { first, stopMs, wall: now(), calls };
}

/* -------------------------------------------------------------------- main */

const fmt = (ms) => (ms == null ? '—' : `${(ms / 1000).toFixed(1)}s`);
const rows = [];
for (const sc of SCENARIOS) {
  const [mh, base] = await Promise.all([runSenju(sc), runBaseline(sc)]);
  rows.push({ scenario: sc.name, msgs: sc.msgs.map((m) => m.text), senju: mh, baseline: base });
}

const lines = [
  `model call ${MODEL_MS} ms, dispatch call ${DISPATCH_MS} ms (simulated)`,
  '',
  '| scenario | message | first response: single loop | first response: senju |',
  '|---|---|---:|---:|',
];
for (const r of rows) {
  r.msgs.forEach((m, i) => lines.push(`| ${i === 0 ? r.scenario : ''} | ${m} | ${fmt(r.baseline.first[i])} | ${fmt(r.senju.first[i])} |`));
}
lines.push('', '| scenario | wall time: single loop | wall time: senju | stop takes effect: single loop | senju | model calls: single loop | senju |', '|---|---:|---:|---:|---:|---:|---:|');
for (const r of rows) {
  lines.push(`| ${r.scenario} | ${fmt(r.baseline.wall)} | ${fmt(r.senju.wall)} | ${fmt(r.baseline.stopMs)} | ${fmt(r.senju.stopMs)} | ${r.baseline.calls} | ${r.senju.calls} |`);
}
console.log(lines.join('\n'));
const out = arg('json', null);
if (out) writeFileSync(out, JSON.stringify({ modelMs: MODEL_MS, dispatchMs: DISPATCH_MS, rows }, null, 2));
