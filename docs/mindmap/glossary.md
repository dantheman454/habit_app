## Glossary

- Anchor (date): The `scheduledFor` date on a repeating master that determines recurrence alignment. Required for any `recurrence.type != 'none'`. Server references: `validateOperation` anchor checks (server 625:627, 471:475).

- Occurrence: A per-day instance expanded from a repeating master within a range. Has `masterId = id`, `scheduledFor = occurrence date`, `completed` derived from `completedDates`. Built by `expandOccurrences` (server 258:287).

- CompletedDates: Array of `YYYY-MM-DD` on repeating masters marking which occurrences were completed. Toggled by `/api/todos/:id/occurrence` (server 506:529) and by `complete_occurrence` in LLM apply (server 968:975).

- Backlog: Todos with `scheduledFor = null`. Served by `/api/todos/backlog` and surfaced in snapshots (server 415:418, 63:77).

- Bulk operations: Not supported. Proposals attempting `bulk_*` are rejected with `bulk_operations_removed` during validation (server 860:864).

- Router: The auto-mode intent decision step that returns `{ decision, confidence, question? }` and may request `clarify`. Implemented in `runRouter` and prompt builders (server 811:887, 831:887).

- Idempotency: Apply endpoint deduplicates by `Idempotency-Key` for ~10 minutes (server 552:567, 919:939, 1038:1041).

- Apply lock: Single-process mutex `withApplyLock` serializes mutation to JSON files (server 916:918).

- Aggregates: Counts `{ overdueCount, next7DaysCount, backlogCount, scheduledCount }` from the index used for UI and prompts (index 143:157).

- Clarify options: Structured list `{ id, title, scheduledFor|null }[]` provided to guide user disambiguation; may be echoed back as `selection` to bias planning (server 871:880, 856:864).

- Idempotency-Key: Request header caching `apply` response to avoid re-applying the same changes; TTL ~10 minutes (server 552:567, 919:939).

- Snapshot (router): Compact view of week and backlog items used to ground routing decisions (server 63:77).



