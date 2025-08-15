## API Surface and Couplings

Audience: backend and client developers. Covers endpoints, payload shapes, validation rules, and concrete coupling to Flutter `api.dart`.

### Cross-cutting concerns

- Content type and size: JSON bodies up to 256kb (server 293:294)
- CORS enabled, `x-powered-by` disabled (server 291:293)
- Static assets served after API routes from `STATIC_DIR` (server 1403:1406)

### Endpoints (server)

- Health
  - GET `/health` → `{ ok: true }`
  - Source: `apps/server/server.js` 297:299

- List scheduled (optionally expanded occurrences)
  - GET `/api/todos`
  - Query: `from?: YYYY-MM-DD`, `to?: YYYY-MM-DD`, `priority?: low|medium|high`, `completed?: true|false`
  - Response: `{ todos: Todo[] }` where `Todo` are masters when no range is supplied; when `from,to` are present, returns expanded occurrences within range
  - Source: `apps/server/server.js` 358:412
  - Behavior details:
    - When `from,to` are provided, repeating tasks are expanded into daily occurrences across the closed-open interval `[from, to+1d)`; non-repeating tasks are included once if within range (server 397:410)
    - Without a range, returns scheduled masters optionally filtered by `priority` and `completed` (server 375:393)
    - Input validation errors: `invalid_from`, `invalid_to`, `invalid_priority`, `invalid_completed`

- Backlog (unscheduled only)
  - GET `/api/todos/backlog` → `{ todos: Todo[] }`
  - Source: `apps/server/server.js` 415:418

- Search (title or notes)
  - GET `/api/todos/search?query=<text>&completed=true|false`
  - Response: `{ todos: Todo[] }`
  - Source: `apps/server/server.js` 421:434

- Get by id
  - GET `/api/todos/:id` → `{ todo: Todo }`
  - Source: `apps/server/server.js` 437:443

- Create
  - POST `/api/todos`
  - Body: `{ title: string, notes?: string, scheduledFor?: YYYY-MM-DD|null, priority?: 'low'|'medium'|'high', timeOfDay?: 'HH:MM'|null, recurrence: Recurrence }`
  - Strict policy: recurrence object is REQUIRED; use `{ type: 'none' }` for non-repeating.
  - For repeating recurrence, `scheduledFor` anchor is REQUIRED.
  - Response: `{ todo: Todo }`
  - Source: `apps/server/server.js` 320:355
  - Validation matrix:
    - `title`: required non-empty string → `invalid_title`
    - `recurrence`: required object with `type` → `missing_recurrence`/`invalid_recurrence`
    - `scheduledFor`: must be `YYYY-MM-DD|null|undefined`; if repeating `type!=none`, anchor REQUIRED → `missing_anchor_for_recurrence`
    - `timeOfDay`: `HH:MM|null|''` ('' normalized to null) → `invalid_timeOfDay`
    - `priority`: in `low|medium|high` → `invalid_priority`

- Update by id
  - PATCH `/api/todos/:id`
  - Body (partial): `title?`, `notes?`, `scheduledFor?`, `priority?`, `completed?`, `timeOfDay?`, `recurrence?`
  - Strict policy: recurrence object REQUIRED on update as well. For repeating recurrence, anchor must exist (either in patch or existing).
  - Response: `{ todo: Todo }`
  - Source: `apps/server/server.js` 446:503
  - Validation matrix (differences from Create):
    - `id`: path param must be int → `invalid_id`, 404 → `not_found`
    - `recurrence`: REQUIRED; for repeating, anchor must exist in patch or existing record → `missing_recurrence`, `missing_anchor_for_recurrence`
    - `completed`: boolean → `invalid_completed`
    - Normalization: if recurrence changes from repeating→none, clear `completedDates`; ensure `until` defaulted (server 488:498, 491)

- Complete occurrence (repeating only)
  - PATCH `/api/todos/:id/occurrence` with `{ occurrenceDate: YYYY-MM-DD, completed?: boolean }`
  - Mutates `completedDates` on master
  - Response: `{ todo: Todo }`
  - Source: `apps/server/server.js` 506:529
  - Notes:
    - Validates `occurrenceDate` strictly; toggles membership in master `completedDates`
    - Returns 400 `not_repeating` if target is non-repeating

