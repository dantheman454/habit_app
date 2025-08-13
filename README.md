## Habit App — Full Todo + LLM Proposal-and-Verify Guide (Single Server)

This document is the single source of truth for running, understanding, and extending this app into a reliable, fully functioning todo list with optional LLM-assisted edits that are verified by you before they are applied. It targets a simplified, single-server architecture and specifies Ollama as the LLM backend.

### What you get
- **Basic todo app**: Create, list, update, complete/uncomplete, and delete tasks. Scheduled tasks show under a date range; unscheduled ones live in the backlog.
- **Lightweight stack**: Node + Express serving a small vanilla JS UI. Data persisted as JSON files.
- **LLM extension plan**: A safe, verify-before-apply workflow where the LLM proposes changes (create/update/delete/complete). You review the proposal and explicitly apply or reject it.


## 1) Target architecture and responsibilities

- `server.js` (to be introduced) — Single Express server that:
  - Serves the UI from `web/public/`
  - Implements all CRUD endpoints under `/api/todos*` and backlog/search helpers
  - Implements LLM endpoints under `/api/llm/*` using Ollama via CLI (`ollama run <model>`) with strict JSON validation
  - Persists to `data/todos.json` and `data/counter.json`

- `web/public/` — UI (vanilla JS): `index.html`, `app.js`, `styles.css`.
  - Will gain inline editing, completion checkboxes, search box, and an LLM proposal review panel.

- `data/` — Persistent JSON store for todos and the autoincrement counter.

Legacy components prior to simplification (scheduled for removal after parity):
- `web/server.js`, `src/server.js`, and `scripts/mcp_client.js` (bridge + MCP server)


## 2) Running locally

Prereqs: Node 18+ and Python 3 (for some tests). From the repo root:

```bash
npm install
# Until the single server lands, keep using the bridge server:
npm run web  # serves UI + API at http://127.0.0.1:3000
```

After migration to `server.js` (single server), start with:

```bash
node server.js  # or add an npm script like: "start:web": "node server.js"
```

Current status: single server `server.js` has been added and `npm run web` now starts it.

Flutter Web build (if you modify the UI):

```bash
cd apps/web/flutter_app
flutter build web
cd -
# Then start the server (serves build/web):
npm run web
```

Seed/clear data:

```bash
npm run seed
npm run clear
```


## 3) Data model and constraints

Todo fields stored in `data/todos.json`:
- `id: number` — unique
- `title: string` — required, non-empty
- `notes: string` — optional
- `scheduledFor: string | null` — `YYYY-MM-DD` or `null` for backlog
- `priority: "low" | "medium" | "high"`
- `completed: boolean`
- `createdAt: ISO string`
- `updatedAt: ISO string`

Validation is enforced at the API layer. After migration, it will all live in `server.js`.


## 4) REST API (single server)

- `GET /health` → `{ ok: true }`

- `GET /api/todos?from=YYYY-MM-DD&to=YYYY-MM-DD&completed=true|false&priority=low|medium|high` → `{ todos: Todo[] }`
  - Returns only scheduled tasks within the inclusive date range.

- `GET /api/todos/backlog` → `{ todos: Todo[] }`
  - Returns unscheduled tasks; UI can hide completed based on a toggle.

- `GET /api/todos/search?query=...` → `{ todos: Todo[] }`

- `GET /api/todos/:id` → `{ todo: Todo }`

- `POST /api/todos` with JSON body `{ title, notes?, scheduledFor? (YYYY-MM-DD|null), priority? }` → `{ todo }`

- `PATCH /api/todos/:id` with any of `{ title, notes, scheduledFor (YYYY-MM-DD|null), priority, completed }` → `{ todo }`

- `DELETE /api/todos/:id` → `{ ok: true }`


## 5) Current UI behaviors (quick reference)

- Day/Week/Month view with an anchor date determines the Scheduled list range.
- Backlog shows all unscheduled tasks.
- Toggle show-completed to include/exclude completed entries in both lists.
- Create form supports title/notes/date/priority.
- Actions on each todo: Complete/Uncomplete, Edit (prompt-based), Delete.


## 6) Immediate polish recommendations (no framework required)

1) Replace `window.prompt` edits with an inline edit drawer or modal:
   - Editable fields: title, notes, priority, scheduled date, completed checkbox
   - Keep validation errors inline; reuse existing PATCH endpoint

2) Make completion a first-class checkbox in the list items:
   - A checked box marks completed and dims the row (strikethrough, muted color)
   - The UI already toggles via PATCH; just bind the checkbox to `completed`

