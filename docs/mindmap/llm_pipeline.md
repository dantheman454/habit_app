## LLM Pipeline (Router → Propose → Repair → Summarize)

This document details control flow, prompts, thresholds, parsing, and streaming.

### Modes

- `plan` (default): Generate operations, validate/repair, summarize; no routing step
- `chat`: Bypass operations and return a concise chat answer
- `auto`: Router decides `clarify|chat|plan`; may insert a clarification turn

Entrypoints: POST `/api/assistant/message` and GET `/api/assistant/message/stream` (server 1268:1332, 1335:1442)

### Router (auto mode)

- Decision JSON: `{ decision: 'chat'|'plan'|'clarify', category, entities, missing, confidence, question? }`
- Thresholds: `CLARIFY_THRESHOLD = 0.45`, `CHAT_THRESHOLD = 0.70` (server 554:556)
- Context snapshot: week range (Mon–Sun) and backlog sample assembled via index (server 62:75, 870:887)
- Clarify decoration: adds `question` and structured `options` with `(id,title,scheduledFor)` (server 921:937)

Clarify selection feedback:
- Client may pass `options.clarify.selection` with `ids`, `date`, `priority` to bias routing toward `plan` with a seeded `where` (server 911:919)

### Proposal generation

- Snapshot seeding: use focused `where` when router provides it; else top-K search (server 1189:1192, 1390:1394)
- Prompt schema constraints: require `recurrence` for create/update; require anchor when repeating; allow `bulk_*` ops and document `occurrenceDate`/`occurrence_range` for bulk completes (server 944:961)
- Parsing robustness:
  - Prefer JSON (`/api/generate` with `format: 'json'`) fallback to CLI
  - Extract `<response>...</response>` if Granite tags present (server 760:775, 768:775)
  - Strip code fences or brace-match first JSON object (server 783:813, 795:810)
- Operation shaping: `inferOperationShape` fills `op` when omitted; normalizes priority and `''→null` for scheduledFor (server 677:696)

Proposal context:
- Includes aggregates and either `topK` or `focused` snapshot based on router narrowing (server 1189:1192, 1390:1394)
- Example JSON scaffold provided in prompt to constrain format (server 949:960)

### Validation and repair

- `validateProposal` returns per-op errors from `validateOperation` (server 668:675, 597:665)
- One repair attempt via `buildRepairPrompt` using schema excerpt and last-3 transcript (server 853:867, 1231:1263)
- If repair fails, fall back to valid subset of first pass (server 1183:1189)

Common validation failures and repairs:
- Missing `recurrence` on create/update → insert `{type:'none'}` or propagate provided structure
- Repeating without anchor → inject/retain `scheduledFor` anchor
- Use `complete_occurrence` for repeating instead of `complete`; for bulk completes use `occurrenceDate` or `occurrence_range`
- Bulk set field shape/typing corrections

### Summarization

- Conversational summary via LLM with strict plain-text cleanup (strip Granite tags, remove code blocks, collapse whitespace) (server 1137:1156, 1420:1431)
- Deterministic fallback summary when LLM fails: counts and targets (server 1159:1181)

Granite cleanup specifics:
- Strip `<think>...</think>` entirely; unwrap `<response>...</response>` (server 772:775, 768:775)
- Remove code blocks via regex and collapse whitespace (server 783:813)

### Streaming (SSE)

- Events:
  - `stage`: routing → proposing → validating → repairing → summarizing
  - `clarify`: `{ question, options[] }` emitted early in auto mode
  - `ops`: `{ version, operations: [{ op, errors[] }], validCount, invalidCount }`
  - `summary`: `{ text }`
  - `result`: final payload including operations array
  - `done`: terminal event
- Heartbeat: every 10s (server 1402:1404)
- Chat-only: when router decides `chat`, only `summary` and `done` are emitted (server 1356:1384)

Client integration:
- `api.dart` uses `dart:html` EventSource, maps events to callbacks, and falls back to POST on error (api.dart 96:179)

### Idempotent apply (separate call)

- POST `/api/llm/apply` with optional `Idempotency-Key` header caches response for 10 minutes (server 559:569, 974:979, 1132:1133)
- Dry-run `/api/llm/dryrun` surfaces warnings for large bulk ops (server 1445:1481)

Safety thresholds:
- `MAX_DELETE_WARNING = 20`, `MAX_BULK_UPDATE_WARNING = 50` (server 556:557)



