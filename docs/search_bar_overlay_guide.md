## Search Bar UX Overhaul — Implementation Guide

Decisions:
- Glass effect on dark header
- Overlay results only (no inline block)
- Show date and priority chips per result
- Enter navigates to the task in the main list
- Respect "Show completed" toggle
- Min query length 2; debounce 250ms
- No highlight; overlay only

Files to touch:
- apps/web/flutter_app/lib/main.dart
- apps/web/flutter_app/lib/api.dart
- apps/server/server.js (optional: search completed filter)

Flow:
1) Type in search → debounce 250ms (min length 2)
2) Cancel any in-flight request; call /api/todos/search with query and optional completed filter
3) Render overlay dropdown anchored to the field with up to 7 items
4) Keyboard: Up/Down to move; Enter scrolls to the task in main list

Backend (optional): add `completed` param to /api/todos/search
```js
// inside /api/todos/search
let completedBool;
if (req.query.completed !== undefined) {
  if (req.query.completed === 'true' || req.query.completed === true) completedBool = true;
  else if (req.query.completed === 'false' || req.query.completed === false) completedBool = false;
  else return res.status(400).json({ error: 'invalid_completed' });
}
let items = todos;
if (completedBool !== undefined) items = items.filter(t => t.completed === completedBool);
items = items.filter(t => String(t.title || '').toLowerCase().includes(q) || String(t.notes || '').toLowerCase().includes(q));
res.json({ todos: items });
```

Frontend — visuals (glass):
- Keep position/size
- Rounded pill (radius 24), semi-transparent white fill, subtle border and focus ring
- suffixIcon: clear button when text non-empty
- Show small spinner while fetching

Frontend — overlay mechanics:
- State: LayerLink _searchLink; OverlayEntry? _searchOverlay; int _searchHoverIndex; bool _searching; CancelToken? _searchCancelToken; FocusNode _searchFocus
- Wrap TextField with CompositedTransformTarget; overlay uses CompositedTransformFollower with offset just below field
- Build overlay only when search has focus and length >= 2; hide on blur, when input becomes empty, and on outside click immediately (pointer/tap outside the field or overlay). Inline results panel in the main list is removed — overlay is the only results surface.
- List up to 7 items; each row shows title + chips (date or "unscheduled", priority)
- Keyboard: Up/Down cycle; Enter selects (first item if none selected)
 - Mouse: Clicking an item also navigates (same as Enter)
 - On select (click or Enter): close overlay, clear the search field, and unfocus the input

Frontend — networking:
- api.searchTodos(String q, { bool? completed, CancelToken? cancelToken }) — IMPLEMENTED
- Pass completed: showCompleted ? null : false — IMPLEMENTED
- Cancel previous token before firing a new request — IMPLEMENTED
- Fallback client-side filter for completed if backend not yet updated — not needed when backend param is available

Frontend — navigation:
- Maintain Map<int, GlobalKey> for rows; on Enter: close overlay and ensureVisible on the target row.
- If the chosen result is outside the currently visible smart list, SWITCH TO `SmartList.all` automatically, then scroll to the item and briefly highlight the row for discoverability.
- Implementation sketch:
  - Determine target list membership (scheduled/backlog) from the result.
  - If not visible in current `selected`, set `selected = SmartList.all`, await `_refreshAll()`, then run `ensureVisible` on the row key.
  - Apply a transient highlight (e.g., via a `ValueNotifier<int?> highlightedId` consumed by `TodoRow`).

QA checklist:
- Debounce works; <2 chars hides overlay and cancels requests — IMPLEMENTED
- Overlay positions under field; no layout shift; capped to 7 results — IMPLEMENTED
- Keyboard: Up/Down moves selection; Enter navigates to item in main list — IMPLEMENTED
- Mouse: Clicking an overlay item navigates — IMPLEMENTED
- On select: overlay closes, field clears, focus removed — IMPLEMENTED
- Respects Show completed toggle — IMPLEMENTED via backend param
- No errors/leaks — TESTS GREEN (14 passed, 1 skipped)

Rollback: disable overlay creation and re-enable old inline section if needed

---

Repo bearings (high level):
- Purpose: Simple todo app with web UI (Flutter Web) and Node/Express backend. Includes LLM-assisted operations pipeline.
- Key components:
  - Backend: `apps/server/server.js` (Express API, CRUD, search, assistant endpoints)
  - Frontend: `apps/web/flutter_app` (Flutter Web app, API client in `lib/api.dart`, UI in `lib/main.dart` and `lib/widgets/*`)
  - Python: evaluation/pipeline tests under `python/` with pytest
- Entrypoints:
  - Backend start: `npm run start` (Node ESM)
  - Tests: `python3 -m pytest -q`
- Tooling: Node (ESM), Express 5, Flutter Web (Dart), dio HTTP client, pytest for Python tests

File map (relevant):
- `apps/server/server.js`: Express API including `/api/todos/search`
- `apps/web/flutter_app/lib/api.dart`: HTTP client wrappers; now supports search `completed` + cancellation
- `apps/web/flutter_app/lib/main.dart`: App scaffold; search debounce + min length; overlay PENDING
- `apps/web/flutter_app/lib/widgets/todo_row.dart`: Row rendering; may need highlight flag later

Recent edits (current state):
- Backend: `/api/todos/search` now accepts optional `completed` filter — DONE
- Frontend API: `searchTodos(q, {completed, cancelToken})` — DONE
- Frontend UI: Min length 2, request cancellation — DONE
- Frontend UI: Overlay dropdown (glass styling), keyboard Up/Down, Enter-to-row navigation with transient highlight — DONE
- Tests: all passing (14 passed, 1 skipped)

Final phases (optional polish):
1) Consider backdrop blur for a stronger glass effect (web performance permitting).
2) Tune highlight duration/style and overlay animations; consider hover states.
3) Accessibility: ARIA roles, semantic listbox/menu roles, announce selection count, improve keyboard focus order.

Acceptance criteria status:
- Overlay, keyboard navigation, Enter-to-row navigation, and completed respect — MET.


