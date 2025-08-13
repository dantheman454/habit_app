## API Contract (v1)

Base: `http://127.0.0.1:3000`  Content-Type: `application/json`

### Health
- GET `/health` → `{ ok: true }`

```103:105:apps/server/server.js
app.get('/health', (_req, res) => { res.json({ ok: true }); });
```

### Todos
- GET `/api/todos`
  - Query: `from=YYYY-MM-DD` (optional), `to=YYYY-MM-DD` (optional), `completed=true|false` (optional), `priority=low|medium|high` (optional)
  - Returns only scheduled items (`scheduledFor != null`)
  - `to` is inclusive; server implements inclusivity by filtering `td < (to + 1 day)`
  - Response: `{ todos: Todo[] }`

```145:181:apps/server/server.js
app.get('/api/todos', (req, res) => {
  const { from, to, priority, completed } = req.query;
  // ... validation omitted ...
  const fromDate = from ? parseYMD(from) : null;
  const toDate = to ? parseYMD(to) : null;
  let items = todos.filter(t => t.scheduledFor !== null);
  // ... filters ...
  if (fromDate || toDate) {
    items = items.filter(t => {
      // ...
      if (toDate) {
        const inclusiveEnd = new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate() + 1);
        if (td >= inclusiveEnd) return false;
      }
      return true;
    });
  }
  res.json({ todos: items });
});
```

- GET `/api/todos/backlog`
  - Returns unscheduled items (`scheduledFor === null`)
  - Response: `{ todos: Todo[] }`

```183:187:apps/server/server.js
app.get('/api/todos/backlog', (_req, res) => {
  const items = todos.filter(t => t.scheduledFor === null);
  res.json({ todos: items });
});
```

- GET `/api/todos/search?query=string`
  - Case-insensitive search in `title` or `notes`
  - Requires non-empty `query`
  - Response: `{ todos: Todo[] }`

```189:195:apps/server/server.js
app.get('/api/todos/search', (req, res) => {
  const q = String(req.query.query || '').toLowerCase().trim();
  if (!q) return res.status(400).json({ error: 'invalid_query' });
  const items = todos.filter(t => String(t.title || '').toLowerCase().includes(q) || String(t.notes || '').toLowerCase().includes(q));
  res.json({ todos: items });
});
```

- GET `/api/todos/:id`
  - Response: `{ todo: Todo }`

```197:204:apps/server/server.js
app.get('/api/todos/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  const t = findTodoById(id);
  if (!t) return res.status(404).json({ error: 'not_found' });
  res.json({ todo: t });
});
```

- POST `/api/todos`
  - Body: `{ title: string, notes?: string, scheduledFor?: YYYY-MM-DD|null, priority?: 'low'|'medium'|'high' }`
  - Response: `{ todo: Todo }`

```124:143:apps/server/server.js
app.post('/api/todos', (req, res) => {
  const { title, notes, scheduledFor, priority } = req.body || {};
  if (typeof title !== 'string' || title.trim() === '') {
    return res.status(400).json({ error: 'invalid_title' });
  }
  // ... validation ...
  const todo = createTodo({ title: title.trim(), notes: notes || '', scheduledFor: scheduledFor ?? null, priority: priority || 'medium' });
  todos.push(todo);
  saveTodos(todos);
  res.json({ todo });
});
```

- PATCH `/api/todos/:id`
  - Body: any of `{ title, notes, scheduledFor, priority, completed }`
  - Response: `{ todo: Todo }`

```206:234:apps/server/server.js
app.patch('/api/todos/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  const { title, notes, scheduledFor, priority, completed } = req.body || {};
  // ... validation ...
  const t = findTodoById(id);
  if (!t) return res.status(404).json({ error: 'not_found' });
  const now = new Date().toISOString();
  if (title !== undefined) t.title = title;
  if (notes !== undefined) t.notes = notes;
  if (scheduledFor !== undefined) t.scheduledFor = scheduledFor;
  if (priority !== undefined) t.priority = priority;
  if (completed !== undefined) t.completed = completed;
  t.updatedAt = now;
  saveTodos(todos);
  res.json({ todo: t });
});
```

