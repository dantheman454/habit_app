### Step-by-step guide: Correctness and robustness fixes (non-breaking)

This guide documents small, targeted improvements to the Habit app that do not change its fundamental functionality. Each step lists the file, location, and the precise change to apply.

### Prerequisites
- Ensure the server is stopped before editing server files.
- Recommended Node 18+ (per `package.json`).
- Optional: create a new branch for these edits.

### 1) Respect `completed` filter for expanded occurrences in GET `/api/todos` (DONE)
- **File**: `apps/server/server.js`
- **Location**: Inside the list handler `app.get('/api/todos', ...)`, in the branch where both `from` and `to` are provided, right after `expanded` is built.
- **Why**: When expanding repeating tasks to occurrences, the server currently ignores `completed` filtering for the expanded results. Applying the filter post-expansion ensures the API and UI behave as expected.
- **Edit**: Apply `completed` filtering to `expanded` before returning the response.

```js
// After building `expanded`
if (completedBool !== undefined) {
  const filtered = expanded.filter(t => t && typeof t.completed === 'boolean' && (t.completed === completedBool));
  return res.json({ todos: filtered });
}
return res.json({ todos: expanded });
```

Notes:
- Keep the earlier master-level filters as-is. This post-expansion filter ensures occurrences honor `completed` while still allowing non-repeating masters to be filtered correctly.

### 2) Add HTTP timeout to Ollama JSON request (DONE)
- **File**: `apps/server/server.js`
- **Location**: Function `tryRunOllamaJsonFormat({ userContent })`.
- **Why**: The CLI path has a timeout; the HTTP JSON path does not. Add an AbortController timeout using the existing `GLOBAL_TIMEOUT_SECS` constant.
- **Edit**: Wrap `fetch` with an `AbortController` and clear it on completion.

```js
async function tryRunOllamaJsonFormat({ userContent }) {
  const base = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
  const url = `${base}/api/generate`;
  const payload = { model: OLLAMA_MODEL, prompt: userContent, format: 'json', stream: false };
  const controller = new AbortController();
  const timeoutMs = Math.max(1000, GLOBAL_TIMEOUT_SECS * 1000);
  const timer = setTimeout(() => { try { controller.abort(); } catch {} }, timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`ollama_http_${res.status}`);
    const obj = await res.json();
    const text = String(obj && (obj.response ?? obj.text) || '');
    if (!text) throw new Error('ollama_http_empty');
    return text;
  } finally {
    try { clearTimeout(timer); } catch {}
  }
}
```

### 3) Unify index refresh + timezone application (PARTIAL)
- **File**: `apps/server/server.js`
- **Why**: Multiple write paths call `todosIndex.refresh(todos)` and sometimes forget to re-apply timezone (e.g., delete route). Centralize into a helper and use it consistently.
- **Edits**:
  1) Add a helper near other utilities:
     ```js
     function refreshIndexWithTz() {
       try { todosIndex.refresh(todos); todosIndex.setTimeZone(TIMEZONE); } catch {}
     }
     ```
  2) Replace occurrences of `try { todosIndex.refresh(todos); todosIndex.setTimeZone(TIMEZONE); } catch {}` with `refreshIndexWithTz();` in:
     - POST `/api/todos` (create)
     - PATCH `/api/todos/:id`
     - PATCH `/api/todos/:id/occurrence`
     - LLM apply/bulk operations where refreshes happen
  3) Replace `try { todosIndex.refresh(todos); } catch {}` in DELETE `/api/todos/:id` with `refreshIndexWithTz();`.

If you prefer not to add the helper, at minimum update the delete route to also call `setTimeZone(TIMEZONE)` after refresh.

### 4) Update `package.json` test script (clarity) (DONE)
- **File**: `package.json`
- **Why**: The `test` script currently runs `pytest`, which does not reflect this project’s setup and is misleading in CI/dev flows.
- **Edit**: Replace with a no-op placeholder until tests are added.

```json
"scripts": {
  "start": "node apps/server/server.js",
  "dev": "nodemon apps/server/server.js",
  "test": "echo \"No tests configured yet\" && exit 0"
}
```

Optionally add a `lint` script later for server linting.

### Optional follow-ups (nice-to-have)
- Harden `withApplyLock`: avoid fully swallowing errors. For example, log and rethrow inside the `.catch` to keep observability. Validate this against your desired error behavior before changing.
- Normalize incoming `'' → null` for `timeOfDay`/`scheduledFor` via a shared small helper to reduce duplication across create/update/bulk paths.
- Client search selection: route to a more contextually appropriate smart list (e.g., `SmartList.scheduled` when `scheduledFor != null`) instead of always `All`.
- Consider a minimal eslint config for the server to catch minor drifts.

### Decisions implemented in this pass
- Bulk complete semantics extended:
  - `bulk_complete` now supports optional `occurrenceDate` (single day) or `occurrence_range: { from?, to? }`. If provided and the target is repeating, the server toggles membership in `completedDates` for the specified date(s). When neither is provided, non-repeating tasks set `completed`; repeating tasks fall back to setting master `completed` (no-op for occurrences) for backward compatibility.
  - Validation additions: `invalid_occurrenceDate`, `invalid_occurrence_range[_from|_to]` when malformed.
  - Default: when no date hint is provided for repeating tasks, the server applies to “today” (in server timezone) for convenience.
- Router behavior aligned to intent:
  - If router decides `clarify`, return a clarify payload.
  - If router decides `chat`, return a concise chat answer without proposing operations (both POST and SSE paths).

Status: Implemented and health-checked.

### Verification checklist
- GET `/api/todos?from=YYYY-MM-DD&to=YYYY-MM-DD&completed=false` no longer returns completed occurrences. ✅
- LLM HTTP path aborts long requests roughly at `GLOBAL_TIMEOUT_SECS` like the CLI path. ✅
- After create/update/occurrence/delete/bulk ops, the index is refreshed and timezone consistently applied. ⚠️ Partial (DELETE route fixed; others already applied)
- `npm test` no longer fails due to absent Python tests. ✅

### Rollback
- All edits are local and small. Revert individual hunks if needed.


