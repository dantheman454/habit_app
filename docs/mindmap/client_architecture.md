## Client Architecture (Flutter Web)

Entry files: `apps/web/flutter_app/lib/main.dart`, `apps/web/flutter_app/lib/api.dart`

### State and views

- Enums: `View { day, week, month }`, `SmartList { today, scheduled, all, backlog }`, `MainView { tasks, habits, goals }`
- Anchor date `anchor` drives date-range via `rangeForView(anchor, view)` → `{from,to}`
- Primary lists in state:
  - `scheduled`: unified schedule items (with `kind: 'todo'|'event'|'habit'`) in the current date window
  - `scheduledAllTime`: all scheduled masters (todos/events) for counts and badges
  - `backlog`: unscheduled todos
- Sidebar counts recomputed on refresh per active tab scope

### Data loading

- `_refreshAll()`
  - For day/week/month views: calls unified `fetchSchedule({ from, to, kinds, completed?, priority? })` to populate `scheduled`
  - Also calls `fetchScheduledAllTime({ completed? })` and `fetchBacklog()` for counts and backlog view
  - When showing Habits tab, also calls `listHabits({ from, to })` to collect per-habit stats (`currentStreak`, `longestStreak`, `weekHeatmap`)
  - When `showCompleted=false`, exclude completed in queries and UI

### Search overlay

- Debounced query via `_runSearch` with `CancelToken` cancellation
- Overlay rendered via `CompositedTransformTarget/Follower`; keyboard navigation with Up/Down and Enter
- Selecting a result focuses the appropriate list and scrolls it into view

### CRUD interactions

- Toggle completion:
  - Todo: occurrence → `PATCH /api/todos/:id/occurrence`, master → `PATCH /api/todos/:id`
  - Event: occurrence → `PATCH /api/events/:id/occurrence`, master → `PATCH /api/events/:id`
  - Habit: occurrence → `PATCH /api/habits/:id/occurrence`, master → `PATCH /api/habits/:id`
- Create inline quick-add rows for todo/event/habit; todos and events send `{recurrence:{type:'none'}}`, habits `{recurrence:{type:'daily'}}`
- Edit dialogs mirror create with delta patching; recurrence anchor hints are shown where relevant
- Delete with confirm dialog; calls respective delete endpoints

### Assistant UX and couplings

- Transcript limited to last 3 turns when sending
- SSE handler wires `onSummary`, `onClarify`, `onStage`, and `onOps`; falls back to POST when SSE fails
- Clarify selection state is stored and passed back via `options.clarify.selection`
- Apply flow: dry-run to preview then POST `/api/llm/apply`; `Idempotency-Key` supported at server side

### Presentation and grouping

- Group by date, then sort by start/time-of-day (nulls first), then by kind order `event < todo < habit`, then by id
- Overdue highlighting for Today based on time; chips and tabs filter by `kind` and priority

### Networking and environment

- Base URL: `_computeApiBase()` prefers Express origin, else `http://127.0.0.1:3000`
- `Dio` client; booleans serialized as strings for server validation compatibility