- DELETE `/api/todos/:id`
  - Response: `{ ok: true }`

```236:245:apps/server/server.js
app.delete('/api/todos/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  const idx = todos.findIndex(t => t.id === id);
  if (idx === -1) return res.status(404).json({ error: 'not_found' });
  todos.splice(idx, 1);
  saveTodos(todos);
  res.json({ ok: true });
});
```

Notes:
- Lists are returned in storage order (no sort guarantees)
- All successful responses use HTTP 200 with JSON bodies

### Assistant and LLM apply
- POST `/api/assistant/message`
  - Body: `{ message: string, transcript?: Array<{role:string,text:string}>, options?: { streamSummary?: boolean } }`
  - Response: `{ text: string, operations?: Operation[] }`
  - Behavior: server builds a strict proposal prompt (internally), parses/normalizes operations, validates them, and also generates a one- or two-sentence summary. Supports SSE streaming of the summary when requested (set `options.streamSummary=true` and `Accept: text/event-stream`).

```469:555:apps/server/server.js
app.post('/api/assistant/message', async (req, res) => {
  // ... validates message ...
  // Call 1 — generate operations (robust proposal pipeline)
  const prompt1 = buildProposalPrompt({ instruction: message.trim(), todosSnapshot: todos, transcript });
  const raw1 = await runOllamaWithThinkingIfGranite({ userContent: prompt1 });
  // ... parse JSON, infer op shape, validate ...
  // Call 2 — conversational summary
  try {
    const prompt2 = buildConversationalSummaryPrompt({ instruction: message.trim(), operations: ops, todosSnapshot: todos, transcript });
    const raw2 = await runOllamaWithThinkingIfGranite({ userContent: prompt2 });
    // ... sanitize to plain text ...
  } catch (e) {
    // deterministic fallback summary
  }
  // Optional SSE streaming when Accept: text/event-stream and options.streamSummary
  // ... else res.json({ text, operations? })
});
```

- POST `/api/llm/apply`
  - Body: `{ operations: Operation[] }`
  - Response: `{ results: Array<{ ok: boolean, op: Operation, todo?: Todo, error?: string }>, summary: { created, updated, deleted, completed } }`
  - Behavior: applies operations under a single-process lock; appends `data/audit.jsonl`

```374:419:apps/server/server.js
app.post('/api/llm/apply', async (req, res) => {
  const { operations } = req.body || {};
  const validation = validateProposal({ operations });
  if (validation.errors.length) {
    return res.status(400).json({ error: 'invalid_operations', detail: validation });
  }
  const results = [];
  let created = 0, updated = 0, deleted = 0, completed = 0;
  await withApplyLock(async () => {
    for (const op of operations) {
      // create | update | delete | complete
      // append audit for each
    }
  });
  res.json({ results, summary: { created, updated, deleted, completed } });
});
```

### Types
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

Client usage examples (Flutter `api.dart`):

```1:15:apps/web/flutter_app/lib/api.dart
import 'package:dio/dio.dart';

String _computeApiBase() {
  // Works when served by Express or running Flutter in Chrome
  final origin = Uri.base.origin;
  if (origin.contains('127.0.0.1:3000') || origin.contains('localhost:3000')) {
    return origin;
  }
  return 'http://127.0.0.1:3000';
}

final Dio api = Dio(BaseOptions(baseUrl: _computeApiBase()));
```

### Validation rules (server-enforced)
- `title` required on create (non-empty string)
- `notes` is string if provided
- `scheduledFor` is `YYYY-MM-DD` or `null` if provided
- `priority` ∈ `low|medium|high` if provided
- `completed` is boolean if provided
- For `update|delete|complete`, `id` must exist

