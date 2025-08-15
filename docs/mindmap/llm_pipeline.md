## LLM Pipeline (Router → Propose → Repair → Summarize)

This document details control flow, prompts, thresholds, parsing, and streaming.

### Modes

- `plan` (default): Generate operations, validate/repair, summarize; no routing step
- `chat`: Bypass operations and return a concise chat answer
- `auto`: Router decides `clarify|chat|plan`; may insert a clarification turn

Entrypoints: POST `/api/assistant/message` and GET `/api/assistant/message/stream` (server 1601:1665, 1668:1775)

### Router (auto mode)

- Decision JSON: `{ decision: 'chat'|'plan'|'clarify', category, entities, missing, confidence, question? }`
- Thresholds: `CLARIFY_THRESHOLD = 0.45`, `CHAT_THRESHOLD = 0.70` (server 790:792)
- Context snapshot: week range (Mon–Sun) and backlog sample derived from DB queries (server 145:152, 173:178, 1098:1115)
- Clarify decoration: adds `question` and structured `options` with `(id,title,scheduledFor)` (server 1148:1163)

Clarify selection feedback:
- Client may pass `options.clarify.selection` with `ids`, `date`, `priority` to bias routing toward `plan` with a seeded `where` (server 1137:1146)

### Proposal generation

- Snapshot seeding: use focused selection when router provides it; else top-K (server 1521:1526)
- Prompt schema constraints: require `recurrence` for create/update; require anchor when repeating; no bulk operations are supported. Use `complete_occurrence` to act on repeating items.
- Parsing robustness:
  - Prefer JSON (`/api/generate` with `format: 'json'`) fallback to CLI
  - Extract `<response>...</response>` if Granite tags present (server 1009:1016)
  - Strip code fences or brace-match first JSON object (server 1030:1062)
- Operation shaping: `inferOperationShape` fills `op` when omitted; normalizes priority and `''→null` for scheduledFor (server 876:923)

Proposal context:
- Includes aggregates and either `topK` or `focused` snapshot based on router narrowing (server 1521:1526)
- Example JSON scaffold provided in prompt to constrain format (server 1171:1188)

### Validation and repair

- `validateProposal` returns per-op errors from `validateOperation` (server 867:874, 817:865)
- One repair attempt via `buildRepairPrompt` using schema excerpt and last-3 transcript (server 1080:1094)
- If repair fails, fall back to valid subset of first pass (server 1590:1594)

Common validation failures and repairs:
- Missing `recurrence` on create/update → insert `{type:'none'}` or propagate provided structure
- Repeating without anchor → inject/retain `scheduledFor` anchor
- Use `complete_occurrence` for repeating instead of `complete`

### Summarization

- Conversational summary via LLM with strict plain-text cleanup (strip Granite tags, remove code blocks, collapse whitespace) (server 1645:1653, 1753:1761)
- Deterministic fallback summary when LLM fails: counts and targets (server 1492:1514, 1762:1764)

Granite cleanup specifics:
- Strip `<think>...</think>` entirely; unwrap `<response>...</response>` (server 1018:1026, 1009:1016)
- Remove code blocks via regex and collapse whitespace

### Streaming (SSE)

- Events:
  - `stage`: routing → proposing → validating → repairing → summarizing
  - `clarify`: `{ question, options[] }` emitted early in auto mode
  - `ops`: `{ version, operations: [{ op, errors[] }], validCount, invalidCount }`
  - `summary`: `{ text }`
  - `result`: final payload including operations array
  - `done`: terminal event
- Heartbeat: every 10s (server 1735:1737)
- Chat-only: when router decides `chat`, only `summary` and `done` are emitted (server 1689:1716)

Client integration:
- `api.dart` uses `dart:html` EventSource, maps events to callbacks, and falls back to POST on error (api.dart 95:176)

### Idempotent apply (separate call)

- POST `/api/llm/apply` with optional `Idempotency-Key` header caches response (server 1199:1210, 1464:1466)
- Dry-run `/api/llm/dryrun` returns validation results; bulk warnings removed and bulk ops are rejected by validation (server 1777:1816)

Safety boundaries:
- No bulk operations; proposals attempting `bulk_*` receive `bulk_operations_removed` during validation (server 860:864)



