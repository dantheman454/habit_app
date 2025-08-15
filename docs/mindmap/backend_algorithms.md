## Backend Algorithms and Policies

This document enumerates server-side algorithms and strict policies with file/line references.

### Validation and normalization

- Primitive validators
  - `isYmdString(value)` → regex `^\d{4}-\d{2}-\d{2}$` (server 206:208)
  - `isValidTimeOfDay(value)` → regex `^([01]\d|2[0-3]):[0-5]\d$` or null/undefined (server 210:214)
  - `isValidRecurrence(rec)` → type guard, allowed types, `intervalDays>=1`, `until` shape (server 216:228)

- Todo normalization (server 143:161)
  - Default `timeOfDay` to null
  - Ensure `recurrence` has `type` and default `until`
  - Ensure `completedDates` array exists for repeating
  - Ensure `completed` boolean

- Endpoint-level strictness
  - Create and Update require a `recurrence` object; use `{type:'none'}` for non-repeating (server 325:346, 467:470)
  - Repeating create/update must include a valid anchor `scheduledFor` (server 344:347, 471:475)
  - Completing a repeating task via master `complete` is forbidden in apply validation (use `complete_occurrence`) (server 615:619)

- Operation-level validation (apply path)
  - `validateProposal` enforces presence of `operations` array (server 651:658)
  - `validateOperation` guards op kind, field shapes, id existence, and bulk where/set shapes (server 590:649)
  - For `complete_occurrence`, requires valid `occurrenceDate` and boolean `completed` if provided (server 611:613)

### Recurrence and occurrences

- Rule evaluation: `matchesRule(date, anchor, recurrence)` — see types in Data Model (server 239:256)
- Expansion: `expandOccurrences(master, fromDate, toDate)` builds per-day instances with `completed` flag derived from `completedDates` (server 258:287)
- List handler expands whenever `from,to` are provided (server 397:410). Without a range, returns scheduled masters optionally filtered (server 375:393).

Edge behaviors:
- `weekdays` uses JS weekday 1..5 (Mon..Fri) (server 243:246)
- `weekly` matches `getDay()` equality with anchor (server 247:249)
- `every_n_days` computes `daysBetween(anchor,date) % step == 0` and `diff >= 0` (server 250:254)

### Indexing and retrieval

- In-memory index lifecycle: `init`, `refresh`, `setTimeZone` (index 55:67)
- Query-less ranking: scheduled soon first, then backlog (index 69:98)
- `filterByWhere` implements where-clause for bulk ops and router narrowing (index 100:141)
- Aggregates: counts for today windowing and UI badges (index 143:157)

Router snapshots builder:
- Computes Mon–Sun week range in given timezone (server 43:61)
- Snapshot contents: compact `{ id, title, scheduledFor, priority }` for week and backlog sample (server 63:77)
- Clarify candidates scored by token inclusion plus small high-priority bonus (server 80:96)

### Assistant router and proposal pipeline

- Router thresholds: `CLARIFY_THRESHOLD = 0.45`, `CHAT_THRESHOLD = 0.70` (server 547:549)
- Router prompt construction embeds Monday–Sunday snapshot and backlog sample; when low confidence, rewrites to `clarify` (server 811:829)
- Clarify augmentation: attaches concise options of top candidates (server 866:881)
- Proposal prompt: instructs LLM to output JSON-only operations; enforces recurrence requirements; includes aggregates/topK snapshot (server 889:907)
- Operation inference: `inferOperationShape` sets `op` when omitted (server 660:679)
- Validation pass: `validateProposal` + `validateOperation` returns per-op errors (server 651:658, 590:649)
- Single repair attempt: builds a repair prompt with schema excerpt and last-3 transcript; re-validate (server 794:809, 1165:1188)
- Conversational summary: plain-text post-plan summary; Granite tags stripped; deterministic fallback available (server 1045:1063, 1190:1207)

Deterministic summary details:
- Counts created/updated/deleted/completed; previews created titles (up to 2) and dates (up to 2) (server 1067:1088)

### Idempotency, locking, and auditing

- Idempotency cache: header `Idempotency-Key` (or body `idempotencyKey`) deduplicates apply responses for 10 minutes (server 552:567, 919:939, 1038:1041)
- Apply mutex: `withApplyLock` serializes write operations to JSON files (server 916:918)
- Audit: append `{ ts, action, op, result, id?, error? }` to `data/audit.jsonl` (server 911:914, various append sites 936, 961, 967, 976, 1006, 1016, 1027)

Audit coverage per op (apply path):
- create/update/delete/complete/complete_occurrence/bulk_update/bulk_complete/bulk_delete each write an audit entry
- Invalid op and caught errors also logged with `result: 'invalid'|'error'`
### Error messages catalog (quick reference)

- Endpoints: `invalid_title`, `missing_recurrence`, `invalid_notes`, `invalid_scheduledFor`, `invalid_priority`, `invalid_timeOfDay`, `invalid_recurrence`, `missing_anchor_for_recurrence`, `invalid_completed`, `invalid_id`, `not_found`, `not_repeating`, `invalid_occurrenceDate`
- Apply/validate: `invalid_op`, `missing_or_invalid_id`, `id_not_found`, `use_complete_occurrence_for_repeating`, bulk where/set invalidations


### Error taxonomy (selected)

- Proposal/validation errors: `invalid_op`, `invalid_priority`, `invalid_scheduledFor`, `invalid_timeOfDay`, `invalid_recurrence`, `missing_recurrence`, `missing_anchor_for_recurrence`, `missing_or_invalid_id`, `id_not_found`, `invalid_occurrenceDate`, `invalid_completed`, `use_complete_occurrence_for_repeating` (server 590:649)
- CRUD-level errors on endpoints mirror the above; see create/update/occurrence handlers (server 320:355, 446:503, 506:529)


