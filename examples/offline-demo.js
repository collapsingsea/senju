#!/usr/bin/env node
/**
 * No API key needed: a scripted model plays the assistant so you can watch
 * placement, parallel hands, labels and stop in action.
 *
 *   node examples/offline-demo.js
 */
import { Runtime, call, place, messageIds } from '../src/index.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`.padStart(5);

let rt;
const model = {
  async complete(req) {
    await wait(300);
    if (req.meta.kind === 'dispatch') {
      const board = rt.board();
      const find = (word) => board.find((h) => h.title.includes(word))?.id;
      return place(messageIds(req).map((id) => {
        const text = req.messages[0].content.split('\n').find((l) => l.startsWith(`[${id}]`));
        if (text.includes('PDF')) return { message: id, action: 'join', hand: find('downloads') };
        if (text.includes('stop the backup')) return { message: id, action: 'stop', hand: find('backup'), text: 'OK, backup stopped.' };
        if (text.includes('how is it going')) return { message: id, action: 'reply', text: `Working on: ${board.map((h) => h.title).join(', ')}.` };
        return { message: id, action: 'new', title: text.includes('backup') ? 'photo backup' : 'chat', goal: text };
      }));
    }
    const brief = req.meta.title;
    const used = req.messages.filter((m) => m.role === 'tool').length;
    const extra = req.messages.some((m) => m.role === 'user' && m.content.includes('PDF'));
    if (brief.includes('downloads')) return used < 2 ? call('work', { ms: 2500 }) : { text: `Downloads cleaned${extra ? ', PDFs kept' : ''}.` };
    if (brief.includes('backup')) return used < 1 ? call('work', { ms: 6000 }) : { text: 'Backup done.' };
    return { text: 'Paris is 8 hours behind Tokyo.' };
  },
};

rt = new Runtime({
  model,
  persona: 'demo',
  tools: [{ name: 'work', description: 'work', parameters: { type: 'object' }, resources: () => ['disk'], run: async ({ ms }, { signal }) => { await new Promise((r, j) => { const t = setTimeout(r, ms); signal.addEventListener('abort', () => { clearTimeout(t); j(new Error('stopped')); }); }); return 'ok'; } }],
  labelPrefix: (label, text) => `[${label}] ${text}`,
});
rt.on('message', ({ entry }) => console.log(`${stamp()}  you: ${entry.text}`));
rt.on('utterance', ({ entry }) => console.log(`${stamp()}  ${entry.kind === 'note' ? '—' : 'assistant'}: ${entry.text}`));
rt.on('placement', ({ placements, path }) => console.log(`${stamp()}    placed (${path}): ${placements.map((p) => p.action + (p.hand ? ' ' + rt.hand(p.hand).title : '')).join(', ')}`));

rt.receive({ text: 'clean up my downloads folder' });
await wait(800); rt.receive({ text: 'keep the PDF files though' });
await wait(400); rt.receive({ text: 'start the photo backup too' });
await wait(1500); rt.receive({ text: 'what is the time difference between Paris and Tokyo?' });
await wait(1500); rt.receive({ text: 'how is it going?' });
await wait(1000); rt.receive({ text: 'stop the backup, I need the disk' });
await rt.idle();
console.log('\nper message:');
console.table(rt.messageMetrics().map((m) => ({ text: rt.timeline.get(m.message).text.slice(0, 32), path: m.path, action: m.placement.action, firstResponseMs: m.firstResponseMs })));
