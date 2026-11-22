import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Append-only JSONL store. Three files in `dir`:
 *   timeline.jsonl – one entry per line
 *   hands.jsonl    – a full hand snapshot per change; the last line per id wins
 *   metrics.jsonl  – a metric snapshot per change; the last line per message wins
 * Good enough for demos, single-process apps and post-mortems. Hosts with a
 * database should implement the same four methods on top of it.
 */
export class JsonlStore {
  constructor(dir) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }
  #append(file, value) { appendFileSync(join(this.dir, file), JSON.stringify(value) + '\n'); }
  #read(file) {
    const path = join(this.dir, file);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; } // tolerate a torn last line
    });
  }
  appendTimeline(entry) { this.#append('timeline.jsonl', entry); }
  putHand(record) { this.#append('hands.jsonl', record); }
  putMetric(record) { this.#append('metrics.jsonl', record); }
  load() {
    const lastBy = (rows, key) => [...new Map(rows.map((r) => [r[key], r])).values()];
    return {
      timeline: this.#read('timeline.jsonl'),
      hands: lastBy(this.#read('hands.jsonl'), 'id'),
      metrics: lastBy(this.#read('metrics.jsonl'), 'message'),
    };
  }
}
