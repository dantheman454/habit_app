## Maintenance and Update Guide (Bulk Ops Removal, Docs Refresh, Modularization)

Status (2025-08-15): Code-side bulk removal complete; client model pruned; assistant pipeline validated. Docs refresh remains.

Audience: contributors maintaining the Habit app server/client. This guide captures agreed updates:

- Remove bulk operations completely
- Refresh docs to match SQLite persistence and current APIs
- Modularize the monolithic server file without functional changes
- Clarify strategy for events/goals exposure in the client (see Options below)

### Repo map (current state)

- Server: `apps/server/server.js`
- DB layer: `apps/server/database/DbService.js`, schema at `apps/server/database/schema.sql`
- Migration: `apps/server/database/migration_script.js` (JSON → SQLite)
- Client (Flutter Web): `apps/web/flutter_app/lib/*.dart`
- Scripts: `scripts/db_dump.js`
- Docs (mindmap): `docs/mindmap/*`

Entrypoints and tooling:

- Start server: `npm start` (Node 20.x, Express 5, SQLite via `better-sqlite3`)
- Tests: `npm run test:unit`, `npm run test:integration`, `npm run test`
- DB migration: `npm run db:migrate`
- Client served as static build from `apps/web/flutter_app/build/web` when present

---

## 1) Remove bulk operations completely

Target: Eliminate dead/unreachable bulk code paths, warnings, and doc references. Keep functionality equivalent (no bulk).

Scope of change (server):

- Validation (keep rejecting bulk ops): unchanged — still returns `bulk_operations_removed` when a bulk op is proposed.
- Apply path: removed handlers for `bulk_update`, `bulk_complete`, `bulk_delete` in `/api/llm/apply`.
- Dry-run: removed bulk warnings/logic.
- Note: ID existence checks are deferred to the apply stage to avoid false negatives across mixed-kind batches (e.g., events). Apply handlers still enforce 404 semantics.
- Helper functions previously used by bulk: `filterTodosByWhere` remains for router snapshots and focused selection; `getAggregatesFromDb` remains used by router.

Scope of change (docs/client):

- Remove bulk op documentation from `docs/mindmap/*` (API surface, LLM pipeline). (PENDING)
- Flutter: bulk-related fields removed from `LlmOperation` model in `apps/web/flutter_app/lib/main.dart`:
  - Removed: `where`, `setFields` (serialized as `set`), and `occurrenceRange` (serialized as `occurrence_range`).
  - Updated: serialization/deserialization pruned; UI contains no bulk hints.
  - `AssistantPanel` labeling and checkbox logic remain unchanged for non-bulk ops.
  - Remove any unit/widget tests referencing bulk fields. If none exist, record a note in the PR. Quick scan:
    ```bash
    rg "bulk_|occurrence_range|setFields|where\s*[:=]" -n apps/web tests -S
    ```

Checkpoints:

- Code branches removed in server apply/dry-run; Flutter model pruned.
  ```bash
  rg "bulk_(update|complete|delete)" -n apps/server apps/web -S
  # no results expected in code after this change
  ```
- Tests confirm: unit and integration pass; dry-run annotates bulk ops as `bulk_operations_removed`.

---

## 2) Docs refresh to reflect SQLite, no in-memory index, no JSON persistence (DO THIS NOW)

Targets: `docs/mindmap/*.md`

- Replace JSON-file persistence references with SQLite (`better-sqlite3`) and `schema.sql`.
- Remove references to `todos_index.js` and any “in-memory index.”
- Update API Surface to include Events and Goals endpoints; remove bulk operations.
  - Add explicit request/response shapes in `docs/mindmap/api_surface.md` for:
    - Events: `POST /api/events`, `GET /api/events`, `GET /api/events/:id`, `PATCH /api/events/:id`, `PATCH /api/events/:id/occurrence`, `DELETE /api/events/:id`, `GET /api/events/search`
    - Goals: `POST /api/goals`, `GET /api/goals`, `GET /api/goals/:id?includeItems&includeChildren`, `PATCH /api/goals/:id`, `DELETE /api/goals/:id`, `POST /api/goals/:id/items`, `DELETE /api/goals/:goalId/items/todo/:todoId`, `DELETE /api/goals/:goalId/items/event/:eventId`, `POST /api/goals/:id/children`, `DELETE /api/goals/:parentId/children/:childId`
  - For each, document parameters, validation errors, and example success JSON (mirror server behavior).
  - Prefer minimal INLINE examples under each endpoint (request and response snippets), plus a short consolidated “Types” section for shared shapes (e.g., `Event`, `Goal`, `Recurrence`).