- Delete by id
  - DELETE `/api/todos/:id` → `{ ok: true }`
  - Source: `apps/server/server.js` 531:541

- Assistant — auto pipeline (non-streaming)
  - POST `/api/assistant/message` with `{ message: string, transcript?: {role,text}[], options?: { clarify?: object } }`
  - Returns `{ text: string, operations: { op: LlmOperation, errors: string[] }[] }` or a clarification `{ requiresClarification: true, question }`.
  - Source: `apps/server/server.js` 1094:1214

- Assistant — auto pipeline (SSE streaming)
  - GET `/api/assistant/message/stream` query: `message`, `transcript`, `clarify?`
  - Events: `stage`, `clarify`, `ops`, `summary`, `result`, `done`
  - Source: `apps/server/server.js` 1216:1362

- LLM Apply (idempotent via header `Idempotency-Key`)
  - POST `/api/llm/apply` `{ operations: LlmOperation[] }` → `{ results, summary }`
  - Validation and per-op application; bulk operations expand `where` via index.
  - Source: `apps/server/server.js` 919:1041
  - Operation coverage:
    - `create|update|delete|complete|complete_occurrence|bulk_update|bulk_complete|bulk_delete`
    - Bulk ops expand `where` via index: `filterByWhere` (index 100:141)
  - Side effects: persist todos, refresh index, append audit

- LLM Dry-run
  - POST `/api/llm/dryrun` `{ operations: LlmOperation[] }` → `{ results, summary, warnings? }`
  - Source: `apps/server/server.js` 1365:1401
  - Warnings:
    - `bulk_delete` over `MAX_DELETE_WARNING` (20)
    - `bulk_update` over `MAX_BULK_UPDATE_WARNING` (50)
    - Source: server 1389:1394, constants 549:551

### Client couplings (Flutter `api.dart`)

- Base URL resolution: `_computeApiBase()` selects origin when served via Express; otherwise defaults to `http://127.0.0.1:3000` (api.dart 6:15).
- CRUD/search/backlog methods map 1:1 to endpoints above (api.dart 17:68).
- Assistant message wrapper supports POST and SSE, with callbacks for `onSummary`, `onClarify`, `onStage`, `onOps` (api.dart 70:189).
- Apply and dry-run wrappers: `applyOperations`, `dryRunOperations` (api.dart 191:199).

### Status codes and error strings (quick index)

- 200: successful responses per endpoint
- 400: validation failures (strings listed above per endpoint)
- 404: `not_found` for missing id (server 479:480, 536:537)
- 500: internal error handler returns `{ error: 'internal_error' }` (server 1408:1411)

### Error contracts (selected)

- Common 400 errors on CRUD: `invalid_title`, `missing_recurrence`, `invalid_notes`, `invalid_scheduledFor`, `invalid_priority`, `invalid_timeOfDay`, `invalid_recurrence`, `missing_anchor_for_recurrence` (create/update), `invalid_completed`, `invalid_id`.
- Assistant apply/dryrun: returns `invalid_operations` with per-op `errors` array; see `validateProposal` and `validateOperation` for exact strings (server 651:658, 590:649).

### Types

- Todo: see [Data Model](./data_model.md).
- Recurrence: `{ type: 'none'|'daily'|'weekdays'|'weekly'|'every_n_days', intervalDays?: int (>=1), until?: YYYY-MM-DD|null }`.
- LlmOperation: one of `create|update|delete|complete|complete_occurrence|bulk_update|bulk_complete|bulk_delete` plus fields; normalization/inference may fill `op` when omitted.

### Endpoint → Client usage map

- `/api/todos` → `fetchScheduled`, `fetchScheduledAllTime`
- `/api/todos/backlog` → `fetchBacklog`
- `/api/todos/search` → `searchTodos`
- `/api/todos` (POST) → `createTodo`
- `/api/todos/:id` (PATCH) → `updateTodo`
- `/api/todos/:id/occurrence` (PATCH) → `updateOccurrence`
- `/api/todos/:id` (DELETE) → `deleteTodo`
- `/api/assistant/message` → `assistantMessage` (POST fallback)
- `/api/assistant/message/stream` → `assistantMessage` (SSE)
- `/api/llm/apply` → `applyOperations`
- `/api/llm/dryrun` → `dryRunOperations`


