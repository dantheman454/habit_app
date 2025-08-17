## Glossary

- Anchor (date): The `scheduledFor` date on a repeating master that determines recurrence alignment. Required when `recurrence.type != 'none'`.

- Occurrence: A per-day instance expanded from a repeating master within a range. Has `masterId = id`, `scheduledFor = occurrence date`, `completed` derived from `completedDates`.

- CompletedDates: Array of `YYYY-MM-DD` on repeating masters marking which occurrences were completed. Toggled by `/api/*/:id/occurrence` and by `complete_occurrence` in apply.

- Backlog: Todos with `scheduledFor = null`. Served by `/api/todos/backlog`; also used in router snapshots.

- Unified schedule: Range-based view that merges todos, events, and habits. Items carry `kind` and kind-specific time fields; repeating are expanded within `[from,to]`.

- Bulk operations: Not supported. Proposals attempting `bulk_*` are rejected with `bulk_operations_removed`.

- Router: Auto-mode decision step returning `{ decision, confidence, question? }`; may ask to clarify and includes `options` for disambiguation.

- Clarify options: Structured list `{ id, title, scheduledFor|null }[]` to guide selection. The client may return a `selection` object `{ ids?, date? }` to bias planning.

- Idempotency: Apply endpoint deduplicates by `Idempotency-Key` + request hash to avoid re-applying the same changes.

- Audit log: Append-only records of assistant and CRUD actions written during apply.

- Habits: Repeating-only items (recurrence must not be `none`) with optional `timeOfDay` and derived stats `currentStreak`, `longestStreak`, `weekHeatmap` when listed with a range.

- Goals: High-level objectives with optional progress fields and links to todos/events and child goals.

- SSE events: Streaming assistant emits `stage`, `clarify`, `ops`, `summary`, `result`, periodic `heartbeat`, and `done`.



- Time formats: Dates are `YYYY-MM-DD`; `timeOfDay`, `startTime`, `endTime` are `HH:MM` or null.

- Recurrence: `{ type: 'none'|'daily'|'weekdays'|'weekly'|'every_n_days', intervalDays?, until? }`; for repeating, anchor required and `until` may be null (no cap).



