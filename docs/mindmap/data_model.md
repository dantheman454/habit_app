## Data Model and Persistence

This document specifies the Todo/Event/Goal schemas, recurrence semantics, occurrence expansion, and SQLite persistence.

### Persistence (SQLite)

- Database file: `data/app.db` (created on demand)
- Schema: `apps/server/database/schema.sql`
- Tables (selected):
  - `todos(id, title, notes, scheduled_for, time_of_day, priority, completed, recurrence JSON, completed_dates JSON, created_at, updated_at)`
  - `events(id, title, notes, scheduled_for, start_time, end_time, location, priority, completed, recurrence JSON, completed_dates JSON, created_at, updated_at)`
  - `goals(id, title, notes, status, current_progress_value, target_progress_value, progress_unit, created_at, updated_at)`
  - Linking tables: `goal_todo_items(goal_id, todo_id)`, `goal_event_items(goal_id, event_id)`, `goal_hierarchy(parent_goal_id, child_goal_id)`
  - Supporting: `audit_log(ts, action, entity, entity_id, payload)`, `idempotency(idempotency_key, request_hash, response, ts)`

### Todo schema (normalized)

- `id: number`
- `title: string`
- `notes: string`
- `scheduledFor: string|null` — `YYYY-MM-DD`; null for backlog
- `timeOfDay: string|null` — `HH:MM` or null (all-day)
- `priority: 'low'|'medium'|'high'`
- `completed: boolean`
- `recurrence: Recurrence` — `{ type: 'none'|'daily'|'weekdays'|'weekly'|'every_n_days', intervalDays?: number, until?: YYYY-MM-DD|null }`
- `completedDates?: string[]` — only on repeating masters
- `createdAt: ISO-8601 string`
- `updatedAt: ISO-8601 string`

Normalization highlights:
- Default `timeOfDay` to null
- Ensure `recurrence` has `type`; default `until` when absent
- For repeating, ensure `completedDates` array exists
- Ensure `completed` boolean

### Event schema (normalized)

- Same base fields as Todo with:
  - `startTime: string|null` (HH:MM)
  - `endTime: string|null` (HH:MM)
  - `location: string|null`

### Goal schema (normalized)

- `id, title, notes, status: 'active'|'completed'|'archived'`
- `currentProgressValue?: number|null`, `targetProgressValue?: number|null`, `progressUnit?: string|null`
- Optional `items` and `children` via joins

### Recurrence

- Types: `'none'|'daily'|'weekdays'|'weekly'|'every_n_days'`
- Anchor: `scheduledFor` is REQUIRED when `type != 'none'`
- `until?: YYYY-MM-DD|null`: cap expansion; `null` means no cap
- `intervalDays` for `every_n_days` must be integer >= 1

### Occurrence expansion

- Functionally: expand occurrences per day between `[from, to]` when listing with a range
- Each expanded occurrence uses the master `id` for `id` and sets `masterId = id`
- Completion state for repeating is derived from `completedDates.includes(occurrenceDate)`

### Aggregates and snapshots

- Aggregates: counts over DB-backed queries (overdue, next 7 days, backlog, scheduled)
- Router snapshots: Mon–Sun week window plus backlog sample derived from DB (no in-memory index)

### Invariants

- For repeating: master `completed` does not mark occurrences; use `completedDates` or `complete_occurrence`
- Switching repeating→none clears `completedDates`
- `timeOfDay` accepts `HH:MM` or null
- `id` stable across edits; expanded occurrences are view-layer constructs

### Durability and idempotency

- All CRUD writes persist to SQLite
- Assistant apply writes `audit_log` entries and caches responses in `idempotency`
- Idempotent replay returns cached response when the same `Idempotency-Key` and request hash are used



