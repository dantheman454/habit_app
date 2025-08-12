## Todo App: Web-to-Flutter Architecture and Implementation Guide

Audience: you (solo dev). Scope: replace current browser UI with a Flutter Web app that keeps the existing Node/Express API, is inspired by Apple Reminders, and can later ship to iOS/Android with minimal changes. Assume always-online for now; LLM propose/apply is server-side.

### Objectives and constraints
- **Keep backend**: reuse `server.js` endpoints and file storage under `data/`.
- **Flutter-first UI**: build a new Flutter Web client; later reuse for mobile without code changes beyond platform adaptors.
- **Serve via Express**: the Flutter Web build will replace the current JS UI by serving the build output from `server.js` (replacing `web/public`).
- **Apple Reminders inspiration**: Today, Scheduled, All, Flagged, sections by time-of-day, inline edits, quick entry, clean typography.
- **LLM features day one**: wire propose/apply flows to current endpoints.
- **Privacy/simple**: single user, no auth; no offline for now.

### Target system architecture
```mermaid
graph TD
  A[Flutter Web (shared Flutter UI)] -->|HTTP JSON| B[Express API server (server.js)]
  B -->|CRUD/search/backlog| C[(data/todos.json)]
  B -->|id counter| D[(data/counter.json)]
  B -->|append audit| E[(data/audit.jsonl)]
  B -->|/api/llm/propose| F[[Ollama CLI (server-side)]]
  B -->|/api/llm/apply| C

  subgraph Future Mobile
    A2[Flutter iOS/Android]
  end
  A2 -->|reuse same repositories/models| B
```

### API contract (stable v1)
Keep the current endpoints and payloads. Document them as a contract the Flutter app will rely on.

- Base: `http://127.0.0.1:3000`
- Content type: `application/json`
- Errors: `{ error: string, ... }` with appropriate HTTP status

Endpoints (request → response excerpt):
- POST `/api/todos`
  - body: `{ title: string, notes?: string, scheduledFor?: YYYY-MM-DD|null, priority?: 'low'|'medium'|'high' }`
  - resp: `{ todo: Todo }`
- GET `/api/todos?from=YYYY-MM-DD&to=YYYY-MM-DD&priority=...&completed=true|false`
  - resp: `{ todos: Todo[] }` (scheduled only)
- GET `/api/todos/backlog` → `{ todos: Todo[] }` (unscheduled)
- GET `/api/todos/search?query=string` → `{ todos: Todo[] }`
- GET `/api/todos/:id` → `{ todo: Todo }`
- PATCH `/api/todos/:id`
  - body: partial fields `{ title?, notes?, scheduledFor?, priority?, completed? }`
  - resp: `{ todo: Todo }`
- DELETE `/api/todos/:id` → `{ ok: true }`
- POST `/api/llm/propose`
  - body: `{ instruction: string }`
  - resp: `{ operations: Operation[] }`
- POST `/api/llm/apply`
  - body: `{ operations: Operation[] }`
  - resp: `{ results: ..., summary: { created, updated, deleted, completed } }`

Types used by the contract:
```ts
type Priority = 'low' | 'medium' | 'high';

type Todo = {
  id: number;
  title: string;
  notes: string;
  scheduledFor: string | null; // YYYY-MM-DD
  priority: Priority;
  completed: boolean;
  createdAt: string; // ISO
  updatedAt: string; // ISO
};

type Operation =
  | { op: 'create'; title: string; notes?: string; scheduledFor?: string | null; priority?: Priority }
  | { op: 'update'; id: number; title?: string; notes?: string; scheduledFor?: string | null; priority?: Priority; completed?: boolean }
  | { op: 'delete'; id: number }
  | { op: 'complete'; id: number; completed?: boolean };
```

### Data model roadmap
- v1 (today): keep existing fields above.
- v1.1 (backward compatible additions – optional, no breaking server changes needed):
  - `flagged?: boolean` (map to Apple “Flagged”; interim: treat `priority='high'` as flagged in UI)
  - `listId?: string` and a new `/api/lists` set (future); for now, a single implicit list
  - `parentId?: number` for subtasks (future)
  - `repeatRule?: string` (RFC5545-like; future client-only until server evolves)
  - `order?: number` (stable ordering within groups)

The current PATCH semantics make these additions non-breaking when added later.

### Flutter application architecture
- Language/tooling: Flutter 3.22+, Dart 3+, Flutter Web as the first target; later add iOS/Android runner without changing core code.
- Recommended libraries:
  - `riverpod` + `flutter_riverpod`: simple, testable state management
  - `freezed` + `json_serializable`: immutable models and JSON
  - `dio`: HTTP client with interceptors
  - `go_router`: declarative navigation
  - `intl`: date formatting

