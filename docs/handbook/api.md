## API Contract (v1)

Base: `http://127.0.0.1:3000`  Content-Type: `application/json`

### Health
- GET `/health` → `{ ok: true }`

### Todos
- GET `/api/todos`
  - Query: `from=YYYY-MM-DD` (optional), `to=YYYY-MM-DD` (optional), `completed=true|false` (optional), `priority=low|medium|high` (optional)
  - Returns only scheduled items (`scheduledFor != null`)
  - `to` is inclusive; server implements inclusivity by filtering `td < (to + 1 day)`
  - Response: `{ todos: Todo[] }`
- GET `/api/todos/backlog`
  - Returns unscheduled items (`scheduledFor === null`)
  - Response: `{ todos: Todo[] }`
- GET `/api/todos/search?query=string`
  - Case-insensitive search in `title` or `notes`
  - Requires non-empty `query`
  - Response: `{ todos: Todo[] }`
- GET `/api/todos/:id`
  - Response: `{ todo: Todo }`
- POST `/api/todos`
  - Body: `{ title: string, notes?: string, scheduledFor?: YYYY-MM-DD|null, priority?: 'low'|'medium'|'high' }`
  - Response: `{ todo: Todo }`
- PATCH `/api/todos/:id`
  - Body: any of `{ title, notes, scheduledFor, priority, completed }`
  - Response: `{ todo: Todo }`
- DELETE `/api/todos/:id`
  - Response: `{ ok: true }`

Notes:
- Lists are returned in storage order (no sort guarantees)
- All successful responses use HTTP 200 with JSON bodies

### LLM propose/apply
- POST `/api/llm/propose`
  - Body: `{ instruction: string }`
  - Response: `{ operations: Operation[] }`
  - Behavior: server builds a strict prompt, runs `ollama run <model>`, parses JSON output using multiple strategies (code-fence removal, brace matching), normalizes operations, validates them, and returns the valid list
- POST `/api/llm/apply`
  - Body: `{ operations: Operation[] }`
  - Response: `{ results: Array<{ ok: boolean, op: Operation, todo?: Todo, error?: string }>, summary: { created, updated, deleted, completed } }`
  - Behavior: applies operations under a single-process lock; appends `data/audit.jsonl`

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

### Validation rules (server-enforced)
- `title` required on create (non-empty string)
- `notes` is string if provided
- `scheduledFor` is `YYYY-MM-DD` or `null` if provided
- `priority` ∈ `low|medium|high` if provided
- `completed` is boolean if provided
- For `update|delete|complete`, `id` must exist

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

# LLM propose/apply
curl -s -X POST http://127.0.0.1:3000/api/llm/propose \
  -H 'Content-Type: application/json' \
  -d '{"instruction":"schedule high-priority backlog for tomorrow"}'

curl -s -X POST http://127.0.0.1:3000/api/llm/apply \
  -H 'Content-Type: application/json' \
  -d '{"operations":[{"op":"create","title":"Buy bread","priority":"high"}]}'
```

### Error codes
- 400: validation errors
  - Todos: `invalid_title`, `invalid_notes`, `invalid_scheduledFor`, `invalid_priority`, `invalid_completed`, `invalid_id`, `invalid_query`, `invalid_from`, `invalid_to`
  - Propose/Apply: `invalid_instruction`, `invalid_operations` (with `detail` listing per-op errors)
- 404: `not_found`
- 502: propose failures: `non_json_response`, `upstream_failure` (LLM CLI or timeout)
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

// POST /api/llm/propose
{
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


