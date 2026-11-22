#!/usr/bin/env node
/**
 * A terminal chat with one assistant that can work on several things at once.
 *
 *   OPENAI_API_KEY=... node examples/basic/chat.js
 *   OPENAI_BASE_URL=https://api.deepseek.com/v1 MODEL=deepseek-chat OPENAI_API_KEY=... node examples/basic/chat.js
 *
 * Try: "count to 20 slowly", then while it runs: "what's 17*23?", "make it 30", "stop counting".
 * Commands: /board shows the board, /metrics the per-message latencies, /quit exits.
 */
import readline from 'node:readline';
import { Runtime, JsonlStore, openai } from '../../src/index.js';

const model = openai({
  baseURL: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.MODEL ?? 'gpt-4.1-mini',
});

const tools = [
  {
    name: 'count',
    description: 'Count slowly from 1 to n, one number per second, showing progress to the user. Takes n seconds.',
    parameters: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
    async run({ n }, { signal, say }) {
      for (let i = 1; i <= n; i++) {
        await new Promise((r, j) => { const t = setTimeout(r, 1000); signal.addEventListener('abort', () => { clearTimeout(t); j(new Error('stopped')); }, { once: true }); });
        if (i % 5 === 0) say(`…${i}`);
      }
      return { counted: n };
    },
  },
  {
    name: 'note',
    description: 'Append a line to the shared notes file. Only one item can write at a time.',
    parameters: { type: 'object', properties: { line: { type: 'string' } }, required: ['line'] },
    resources: () => ['notes'],
    async run({ line }) {
      notes.push(line);
      return { notes };
    },
  },
];
const notes = [];

const rt = new Runtime({
  model,
  persona: 'You are Juno, a friendly assistant in a terminal. Keep replies short.',
  tools,
  store: new JsonlStore(process.env.STORE_DIR ?? '.senju-chat'),
});
await rt.restore();

rt.on('utterance', ({ entry }) => {
  const tag = entry.label ? `[${entry.label}] ` : '';
  const mark = { ask: '? ', say: '· ', final: '', reply: '', note: '— ' }[entry.kind] ?? '';
  process.stdout.write(`\r\x1b[K${mark}${tag}${entry.text}\n> `);
});
rt.on('placement', ({ placements, path }) => {
  if (process.env.DEBUG) console.log(`\r\x1b[K  (${path}) ${placements.map((p) => `${p.action}${p.hand ? ':' + p.hand : ''}`).join(', ')}`);
});
rt.on('error', ({ where, error }) => console.error(`\r\x1b[K! ${where}: ${error?.message ?? error}`));

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
rl.prompt();
rl.on('line', (line) => {
  const text = line.trim();
  if (text === '/quit') { rl.close(); return; }
  if (text === '/board') console.table(rt.board({ includeFinished: true }).map(({ id, title, state, lastText }) => ({ id, title, state, lastText })));
  else if (text === '/metrics') console.table(rt.messageMetrics().map(({ message, path, placement, firstResponseMs }) => ({ message, path, action: placement?.action, firstResponseMs })));
  else if (text) {
    // answering the open question of the only asking item links the reply to it
    const asking = rt.board().filter((h) => h.state === 'asking');
    const q = asking.length === 1 ? rt.timeline.all().findLast((e) => e.kind === 'ask' && e.hand === asking[0].id) : null;
    rt.receive({ text, ...(q && { replyTo: q.id }) });
  }
  rl.prompt();
});
rl.on('close', async () => { await rt.close(); process.exit(0); });
