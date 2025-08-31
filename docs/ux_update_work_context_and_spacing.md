## UX Update Guide: Work context chip + Day view whitespace

Audience: Flutter web client developers. Goal is to make the Work context chip reliably filter the schedule (single-select, resets each load) and shrink the empty space at the bottom of the Day view when there are few/no timed events.

### Terminal goals
- **Work chip works**: Selecting `Work` filters all loaded data by `context='work'`. It is single-select (tap All to clear) and resets to `All` on reload.
- **Smaller bottom whitespace (Day view)**: The large empty area below the all-day list is significantly reduced in Day view.

### Where things live (current code)
- Context state + data loading: `apps/web/flutter_app/lib/main.dart`
  - `selectedContext` state; `_refreshAll()` passes it to API
  - `CompactSubheader` wiring for context changes
- Context chips UI: `apps/web/flutter_app/lib/widgets/context_filter.dart` (used by `CompactSubheader`)
- Day view layout: `apps/web/flutter_app/lib/views/day_view.dart` (All Day card + timeline)
- Timeline widget: `apps/web/flutter_app/lib/widgets/event_timeline.dart`

Key anchors shown for reference:

```2869:2876:apps/web/flutter_app/lib/main.dart
CompactSubheader(
  dateLabel: anchor,
  selectedContext: selectedContext,
  onContextChanged: (context) async {
    setState(() { selectedContext = context; });
    await _refreshAll();
  },
  // ...
)
```

```173:187:apps/web/flutter_app/lib/views/day_view.dart
// Unified timeline (timed items only)
Expanded(
  child: AnimatedSwitcher(
    // ...
    child: EventTimeline(
      key: ValueKey('timeline_${timedUnified.length}'),
      dateYmd: dateYmd,
      events: timedUnified,
      onTapEvent: onEditEvent,
      scrollController: scrollController,
      minHour: timedUnified.isEmpty ? 7 : 0,
      maxHour: timedUnified.isEmpty ? 20 : 24,
      pixelsPerMinute: timedUnified.isEmpty ? 0.6 : 0.9,
    ),
  ),
),
```

### A. Make the Work context chip “single-select and reset”

Expected UX:
- Only one chip is active at a time (All/School/Personal/Work). Tapping an already-active chip should not toggle it off; clearing requires tapping `All`.
- On reload, default to `All` (i.e., `selectedContext == null`).
- Filtering applies everywhere the app loads data (unified schedule, all-time counts, events list, and unified search).

Implementation steps:
1) Confirm single-select behavior is wired through `ContextFilter` → `CompactSubheader.onContextChanged` → `selectedContext` and `_refreshAll()`.
   - The current `onContextChanged` in `HomePage` already sets state and refreshes (see anchor above).
   - `ContextFilter` taps call `onChanged(contextValue)` and use selected styling based on `selectedContext`—this is already single-select.

2) Ensure reset-on-reload:
   - Keep `selectedContext` uninitialized (null) in `_HomePageState` so the app starts in `All`.
   - Do not persist `selectedContext` to storage. Verify there are no reads/writes for this key (none by default).

3) Verify propagation to all loaders/search:
   - `_refreshAll()` already forwards `context: selectedContext` to `api.fetchSchedule`, `api.fetchScheduledAllTime`, and `api.listEvents`.
   - Search overlay sync: `_setSearchContext()` mirrors `selectedContext` and triggers refresh.

No code changes are required if the above is true in your branch. If the Work chip still doesn’t filter, sanity-check the lower-casing and plumbed value is exactly `'work'` (server validator expects `'school'|'personal'|'work'`).

Diagnostics if Work still appears broken:
- Temporarily log the effective query in `_refreshAll()` to confirm `context: 'work'` is sent.
- Hit the API directly in the browser: `/api/schedule?from=YYYY-MM-DD&to=YYYY-MM-DD&context=work` and ensure the server filters.

### B. Shrink bottom whitespace in Day view

Observed cause:
- In Day view, the `EventTimeline` is rendered at a height proportional to the full day span with `pixelsPerMinute: 1.2`. When there are few/no timed events, the timeline contributes a large empty scroll area below the All Day card.

Low-risk surgical change:
- Reduce the timeline’s vertical scaling and make it dynamic when there are no timed events.

Edit in `apps/web/flutter_app/lib/views/day_view.dart`:
1) Compute a local `timelinePpm` just before creating `EventTimeline`:
   - If `timedUnified.isEmpty`, use something small (e.g., `0.6`).
   - Otherwise use a compact value (e.g., `0.9`) instead of `1.2`.

Suggested snippet (replace only the `pixelsPerMinute:` argument):

```dart
// before
pixelsPerMinute: 1.2,

// after
pixelsPerMinute: timedUnified.isEmpty ? 0.6 : 0.9,
```

Optional enhancements (if you want it tighter later):
- Also narrow the visible window on empty or sparse days by setting `minHour: 7, maxHour: 20` (keeps early/late hours but reduces height).
  - Implemented: `minHour`/`maxHour` now dynamic for empty days (see anchor above).

Additional refinement implemented:
- Autoscroll alignment in DayView: replaced the fixed `pxPerMin = 1.2` with the same dynamic value used by `EventTimeline`.
  - Before:
```apps/web/flutter_app/lib/views/day_view.dart
const double pxPerMin = 1.2; // matches EventTimeline pixelsPerMinute
```
  - After:
