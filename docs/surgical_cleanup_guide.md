## Surgical Cleanup and Hardening Guide

Audience: backend and client developers. This guide encodes the accepted decisions and provides precise edits, file moves, validation rules, and test updates to refactor the codebase safely.

## Repo Bearings

- Purpose: Habit/todo/events system with MCP tools and a Flutter Web client. Node/Express backend with SQLite persistence, LLM-assisted operations, and tests.
- Key components:
  - Server (`apps/server/`): Express app, routing, operations, MCP, LLM, database access.
  - Web client (`apps/web/flutter_app/`): Flutter Web UI calling the REST API.
  - Database (`data/app.db` via Better-Sqlite3): schema + seeds.
  - Tests (`tests/`): Node test runner covering DB, ops, router, and integration.
- Entrypoints:
  - Server process: `apps/server/server.js` (start with `npm start`).
  - Tests: `npm test` (runs `tests/all.js`).
  - DB migration/seed: `apps/server/database/migration_script.js` (wrapped by `scripts/rebuild_db.sh`).
- Tooling:
  - Node >= 20; Express 5; Better-Sqlite3; Nodemon for dev.
  - Flutter (client tests via `flutter test`, client build under `build/web`).
  - LLM scaffolding under `apps/server/llm/*` and MCP server under `apps/server/mcp/mcp_server.js`.
- High-level file map:
  - `apps/server/database/` – `DbService.js`, `schema.sql`, migration/seed scripts.
  - `apps/server/llm/` – chat/router/context/agents; logs under `logs/llm/`.
  - `apps/server/operations/` – validators, executors, registry, processor.
  - `apps/server/server.js` – bootstrap (DB schema, static, import `app.js`, listen).
  - `apps/server/app.js` – Express init and router mounting.
  - `apps/server/routes/*` – modular route handlers.
  - `apps/web/flutter_app/` – `lib/` widgets, views, API client; `test/`.
  - `scripts/` – db helpers, seeds, test helpers.
  - `docs/` – mindmaps, APIs, this guide.

### Decisions (confirmed)
- Recurrence types: use only `none`, `daily`, `weekdays`, `weekly`, `every_n_days`.
- Anchor requirement: if `recurrence.type != 'none'`, `scheduledFor` is required on create/update.
- Events completion: remove completion semantics; events are not “completed”, they can be updated or deleted only.
- Required dates: todos and events cannot be unscheduled; default to “today” at the API if omitted.
- Context: restrict to `school`, `personal`, `work`.
- Tests: add request validation, remove legacy behaviors; align expectations accordingly.
- MCP tools: choose intuitive surface; see below for the unified set.

---

## Phase 0 – Prep and plan (no code movement yet)

1) Create work branch: `git checkout -b refactor/surgical-cleanup`
2) Snapshot docs: skim `docs/mindmap/*` and confirm they remain the source of truth after edits.
3) Ensure tests pass on main to have a clean baseline.

---

## Phase 1 – Utilities extraction (dedupe helpers)

Create `apps/server/utils/` and move shared logic out of `server.js`.

- `apps/server/utils/date.js`
  - `ymd(date: Date): string`
  - `parseYMD(ymd: string): Date|null`
  - `addDays(date: Date, n: number): Date`
  - `weekRangeFromToday(tz: string): { fromYmd, toYmd }` (Sunday–Saturday)
  - `ymdInTimeZone(date: Date, tz: string): string`

- `apps/server/utils/recurrence.js`
  - `isYmdString(value: unknown): boolean`
  - `isValidTimeOfDay(value: unknown): boolean` (HH:MM or null)
  - `isValidRecurrence(rec: any): boolean` (allowed = `none|daily|weekdays|weekly|every_n_days`; `intervalDays>=1` for every_n_days; `until` valid YMD or null)
  - `daysBetween(a: Date, b: Date): number`
  - `matchesRule(date: Date, anchor: Date, recurrence): boolean`
  - `expandOccurrences(master, fromDate, toDate): Occurrence[]` (used by schedule/unified expansion)

- `apps/server/utils/normalize.js`
  - `endOfCurrentYearYmd(): string`
  - `normalizeTodo(todo)` → apply defaults; for repeating, ensure arrays
  - `normalizeHabit(habit)` → default to daily; ensure arrays
  - `applyRecurrenceMutation(targetTodo, incomingRecurrence)` → clear/init arrays on transitions

- `apps/server/utils/filters.js`
  - `filterTodosByWhere(where)`
  - `filterItemsByWhere(items, where)`
  - `getAggregatesFromDb(db)` (overdue/next7/backlog/scheduled)

Edit `apps/server/llm/context.js` to import from `utils/date` and `utils/filters` (single source for router snapshots). Delete duplicate `buildRouterSnapshots()` in `server.js` (Phase 3).