Project layout:
```
lib/
  app/
    app.dart                 // MaterialApp + theme + router
    router.dart              // go_router configuration
    theme.dart               // typography, colors (Apple-like)
  core/
    http/dio_client.dart     // base Dio instance
    utils/date_ranges.dart   // day/week/month helpers
    utils/result.dart        // Result<T> wrapper
  features/
    todos/
      data/
        todos_api.dart       // low-level API client → DTOs
        todos_repository.dart// domain-facing repository
      domain/
        todo.dart            // Freezed model
        operation.dart       // Freezed union
        smart_lists.dart     // derived filters (Today, Scheduled, All, Flagged)
      presentation/
        pages/
          home_page.dart    // sidebar + main content
          list_page.dart    // grouped view with headers
        widgets/
          todo_row.dart      // checkbox, title, actions
          quick_entry.dart   // LLM-powered quick add
          inline_editor.dart // edit row controls
    llm/
      data/llm_api.dart
      data/llm_repository.dart
      presentation/proposal_sheet.dart
```

Dart models (example with `freezed`):
```dart
@freezed
class Todo with _$Todo {
  const factory Todo({
    required int id,
    required String title,
    @Default('') String notes,
    String? scheduledFor, // YYYY-MM-DD
    @Default(Priority.medium) Priority priority,
    @Default(false) bool completed,
    required String createdAt,
    required String updatedAt,
  }) = _Todo;

  factory Todo.fromJson(Map<String, dynamic> json) => _$TodoFromJson(json);
}

enum Priority { low, medium, high }
```

Repository mapping (sketch):
```dart
class TodosRepository {
  TodosRepository(this._dio);
  final Dio _dio;

  Future<List<Todo>> list({required String from, required String to, bool showCompleted = false}) async {
    final q = {
      'from': from,
      'to': to,
      if (!showCompleted) 'completed': 'false',
    };
    final res = await _dio.get('/api/todos', queryParameters: q);
    return (res.data['todos'] as List).map((e) => Todo.fromJson(e)).toList();
  }

  Future<List<Todo>> backlog({bool showCompleted = false}) async {
    final res = await _dio.get('/api/todos/backlog');
    var items = (res.data['todos'] as List).map((e) => Todo.fromJson(e)).toList();
    if (!showCompleted) items = items.where((t) => !t.completed).toList();
    return items;
  }

  Future<Todo> create({required String title, String notes = '', String? scheduledFor, Priority priority = Priority.medium}) async {
    final res = await _dio.post('/api/todos', data: {
      'title': title,
      'notes': notes,
      'scheduledFor': scheduledFor,
      'priority': priority.name,
    });
    return Todo.fromJson(res.data['todo']);
  }

  Future<Todo> update(int id, Map<String, dynamic> patch) async {
    final res = await _dio.patch('/api/todos/$id', data: patch);
    return Todo.fromJson(res.data['todo']);
  }

  Future<void> delete(int id) async {
    await _dio.delete('/api/todos/$id');
  }
}
```

State management (Riverpod):
```dart
final anchorProvider = StateProvider<String>((ref) => DateRanges.today());
final viewProvider = StateProvider<View>((ref) => View.day);
final showCompletedProvider = StateProvider<bool>((ref) => false);

final scheduledTodosProvider = FutureProvider.autoDispose<List<Todo>>((ref) async {
  final repo = ref.watch(todosRepositoryProvider);
  final anchor = ref.watch(anchorProvider);
  final view = ref.watch(viewProvider);
  final range = DateRanges.forView(anchor, view);
  final showCompleted = ref.watch(showCompletedProvider);
  return repo.list(from: range.from, to: range.to, showCompleted: showCompleted);
});
```

Navigation (go_router):
```
/
  ?anchor=YYYY-MM-DD&view=day|week|month&completed=true|false
  /todo/:id (future detail route)
```

### Apple Reminders–inspired UX mapping
Core screens and interactions to deliver first, using only existing server fields:

- **Sidebar smart lists**: Today, Scheduled, All, Flagged
  - Today = range [today, today]
  - Scheduled = all with `scheduledFor != null`
  - All = union of Scheduled + Backlog
  - Flagged (v1) = priority == high (later: dedicated `flagged: true`)
- **Main list view**: grouped by date (YYYY-MM-DD headers), with row items:
  - Leading checkbox toggles completed via PATCH
  - Title text; priority badge (red=high, amber=medium, green=low)
  - Row hover actions: Edit, Delete
  - Inline editor expands the row (title, notes, date, priority)