- Update Backend Algorithms to match server code (validators, recurrence rules, router snapshots built from DB queries, thresholds: `CLARIFY_THRESHOLD=0.45`, `CHAT_THRESHOLD=0.70`).
- Update LLM Pipeline to reflect V3 schema wrapper (`kind`, `action`) and no bulk ops.
- Update Data Model to align fields with DB mapping (`scheduled_for`→`scheduledFor`, etc.).
- Update mindmap diagrams now:
  - In `docs/mindmap/README.md` Mermaid graph, change Persistence to `data/app.db (SQLite)` and remove `counter.json`, `audit.jsonl` arrows from server (or note audit now in DB table `audit_log`).
  - Remove any in-memory index nodes; note snapshots are derived from DB queries.
  - Label the Persistence node explicitly: `SQLite (data/app.db)` with tables: `todos`, `events`, `goals`, `audit_log`, `idempotency`.
  - Adjust the sequence diagram to remove JSON file writes and show explicit DB interactions:
    - CRUD: `API -> DB: INSERT/UPDATE/DELETE todos|events|goals`
    - Assistant apply: `API -> DB: INSERT/UPDATE/DELETE todos|events|goals`, `API -> DB: INSERT audit_log`, `API -> DB: INSERT OR REPLACE idempotency`
    - Note: CRUD endpoints do not append audit; apply path does

Line references caveat:

- Update line references to match current `apps/server/server.js` now. After modularization, update them again or switch references to function names/sections to reduce churn.

Suggested acceptance checklist:

- [ ] README mindmap diagram updated
- [ ] `api_surface.md` aligned with current endpoints and parameters
- [ ] `backend_algorithms.md` references line ranges in `server.js` updated
- [ ] `llm_pipeline.md` removes bulk ops and reflects V3 wrapper
- [ ] `data_model.md` shows SQLite tables and mapped shapes
- [ ] `client_architecture.md` notes assistant-only exposure (until decision on UI)

---

## 3) Modularize `apps/server/server.js` (no functional changes)

Goal: Improve readability/testability by extracting pure helpers and route groups. No API or behavior changes.

Proposed module split (incremental PRs):

1) Utilities
   - `apps/server/util/dates.js`: `ymd`, `ymdInTimeZone`, `parseYMD`, `addDays`, `daysBetween`
   - `apps/server/util/validators.js`: `isYmdString`, `isValidTimeOfDay`, `isValidRecurrence`

2) Domain helpers
   - `apps/server/domain/recurrence.js`: `matchesRule`, `expandOccurrences`, `applyRecurrenceMutation`, `normalizeTodo`, `endOfCurrentYearYmd`
   - `apps/server/domain/snapshots.js`: `filterTodosByWhere` (if kept), `getAggregatesFromDb`, `buildRouterSnapshots`, `topClarifyCandidates`

3) LLM integration
   - `apps/server/llm/ollama.js`: `runOllamaPrompt`, `tryRunOllamaJsonFormat`, `runOllamaForJsonPreferred`, `isGraniteModel`, `stripGraniteTags`, `extractResponseBody`, `parseJsonLenient`
   - `apps/server/llm/planner.js`: `inferOperationShape`, `validateOperation`, `validateProposal`, `buildSchemaV2Excerpt`, `buildRepairPrompt`, `buildProposalPrompt`, `buildConversationalSummaryPrompt`, router builders

4) Routes (grouped)
   - `apps/server/routes/todos.js`
   - `apps/server/routes/events.js`
   - `apps/server/routes/goals.js`
   - `apps/server/routes/assistant.js`