---

## Phase 2 – Route modularization

Create thin route modules and central app bootstrap.

- `apps/server/app.js` (new)
  - Express init, CORS, JSON body limit, error handler
  - Mount routers listed below
  - Export Express app; keep `server.js` as the process entry (static hosting + listen)

- `apps/server/routes/health.js`
- `apps/server/routes/todos.js`
- `apps/server/routes/events.js`
- `apps/server/routes/habits.js`
- `apps/server/routes/goals.js`
- `apps/server/routes/search.js`
- `apps/server/routes/schedule.js`
- `apps/server/routes/assistant.js` (SSE + POST)
- `apps/server/routes/llm.js`

Each router should:
- Validate request with Ajv schemas (Phase 4)
- Use `DbService` and `utils/*` helpers
- Return errors as `{ error: code }` with documented status codes

Edit `apps/server/server.js`:
- Keep only:
  - bootstrap DB (`schema.sql` read + `db.bootstrapSchema`)
  - static hosting
  - import and use app from `app.js`
  - start HTTP server
- Remove in-file helpers moved to `utils/*` and any route handlers now living under `routes/*`.

---

## Phase 3 – Data model and invariants

1) Schema updates (`apps/server/database/schema.sql`):
   - Todos: enforce `scheduled_for NOT NULL` (drop backlog capability)
   - Events: enforce `scheduled_for NOT NULL`
   - Events: remove `completed` column and `completed_dates` column
   - Habits: keep as is (repeating-only remains enforced at API/validators)
   - Context: `CHECK(context IN ('school','personal','work'))`
   - Todos: `CHECK(status IN ('pending','completed','skipped'))`
   - Recurrence default: `'{"type":"none"}'` for todos/events; daily for habits

2) Migration/rebuild path:
   - Because data is synthetic, prefer rebuild:
     - Update `scripts/seed_*` and `scripts/db_dump.js` if needed
     - Add `scripts/rebuild_db.sh` or node script to:
       - remove `data/app.db*`
       - run schema
       - run seed scripts

3) API defaulting behavior:
   - When creating/updating todos/events and `scheduledFor` is absent or null, set to `today` (TZ = `America/New_York`).
   - Reject repeating items without an anchor (`scheduledFor` required if `recurrence.type!='none'`).

4) Remove backlog API:
   - Delete `/api/todos/backlog` and any server-side backlog logic
   - Update snapshots in `llm/context` to not rely on backlog (use week-only or sampled pending items that are scheduled)

---

## Phase 4 – Validation unification (Ajv + OperationValidators)

1) Operation validators (`apps/server/operations/validators.js`):
   - Allowed recurrence set = `none|daily|weekdays|weekly|every_n_days` (remove `monthly`,`yearly`)
   - Enforce `missing_recurrence` on create/update (todos, events, habits)
   - If repeating, require `scheduledFor` anchor (error `missing_anchor_for_recurrence`)
   - Events: remove `event_set_occurrence_status` validator (no completion semantics)

2) Ajv request schemas (per route):
   - Colocate Ajv validators inside each route file (easiest path). Export tiny shared constants for enums if needed.
   - Mirror the same rules as OperationValidators (keep literals in sync with a shared `RECURRENCE_TYPES` export in `utils/recurrence.js`).
   - Map errors to documented error codes from `docs/mindmap/api_surface.md`.
   - Example (todos.create):
     - body: `{ title: string, notes?: string, scheduledFor?: YMD|null, timeOfDay?: HH:MM|null, recurrence: { type: enum, intervalDays?, until? }, context?: enum }`
     - runtime: if `scheduledFor` omitted or null → default to today; if `recurrence.type!='none'` AND no scheduledFor → 400 `missing_anchor_for_recurrence`.

3) DbService guardrails (`apps/server/database/DbService.js`):
   - On create/update for todos/events: coerce `scheduledFor ||= today` if absent.
   - Throw when repeating and no anchor.
   - Remove event completion toggles and related methods for events.
   - Update event CRUD to drop all use of `completed` and `completed_dates`.
   - Update `_mapEvent` to exclude removed fields.

4) Server error semantics for removed behaviors:
   - Any client attempt to complete/toggle event occurrences should return `400 { error: 'not_supported' }`.

---

## Phase 5 – Operations, MCP, and LLM alignment

1) OperationRegistry (`apps/server/operations/operation_registry.js`):
   - Remove `event_set_occurrence_status`
   - Keep:
     - `todo_create`, `todo_update`, `todo_delete`, `todo_set_status` (supports optional `occurrenceDate` for repeating todos)
     - `event_create`, `event_update`, `event_delete` (no completion)
     - `habit_create`, `habit_update`, `habit_delete`, `habit_set_occurrence_status`

