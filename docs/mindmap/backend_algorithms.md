## Backend Algorithms and Policies

This document enumerates server-side algorithms and strict policies with file/line references.

### Validation and normalization

- Primitive validators
  - `isYmdString(value)` → regex `^\d{4}-\d{2}-\d{2}$` (server 219:221)
  - `isValidTimeOfDay(value)` → regex `^([01]\d|2[0-3]):[0-5]\d$` or null/undefined (server 223:227)
  - `isValidRecurrence(rec)` → type guard, allowed types, `intervalDays>=1`, `until` shape (server 229:241)

- Todo normalization (server 142:160)
  - Default `timeOfDay` to null
  - Ensure `recurrence` has `type` and default `until`
  - Ensure `completedDates` array exists for repeating
  - Ensure `completed` boolean

- Endpoint-level strictness
  - Create and Update require a `recurrence` object; use `{type:'none'}` for non-repeating (server 339:341, 485:487)
  - Repeating create/update must include a valid anchor `scheduledFor` (server 357:361, 489:493)
  - Completing a repeating task via master `complete` is forbidden in apply validation (use `complete_occurrence`) (server 622:626)

- Operation-level validation (apply path)
  - `validateProposal` enforces presence of `operations` array (server 867:874)
  - `validateOperation` guards op kind, field shapes, and recurrence/time/date constraints; bulk operations are rejected (server 817:865, 860:864)
  - For `complete_occurrence`, requires valid `occurrenceDate` and boolean `completed` if provided (server 841:844)

### Recurrence and occurrences

- Rule evaluation: `matchesRule(date, anchor, recurrence)` — see types in Data Model (server 252:269)
- Expansion: `expandOccurrences(master, fromDate, toDate)` builds per-day instances with `completed` flag derived from `completedDates` (server 271:300)
- List handler expands whenever `from,to` are provided (server 410:423). Without a range, returns scheduled masters optionally filtered (server 392:407). Post-expansion filter honors `completed` (server 424:429).

Edge behaviors:
- `weekdays` uses JS weekday 1..5 (Mon..Fri) (server 256:258)
- `weekly` matches `getDay()` equality with anchor (server 260:262)
- `every_n_days` computes `daysBetween(anchor,date) % step == 0` and `diff >= 0` (server 263:268)

### Snapshots and aggregates

- Aggregates: counts from DB-backed search used for assistant prompts (server 125:143)
- Router snapshots: Mon–Sun week range + backlog sample derived from DB, not an in-memory index (server 145:152)

Router snapshots builder:
- Computes Mon–Sun week range in given timezone (server 42:60)
- Snapshot contents: compact `{ id, title, scheduledFor, priority }` for week and backlog sample (server 62:75)
- Clarify candidates scored by token inclusion plus small high-priority bonus (server 78:95)

### Assistant router and proposal pipeline

- Router thresholds: `CLARIFY_THRESHOLD = 0.45`, `CHAT_THRESHOLD = 0.70` (server 554:556)
- Router prompt construction embeds Monday–Sunday snapshot and backlog sample; when low confidence, rewrites to `clarify` (server 870:887)
- Clarify augmentation: attaches concise options of top candidates (server 921:937)
- Proposal prompt: instructs LLM to output JSON-only operations; enforces recurrence requirements; includes aggregates/topK snapshot; use `complete_occurrence` for repeating items (server 1171:1183)
- Operation inference: `inferOperationShape` sets `op` when omitted (server 677:696)
- Validation pass: `validateProposal` + `validateOperation` returns per-op errors (server 668:675, 597:665)
- Single repair attempt: builds a repair prompt with schema excerpt and last-3 transcript; re-validate (server 853:867, 1231:1263)
- Conversational summary: plain-text post-plan summary; Granite tags stripped; deterministic fallback available (server 1137:1156, 1420:1431)

Determinisic summary details:
- Counts created/updated/deleted/completed; previews created titles (up to 2) and dates (up to 2) (server 1159:1181)

### Idempotency and auditing

- Idempotency cache: header `Idempotency-Key` (or body `idempotencyKey`) deduplicates apply responses (server 1201:1210, 1465:1466)
- Audit: entries recorded via DB (`audit_log`); assistant/apply path emits audit entries throughout apply (server 1235:1453)

Audit coverage per op (apply path): create/update/delete/complete/complete_occurrence (todo/event) and goal operations write audit entries; invalid ops and caught errors are logged with `result: 'invalid'|'error'`.
### Error messages catalog (quick reference)

- Endpoints: `invalid_title`, `missing_recurrence`, `invalid_notes`, `invalid_scheduledFor`, `invalid_priority`, `invalid_timeOfDay`, `invalid_recurrence`, `missing_anchor_for_recurrence`, `invalid_completed`, `invalid_id`, `not_found`, `not_repeating`, `invalid_occurrenceDate`
- Apply/validate: `invalid_op`, `missing_or_invalid_id`, `id_not_found`, `use_complete_occurrence_for_repeating`, bulk where/set invalidations


### Error taxonomy (selected)

- Proposal/validation errors: `invalid_op`, `invalid_priority`, `invalid_scheduledFor`, `invalid_timeOfDay`, `invalid_recurrence`, `missing_recurrence`, `missing_anchor_for_recurrence`, `missing_or_invalid_id`, `id_not_found`, `invalid_occurrenceDate`, `invalid_completed`, `use_complete_occurrence_for_repeating` (server 590:649)
- CRUD-level errors on endpoints mirror the above; see create/update/occurrence handlers (server 320:355, 446:503, 506:529)


