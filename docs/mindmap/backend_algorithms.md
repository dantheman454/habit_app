## Backend Algorithms and Policies

This document enumerates server-side algorithms and strict policies. References map to functions/behaviors to reduce churn.

### Validation and normalization

- Primitive validators
  - `isYmdString(value)`: `^\d{4}-\d{2}-\d{2}$`
  - `isValidTimeOfDay(value)`: `^([01]\d|2[0-3]):[0-5]\d$` or null/undefined
  - `isValidRecurrence(rec)`: allowed types (`none|daily|weekdays|weekly|every_n_days`), `intervalDays>=1` for every_n_days, `until` shape nullable or YYYY-MM-DD

- Normalization helpers
  - Todos/Habits: default `timeOfDay` to null; ensure `recurrence.type` and default `until` to end-of-year; for todos ensure master `status` defaults to `pending` and for repeating ensure `completedDates`/`skippedDates` exist
  - `applyRecurrenceMutation(target, incoming)`: merges recurrence, ensures defaults, and clears `completedDates` when switching repeating→none

- Endpoint-level strictness
  - Todos Create/Update require a `recurrence` object; use `{type:'none'}` for non-repeating. Todos accept `status` (`pending|completed|skipped`) on update.
  - Repeating create/update must include an anchor `scheduledFor`
  - Habits: must be repeating when `recurrence` provided (and on create); anchor required
  - Events: time validation for `startTime/endTime` and anchor when repeating
  - Occurrence endpoints toggle `completedDates` by `occurrenceDate`

- Operation-level validation (MCP tools)
  - `validateProposal` requires `operations` array; maps V3 `{kind,action,...}` via `inferOperationShape`
  - Guards op kind, field shapes, recurrence/time/date constraints; rejects bulk operations; enforces recurrence + anchor rules
  - Todos: use `set_status` for master or occurrence updates (`{id, status, occurrenceDate?}`); `complete`/`complete_occurrence` on todos yields `use_set_status`
  - Events/Habits: `complete` (master for non-repeating) or `complete_occurrence` (repeating) remains valid; `complete_occurrence` requires `occurrenceDate`

### Recurrence and occurrences

- Rule evaluation: `matchesRule(date, anchor, recurrence)` implements: daily; weekdays (Mon–Fri); weekly (weekday equality); every_n_days (diff%step==0, diff>=0)
 - Expansion: `expandOccurrences(master, fromDate, toDate)` builds per-day instances. For todos, per-occurrence `status` is derived from `completedDates` and `skippedDates`.
- List handlers expand when both `from` and `to` are provided; otherwise filter masters; completed filter runs post-expansion

Edge behaviors:
- `until` caps expansion (null/undefined means no cap)
- Time ordering: null/empty time sorts before a set time

### Snapshots and aggregates

- Aggregates for prompts: computed from DB (overdue, next7Days, backlog, scheduled)
- Router snapshots: Mon–Sun week range + backlog sample from DB (not an in-memory index), with compact `{id,title,scheduledFor}`
- Clarify candidate ranking: token inclusion

### Assistant router and proposal pipeline

- Router thresholds: `CLARIFY_THRESHOLD = 0.45`, `CHAT_THRESHOLD = 0.70`
- Router prompt includes week snapshot + backlog and last-3 transcript; low confidence → `clarify` with structured `options`
- Clarify feedback: client may pass `options.clarify.selection` with `ids/date` to seed `where` and bias planning
- Proposal prompt: outputs JSON-only operations; enforces recurrence and anchor; includes topK/focused snapshot and aggregates
- Operation inference: `inferOperationShape` sets `op` when omitted; normalizes `scheduledFor: ''→null`
- Validation + single repair attempt: `buildRepairPrompt` uses schema excerpt and last-3 transcript; re-validate and fall back to valid subset
- Summarization: chat-style plain text; Granite tags stripped; deterministic fallback when LLM fails

### Operation execution via MCP tools

- Operations are executed through MCP tool calls rather than direct apply/dryrun endpoints
- `OperationProcessor` class handles validation and execution with transaction support
- MCP tools provide structured interface for CRUD operations on todos, events, habits, and goals
- Audit logging occurs during MCP tool execution
- Idempotency is handled at the MCP tool level

### Idempotency and auditing

- Idempotency cache: `Idempotency-Key` header (or `idempotencyKey` in body) + request hash stores/returns cached apply response
- Audit: DB `audit_log` receives entries across router, repair attempts, MCP tool execution, and errors
- Coverage: create/update/delete/complete/complete_occurrence for todos/events/habits and all `goal_*` operations

### Error messages catalog (quick reference)

- Endpoints: `invalid_title`, `missing_recurrence`, `invalid_notes`, `invalid_scheduledFor`, `invalid_timeOfDay`, `invalid_recurrence`, `missing_anchor_for_recurrence`, `invalid_completed`, `invalid_id`, `not_found`, `not_repeating`, `invalid_occurrenceDate`, plus event-specific `invalid_start_time`, `invalid_end_time`, `invalid_time_range`
 - MCP Tools: `invalid_operations`, `invalid_op`, `missing_or_invalid_id`, `id_not_found`, `use_complete_occurrence_for_repeating`, `use_set_status`, `bulk_operations_removed`, `too_many_operations`