2) MCP server (`apps/server/mcp/mcp_server.js`):
   - Tools:
     - `todo.set_status` (parameters: `{ id, status: 'pending'|'completed'|'skipped', occurrenceDate?: YMD }`)
     - `habit.set_occurrence_status` (parameters: `{ id, occurrenceDate: YMD, status: 'pending'|'completed'|'skipped' }`)
     - CRUD tools for todos/events/habits aligned to recurrence rules
   - Remove event completion tools
   - Ensure `convertToolCallToOperation()` maps to the registry consistently

   Migration notes:
   - Delete registrations and schema for: `set_event_occurrence_status`, `complete_event_occurrence`.
   - If any UI/assistant flows reference those, surface a clear summary: "Event completion is not supported; consider converting to a todo or marking done elsewhere."

3) LLM router/context:
   - `llm/context.js`: import snapshots from utilities; sample week-only items
   - `llm/router.js`: no change required beyond snapshot shape alignment

---

## Phase 6 – Client adjustments (Flutter)

1) Remove backlog usage:
   - Delete calls to `fetchBacklog()` and any backlog UI
   - Ensure quick-add defaults date to today when omitted

2) Events UI:
   - Remove completion toggles/actions for events; keep edit/delete only
   - If an action tries to call removed endpoints, display a snackbar: "Event completion is not supported."

3) Create/update flows:
   - Ensure todos/events always pass `scheduledFor` (or rely on server default); surface the chosen date in UI

4) Assistant panel expectations:
   - When assistant generates operations for events, do not expect completion actions
   - Todos/habits completion remain supported

---

## Phase 7 – Tests and docs

1) Update unit tests (`tests/unit/`):
   - Remove/replace tests expecting event occurrence toggling
   - Add tests covering:
     - Missing `recurrence` → error on create/update
     - Repeating with missing anchor → error
     - Defaulting `scheduledFor` to today when omitted for todos/events
     - Recurrence set does not accept `monthly`/`yearly`; accepts `weekdays`

   File-level checklist:
   - `tests/unit/dbservice.test.js`
     - Remove usage of `toggleEventOccurrence` and assertions on `event.completedDates`.
     - Add assertions that creating/updating events without `scheduledFor` results in today.
   - `tests/unit/operation_registry.test.js`, `validators.test.js`
     - Update recurrence enum expectations and anchor checks.
   - `tests/unit/router_chat_act.test.js`
     - Ensure snapshots no longer reference backlog items.

2) Add route-level tests for validation errors and success paths for todos/events/habits/goals/search/schedule.

3) Update integration tests in `tests/llm/suite/*` if they reference event completion or backlog.

4) Refresh docs:
   - `docs/mindmap/api_surface.md`: remove backlog endpoint; update validation rules; remove event completion endpoints; clarify defaulting to today.
   - `docs/mindmap/backend_algorithms.md`: recurrence set, anchor requirement, snapshot changes; remove event completion rules.
   - `docs/mindmap/client_architecture.md`: remove backlog flows and event completion UI references.

---

## Exact edit checklist (by file)

- `apps/server/server.js`
  - Remove: in-file `weekRangeFromToday`, `buildRouterSnapshots`, recurrence helpers, normalization helpers, filters
  - Add: import `app.js`, keep static hosting and bootstrap

- Search-and-remove duplicate helpers from `server.js` (move to `utils/*`):
  - `ymd`, `ymdInTimeZone`, `parseYMD`, `addDays`, `daysBetween`
  - `isYmdString`, `isValidTimeOfDay`, `isValidRecurrence`
  - `matchesRule`, `expandOccurrences`
  - `normalizeTodo`, `normalizeHabit`, `applyRecurrenceMutation`
  - `filterTodosByWhere`, `filterItemsByWhere`, `getAggregatesFromDb`

- `apps/server/app.js` (new)
  - Create express app, mount routers, Ajv, error middleware

- `apps/server/utils/*` (new)
  - Implement functions copied from `server.js` (one place only)

- `apps/server/llm/context.js`
  - Use utilities; ensure backlog removed; week snapshot only

- `apps/server/database/schema.sql`
  - Enforce NOT NULL dates on todos/events; remove event `completed` + `completed_dates`
  - Update triggers/FTS definitions if they reference removed columns.

- `apps/server/database/DbService.js`
  - Remove event completion toggle methods: `toggleEventOccurrence` and any references.
  - Coerce missing `scheduledFor` to today for todos/events.
  - Enforce repeating-with-anchor.
  - Update `createEvent`, `updateEvent`, `_mapEvent` to drop `completed` and `completedDates`.

