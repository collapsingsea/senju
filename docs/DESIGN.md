# senju — design

> One persona, many hands. A runtime for a single conversational agent that can
> work on several things at once without ever making the user wait or repeat
> themselves.

## 1. Problem

Most agent runtimes run **one loop per conversation**. While that loop is busy
(a tool call, a long command), new user messages can only be queued, injected
into the current run, or used to interrupt it. (Examples: "steer / followup /
collect / interrupt" queue modes, "enqueue / reject / interrupt / rollback"
double-texting strategies.)

The usual escape is a **front/back split**: a front agent talks, and background
workers do the work. That costs a relay on every task. The worker's result has
to go back to the front agent, which then rephrases it for the user. It also
blurs who is speaking.

senju removes the split. There is **one persona** (one identity, one voice,
one shared timeline), and that persona works through any number of concurrent
**hands**. Each hand is a unit of work that can use tools *and* speak to the user
directly. Every new user message is placed by a small, fast **dispatch** step.
Dispatch reads the board of live hands and decides, per message, whether to:

- `join`: deliver the message to a live hand (a supplement, a correction or an
  answer to its question). The hand sees it at its next step boundary.
- `new`: start a new hand for a new piece of work.
- `reply`: answer directly, for small talk or questions about progress that the
  board already answers.
- `stop`: stop a live hand.

Dispatch is not a separate character. It is the persona reading a new message,
with a deliberately small context.

## 2. Concepts

| Concept | What it is |
|---|---|
| **Persona** | The shared system prompt. It is the identical prefix of every model request (dispatch and hands), so the provider's prompt cache is shared. |
| **Timeline** | One append-only log of everything the user sees: user messages, utterances from any hand (tagged with the hand id), hand lifecycle notes, dispatch replies. |
| **Hand** | A unit of work. It has a title, a goal, a state and its own working transcript of model turns and tool calls (append-only, so it stays cache-friendly). It may `say` progress, `ask` a question, or finish with a final utterance. |
| **Board** | The registry of hands with their title, state, last utterance, open question and held resources. It is the single source of truth for "who is doing what". |
| **Dispatch** | Places every incoming user message. When no hand is live it takes a fast path that skips the model call. |
| **Resource** | A named exclusive thing, such as `pc.input` (one mouse and keyboard) or `fs:/path/prefix`. Tools declare what they need. The runtime grants locks FIFO and per call. |
| **Store** | Pluggable persistence for the timeline, hands and metrics. Ships with in-memory and JSONL stores. |
| **Model adapter** | `complete({system, messages, tools, signal}) → {text, calls, usage}`. Ships an OpenAI-compatible adapter and a scripted adapter for tests. |

## 3. Invariants

These are enforced in code, not left to the model.

1. **Every user message gets exactly one placement.** A dispatch result that
   omits a message, places one twice, or names an unknown or finished hand is
   repaired by the fallback rules in §5. Nothing is ever silently dropped.
2. **One voice.** Only hands and dispatch write utterances, and all of them go to
   the one timeline. When two or more hands are live, every utterance carries
   the hand's title so the user can tell them apart.
3. **The board is the only registry.** A hand cannot create another hand behind
   the board's back. Spawning goes through `runtime.spawn`, which records it.
4. **Exclusive resources are never shared.** A tool call that declares a
   resource runs only while it holds the lock. Waiters queue in FIFO order, and
   aborting a hand releases its locks.
5. **Hands never block the conversation.** Dispatch never waits for a hand's
   tool call to finish. A message delivered to a busy hand is queued on that
   hand and read at its next step boundary.
6. **Append-only transcripts.** A hand's request is always its previous request
   plus new items. Nothing earlier is rewritten, so cached prefixes stay valid.
7. **Stopping is immediate and clean.** `stop` aborts the hand's signal,
   releases its resources and records a lifecycle note. In-flight tools receive
   the abort.

## 4. Lifecycle of a hand

