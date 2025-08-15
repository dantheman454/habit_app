## LLM Pipeline (Router → Propose → Repair → Summarize)

This document details control flow, prompts, thresholds, parsing, and streaming.

### Modes

- `plan` (default): Generate operations, validate/repair, summarize; no routing step
- `chat`: Bypass operations and return a concise chat answer
- `auto`: Router decides `clarify|chat|plan`; may insert a clarification turn

Entrypoints: POST `/api/assistant/message` and GET `/api/assistant/message/stream` (server 1094:1214, 1216:1362)

### Router (auto mode)

- Decision JSON: `{ decision: 'chat'|'plan'|'clarify', category, entities, missing, confidence, question? }`
- Thresholds: `CLARIFY_THRESHOLD = 0.45`, `CHAT_THRESHOLD = 0.70` (server 547:549)
- Context snapshot: week range (Mon–Sun) and backlog sample assembled via index (server 63:77, 811:827)
- Clarify decoration: adds `question` and structured `options` with `(id,title,scheduledFor)` (server 866:881)

Clarify selection feedback:
- Client may pass `options.clarify.selection` with `ids`, `date`, `priority` to bias routing toward `plan` with a seeded `where` (server 856:864)

### Proposal generation

- Snapshot seeding: use focused `where` when router provides it; else top-K search (server 1111:1116, 1260:1264)
- Prompt schema constraints: require `recurrence` for create/update; require anchor when repeating; allow `bulk_*` ops (server 889:907)
- Parsing robustness:
  - Prefer JSON (`/api/generate` with `format: 'json'`) fallback to CLI
  - Extract `<response>...</response>` if Granite tags present (server 760:775, 768:775)
  - Strip code fences or brace-match first JSON object (server 1119:1137, 1268:1283)
- Operation shaping: `inferOperationShape` fills `op` when omitted; normalizes priority and `''→null` for scheduledFor (server 660:679)

Proposal context:
- Includes aggregates and either `topK` or `focused` snapshot based on router narrowing (server 1115:1117, 1260:1264)
- Example JSON scaffold provided in prompt to constrain format (server 900:904)

### Validation and repair

- `validateProposal` returns per-op errors from `validateOperation` (server 651:658, 590:649)
- One repair attempt via `buildRepairPrompt` using schema excerpt and last-3 transcript (server 794:809, 1165:1188, 1314:1328)
- If repair fails, fall back to valid subset of first pass (server 1180:1186)

Common validation failures and repairs:
- Missing `recurrence` on create/update → insert `{type:'none'}` or propagate provided structure
- Repeating without anchor → inject/retain `scheduledFor` anchor
- Use `complete_occurrence` for repeating instead of `complete`
- Bulk set field shape/typing corrections

### Summarization

- Conversational summary via LLM with strict plain-text cleanup (strip Granite tags, remove code blocks, collapse whitespace) (server 1045:1063, 1237:1251, 1343:1348)
- Deterministic fallback summary when LLM fails: counts and targets (server 1067:1088, 1249:1251)

Granite cleanup specifics:
- Strip `<think>...</think>` entirely; unwrap `<response>...</response>` (server 772:775, 768:775)
- Remove code blocks via regex and collapse whitespace (server 1121:1123, 1138:1140, 1341:1343)

### Streaming (SSE)

- Events:
  - `stage`: routing → proposing → validating → repairing → summarizing
  - `clarify`: `{ question, options[] }` emitted early in auto mode
  - `ops`: `{ version, operations: [{ op, errors[] }], validCount, invalidCount }`
  - `summary`: `{ text }`
  - `result`: final payload including operations array
  - `done`: terminal event
- Heartbeat: every 10s (server 1355:1357)

Client integration:
- `api.dart` uses `dart:html` EventSource, maps events to callbacks, and falls back to POST on error (api.dart 96:179)

### Idempotent apply (separate call)

- POST `/api/llm/apply` with optional `Idempotency-Key` header caches response for 10 minutes (server 552:567, 919:939, 1038:1041)
- Dry-run `/api/llm/dryrun` surfaces warnings for large bulk ops (server 1385:1394)

Safety thresholds:
- `MAX_DELETE_WARNING = 20`, `MAX_BULK_UPDATE_WARNING = 50` (server 549:551)



