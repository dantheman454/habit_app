## Data Model and Persistence

This document specifies the Todo schema, recurrence semantics, occurrence expansion, and persistence files and invariants.

### Files

- `data/todos.json`: authoritative array of Todo objects
- `data/counter.json`: `{ nextId: number }`
- `data/audit.jsonl`: append-only audit lines
- References: `apps/server/server.js` 17:23, 98:101, 101:118, 119:133

### Todo schema (normalized)

Fields present on master todos and expanded occurrences unless noted:

- `id: number` — identifier; same as `masterId` for occurrences
- `masterId?: number` — only on expanded occurrences; equals the master `id`
- `title: string`
- `notes: string`
- `scheduledFor: string|null` — `YYYY-MM-DD`; null for backlog
- `timeOfDay: string|null` — `HH:MM` 24h or null (all-day)
- `priority: 'low'|'medium'|'high'`
- `completed: boolean` — for masters (non-repeating) or for expanded occurrences (derived from `completedDates`)
- `recurrence: Recurrence` — see below; on non-repeating tasks, `{ type: 'none', until: YYYY-12-31 }`
- `completedDates?: string[]` — only on repeating masters; dates `YYYY-MM-DD` marked done per occurrence
- `createdAt: ISO-8601 string`
- `updatedAt: ISO-8601 string`

Normalization rules: `apps/server/server.js` 135:161

- Default `timeOfDay` to null when absent
- Default `recurrence` to `{ type: 'none', until: endOfCurrentYear }` when absent; preserve provided `until` when defined
- When `recurrence.type != 'none'`, ensure `completedDates` is an array
- Ensure `completed` boolean exists (defaults to false)

Creation: `createTodo(...)` applies normalization, increments `nextId`, stamps timestamps, persists `counter.json` (server 175:191)
Update: updates mutable fields; merges `recurrence` with defaults; handles completedDates lifecycle; stamps `updatedAt` (server 478:500)

### Recurrence

Type union: `'none'|'daily'|'weekdays'|'weekly'|'every_n_days'` (server 216:228, 239:256)

- Anchor date: `scheduledFor` on the master is REQUIRED when `type != 'none'`
- `until?: YYYY-MM-DD|null`: cap expansion; `null` means no cap
- `intervalDays` (for `every_n_days`): integer >= 1, step from anchor

Validation: `isValidRecurrence` and validators in `validateOperation` (server 216:228, 590:649)

Edge cases:
- `until === undefined` → default `YYYY-12-31` for current year (server 147:152, 491:491, 949:949, 994:994)
- `until === null` → no cap in expansion; loop only bounded by request `[from,to]` (server 262:269)
- `timeOfDay === ''` from client normalized to `null` in handlers (server 338:339, 486:486)

### Occurrence expansion

Function: `expandOccurrences(todo, fromDate, toDate)` (server 258:287)

- Iterates dates from `max(fromDate, anchor)` to inclusive end-of-day for `toDate`
- Stops at `until` if provided
- Emits occurrences when `matchesRule(date, anchor, recurrence)` is true
- Each occurrence:
  - `id = master.id`
  - `masterId = master.id`
  - `scheduledFor = occurrenceDate`
  - `completed` computed from `completedDates.includes(dateStr)`

Rule matching: `matchesRule` (server 239:256)
- `daily`: always true
- `weekdays`: Monday–Friday only
- `weekly`: same weekday as anchor
- `every_n_days`: `daysBetween(anchor, date) % intervalDays == 0` and non-negative

### Index aggregates and filters

Index module: `apps/server/todos_index.js`

- Tokenization and scoring: `tokenize`, `searchByQuery` (1:3,25:31,69:98)
- Overdue and next-7 window: `isOverdue`, `withinNextDays` (36:53)
- Filters: `filterByWhere(where)` supports `ids`, `title_contains`, `overdue`, `scheduled_range{from,to}`, `priority`, `completed`, `repeating` (100:141)
- Aggregates: `getAggregates()` returns `{ overdueCount, next7DaysCount, backlogCount, scheduledCount }` (143:157)

Tokenization/scoring details:
- Title matches weigh 3, note matches weigh 1; minor overdue bonus (0.5) (index 81:93)
- Query-less fallback prioritizes scheduled soon (sorted by `scheduledFor`) then backlog (index 74:80)

### Invariants

- For any master with `recurrence.type != 'none'`:
  - `scheduledFor` must be a valid `YYYY-MM-DD`
  - `completed` flag on master is not used to mark occurrences; use `completedDates`
  - Completing an occurrence toggles membership of `occurrenceDate` in `completedDates`
- When a repeating task switches to `type: 'none'`, `completedDates` is cleared (server 492:495)
- `timeOfDay` accepts `HH:MM` 24h or null; client uses null to indicate all-day
- `id` is stable; operations that change recurrence do not change `id`
- Expanded occurrences use master `id`; client distinguishes with `masterId!=null` (main.dart 1267:1281)

### Persistence & durability

- Synchronous writes for todos/counter ensure immediate durability (server 113:117, 130:133)
- Apply path uses a single-process mutex to serialize multi-op writes (server 916:918)
- Audit lines appended for all mutating LLM ops; CRUD endpoints do not append audit by design (server 936, 961, 967, 976, 1006, 1016, 1027)



