/**
 * A model for tests and demos: you write the policy as a function.
 *
 *   const model = scripted(async (req) => {
 *     if (req.meta.kind === 'dispatch') return place([{ message: 'm1', action: 'new', title: 'x' }]);
 *     return { text: 'done' };
 *   });
 *
 * Every request is recorded in model.requests (deep-copied) for assertions.
 */
let seq = 0;

export function scripted(policy) {
  const requests = [];
  return {
    requests,
    async complete(req) {
      requests.push(structuredClone({ ...req, signal: undefined }));
      if (req.signal?.aborted) throw req.signal.reason ?? new Error('aborted');
      const out = await policy(req, requests.length - 1);
      if (req.signal?.aborted) throw req.signal.reason ?? new Error('aborted');
      return {
        text: out?.text ?? '',
        calls: (out?.calls ?? []).map((c) => ({ id: c.id ?? `call_${++seq}`, name: c.name, arguments: c.arguments ?? {} })),
        usage: out?.usage ?? { input: 0, cached: 0, output: 0 },
      };
    },
  };
}

/** Helpers for writing policies. */
export const call = (name, args = {}) => ({ calls: [{ name, arguments: args }] });
export const place = (placements) => call('place', { placements });

/** The ids of the user messages in a dispatch request, in order. */
export function messageIds(req) {
  const text = req.messages.map((m) => m.content).join('\n');
  const section = text.split('New messages:')[1] ?? '';
  return [...section.matchAll(/^\[(m_[0-9a-f]+|[^\]\s]+)\]/gm)].map((m) => m[1]);
}
