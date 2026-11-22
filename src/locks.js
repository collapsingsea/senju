/**
 * Named exclusive resources (invariant 4).
 *
 * acquire(['pc.input', 'fs:/data']) waits until every name is free, granting
 * each name to waiters in FIFO order. Names are acquired in sorted order so two
 * callers asking for overlapping sets cannot deadlock. Aborting the signal
 * removes the waiter and releases anything it already holds.
 */
export class LockManager {
  #held = new Map();   // name -> owner
  #queues = new Map(); // name -> [{owner, grant}]

  holders() {
    return Object.fromEntries(this.#held);
  }

  async acquire(names, owner, signal) {
    const sorted = [...new Set(names)].sort();
    const got = [];
    const started = Date.now();
    try {
      for (const name of sorted) {
        await this.#acquireOne(name, owner, signal);
        got.push(name);
      }
    } catch (error) {
      for (const name of got) this.#releaseOne(name, owner);
      throw error;
    }
    let released = false;
    return {
      waitedMs: Date.now() - started,
      release: () => {
        if (released) return;
        released = true;
        for (const name of sorted) this.#releaseOne(name, owner);
      },
    };
  }

  #acquireOne(name, owner, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
    if (!this.#held.has(name)) {
      this.#held.set(name, owner);
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const entry = { owner, grant: resolve };
      const queue = this.#queues.get(name) ?? [];
      queue.push(entry);
      this.#queues.set(name, queue);
      signal?.addEventListener('abort', () => {
        const q = this.#queues.get(name) ?? [];
        const i = q.indexOf(entry);
        if (i >= 0) {
          q.splice(i, 1);
          reject(signal.reason ?? new Error('aborted'));
        }
      }, { once: true });
    });
  }

  #releaseOne(name, owner) {
    if (this.#held.get(name) !== owner) return;
    const queue = this.#queues.get(name) ?? [];
    const next = queue.shift();
    if (next) {
      this.#held.set(name, next.owner);
      next.grant();
    } else {
      this.#held.delete(name);
      this.#queues.delete(name);
    }
  }
}
