## API Surface and Couplings

Audience: backend and client developers. Covers endpoints, payload shapes, validation rules, and concrete coupling to Flutter `api.dart`.

### Cross-cutting concerns

- Requests/Responses: JSON; body limit 256kb
- CORS enabled; `x-powered-by` disabled
- Static assets (Flutter Web build) are mounted after API routes from `STATIC_DIR`

### Endpoints (server)

- Health
  - GET `/health` → `{ ok: true }`

- Todos
  - GET `/api/todos`
    - Query: `from?: YYYY-MM-DD`, `to?: YYYY-MM-DD`, `priority?: low|medium|high`, `completed?: true|false`
    - When both `from` and `to` are provided, repeating todos are expanded into per-day occurrences over `[from, to+1d)`; otherwise returns scheduled masters (optionally filtered)
    - Response: `{ todos: Todo[] }`
  - GET `/api/todos/backlog` → `{ todos: Todo[] }` (unscheduled only)
  - GET `/api/todos/search?query=<text>&completed=true|false` → `{ todos: Todo[] }`
  - GET `/api/todos/:id` → `{ todo: Todo }`
  - POST `/api/todos`
    - Body: `{ title: string, notes?: string, scheduledFor?: YYYY-MM-DD|null, priority?: 'low'|'medium'|'high', timeOfDay?: 'HH:MM'|null, recurrence: Recurrence }`
    - Strict: `recurrence` object is required; use `{ type: 'none' }` for non-repeating. If repeating, `scheduledFor` anchor is required.
    - Response: `{ todo: Todo }`
  - PATCH `/api/todos/:id`
    - Partial body: `title?`, `notes?`, `scheduledFor?`, `priority?`, `completed?`, `timeOfDay?`, `recurrence?`
    - Strict: `recurrence` object is required on update; if repeating, an anchor date must exist (patch or existing)
    - Response: `{ todo: Todo }`
  - PATCH `/api/todos/:id/occurrence` with `{ occurrenceDate: YYYY-MM-DD, completed?: boolean }` → `{ todo: Todo }`
  - DELETE `/api/todos/:id` → `{ ok: true }`

- Events
  - GET `/api/events` with same query/filter semantics as todos; expands when both `from`/`to` provided → `{ events: Event[] }`
  - GET `/api/events/search?query=<text>&completed=...` → `{ events: Event[] }`
  - GET `/api/events/:id` → `{ event: Event }`
  - POST `/api/events` → `{ event: Event }`
  - PATCH `/api/events/:id` → `{ event: Event }`
  - PATCH `/api/events/:id/occurrence` with `{ occurrenceDate, completed? }` → `{ event: Event }`
  - DELETE `/api/events/:id` → `{ ok: true }`

- Habits
  - GET `/api/habits` with optional `from`/`to`/`priority`/`completed`
    - Returns scheduled masters and, when both `from`/`to` are provided, includes derived stats: `currentStreak`, `longestStreak`, `weekHeatmap`
  - GET `/api/habits/search?query=<text>&completed=...` → `{ habits: Habit[] }`
  - GET `/api/habits/:id` → `{ habit: Habit }`
  - POST `/api/habits` (must be repeating) → `{ habit: Habit }`
  - PATCH `/api/habits/:id` → `{ habit: Habit }`
  - PATCH `/api/habits/:id/occurrence` with `{ occurrenceDate, completed? }` → `{ habit: Habit }`
  - POST `/api/habits/:id/items` with `{ todos?: number[], events?: number[] }` (link items) → 204
  - DELETE `/api/habits/:id/items/todo/:todoId` → 204; DELETE `/api/habits/:id/items/event/:eventId` → 204

- Goals
  - GET `/api/goals?status=active|completed|archived` → `{ goals: Goal[] }`
  - GET `/api/goals/:id?includeItems=true&includeChildren=true` → `{ goal }`
  - POST `/api/goals` → `{ goal }`; PATCH `/api/goals/:id` → `{ goal }`; DELETE `/api/goals/:id` → `{ ok: true }`
  - POST `/api/goals/:id/items` with `{ todos?: number[], events?: number[] }` → `{ ok: true }`
  - DELETE `/api/goals/:goalId/items/todo/:todoId` → `{ ok: true }`; DELETE `/api/goals/:goalId/items/event/:eventId` → `{ ok: true }`
  - POST `/api/goals/:id/children` with `[childId, ...]` → `{ ok: true }`; DELETE `/api/goals/:parentId/children/:childId` → `{ ok: true }`