- `apps/server/operations/validators.js`
  - Recurrence set tightening; anchor enforcement; remove event occurrence status

- `apps/server/operations/operation_registry.js`
  - Remove event occurrence status registration

- `apps/server/operations/executors.js`
  - Remove event occurrence status executor; ensure others align
  - Ensure todo/habit behavior unchanged; todo.set_status supports optional `occurrenceDate`.

- `apps/server/mcp/mcp_server.js`
  - Replace/rename tools to `todo.set_status`, `habit.set_occurrence_status`; delete event status tools

- `apps/server/routes/*` (new)
  - Implement REST endpoints with Ajv validation; map errors to `{ error }`

- `apps/web/flutter_app/lib/api.dart`
  - Remove backlog methods; adjust event operations (no completion)

- `tests/unit/*`
  - Update per Phase 7

- `scripts/*`
  - Add rebuild script; update seeds; wipe synthetic DB

---

## Error codes and mapping

Use existing codes; ensure these are consistently returned by routes:
- `invalid_body` – Ajv request body failed
- `invalid_title`
- `invalid_scheduledFor`
- `invalid_timeOfDay`
- `invalid_start_time` / `invalid_end_time` / `invalid_time_range`
- `invalid_context`
- `missing_recurrence`
- `missing_anchor_for_recurrence`
- `invalid_recurrence`
- `not_supported` – event completion attempts
- `create_failed` / `update_failed` / `delete_failed`
- `search_failed` / `schedule_error`
- `not_found`

---

## Rollout plan

1) Implement Phase 1–5 on server; run unit tests.
2) Update client (Phase 6) and restore green widget tests if any.
3) Update docs/tests (Phase 7); run `npm test` and `flutter test`.
4) Rebuild DB: run new rebuild script; start server; smoke test CRUD and assistant flows.
5) Merge PR with clear migration note: “events completion removed; backlog removed; dates now required for todos/events; default to today.”

Commands (example):
- Rebuild: `rm -f data/app.db data/app.db-* && node scripts/seed_tasks_and_events.js && node scripts/seed_week_todos.js`
- Run tests: `npm test && (cd apps/web/flutter_app && flutter test)`
- Start server: `npm start`

---

## MCP tool surface (final)

- `todo.create`, `todo.update`, `todo.delete`, `todo.set_status`
  - set_status supports optional `occurrenceDate` for repeating todos
- `event.create`, `event.update`, `event.delete`
  - no completion tools
- `habit.create`, `habit.update`, `habit.delete`, `habit.set_occurrence_status`

Internally, `convertToolCallToOperation()` should map these 1:1 to registry types.

---

## QA checklist

- Creating a todo/event without `scheduledFor` results in a scheduled item for today
- Creating repeating without `scheduledFor` fails with `missing_anchor_for_recurrence`
- Event completion attempts return `400 { error: 'not_supported' }` (or `404` if route removed)
  - We return 400 per decision.
- Backlog endpoint is absent; client no longer calls it
- LLM snapshots do not reference backlog and remain stable
- Recurrence type validation rejects `monthly`/`yearly` and accepts `weekdays`

---

## Notes

- Keep `TZ_NAME=America/New_York` as the canonical default; utilities should centralize this.
- Prefer Ajv schemas colocated with each route, and export shared definitions for recurrence and dates from a single module under `utils/validation_schemas.js` if desired.


## Session Outcomes (current work)

- Added `scripts/rebuild_db.sh` to wrap full reset + seed via `apps/server/database/migration_script.js`.
- Rebuilt DB successfully; baseline Node tests are green via `npm test`.
- Removed event completion across ops/MCP/server/DB/client/tests; server now returns `{ error: 'not_supported' }` for `PATCH /api/events/:id/occurrence`.
- Removed backlog endpoint and client usage.
- Added Ajv dependency for upcoming route validation.
- Introduced `apps/server/utils/recurrence.js` and `apps/server/utils/date.js` as the initial utilities extract.
- Completed route modularization: created `apps/server/app.js` and extracted `routes/health.js`, `routes/todos.js`, `routes/events.js`, `routes/habits.js`, `routes/goals.js`, `routes/search.js`, `routes/schedule.js`, `routes/assistant.js`, and `routes/llm.js`. `server.js` now bootstraps and serves static assets.
- LLM context and snapshots aligned with new utils and backlog removal.

## Next TODOs (minimal, testable)

1) Refresh mindmaps to reflect final surface and invariants
   - Update: `docs/mindmap/api_surface.md`, `backend_algorithms.md`, `client_architecture.md`.
2) Optional: add lightweight route-level tests for `search` and `schedule`
   - Happy-path + basic validation errors; keep tests green.