```206:221:apps/server/server.js
// Example validation on PATCH
if (title !== undefined && typeof title !== 'string') return res.status(400).json({ error: 'invalid_title' });
if (notes !== undefined && typeof notes !== 'string') return res.status(400).json({ error: 'invalid_notes' });
if (!(scheduledFor === undefined || scheduledFor === null || isYmdString(scheduledFor))) {
  return res.status(400).json({ error: 'invalid_scheduledFor' });
}
if (priority !== undefined && !['low', 'medium', 'high'].includes(String(priority))) {
  return res.status(400).json({ error: 'invalid_priority' });
}
if (completed !== undefined && typeof completed !== 'boolean') {
  return res.status(400).json({ error: 'invalid_completed' });
}
```

### Curl examples
```bash
# Create
curl -s -X POST http://127.0.0.1:3000/api/todos \
  -H 'Content-Type: application/json' \
  -d '{"title":"Buy milk","scheduledFor":"2025-08-12","priority":"high"}'

# List scheduled for a week
curl -s 'http://127.0.0.1:3000/api/todos?from=2025-08-11&to=2025-08-17&completed=false'

# Backlog
curl -s http://127.0.0.1:3000/api/todos/backlog

# Search
curl -s 'http://127.0.0.1:3000/api/todos/search?query=milk'

# Update
curl -s -X PATCH http://127.0.0.1:3000/api/todos/1 \
  -H 'Content-Type: application/json' \
  -d '{"priority":"medium","completed":true}'

# Delete
curl -s -X DELETE http://127.0.0.1:3000/api/todos/1

# Assistant (get plan + summary) then apply
curl -s -X POST http://127.0.0.1:3000/api/assistant/message \
  -H 'Content-Type: application/json' \
  -d '{"message":"schedule high-priority backlog for tomorrow","transcript":[]}'

curl -s -X POST http://127.0.0.1:3000/api/llm/apply \
  -H 'Content-Type: application/json' \
  -d '{"operations":[{"op":"create","title":"Buy bread","priority":"high"}]}'
```

### Error codes
- 400: validation errors
  - Todos: `invalid_title`, `invalid_notes`, `invalid_scheduledFor`, `invalid_priority`, `invalid_completed`, `invalid_id`, `invalid_query`, `invalid_from`, `invalid_to`
  - Assistant/Apply: `invalid_message`, `invalid_operations` (with `detail` listing per-op errors)
- 404: `not_found`
- 502: assistant failures: `assistant_failure` (LLM CLI or timeout)
- 500: `internal_error` (catch-all error handler)

### Response examples
```json
// POST /api/todos (success uses 200 JSON)
{
  "todo": {
    "id": 12,
    "title": "Buy milk",
    "notes": "2%",
    "scheduledFor": "2025-08-12",
    "priority": "high",
    "completed": false,
    "createdAt": "2025-08-11T10:15:12.345Z",
    "updatedAt": "2025-08-11T10:15:12.345Z"
  }
}

// GET /api/todos?from=2025-08-11&to=2025-08-17
{
  "todos": [ { "id": 12, "title": "Buy milk", "notes": "2%", "scheduledFor": "2025-08-12", "priority": "high", "completed": false, "createdAt": "...", "updatedAt": "..." } ]
}

// POST /api/assistant/message
{
  "text": "creating 1 task. (Buy bread) Target: 2025-08-12.",
  "operations": [
    { "op": "create", "title": "Buy bread", "scheduledFor": "2025-08-12", "priority": "high" }
  ]
}

// POST /api/llm/apply
{
  "results": [
    { "ok": true, "op": {"op":"create","title":"Buy bread","scheduledFor":"2025-08-12","priority":"high"}, "todo": {"id":13,"title":"Buy bread", "notes":"", "scheduledFor":"2025-08-12","priority":"high","completed":false,"createdAt":"...","updatedAt":"..."} }
  ],
  "summary": { "created": 1, "updated": 0, "deleted": 0, "completed": 0 }
}
```


