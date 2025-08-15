## Data Model and Persistence

This document specifies the Todo schema, recurrence semantics, occurrence expansion, and persistence files and invariants.

### Files

- `data/todos.json`: authoritative array of Todo objects
- `data/counter.json`: `{ nextId: number }`
- `data/audit.jsonl`: append-only audit lines
- References: `apps/server/server.js` 17:23, 100:116, 118:133

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

Normalization rules: `apps/server/server.js` 142:160

- Default `timeOfDay` to null when absent
- Default `recurrence` to `{ type: 'none', until: endOfCurrentYear }` when absent; preserve provided `until` when defined
- When `recurrence.type != 'none'`, ensure `completedDates` is an array
- Ensure `completed` boolean exists (defaults to false)

Creation: `createTodo(...)` applies normalization, increments `nextId`, stamps timestamps, persists `counter.json` (server 188:204)
Update: updates mutable fields; merges `recurrence` with defaults; handles completedDates lifecycle; stamps `updatedAt` (server 496:506)

### Recurrence

Type union: `'none'|'daily'|'weekdays'|'weekly'|'every_n_days'` (server 229:241, 252:269)

- Anchor date: `scheduledFor` on the master is REQUIRED when `type != 'none'`
- `until?: YYYY-MM-DD|null`: cap expansion; `null` means no cap
- `intervalDays` (for `every_n_days`): integer >= 1, step from anchor

Validation: `isValidRecurrence` and validators in `validateOperation` (server 229:241, 597:665)

Edge cases:
- `until` default is provided by `endOfCurrentYearYmd()` and enforced by `applyRecurrenceMutation` when absent (server 135:140, 167:171)
- `until === null` → no cap in expansion; loop only bounded by request `[from,to]` (server 275:279)
- `timeOfDay === ''` from client normalized to `null` in handlers (server 351:353, 499:500)

### Occurrence expansion

Function: `expandOccurrences(todo, fromDate, toDate)` (server 271:300)

- Iterates dates from `max(fromDate, anchor)` to inclusive end-of-day for `toDate`
- Stops at `until` if provided
- Emits occurrences when `matchesRule(date, anchor, recurrence)` is true
- Each occurrence:
  - `id = master.id`
  - `masterId = master.id`
  - `scheduledFor = occurrenceDate`
  - `completed` computed from `completedDates.includes(dateStr)`

Rule matching: `matchesRule` (server 252:269)
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
  - Completing an occurrence toggles membership of `occurrenceDate` in `completedDates` (server 524:531, 1014:1021)
- When a repeating task switches to `type: 'none'`, `completedDates` is cleared (server 168:172)
- `timeOfDay` accepts `HH:MM` 24h or null; client uses null to indicate all-day
- `id` is stable; operations that change recurrence do not change `id`
- Expanded occurrences use master `id`; client distinguishes with `masterId!=null` (main.dart ~1263:1275)

### Persistence & durability

- Synchronous writes for todos/counter ensure immediate durability (server 112:116, 129:133)
- Apply path uses a single-process mutex to serialize multi-op writes (server 971:973)
- Audit lines appended for all mutating LLM ops; CRUD endpoints do not append audit by design (server 966:969; apply path throughout 989–1116)



