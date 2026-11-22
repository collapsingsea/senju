# Senju 千手

**The full-duplex agent runtime. One mind, a thousand hands.**

Most agents are half-duplex: while they work, they can't really listen. Senju lets one conversational agent keep talking with you while it works on several things at once, so you never wait behind a busy tool call. The name comes from *Senju* (千手), the thousand-armed figure with one heart.

[中文说明](README.zh-CN.md) · [Design](docs/DESIGN.md)

Most agent loops handle one turn at a time. While the agent spends two minutes exporting a report, a quick question waits two minutes, and "stop" waits until the current tool call returns. senju keeps one voice towards the user but lets every piece of work run in its own *hand*: an independent tool-use loop with its own transcript. A dispatcher places each new message, which means it either joins a hand that is already working, starts a new hand, gets answered directly, or stops a hand.

```
user ──► receive ──► dispatch ──► join  ──► hand A (running: export report)
                         │   └──► new   ──► hand B (answers "what time is it in Tokyo?")
                         │   └──► reply ──► "still exporting, about a minute"
                         │   └──► stop  ──► hand C stopped, its locks released
                         ▼
                     timeline (one append-only log of everything said)
```

- **Every message is placed exactly once.** The model proposes the placements and the runtime validates and repairs them, so a missing, duplicated or invalid placement can never drop a message or answer it twice.
- **Nobody waits behind a busy hand.** A hand reads messages for it at its next step boundary. Unrelated messages start their own hand. Status questions are answered by the dispatcher from the board.
- **Stop is immediate.** Each hand has an `AbortSignal` that tools receive, and locks are released at once.
- **Shared resources are safe.** A tool declares the names it needs (for example `pc.input` or `fs:/data`). Hands get them FIFO, with deadlock-free ordering, and the model is told how long it waited.
- **Cache-friendly.** Every hand's transcript is append-only and the persona prefix is shared, so providers with prefix caching hit the cache.
- **No dependencies.** Plain Node ≥ 20 ESM. Bring any model through a two-method adapter. An OpenAI-compatible adapter is included and works with OpenAI, DeepSeek, vLLM, Ollama, OpenRouter and others.

## Quick start

```js
import { Runtime, openai } from 'senju';

const rt = new Runtime({
  model: openai({ baseURL: 'https://api.deepseek.com/v1', apiKey: process.env.KEY, model: 'deepseek-chat' }),
  persona: 'You are Juno, a friendly assistant. Keep replies short.',
  tools: [{
    name: 'export_report',
    description: 'Export the monthly report as PDF.',
    parameters: { type: 'object', properties: { month: { type: 'string' } } },
    resources: () => ['printer'],              // optional exclusive resources
    async run({ month }, { signal, say }) {    // signal aborts on stop; say() posts progress
      say('exporting…');
      return { file: `report-${month}.pdf` };
    },
  }],
});

rt.on('utterance', ({ entry }) => console.log(entry.label ? `[${entry.label}] ` : '', entry.text));
rt.receive({ text: 'export the October report' });
rt.receive({ text: 'what time is it in Tokyo?' });   // answered while the export runs
```

Try it without an API key: `node examples/offline-demo.js`. To chat in a terminal: `OPENAI_API_KEY=… node examples/basic/chat.js`.

## Concepts

| | |
|---|---|
| **Persona** | The one system prompt everything shares. It is the user-facing identity. |
| **Timeline** | An append-only log of user messages and everything the assistant said. Each entry is tagged with the hand that said it. |
| **Hand** | One piece of work: a tool-use loop with its own transcript. States: `queued → running ⇄ asking/waiting → done/failed/stopped`. A finished hand can be joined again and continues with its context. |
| **Board** | The live and recently finished hands, which is what dispatch sees. |
| **Dispatch** | Places new messages: `join` / `new` / `reply` / `stop`. It has three paths. The *fast path* runs when nothing is live: the message becomes new work with no extra model call. The *answer path* runs when the message is a reply to an open question. The *model path* runs otherwise: one small model call with the board and the recent conversation. |
| **Control tools** | Every hand gets `say` (progress), `ask` (a question; the answer is the tool result) and `wait` (a pause that a new message ends early). |
| **Resource** | A named exclusive lock that tools declare. |
| **Store** | Persists the timeline, hands and metrics. `MemoryStore` and `JsonlStore` are included, and `restore()` resumes interrupted hands. |

## API

```js
new Runtime({ model, persona, tools, store, ...options })
rt.receive({ text, id?, replyTo?, from? }) → timeline entry   // never blocks
rt.spawn({ title, goal, messages? })        → hand view        // host-started work
rt.stop(handId, reason?)
rt.board({ includeFinished? }) · rt.hand(id) · rt.timeline.all()
rt.messageMetrics()  // per message: path, placement, repaired, placedAt, firstResponseMs
rt.usage()           // model calls and tokens, split into dispatch and hands
rt.idle() · rt.restore() · rt.close()
rt.on('utterance' | 'placement' | 'hand' | 'message' | 'error' | '*', fn)
```

Options (defaults): `maxLive` 4 · `debounceMs` 250 · `maxSteps` 40 · `modelRetries` 2 · `maxWaitSeconds` 600 · `toolResultChars` 8000 · `tailLines` 8 · `recentFinished` 3 · `reopenWindowMs` 10 min · `fastPath` true · `labelPrefix` null · `handInstructions`.

A **model adapter** is `{ complete({ system, messages, tools, toolChoice, signal, meta }) → { text, calls: [{id, name, arguments}], usage: {input, cached, output} } }`. Messages use the OpenAI chat format. `meta.kind` is `'dispatch'` or `'hand'`.

## Benchmark

`node bench/run.js` runs senju and a classic single-loop agent side by side. The single loop handles one turn at a time and absorbs new messages at tool-round boundaries. Both use the same simulated model (600 ms per call, 400 ms for dispatch), the same tools and an oracle policy, so the numbers measure the architecture and not model quality.

| scenario | single loop | senju |
|---|---:|---:|
| quick question during an 8 s task: first response | 7.7 s | 1.2 s |
| "stop" during a 10 s task: takes effect after | 9.2 s | 0.6 s |
| two independent tasks: all done | 15.8 s | 9.4 s |
| task + supplement + second task + "thanks": all done | 11.8 s | 7.4 s |
| model calls in that last case | 3 | 8 |

The cost is extra model calls: one for dispatch per message burst while work is live, and one per hand. With prefix caching most of those tokens are cached.

### With a real model

The same design runs inside a personal assistant in daily use. On that assistant we compared the old single-loop path with the senju-style path, side by side at the same moment, on 6 multi-message tasks × 3 rounds (web research with a real model, then a second message a few seconds later):

| measure (21 follow-up messages) | single loop | senju |
|---|---:|---:|
| first response, median | 11.8 s | 5.1 s |
| first response, p90 | 21.7 s | 10.4 s |
| "never mind, stop": stops after | 22–28 s | 3.5 s |
| tasks passed | 18/18 | 18/18 |

Dispatch cost about 3 s and ~500 tokens per follow-up. Short supplements to short tasks were not faster: when a turn ends in a few seconds anyway, the single loop picks the message up just as quickly. The gain grows with how long the agent is busy.

## What this is not

It provides no domain tools, no UI and no multi-persona orchestration. senju is the conversation runtime. You bring the tools, the model, the storage and the interface.

## Tests

`npm test` uses Node's built-in test runner and a scripted model. The tests cover placement repair, FIFO locks, delivery to a busy hand, parallel hands and labels, stop, ask/answer, continuing finished hands, append-only transcripts, step budgets, retries and crash recovery.