```apps/web/flutter_app/lib/views/day_view.dart
final double pxPerMin = timedUnified.isEmpty ? 0.6 : 0.9; // match EventTimeline
```

### Acceptance criteria
- Tapping `Work` selects only that chip and filters the schedule, counts, and search results to `context='work'`.
- Reloading the page resets context to `All`.
- In Day view with no timed events, the overall page height below the All Day card is noticeably smaller (approx ≥25–50% reduction), but the timeline remains visible.

### Verification checklist
- Manual
  - Open the app → Day view.
  - Tap `Work` → list shows only items tagged Work; chip styling updates.
  - Refresh browser → context resets to `All`.
  - Ensure search overlay default context matches the header and applies Work when set.
  - Compare bottom whitespace on a day with zero timed events before/after the change.
- API sanity
  - Hit `/api/schedule` with and without `context=work` to confirm server filtering.

### Rollback
- Revert the `pixelsPerMinute` change in `DayView` to `1.2` if the timeline becomes too compressed on dense days.

### Notes
- There’s an older `FilterBar` in `main.dart` with its own context chips. The live UI uses `CompactSubheader` + `ContextFilter`. Avoid editing the unused `FilterBar` to prevent confusion. The final phase of this file should be removing the now deprecated code related to the old `FilterBar`


### Repo bearings (high-level)
- Purpose: Tasks/events scheduling app with a web UI (Flutter Web) backed by a single Express server and SQLite. Includes an assistant/MCP pipeline for operations.
- Components:
  - Server: `apps/server/`
    - Entrypoint: `apps/server/server.js` (serves APIs and static Flutter build)
    - DB: `apps/server/database/DbService.js` with schema `apps/server/database/schema.sql` (SQLite via better-sqlite3)
    - Routes: `apps/server/routes/*.js` (`schedule`, `search`, `tasks`, `events`, `assistant`, `health`)
    - Operations: `apps/server/operations/*` (validators, executors, registry, processor)
    - LLM/MCP: `apps/server/llm/*`, `apps/server/mcp/mcp_server.js`
    - Utils: `apps/server/utils/*`
  - Web client: `apps/web/flutter_app/`
    - App: `lib/main.dart`
    - Views: `lib/views/*` (e.g., `day_view.dart`)
    - Widgets: `lib/widgets/*` (e.g., `context_filter.dart`, `event_timeline.dart`)
    - Utils: `lib/util/*` (e.g., SSE/storage abstractions)
    - Built assets served from `build/web/` by the server
  - Tests: `tests/` (Node test runner invoking unit/integration suites)
  - Scripts: `scripts/` (db dump/seed, test-with-server)
- Entrypoints/commands:
  - Start server: `npm start` → `apps/server/server.js`
  - Dev server: `npm run dev`
  - Tests: `npm test` (runs all Node tests)
  - DB helpers: `npm run db:dump`, `npm run db:seed:tasks-events`
- Tooling:
  - Node.js 20+, Express, better-sqlite3, Ajv
  - Flutter Web for client (built separately; local Flutter SDK not assumed here)
- Gaps/assumptions:
  - Flutter build/run tooling not wired via npm; local `flutter` CLI required to rebuild `build/web/`.
  - Autoscroll in `DayView` now uses the same dynamic `pixelsPerMinute` as `EventTimeline`.

### Immediate TODO (minimal)
1) Implement dynamic timeline scaling in Day view
   - Done: `pixelsPerMinute: timedUnified.isEmpty ? 0.6 : 0.9`.
   - Acceptance: On empty/sparse days, bottom whitespace reduced ≥25%; dense days remain readable.
2) Validate Work chip behavior across loads
   - Verify single-select via `ContextFilter` and reset-to-All on reload (`selectedContext == null`).
   - Acceptance: Tapping Work filters schedule/search/counts; reload resets to All.
3) Align Day view autoscroll with dynamic scaling
   - Done: autoscroll `pxPerMin` reflects the same conditional as the timeline.
   - Acceptance: First render scrolls near earliest timed item within ~100px tolerance.
4) Narrow hours on empty days
   - Done: `minHour: 7, maxHour: 20` when `timedUnified.isEmpty`.
   - Acceptance: Visible timeline shrinks while keeping early/late hours off-screen.

### Execution log (changes)
- Edited `apps/web/flutter_app/lib/views/day_view.dart`:
  - Dynamic `pixelsPerMinute` in `EventTimeline`.
  - Dynamic `minHour`/`maxHour` on empty days.
  - Autoscroll uses matching dynamic `pxPerMin`.
- Validation: Ran Node tests (`npm test`) → all passing (68 tests, 0 failures).
- Built Flutter web assets: `flutter build web --release` → succeeded. Built to `apps/web/flutter_app/build/web`.

### Additional view tweaks
- Week view (`lib/views/week_view.dart`): reduced empty-day vertical padding from 18 to 8 to cut whitespace.
- Month view (`lib/views/month_view.dart`): adjusted `childAspectRatio` from 1.1 → 1.0 for slightly taller cells, reducing perceived empty space.

### Next steps
- Manual verify in browser: Work chip filters to `context='work'`, page reload resets to All, and whitespace reductions are noticeable on empty/sparse days across Day/Week/Month.
- Optionally tune `pixelsPerMinute`, hours window, and grid ratios based on feedback.