- Unified schedule
  - GET `/api/schedule?from=YYYY-MM-DD&to=YYYY-MM-DD&kinds=todo,event,habit&priority=...&completed=...`
  - Expands todos/events/habits into per-day items; each item has `kind: 'todo'|'event'|'habit'`
  - Response: `{ items: Array<{ kind, id, masterId?, scheduledFor, ... }> }`

- Assistant
  - GET `/api/assistant/model` → `{ model: string }`
  - POST `/api/assistant/message` → auto pipeline; returns `{ text, operations }` or `{ requiresClarification, question }`
  - GET `/api/assistant/message/stream` → SSE: emits `stage`, `clarify`, `ops`, `summary`, `result`, `heartbeat`, `done`

- LLM Apply + Dry-run
  - POST `/api/llm/apply` with `{ operations: LlmOperation[] }` → `{ results, summary }` (supports `Idempotency-Key` header)
  - POST `/api/llm/dryrun` with `{ operations }` → `{ results, summary }`

### Validation highlights

- Common errors: `invalid_title`, `missing_recurrence`, `invalid_notes`, `invalid_scheduledFor`, `invalid_priority`, `invalid_timeOfDay`, `invalid_recurrence`, `missing_anchor_for_recurrence`, `invalid_completed`, `invalid_id`, `not_found`, `not_repeating`, `invalid_occurrenceDate`
- Todos: `recurrence` is required on create and update; if repeating, `scheduledFor` is required
- Events/Habits: similar shape checks; habits must be repeating when `recurrence` provided
- Apply/Dry-run: `invalid_operations` with per-op `errors[]`; rejects bulk-like ops, and caps to ≤20 ops per request

### Client couplings (Flutter `api.dart`)

- Base URL: `_computeApiBase()` uses `Uri.base.origin`, falling back to `http://127.0.0.1:3000`
- Todos: `fetchScheduled`, `fetchScheduledAllTime`, `fetchBacklog`, `searchTodos`, CRUD + `updateOccurrence`
- Events: `listEvents`, `searchEvents`, CRUD + `toggleEventOccurrence`
- Habits: `listHabits` (range adds stats), CRUD + `toggleHabitOccurrence`, linking helpers
- Goals: `listGoals`, `getGoal`, CRUD, link/unlink items, add/remove child
- Unified: `fetchSchedule({ from, to, kinds, completed, priority })`
- Assistant: `assistantMessage()` supports SSE or POST fallback; `applyOperations`, `dryRunOperations`; `fetchAssistantModel()` for UI badge

### Types

- Todo/Event/Habit/Goal shapes: see [Data Model](./data_model.md)
- Recurrence: `{ type: 'none'|'daily'|'weekdays'|'weekly'|'every_n_days', intervalDays?: number>=1, until?: YYYY-MM-DD|null }`
- LlmOperation: `create|update|delete|complete|complete_occurrence` for todos/events/habits; `goal_*` for goals

### Endpoint → Client usage map

- `/api/todos` → `fetchScheduled`, `fetchScheduledAllTime`
- `/api/todos/backlog` → `fetchBacklog`
- `/api/todos/search` → `searchTodos`
- `/api/todos` (POST) → `createTodo`
- `/api/todos/:id` (PATCH) → `updateTodo`
- `/api/todos/:id/occurrence` (PATCH) → `updateOccurrence`
- `/api/todos/:id` (DELETE) → `deleteTodo`
- `/api/events*` → `listEvents`, `createEvent`, `updateEvent`, `deleteEvent`, `searchEvents`, `toggleEventOccurrence`
- `/api/habits*` → `listHabits`, `createHabit`, `updateHabit`, `deleteHabit`, `searchHabits`, `toggleHabitOccurrence`, `linkHabitItems`, `unlinkHabitTodo`, `unlinkHabitEvent`
- `/api/goals*` → `listGoals`, `getGoal`, `createGoal`, `updateGoal`, `deleteGoal`, `addGoalItems`, `removeGoalTodoItem`, `removeGoalEventItem`, `addGoalChild`, `removeGoalChild`
- `/api/schedule` → `fetchSchedule`
- `/api/assistant/model` → `fetchAssistantModel`
- `/api/assistant/message` and `/api/assistant/message/stream` → `assistantMessage`
- `/api/llm/apply` → `applyOperations`; `/api/llm/dryrun` → `dryRunOperations`