- **Quick Entry (dual‑mode)**: a single input with an adjacent toggle (Direct | LLM)
  - Direct mode: creates a todo immediately via POST `/api/todos`, defaulting `scheduledFor` to Today when no date is provided
  - LLM mode: sends text to `/api/llm/propose`, renders proposed operations with checkboxes and diffs, then Apply to `/api/llm/apply`
- **Search**: live results calling `/api/todos/search?query=...`
- **Sections by time-of-day** (visual only for now): under Today, subdivide items into Morning/Afternoon/Evening based on user-editable metadata later; initially, simple grouping by creation order.
- **Keyboard and gestures**: web key bindings for New, Delete, Complete; future swipe gestures on mobile map naturally to `Dismissible` in Flutter.

### Theming and visuals
- Typography and spacing inspired by Apple: large “Today” header, subtle section headers, pill badges for priority.
- Use Cupertino colors subtly within Material 3 theme to achieve iOS-like tone without platform lock-in.

### LLM integration in Flutter
- `LlmRepository.propose(instruction)` → POST `/api/llm/propose`
- `LlmRepository.apply(operations)` → POST `/api/llm/apply`
- Show a non-modal panel listing operations with a minimal diff (for updates/complete). Reuse the same comparison logic as current JS by caching the scheduled/backlog lists before propose.

### Build and run (developer experience)
- Backend: `node server.js` (env: `OLLAMA_MODEL` to enable propose)
- Flutter Web – development: `flutter run -d chrome` with `Dio(baseUrl: 'http://127.0.0.1:3000')`; the app calls the running Express API.
- Flutter Web – production (served by Express):
  1) `flutter build web`
  2) Replace the current static UI by copying `build/web/` into the repo’s `web/public/` directory (or point Express to the Flutter build directory)
  3) `node server.js` now serves the Flutter app at `/` and the API under `/api/*`

### Incremental delivery plan (task-by-task)
1) Bootstrap Flutter app
   - Create project, add deps (`riverpod`, `freezed`, `json_serializable`, `dio`, `go_router`, `intl`).
   - Implement `dio_client.dart` with base URL and JSON config.
   - Define `Todo`, `Operation` models with `freezed`.

2) Repositories + providers
   - Implement `TodosRepository`, `LlmRepository` and Riverpod providers.
   - Add date-range helpers: today/week/month, inclusive end logic mirroring server.

3) Home shell and navigation
   - App scaffold with sidebar smart lists and URL query params for anchor/view/completed.
   - Persist state to the URL (works on web; mobile can ignore).

4) Scheduled + Backlog views
   - Fetch scheduled/backlog in parallel and render grouped lists with headers.
   - Row component with checkbox, priority badge, inline actions.

5) Create / toggle / edit / delete
   - Quick add form; PATCH/DELETE wiring; optimistic or strict refresh (start strict).

6) Quick Entry dual‑mode
   - Add toggle: Direct | LLM (default Direct)
   - Direct: POST `/api/todos` with sensible defaults
   - LLM: POST `/api/llm/propose` then `/api/llm/apply`

7) Search panel
   - Debounced query hitting `/api/todos/search`; reuse row component.

8) LLM propose/apply panel
   - Proposal list with checkboxes and diff; Apply and refresh; display summary counts.

9) Theming/Polish
   - Apple-like spacing, typography, and keyboard shortcuts.

10) (Optional) Flagged smart list
   - v1: treat `priority == high` as flagged; expose a toggle in editor to set priority to high quickly.

11) Prep for mobile
   - Ensure no web-only imports in core/features layers.
   - Extract any `dart:html` usage behind an interface (e.g., URL state handling limited to web target).

### Testing strategy
- Unit: repositories (mock Dio), date range helpers, smart list filters.
- Widget: list grouping and row interactions.
- Integration: start the Express server and hit it via `dio` in a Flutter integration test (optional).

### Future-proofing notes
- When you add multi-user/auth and a DB, keep the DTOs identical; Flutter remains unchanged.
- For offline-first later: rely on `updatedAt` and add `GET /api/todos/changes?since=<iso>`; repositories can switch to local cache + delta sync without UI changes.

### Locked-in decisions (from you)
- Serve Flutter Web build from `server.js`, replacing the current static UI under `web/public`.
- Keep “Flagged” equivalent to `priority == 'high'` for now.
- Quick Entry is dual‑mode (Direct | LLM).
- No specific keyboard shortcuts required beyond sensible defaults.

### Next step
With these decisions, I will scaffold the Flutter project and wire the repositories to the existing API, then set up the production build to overwrite `web/public`.



