import { clip } from './util.js';
import { Timeline } from './timeline.js';
import { FINISHED, LIVE } from './hand.js';

export const DISPATCH_INSTRUCTIONS = `You are placing new messages from the user. You are the same person who is talking with them; the board lists what you are working on right now and what you finished recently.
For every new message choose exactly one placement:
- join: it belongs to an item on the board. It adds details, corrects it, answers its open question, asks about it or asks to change or redo it. Use the item's id. Finished items can be joined too: this continues them with their context.
- new: it is a separate request that needs work. Give a short title and a goal written from the user's words: what, where, and what counts as done.
- reply: you can answer completely right now from the board and the conversation alone, without tools (small talk, or "how is it going?" when the board already says). Put the full answer in text, in your own voice and language.
- stop: the user wants an item stopped or cancelled. Put a one-line acknowledgement in text.
If a message clearly continues an item but you are unsure which one, join the most recently active live item. Never skip a message. Call place exactly once.`;

export const PLACE_TOOL = {
  name: 'place',
  description: 'Place every new message.',
  parameters: {
    type: 'object',
    properties: {
      placements: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'message id, e.g. m_ab12' },
            action: { type: 'string', enum: ['join', 'new', 'reply', 'stop'] },
            hand: { type: 'string', description: 'item id for join/stop' },
            title: { type: 'string', description: 'for new' },
            goal: { type: 'string', description: 'for new' },
            text: { type: 'string', description: 'for reply/stop' },
          },
          required: ['message', 'action'],
        },
      },
    },
    required: ['placements'],
  },
};

export function renderBoard(hands, now) {
  if (!hands.length) return '(nothing)';
  return hands.map((h) => {
    const age = Math.round((now - (h.startedAt ?? h.createdAt)) / 1000);
    const parts = [`${h.id} | ${h.title} | ${h.state}${LIVE.has(h.state) ? ` for ${age}s` : ''}`];
    if (h.goal) parts.push(`goal: ${clip(h.goal, 160)}`);
    if (h.question) parts.push(`asked the user: ${clip(h.question, 160)}`);
    if (h.lastText) parts.push(`last said: ${clip(h.lastText, 200)}`);
    return parts.join(' | ');
  }).join('\n');
}

export function buildDispatchRequest({ persona, board, recent, tail, messages, now }) {
  const content = [
    'Board — live items:', renderBoard(board, now),
    '', 'Board — finished recently:', renderBoard(recent, now),
    '', 'Recent conversation:', Timeline.render(tail) || '(none)',
    '', 'New messages:', messages.map((m) => `[${m.id}]${m.replyTo ? ` (reply to ${m.replyTo})` : ''} ${m.text}`).join('\n'),
  ].join('\n');
  return {
    system: `${persona}\n\n${DISPATCH_INSTRUCTIONS}`,
    messages: [{ role: 'user', content }],
    tools: [PLACE_TOOL],
    toolChoice: { name: 'place' },
  };
}

/**
 * Turn the model's answer into exactly one valid placement per message
 * (invariant 1). Returns {placements, repaired} where repaired lists what was fixed.
 */
export function repairPlacements(raw, { messages, hands, fallbackHand }) {
  const known = new Map(hands.map((h) => [h.id, h]));
  const byMessage = new Map();
  const repaired = [];
  for (const p of Array.isArray(raw) ? raw : []) {
    if (!p || typeof p !== 'object') continue;
    const m = messages.find((x) => x.id === p.message);
    if (!m) { repaired.push({ kind: 'unknown-message', placement: p }); continue; }
    if (byMessage.has(m.id)) { repaired.push({ kind: 'duplicate', message: m.id }); continue; }
    let { action } = p;
    if (!['join', 'new', 'reply', 'stop'].includes(action)) { repaired.push({ kind: 'bad-action', message: m.id, action }); action = fallbackHand ? 'join' : 'new'; }
    const out = { message: m.id, action };
    if (action === 'join' || action === 'stop') {
      const target = known.get(p.hand) ?? (action === 'join' ? fallbackHand : null);
      if (!target) {
        repaired.push({ kind: 'unknown-hand', message: m.id, hand: p.hand });
        if (action === 'stop') { out.action = 'reply'; out.text = p.text || ''; }
        else { out.action = 'new'; out.title = clip(m.text, 24); out.goal = m.text; }
      } else {
        if (target.id !== p.hand) repaired.push({ kind: 'unknown-hand', message: m.id, hand: p.hand, used: target.id });
        if (action === 'stop' && FINISHED.has(target.state)) { out.action = 'reply'; out.text = p.text || ''; repaired.push({ kind: 'stop-finished', message: m.id }); }
        else { out.hand = target.id; if (action === 'stop') out.text = p.text || ''; }
      }
    } else if (action === 'new') {
      out.title = clip(p.title || m.text, 40);
      out.goal = p.goal || m.text;
    } else if (action === 'reply') {
      if (!p.text?.trim()) {
        repaired.push({ kind: 'empty-reply', message: m.id });
        if (fallbackHand) { out.action = 'join'; out.hand = fallbackHand.id; }
        else { out.action = 'new'; out.title = clip(m.text, 24); out.goal = m.text; }
      } else out.text = p.text.trim();
    }
    byMessage.set(m.id, out);
  }
  for (const m of messages) {
    if (byMessage.has(m.id)) continue;
    repaired.push({ kind: 'missing', message: m.id });
    byMessage.set(m.id, fallbackHand
      ? { message: m.id, action: 'join', hand: fallbackHand.id }
      : { message: m.id, action: 'new', title: clip(m.text, 24), goal: m.text });
  }
  return { placements: messages.map((m) => byMessage.get(m.id)), repaired };
}
