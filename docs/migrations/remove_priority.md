# Removal Plan: Eliminate priority from backend, frontend, and LLM

This document is a surgical, end-to-end guide to remove all priority levels (`low|medium|high`) from the database, server APIs, LLM pipeline, Flutter client, scripts, tests, and docs. It includes a migration plan, edits by file/area, verification steps, and rollback.

Status: Complete. DB schema updated, migration script added, backend and LLM updated, tests and docs aligned.

## Scope and intent

- Remove priority from all entities and surfaces (todos, events, habits) across DB, API, client, LLM, seeds, tests, and docs.
- Drop columns from the SQLite schema (not just ignore).
- Make breaking API/UI changes. Remove filters/fields. Remove ranking bonus. Remove examples and validation around priority.

## High-level phases

1) Database migration (drop columns) with backup and verification
2) Backend server changes (remove priority from endpoints, validation, ranking, serialization)
3) LLM pipeline changes (router and context)
4) Flutter client changes (API signatures, UI widgets, filters)
5) Scripts and seeds updates
6) Tests updates (unit + integration)
7) Docs updates (mindmap and API surface)
8) Final verification, cleanup, and release notes

Each phase includes a checklist and exact touchpoints.

---

## 1) Database migration (SQLite via better-sqlite3)

Tables affected: `todos`, `events`, `habits` (drop `priority` TEXT NOT NULL CHECK(...) DEFAULT 'medium').

SQLite cannot drop columns directly; we’ll rebuild each table without the column.

Pre-migration checklist
- [ ] Stop server processes that write the DB
- [ ] Backup DB files: `data/app.db*` and test DB: `data/test/app.db*`
- [ ] Confirm WAL mode (enabled in schema); migration script will handle in a single transaction

Schema changes
- Update `apps/server/database/schema.sql` to remove `priority` from the 3 CREATE TABLE definitions; no other changes required for FTS tables/triggers.

Migration script (Node, one transaction)
- Create `apps/server/database/migration_script.js` (or reuse if you prefer a different filename). The script will:
  1. BEGIN IMMEDIATE TRANSACTION
  2. Create new tables `todos_new`, `events_new`, `habits_new` without `priority`
  3. INSERT INTO new tables selecting all original columns except `priority`
  4. DROP original tables
  5. ALTER TABLE rename `_new` tables to original names
  6. Recreate triggers (or rely on schema.sql reapply step if you re-init)
  7. COMMIT
- Also re-seed FTS triggers as they reference title/notes only (no changes, included for completeness)

Reference SQL (for one table — repeat for events and habits with their specific columns)
```sql
-- todos
CREATE TABLE todos_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  scheduled_for TEXT NULL,
  time_of_day TEXT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  recurrence TEXT NOT NULL DEFAULT '{"type":"none"}',
  completed_dates TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO todos_new (id, title, notes, scheduled_for, time_of_day, completed, recurrence, completed_dates, created_at, updated_at)
SELECT id, title, notes, scheduled_for, time_of_day, completed, recurrence, completed_dates, created_at, updated_at
FROM todos;

DROP TABLE todos;
ALTER TABLE todos_new RENAME TO todos;
```

Verification after migration
- [ ] PRAGMA table_info on `todos`, `events`, `habits` to confirm no `priority`
- [ ] Run unit tests that hit DB service (after server/test code updates below)
- [ ] Manual smoke: start server, GET endpoints, ensure responses do not contain `priority`

Rollback
- Restore `data/app.db*` from backup
- Revert code changes to previous commit

---

## 2) Backend server changes (apps/server/server.js and DbService)

Touchpoints to remove/edit
- Filtering: remove all `where.priority` logic in list and schedule endpoints
- Serialization: remove `priority` from compact/list item representations
- Ranking: remove high-priority bonus in clarify/selection ranking
- Validation: remove `invalid_priority` error checks and any schema of accepted priority in create/update
- Request/response: remove `priority` field from request bodies; server should not accept/emit this field

Files and likely edits
- `apps/server/server.js`
  - Remove blocks like:
    - `if (typeof where.priority === 'string') { ... }`
    - compact mappers including `priority`
    - ranking score bonus: `if (item.priority === 'high') s += 0.25;` (or similar place if centralized)
  - Remove all occurrences that validate `priority` values and return `{ error: 'invalid_priority' }`
  - Update Joi/inline validation schemas or ad-hoc checks for create/update to no longer mention `priority`
  - Update all endpoint request parsing to ignore/remove `priority` from req.body and from responses
- `apps/server/database/DbService.js`
  - Remove `priority` from create/update method signatures and SQL statements for todos, events, habits
  - Ensure `INSERT` and `UPDATE` lists no longer reference `priority`
  - Confirm any default merging or object spread doesn’t include `priority`

API contract changes (breaking)
- Remove query parameters: `priority` from GET endpoints (schedule/backlog/etc.)
- Remove body fields: `priority` from POST/PUT bodies for todos/events/habits
- Remove error code `invalid_priority`

---

## 3) LLM pipeline changes (router/context)

Files
- `apps/server/llm/router.js`
  - Remove regex/css parsing for `priority` from free text; don’t set `w.priority`
- `apps/server/llm/context.js`
  - Remove filtering by `where.priority`
  - Remove `priority` from compact item shapes
  - Remove high-priority ranking bonus logic
  - Remove any defaulting of `priority` in snapshots

Docs/prompts (covered in section 7) must drop priority-related examples.

---

## 4) Flutter client changes (apps/web/flutter_app)

API layer
- `lib/api.dart`
  - Remove `priority` parameters from function signatures (fetchSchedule/backlog/create/update for todos/events/habits)
  - Remove adding `priority` to `queryParameters` and `body` maps
  - Update callers accordingly

