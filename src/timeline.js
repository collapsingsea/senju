import { clip } from './util.js';

/**
 * The one append-only log of everything the user sees (invariant 2).
 * Entry: {id, at, kind, text, hand?, label?, replyTo?, from?}
 *   kind: 'user' | 'say' | 'final' | 'ask' | 'reply' | 'note'
 */
export class Timeline {
  #entries = [];
  constructor(store, entries = []) {
    this.store = store;
    this.#entries = entries;
  }
  append(entry) {
    this.#entries.push(entry);
    this.store.appendTimeline(entry);
    return entry;
  }
  get(id) { return this.#entries.find((e) => e.id === id); }
  tail(n) { return this.#entries.slice(-n); }
  all() { return [...this.#entries]; }

  /** Plain-text rendering used inside model prompts. */
  static render(entries, { max = 300 } = {}) {
    return entries.map((e) => {
      const who = e.kind === 'user' ? `user [${e.id}]` : e.kind === 'note' ? 'note' : e.hand ? `you (${e.label || e.hand})` : 'you';
      return `${who}: ${clip(e.text, max)}`;
    }).join('\n');
  }
}