5) Entry
   - `apps/server/app.js`: compose Express app, mount routes, serve static

Execution plan:

- Move pure functions first (no imports back from `server.js`), add unit tests for extracted modules.
- Relink route handlers to use imports; keep file exports and environment variables identical.
- Run existing tests and a manual smoke test (`/health`, CRUD, assistant SSE) after each step.

---

## 4) Tests and verification (recommended additions)

- Add integration tests for HTTP endpoints using Node test runner:
  - CRUD: `/api/todos` list/create/update/delete; `/api/todos/search`
  - Event/Goal minimal CRUD (happy paths)
  - Assistant POST `/api/assistant/message`: mock Ollama by stubbing `runOllama*` functions to deterministic strings
- Keep current `DbService` unit tests; add tests for removed bulk behavior (ensure validation rejects).

Run tests:
```bash
npm run test:unit
npm run test:integration
```

Recent runs (2025-08-15):

- Unit: 5/5 passing
- Integration: OK (server running) — verified `/api/events` CRUD, `/api/assistant` SSE/POST auto pipeline, `idempotency` cache, and V3 apply paths; bulk ops rejected at validation.

---

## 5) Optional polish (no behavior change)

- Remove legacy artifacts and nits:
  - Delete unused `mutatedSinceRefresh` flag and JSON-era comments
  - Remove unused constants like `COUNTER_FILE` if not referenced
  - Delete unused helpers (e.g., `loadAllTodos`) if truly unused after refactor
- Timezone consistency: use a single helper for all date comparisons to respect `TIMEZONE`

---

## 6) Events/Goals exposure in client (explanation and options)

Today:

- Server exposes full Events and Goals APIs and LLM supports `kind: "event"|"goal"` operations.
- Flutter client only surfaces Todos; assistant can still create/update events/goals but the user can’t browse them.

Options (choose one):

1) Assistant-only (status quo)
   - Pros: zero UI work now; keeps UI focused
   - Cons: users cannot browse/edit events/goals directly; operations feel “invisible”

2) Thin API wrappers only (no UI yet)
   - Add `api.dart` methods for events/goals (list/create/update/delete/search)
   - Pros: unblocks other clients; enables quick scripts/testing; small change
   - Cons: still no UI visibility; users rely on assistant or scripts

3) Minimal UI surfacing
   - Sidebar badges for Events/Goals with simple lists and CRUD dialogs (mirroring Todos)
   - Pros: visible and actionable; moderate scope
   - Cons: increases UI footprint; more QA

Recommendation: Start with (2) in a small PR, then (3) if we want parity. If we stay with (1), explicitly document that events/goals are assistant-only and unsupported in UI.

---

## 7) Assistant ops diff and undo (from scratchpad idea)

Idea: Show a recent-ops history in the Assistant panel and support one-click undo per op set.

Design sketch:

- Track last N applied operation sets client-side (include `Idempotency-Key`, timestamp, compact labels).
- Implement symmetric inverse ops where feasible:
  - create → delete
  - delete → recreate (requires storing prior snapshot of the deleted item)
  - update → update with previous values (need before/after diff)
  - complete/complete_occurrence → toggle back
- Server support: none required if the client generates inverse ops correctly; optional endpoint to fetch an op-set audit trail by idempotency key could improve robustness.
- Scope: separate PR after the core cleanups above.

---

## PR sequencing (suggested)

1) Remove bulk ops (server code + docs references + client type pruning)
2) Docs refresh (mindmap files)
3) Modularize server utilities (first extraction wave)
4) Add integration tests + timezone helper consolidation
5) Optional: events/goals API wrappers (if choosing Option 2)
6) Optional: assistant undo feature

---

## Rollback plan

- Each PR is functionally isolated. If an issue arises, revert the PR via Git, re-run tests, and re-open with fixes.

---

## Acceptance checklist (overall)

- [ ] No references to bulk ops in docs; validation still rejects them with a clear error (code OK; docs PENDING)
- [ ] Mindmap/docs match SQLite persistence and live endpoints
- [ ] Server compiles and passes tests; behavior unchanged for non-bulk flows
- [ ] Optional steps executed per chosen options