3) Add a search box in the header:
   - Debounced calls to `/api/todos/search?query=...`
   - Merge results into sections or show a separate “Search results” panel

4) Visual grouping by date in week/month view:
   - Insert date headers between items in `Scheduled`

5) Persist UI state in the URL (anchor/view/showCompleted) so refresh is safe and shareable.

Implemented so far:
- Single server `server.js` with CRUD, search, backlog, and static UI serving.
- NPM scripts `web` and `web:dev` now point to `server.js`.
- UI now renders completion as a checkbox and styles completed items; inline edit form replaces prompt flow.
 - LLM endpoints added: `POST /api/llm/propose` (Ollama) and `POST /api/llm/apply` with audit logging to `data/audit.jsonl`.
 - Note: set `OLLAMA_MODEL` before calling `/api/llm/propose`. Example models that worked locally: `granite3.3:8b`. Usage:
   - `export OLLAMA_MODEL=granite3.3:8b`
   - `ollama pull "$OLLAMA_MODEL"`
   - Start server and POST to `/api/llm/propose`.
 - Search UI added (debounced) and wired to `/api/todos/search`.
 - Scheduled list grouped by date; URL now persists `anchor`, `view`, `completed` state.
 - Proposal review now includes a small inline diff for `update`/`complete` operations, comparing proposed fields to current values.


## 7) LLM proposal-and-verify feature (design, Ollama-backed)

Goal: Let you write a natural-language instruction (e.g., “Schedule all high-priority backlog items for next week and rename ‘test 2’ to ‘Buy milk’”). The LLM does NOT apply changes. Instead it returns a structured proposal (list of operations). You review and explicitly apply.

### 7.1 Operation schema

Each proposed operation has a type and fields:

```json
{
  "operations": [
    {
      "op": "create",
      "title": "Buy milk",
      "notes": "2%",
      "scheduledFor": "2025-08-12",
      "priority": "high"
    },
    {
      "op": "update",
      "id": 2,
      "title": "Buy groceries",
      "priority": "medium"
    },
    {
      "op": "delete",
      "id": 5
    },
    {
      "op": "complete",
      "id": 1,
      "completed": true
    }
  ]
}
```

Notes:
- `complete` is simply `update` with `{ completed: true|false }`, but keeping a distinct op improves UX.
- Operations must reference existing IDs where relevant; creation returns new IDs at apply time.

### 7.2 New endpoints (single server)

- `POST /api/llm/propose` → Ask the LLM (via Ollama) to produce a structured plan based on `{ instruction: string }` and optional context `{ anchor, range, todos }`.
  - Request: `{ instruction: string }`
  - Response: `{ operations: Operation[] , rationale?: string }`

- `POST /api/llm/apply` → Apply a vetted list of operations
  - Request: `{ operations: Operation[] }`
  - Response: `{ results: Array<{ ok: boolean, op: Operation, error?: string, todo?: Todo }>, summary: { created: number, updated: number, deleted: number, completed: number } }`

Implementation detail: `apply` should operate in-process against the same JSON persistence and write an `audit.jsonl`. No external calls.

### 7.3 Verification UI (to add)

1) Add a right-side panel or modal where you can:
   - Enter an instruction
   - Preview the proposed operations rendered as a checklist with human-readable diffs
   - Approve all or individually toggle operations

2) On Apply:
   - Send only the checked operations to `/api/llm/apply`
   - Show a concise results summary and refresh lists

3) Safety and guardrails:
   - Validate schema and field constraints before displaying
   - Cross-check referenced IDs exist
   - Surface conflicts (e.g., trying to update a deleted task) and mark those operations as invalid before apply
   - Dry-run mode inside the server: attempt to validate all ops first and fail fast with actionable errors

### 7.4 Ollama integration and prompting strategy

We strongly constrain the model output to the operation schema and give it only the context needed. Use Ollama via CLI (mirrors our Python orchestrator):

Node pseudocode:

```js
import { spawn } from 'child_process';

function runOllamaPrompt({ model, temperature, prompt, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ollama', ['run', model, '--temperature', String(temperature)]);
    let out = '';
    let err = '';
    const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} ; reject(new Error('timeout')); }, timeoutMs || 90000);
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('close', (code) => { clearTimeout(t); code === 0 ? resolve(out.trim()) : reject(new Error(`ollama_exit_${code}: ${err}`)); });
    proc.stdin.end(prompt);
  });
}
```

