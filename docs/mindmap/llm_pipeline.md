## LLM Pipeline (router → propose → repair → summarize)

This document explains modes, prompts, thresholds, parsing, streaming, and apply/dryrun boundaries. It reflects the current server and client code without fragile line references.

### Modes

- plan (default): Generate operations, validate/repair, summarize.
- chat: Bypass operations and return a concise chat answer.
- auto: Router decides clarify | chat | plan; may insert a clarification turn.

Entrypoints: POST `/api/assistant/message` and GET `/api/assistant/message/stream`.

### Model runtime

- Local model via Ollama; model name is configurable. Default is `deepcoder:14b` in code today.
- JSON-first: tries Ollama HTTP `/api/generate` with `format: 'json'`, falls back to CLI.
- Granite compatibility: if the model outputs `<think>...</think><response>...</response>`, the server extracts `<response>` before JSON parsing and strips tags for summaries.

### Router (auto mode)

- Output JSON: `{ decision: 'chat'|'plan'|'clarify', category, entities, missing, confidence, question? }`.
- Thresholds: `CLARIFY_THRESHOLD = 0.45`, `CHAT_THRESHOLD = 0.70`.
- Context grounding: A Mon–Sun week snapshot (completed=false) and a backlog sample, built from DB queries.
- Clarify decoration: Server adds a concise `question` and structured `options: [{id,title,scheduledFor|null}]` ranked by fuzzy title tokens and priority.
- Selection feedback: Client may send `options.clarify.selection` with `ids`, `date`, `priority` to bias routing toward plan with a seeded `where`.

### Proposal generation

- Prompt includes a schema excerpt with strict rules:
  - For todo/event/habit create|update include `recurrence` (use `{type:'none'}` for non-repeating for todo/event; habits must not be `none`).
  - If `recurrence.type != 'none'`, an anchor `scheduledFor` is required.
  - Use `complete_occurrence` for repeating items rather than master `complete`.
  - No bulk operations; limit proposals to ≤20 independent ops.
- Context: Uses focused selection from router when present; otherwise a compact snapshot.
- Parsing robustness:
  - Prefer JSON response; if fenced code blocks are present, fences are removed.
  - If free-form text, brace-match the first top-level `{...}` JSON object.
  - Granite `<response>` extraction precedes parsing.
- Operation shaping: `inferOperationShape` normalizes partially specified ops, sets `op` (create|update|delete|complete|complete_occurrence|goal_*), lowercases priority, and coerces empty strings to `null` for nullable fields.

### Validation and repair

- `validateProposal` runs per-op checks (recurrence presence/shape, anchors for repeating, time formats, allowed kinds, no bulk, etc.).
- One repair attempt uses a dedicated prompt with the invalid ops plus error reasons; if still invalid, the valid subset of the first pass is kept.
- Common repairs: inject `{type:'none'}` for missing recurrence (todo/event), add missing anchors for repeating, convert master `complete` to `complete_occurrence`.

### Summarization

- LLM summary: short, plain text (no markdown or JSON). Granite tags are stripped; code blocks removed; whitespace collapsed.
- Deterministic fallback: If the model fails, server emits a compact, rule-based summary from the proposed ops.

### Streaming (SSE)

- Events emitted by GET `/api/assistant/message/stream`:
  - `stage`: routing → proposing → validating → repairing → summarizing.
  - `clarify`: `{ question, options[] }` (auto mode ambiguity).
  - `ops`: `{ version, operations[], validCount, invalidCount }` (post-validate/repair).
  - `summary`: `{ text }`.
  - `result`: final payload including operations array.
  - `heartbeat`: emitted periodically to keep the connection warm.
  - `done`: terminal event; the server then closes the stream.
- Chat-only path: when router decides `chat`, only `summary` and `done` are sent.
- Client integration: Flutter Web uses EventSource; callbacks handle `stage|clarify|ops|summary|result`. Heartbeats are ignored; close() occurs after `done`.

### Apply and dryrun

- Dryrun: POST `/api/llm/dryrun` returns validation results for a supplied operations array without changing state.
- Apply: POST `/api/llm/apply` executes validated operations in a DB transaction. Caps at 20 ops. Writes audit entries for each action.
- Idempotency: Optional `Idempotency-Key` header plus request-hash caching returns the cached response for repeats.
- Supported kinds: todo, event, habit, goal. Goal operations include `goal_create|goal_update|goal_delete|goal_add_items|goal_remove_item|goal_add_child|goal_remove_child`.

### Safety boundaries

- Bulk operations are not supported and are rejected during validation.
- Repeating semantics are enforced: anchors required; master `complete` forbidden (use `complete_occurrence`).