```
            ┌────────── join (new message) ──────────┐
            ▼                                        │
 new ──► running ──tool calls──► running ──text──► done
            │  ▲                                     
            │  └──── answer ────┐                    
            ├──► asking ────────┘                    
            ├──► waiting (timer / external) ──► running
            └──► stopped | failed
```

- A model turn **with tool calls** runs the tools and continues.
- A model turn **with text and no tool calls** is a final utterance. The hand
  becomes `done`, unless messages were delivered to it meanwhile; in that case
  it continues with them.
- `say(text)` publishes progress without ending.
- `ask(question)` publishes a question and parks the hand in `asking`. The
  user's answer is routed back by dispatch, normally as `join`.
- `wait(ms | until)` parks the hand in `waiting`. A delivered message also
  wakes it.

## 5. Dispatch

Messages that arrive within `debounceMs` of each other are placed together.

**Fast path (no model call).** If no hand is live and none finished within
`reopenWindowMs`, the batch becomes one new hand. A hand that only needs to
answer simply answers and finishes, so small talk costs one model call.

**Answer path (no model call).** If the batch is a single message whose
`replyTo` is the open question of a live hand, it joins that hand. Hosts set
`replyTo` when the user replies to a question in the UI (or when exactly one
question is open, if they want that shortcut). The runtime does not guess
otherwise, because a guess would swallow new requests.

**Model path.** Otherwise dispatch asks the model, with a small context:

- the persona prefix (shared, so it hits the cache);
- the board: id, title, state, last utterance and open question for each live
  hand, plus the last few finished hands (joining one reopens it with its
  transcript, which is how "do that again, but shorter" works);
- the last few timeline lines;
- the new messages.

The model answers through one tool call:

```json
{"placements":[{"message":"m1","action":"join","hand":"h2"},
               {"message":"m2","action":"new","title":"…","goal":"…"},
               {"message":"m3","action":"reply","text":"…"}]}
```

**Validation and repair:**

- A missing message, or any message when the model call fails, joins the most
  recently active live hand, or becomes a new hand if none is live.
- A `join` to an unknown hand falls back the same way. A `stop` of an unknown
  or already finished hand becomes a `reply` with the given text.
- An empty `reply` or an invalid action falls back like a missing message.
- A duplicate keeps the first placement, and placements for unknown message ids
  are ignored.
- Several `new` placements with the same title are merged into one new hand.
- Every repair is recorded in the message's metric (`repaired`), so hosts can
  measure how often the model needed fixing.

## 6. Resources

```js
tool = { name, description, parameters, resources: args => ['pc.input'], run(args, ctx) }
```

The runtime acquires every named resource, in sorted order to avoid deadlock,
before `run`, and releases them after. The wait time is reported to the hand as
part of the tool result, so the model can tell why a call took long.

## 7. Speaking and labels

- An utterance is `{hand, text, kind: 'say'|'final'|'ask'|'reply'}`.
- When more than one hand is live, the runtime adds the hand title (the event
  field `label`). Rendering it is up to the UI. A `labelPrefix` option prepends
  it to the text.

## 8. Metrics

Recorded per user message:

- `received → placed` (dispatch latency);
- `received → first response`: the first utterance of the hand the message was
  placed in, or the dispatch reply;
- the placement and whether it was repaired.

Recorded per hand: model calls, tool calls, wall time, and resource wait time.

## 9. Persistence and recovery

- The timeline is appended to the store as it grows. A hand snapshot is written
  after every assistant turn and every tool result, and metrics are upserted.
- `restore()` reloads everything. Hands that were `running`, `queued` or
  `waiting` are restarted. `asking` hands keep waiting for their answer.
- A crash can leave a transcript that ends in tool calls without results. Before
  the next model call, each missing result is filled with "interrupted by a
  restart; check the current state before retrying", so the model never sees a
  malformed transcript and does not blindly repeat side effects.

## 10. Non-goals

- No built-in tools beyond the control tools (`say`, `ask`, `wait`). Domain
  tools belong to the host application.
- No UI. The runtime emits events.
- No multi-persona orchestration. If you want several characters, run several
  runtimes.
