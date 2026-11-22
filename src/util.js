import { randomBytes } from 'node:crypto';

export const newId = (prefix) => `${prefix}_${randomBytes(6).toString('hex')}`;

export const systemClock = { now: () => Date.now() };

/** Tiny event emitter: on(name, fn) returns an unsubscribe function. */
export class Emitter {
  #handlers = new Map();
  on(name, fn) {
    if (!this.#handlers.has(name)) this.#handlers.set(name, new Set());
    this.#handlers.get(name).add(fn);
    return () => this.#handlers.get(name)?.delete(fn);
  }
  emit(name, payload) {
    for (const fn of this.#handlers.get(name) ?? []) {
      try { fn(payload); } catch (error) { if (name !== 'error') this.emit('error', { where: `listener:${name}`, error }); }
    }
    for (const fn of this.#handlers.get('*') ?? []) {
      try { fn({ type: name, ...payload }); } catch { /* ignore */ }
    }
  }
}

/** Resolve after ms, or reject early if the signal aborts. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal.reason ?? new Error('aborted')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function clip(text, max) {
  const s = String(text ?? '');
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

/** JSON.stringify that never throws (tool results may contain cycles or BigInts). */
export function safeJson(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  } catch {
    return String(value);
  }
}