Prompt template (sketch):

```
You are an assistant for a todo app. You must ONLY output a single JSON object strictly matching this schema:
{ "operations": Operation[] }
Where Operation is one of create|update|delete|complete as documented below.
If unsure, prefer suggesting fewer changes rather than hallucinating.

Context:
- Current date anchor: {{anchor}}
- Visible range: {{from}}..{{to}}
- Todos: {{todos_json}}

User instruction: {{instruction}}

Rules:
- Only include valid IDs for update/delete/complete
- For scheduled tasks, use YYYY-MM-DD
- priority ∈ {low, medium, high}
- No comments or explanations. Output JSON only.
```

Environment/config:
- `OLLAMA_MODEL` (e.g., `llama3.1:8b`)
- `OLLAMA_TEMPERATURE` (default `0.1`)
- `GLOBAL_TIMEOUT_SECS` (default `90`)

Install and pull model:
```bash
brew install ollama
ollama pull llama3.1:8b
```


## 8) Reliability and safety checklist

- Input validation on all endpoints (CRUD and `/api/llm/*`).
- JSON schema validation for the LLM response before rendering or applying.
- Idempotency and race-safety for apply:
  - Write operations serialize on a file lock (or a simple mutex in process).
  - Persist an `audit.jsonl` with `{ ts, user, op, result }` for transparency and recovery.
- Unit tests for operation translation and for edge cases (missing IDs, invalid dates, empty titles, etc.).


## 9) Implementation plan (incremental)

Phase A — Simplify to a single server and polish basics
1. Create `server.js` (serve static UI; implement `/api/todos*`, backlog, search; migrate persistence from `src/server.js`).
2. Update `package.json` scripts to run `server.js`; keep `web/server.js` temporarily for rollback.
3. UI polish: add completion checkboxes + styles; replace prompt-based edit with inline edit; add search box; group scheduled items by date; persist UI state in URL.

Phase B — LLM proposal-and-verify (Ollama)
1. Implement `/api/llm/propose` using `ollama run $OLLAMA_MODEL` and strict JSON parsing/validation. ✅
2. Implement `/api/llm/apply` (in-process ops with audit logging and dry-run validation). ✅
3. Add a review UI: input + proposed ops checklist → Apply. ✅ (basic version)
4. Add tests for propose/apply, including invalid schemas and conflicting ops. ⏳

Phase C — Cleanup
- Remove `web/server.js`, `src/server.js`, and `scripts/mcp_client.js` after parity and tests are green.
 - Update README to remove bridge/MCP references after deletion. Add a migration note and changelog entry.

Status:
- Endpoint tests added in `tests/test_llm_endpoints.py`; they pass locally. Legacy bridge files removed.


## 10) Testing

- Smoke tests: create/list/update/delete through the API; verify JSON files change as expected.
- Contract tests for `/api/llm/propose` validation and `/api/llm/apply` translation.
- UI tests (manual to start):
  - Toggle completion via checkbox reflects immediately
  - Edit inline, cancel, save, validation errors
  - Search filters results correctly
  - Proposal review shows correct diffs and applies only selected ops


## 11) Troubleshooting

- If the UI shows “Bridge not ready”, ensure `npm run web` is active and you are on `http://127.0.0.1:3000`.
- Data not saving? Check file permissions under `data/` and that the process can write to `todos.json`.
- Ollama issues: ensure `ollama list` works and the model is pulled; raise `GLOBAL_TIMEOUT_SECS` if needed.


## 12) Security and privacy

- API keys for LLM providers should be read from env vars; never commit them.
- Do not send full todo data to external services unless necessary; consider sending only the visible range and relevant backlog subset.
- Keep an `audit.jsonl` for changes applied via LLM proposals.


---

Confirming decisions and next steps:
- We will simplify to a single Express server (`server.js`) that owns CRUD and LLM endpoints.
- We will use Ollama via the CLI (`ollama run`) for proposals, mirroring the test suite approach.
- For the verification UI, a right-side panel keeps context visible; a modal is also feasible.

See the modular handbook under `docs/handbook/` for in-depth, single-user local documentation:

- `docs/handbook/overview.md`
- `docs/handbook/architecture.md`
- `docs/handbook/api.md`
- `docs/handbook/ui.md`
- `docs/handbook/llm.md`
- `docs/handbook/development.md`
- `docs/handbook/testing.md`
- `docs/handbook/troubleshooting.md`
- `docs/handbook/roadmap.md`


