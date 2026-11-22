import { Runtime, scripted } from '../src/index.js';

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Poll until fn() is truthy (fails the test after `ms`). */
export async function until(fn, ms = 2000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await tick(2);
  }
}

/** A runtime with fast timings for tests. */
export function makeRuntime(policy, opts = {}) {
  const model = scripted(policy);
  const rt = new Runtime({ model, persona: 'You are Tess, a helpful assistant.', debounceMs: 5, retryDelayMs: 1, ...opts });
  const events = [];
  rt.on('*', (e) => events.push(e));
  return { rt, model, events };
}

/** Last user-role content of a hand request. */
export const lastUser = (req) => [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
export const said = (rt) => rt.timeline.all().filter((e) => e.kind !== 'user');

/** A controllable gate: await gate.wait() inside a tool; call gate.open() from the test. */
export function gate() {
  let open;
  const p = new Promise((r) => { open = r; });
  return { wait: () => p, open };
}
