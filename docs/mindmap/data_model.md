## Data Model and Persistence

This document specifies the Todo/Event/Habit/Goal schemas, recurrence semantics, occurrence expansion, and SQLite persistence.

### Persistence (SQLite)

- Database file: `data/app.db` (created on demand)
- Schema: `apps/server/database/schema.sql`
 - Tables (selected):
  - `todos(id, title, notes, scheduled_for, time_of_day, status, recurrence TEXT(JSON), completed_dates TEXT(JSON), skipped_dates TEXT(JSON), created_at, updated_at)`
  - `events(id, title, notes, scheduled_for, start_time, end_time, location, completed, recurrence TEXT(JSON), completed_dates TEXT(JSON), created_at, updated_at)`
  - `habits(id, title, notes, scheduled_for, time_of_day, completed, recurrence TEXT(JSON), completed_dates TEXT(JSON), created_at, updated_at)`
  - `goals(id, title, notes, status, current_progress_value, target_progress_value, progress_unit, created_at, updated_at)`
  - Linking tables: `habit_todo_items(habit_id, todo_id)`, `habit_event_items(habit_id, event_id)`, `goal_todo_items(goal_id, todo_id)`, `goal_event_items(goal_id, event_id)`, `goal_hierarchy(parent_goal_id, child_goal_id)`
  - Supporting: `audit_log(ts, action, entity, entity_id, payload)`, `idempotency(idempotency_key, request_hash, response, ts)`
  - FTS5 virtual tables: `todos_fts(title,notes)`, `events_fts(title,notes,location)`, `habits_fts(title,notes)` with triggers

### Todo schema (normalized)

- `id: number`
- `title: string`
- `notes: string`
- `scheduledFor: string|null` — `YYYY-MM-DD`; null for backlog
- `timeOfDay: string|null` — `HH:MM` or null (all-day)

 - `status: 'pending'|'completed'|'skipped'`
- `recurrence: Recurrence` — `{ type: 'none'|'daily'|'weekdays'|'weekly'|'every_n_days', intervalDays?: number, until?: YYYY-MM-DD|null }`
 - `completedDates?: string[]|null` — present on repeating masters; null or `[]` otherwise
 - `skippedDates?: string[]|null` — present on repeating masters; null or `[]` otherwise 
- `createdAt: ISO-8601 string`
- `updatedAt: ISO-8601 string`

Normalization highlights:
- Default `timeOfDay` to null; ensure `recurrence` with `type`; default `until` when absent
- For repeating, ensure `completedDates`/`skippedDates` arrays exist; master `status` defaults to `pending`

### Event schema (normalized)

- Same base fields as Todo with:
  - `startTime: string|null` (HH:MM)
  - `endTime: string|null` (HH:MM)
  - `location: string|null`

### Habit schema (normalized)

- Mirrors Todo with `timeOfDay`; recurrence should be repeating (API enforces non-`none` on create/update)
- Stats: derived fields when listing with a range `from`/`to` — `currentStreak: number`, `longestStreak: number`, `weekHeatmap: Array<{date, completed}>`

### Goal schema (normalized)

- `id, title, notes, status: 'active'|'completed'|'archived'`
- `currentProgressValue?: number|null`, `targetProgressValue?: number|null`, `progressUnit?: string|null`
- Optional `items` (`{todos, events}`) and `children` via joins

### Recurrence

- Types: `'none'|'daily'|'weekdays'|'weekly'|'every_n_days'`
- Anchor: `scheduledFor` is REQUIRED when `type != 'none'`
- `until?: YYYY-MM-DD|null`: cap expansion; `null` or `undefined` means no cap
- `intervalDays` for `every_n_days` must be integer >= 1

### Occurrence expansion

- Expand occurrences per day between `[from, to]` when listing with a range
- Each expanded occurrence uses the master `id` and sets `masterId = id`
- Status for repeating derived from dates: `completedDates` → completed; `skippedDates` → skipped; else pending
- Unified schedule items add `kind: 'todo'|'event'|'habit'` and appropriate time field (`timeOfDay` or `startTime`)

### Aggregates and snapshots

- Aggregates: counts over DB-backed queries (overdue, next 7 days, backlog, scheduled)
- Router snapshots: Mon–Sun window + backlog sample from DB (no in-memory index)

### Invariants

- For repeating: master `status` does not mark occurrences; use `completedDates`/`skippedDates` or occurrence endpoints/ops
- Switching repeating→none clears `completedDates`
- `timeOfDay`/`startTime` accept `HH:MM` or null
- `id` stable across edits; expanded occurrences are view constructs

### Durability and idempotency

- All CRUD writes persist to SQLite
- Assistant apply writes `audit_log` entries and caches responses in `idempotency`
- Idempotent replay returns cached response when the same `Idempotency-Key` and request hash are used