UI widgets
- Remove `lib/widgets/priority_chip.dart`
- Remove all imports/usages:
  - `lib/widgets/todo_row.dart`
  - `lib/widgets/habits_tracker.dart`
- Adjust layouts where chips previously occupied space

Filtering
- Remove any UI state and controls related to priority filtering (tabs, chips)

Build verification
- `flutter pub get` should remain unaffected
- Build the web app and smoke test the views that previously showed priority

---

## 5) Scripts and seeds updates (scripts/*)

- `scripts/seed_tasks_and_events.js` and `scripts/seed_week_todos.js`
  - Remove `randomPriority()` helpers
  - Remove `priority` from `INSERT` statements and bind objects
  - Confirm data still seeds properly post schema change

---

## 6) Tests updates (tests/*)

Integration tests (`tests/run.js`)
- Remove `priority` fields from create/update operations
- Replace bulk update test that sets `priority` with setting `completed`

Unit tests (`tests/unit/dbservice.test.js`)
- Remove assertions about `priority`
- Update creates/updates to not include `priority`

Global
- Remove any references to `invalid_priority`

---

## 7) Docs updates (docs/mindmap/*)

Files with priority mentions (non-exhaustive; grep confirms these)
- `api_surface.md`: remove priority from query/body and error list
- `client_architecture.md`: remove priority filtering references
- `backend_algorithms.md`: remove compact `priority`, remove ranking bonus mentions; remove clarify feedback `priority`
- `llm_pipeline.md`: remove priority in clarify/options and normalization
- `glossary.md`: remove Priority entry and references
- `data_model.md`: remove priority from tables
- `assistant_chat_mindmap.md`: remove examples like “update my task ... high priority” and adjust flows

Docs verification
- Ensure no remaining `priority` mentions in docs and code comments

---

## 8) Verification, quality gates, and release notes

Quality gates
- Build: Node server starts without runtime errors; Flutter builds
- Lint/Typecheck: N/A for JS unless configured; compile Flutter
- Tests: `npm run test:all` (or the same script in package.json) must pass after updates
- Smoke: 
  - Create/update/list todos/events/habits
  - Fetch schedule/backlog without priority filters
  - LLM endpoints: dryrun/apply flows work without priority parsing or ranking effects

Release notes (breaking changes)
- Removed: `priority` field in todos/events/habits
- Removed: `priority` query parameter from schedule/backlog endpoints
- Removed: `invalid_priority` error code
- Removed: priority-related UI and filters
- Removed: priority parsing and ranking in LLM
- Database: `priority` columns dropped from `todos`, `events`, `habits`

---

## Execution checklist (concise)

DB
- [ ] Update `schema.sql` to exclude `priority`
- [ ] Add `apps/server/database/migration_script.js` to rebuild tables and copy data
- [ ] Backup and run migration for both prod and test DBs

Server
- [ ] Remove `where.priority` filters and `invalid_priority` checks
- [ ] Remove `priority` from response shapes and request parsing
- [ ] Remove ranking bonus based on priority
- [ ] Update DbService SQL and method signatures

LLM
- [ ] Remove priority parsing in `router.js`
- [ ] Remove priority filter/default/bonus and shape in `context.js`

Flutter
- [ ] Remove `priority` params from `lib/api.dart` methods and callers
- [ ] Delete `widgets/priority_chip.dart` and imports/usages; fix layouts
- [ ] Remove any priority filters in UI

Scripts/Seeds
- [ ] Remove `randomPriority()` and `priority` bindings from seed scripts

Tests
- [ ] Update integration/unit tests to not use/expect priority
- [ ] Replace bulk update on priority with another field

Docs
- [ ] Remove all mentions and examples of priority in mindmap docs

Verify
- [ ] Run unit + integration tests
- [ ] Manual smoke
- [ ] Commit with clear message and tag release

---

## Notes and edge cases

- WAL mode: Migration runs in a single transaction; backup DB files first.
- Unknown fields: If `priority` is still sent by any client, the server will ignore it; no special error is surfaced.
- FTS tables: No dependency on priority; no change required beyond standard trigger recreation.
- Client caching/local storage: Remove any locally stored priority values if they exist (search for usage).

---

## Proposed migration script outline (Node)

If using the existing npm script name:
- package.json already contains: `"db:migrate": "node apps/server/database/migration_script.js"`
- The file has been created with the following steps implemented:
  - Open DB with better-sqlite3
  - BEGIN IMMEDIATE
  - Execute rebuild for `todos`, `events`, `habits` as shown above
  - Recreate triggers (copy from `schema.sql` or re-run those sections)
  - COMMIT
  - Print summary

We can also embed `PRAGMA foreign_keys=OFF` temporarily during table moves if constraints block, then re-enable.

---

## Decisions (confirmed)

- Unknown fields policy: We won’t worry about legacy clients; if `priority` is present in a request, the server will ignore it. No new error code will be introduced.
- Migration script placement: Keep `apps/server/database/migration_script.js` and the existing `db:migrate` script in `package.json`.
- Tests: Update the bulk update case to set `completed` instead of `priority`.
- Docs: Update all mindmap and API docs in-place to remove priority references and examples.

With these decisions, the next step is to run the migration, remove priority usages across server/LLM/tests/client, then run tests and update docs as outlined above.

Progress log
- [x] Added `apps/server/database/migration_script.js` to drop priority columns
- [x] Enhanced LLM focused context to include events/habits when the client hints kinds
- [x] Updated `schema.sql` to remove priority
- [x] Removed priority across server endpoints/validation and DbService
- [x] Updated LLM router/context to stop scoring/filtering by priority
- [x] Updated tests and docs; added assistant SSE and non-stream tests
