## Client Architecture (Flutter Web)

Entry files: `apps/web/flutter_app/lib/main.dart`, `apps/web/flutter_app/lib/api.dart`

### State and views

- Enums: `View { day, week, month }`, `SmartList { today, scheduled, all, flagged, backlog }` (main.dart 190:193)
- Anchor date string `anchor` drives date-range computation; `rangeForView(anchor, view)` computes `[from,to]` (main.dart 151:169)
- Primary lists in state:
  - `scheduled`: expanded occurrences (or masters) for current view range
  - `scheduledAllTime`: all scheduled masters for badges and flagged list
  - `backlog`: unscheduled masters
- Counts for sidebar badges computed on refresh (main.dart 271:296)
  - `today`: scheduled occurrences with `scheduledFor == today`
  - `scheduled`: count of items returned for current view window
  - `flagged`: high-priority across scheduledAllTime + backlog
  - `all`: scheduledAllTime + backlog lengths

### Data loading

- `_refreshAll()` orchestrates three calls:
  - `fetchScheduled({from,to,completed?})` → `scheduled`
  - `fetchScheduledAllTime({completed?})` → `scheduledAllTime`
  - `fetchBacklog()` → `backlog`
  - Source: `api.dart` 17:39; `main.dart` 271:305
  - Completed filter: when `showCompleted=false`, exclude completed from `backlog` and scheduled queries pass `completed=false`

### Search overlay

- Debounced query via `_runSearch` with `CancelToken` cancellation (main.dart 311:341)
- Overlay rendered via `CompositedTransformTarget/Follower` and keyboard navigation (main.dart 344:439, 1026:1044)
- Result selection focuses relevant list and scrolls into view (main.dart 458:478)
  - Key navigation: Up/Down cycles 0..N-1; Enter selects highlighted (main.dart 1027:1042)
  - Visual: glassmorphism-style blur and elevation; selected row background uses theme primary at 8% opacity

### CRUD interactions

- Toggle completion:
  - If occurrence (`masterId` present): `PATCH /api/todos/:id/occurrence`
  - Else master: `PATCH /api/todos/:id`
  - Source: `main.dart` 480:489, `api.dart` 58:64
  - Overdue detection: computed only for Today view based on `timeOfDay` (main.dart 1269:1279)

- Create via FAB sheet:
  - Requires recurrence; derives `{ type: 'none' }` when user selects non-repeating
  - Sends `timeOfDay` only when filled; `scheduledFor` null/empty normalization
  - Source: `main.dart` 521:616, `api.dart` 48:51

- Edit dialog mirrors create, with delta-based patch and recurrence handling (main.dart 618:714)
  - Recurrence delta logic:
    - Change of type → send `{recurrence: { type, intervalDays? }}`
    - Same type `every_n_days` but changed N → send `recurrence` with new `intervalDays`
    - Anchor reminders shown for `weekly` when date present

- Delete with confirm dialog (main.dart 494:513)

### Assistant UX and couplings

- Transcript limited to last 3 turns when sending (main.dart 735:738)
- Streaming SSE handler wires `onSummary`, `onClarify`, `onStage`, and `onOps` callbacks (api.dart 96:179)
- Clarify selection state stored locally and passed back in subsequent auto-mode calls (main.dart 771:781)
- Operations table includes per-op checkbox with default selection mirroring validity (main.dart 788:804)
  - Key for preserving checkbox state across streamed `ops` updates: "${op.op}${op.id == null ? '' : '#'+op.id.toString()}" (main.dart 794:803)
- Apply flow:
  - Dry-run to show warnings; then POST `/api/llm/apply` (main.dart 876:917, `api.dart` 191:199)

### Presentation and grouping

- Group by date, then sort within date by `timeOfDay`, nulls first (main.dart 924:943)
- Overdue highlighting for Today list if `timeOfDay` in past (main.dart 1269:1279)
  - Group key uses `scheduledFor ?? 'unscheduled'`; within groups, null/empty time sorts first (main.dart 924:943)

### Networking and environment

- Base URL: `_computeApiBase()` uses `Uri.base.origin`, falling back to `http://127.0.0.1:3000` (api.dart 6:15)
- Dio client created with base URL; query params serialize booleans as strings where required by server validation



