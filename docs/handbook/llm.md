## LLM: Proposal-and-Verify

Goal: convert natural-language instructions into a safe, reviewable set of operations that you explicitly approve before applying.

Flow
1) UI sends `{ message, transcript?, options? }` → `/api/assistant/message`
2) Server builds a strict prompt for operations, runs `ollama run <model>`, parses/normalizes JSON
3) Server validates operations (shape, IDs, dates, priority); also generates a brief summary (second call)
4) UI renders summary and operations; you select a subset
5) UI sends `{ operations }` → `/api/llm/apply`
6) Server mutates JSON persistence under a simple mutex and appends `data/audit.jsonl`

Operation schema
```json
{
  "operations": [
    { "op": "create", "title": "Buy milk", "notes": "2%", "scheduledFor": "2025-08-12", "priority": "high" },
    { "op": "update", "id": 2, "title": "Buy groceries", "priority": "medium" },
    { "op": "delete", "id": 5 },
    { "op": "complete", "id": 1, "completed": true }
  ]
}
```

Models and environment
- Current default model: `granite3.3:8b`
- Also supported: `granite-code:8b`
- Env vars: `OLLAMA_MODEL` (default `granite3.3:8b`), `OLLAMA_TEMPERATURE` (default `0.1`), `GLOBAL_TIMEOUT_SECS` (default `120`)

Setup
```bash
brew install ollama
ollama pull granite3.3:8b
# optionally
ollama pull granite-code:8b
export OLLAMA_MODEL=granite3.3:8b
```

Server strategy
- Prompt: injects today's date, enumerates allowed fields, forbids prose, and asks for a single JSON object with `operations`
- Parsing: attempts direct JSON parse; strips code fences; as a last resort, brace-matches the first JSON object
- Coercion: maps `action` or `type` → `op` if present
- Inference: if `op` missing, infer:
  - no `id` and fields like `title/scheduledFor/priority` → `create` (drop any provided `id`)
  - `id` present and only `completed` provided → `complete`
  - `id` present and any of `title|notes|scheduledFor|priority` provided → `update`
- Normalization: lowercase `priority`; empty string `scheduledFor: ''` → `null`
- Validation: per-operation (`priority` enum, `scheduledFor` format, `id` existence for `update|delete|complete`); `invalid_operations` is returned with per-op errors in `detail`
- Apply: executed under an in-process mutex (`withApplyLock`) to serialize writes; appends audit lines

```333:361:apps/server/server.js
function buildProposalPrompt({ instruction, todosSnapshot, transcript }) {
  const today = new Date();
  const todayYmd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const system = `You are an assistant for a todo app. Output ONLY a single JSON object with key "operations" as an array. No prose.\n` +
    `Each operation MUST include field "op" which is one of: "create", "update", "delete", "complete".\n` +
    `Allowed fields: op, id (int for update/delete/complete), title, notes, scheduledFor (YYYY-MM-DD or null), priority (low|medium|high), completed (bool).\n` +
    `If the user's instruction does not specify a date for a create operation, DEFAULT scheduledFor to TODAY (${todayYmd}).\n` +
    `Today's date is ${todayYmd}. Do NOT invent invalid IDs. Prefer fewer changes over hallucination.\n` +
    `You may reason internally, but the final output MUST be a single JSON object exactly as specified. Do not include your reasoning or any prose.`;
  // ...
}
```

Safety/guardrails
- Strict JSON parsing (codefence and brace-matching fallbacks)
- Schema/field validation before display and before apply
- Dry-run style validation in both propose and apply paths

Audit format
- `data/audit.jsonl` (one JSON per line): `{ ts, action, op, result, id?, error? }`
- Actions: `create|update|delete|complete|invalid`

Prompt shape (server)
- System: enumerates allowed fields and today’s date; forbids prose
- User: embeds instruction and current todos snapshot; demands JSON-only output

Example prompt body (abbreviated)
```text
You are an assistant for a todo app. Output ONLY a single JSON object with key "operations" as an array. No prose.
Each operation MUST include field "op" which is one of: "create", "update", "delete", "complete".
Allowed fields: op, id (int for update/delete/complete), title, notes, scheduledFor (YYYY-MM-DD or null), priority (low|medium|high), completed (bool).
If the user's instruction does not specify a date for a create operation, DEFAULT scheduledFor to TODAY (YYYY-MM-DD).
Today's date is YYYY-MM-DD. Do NOT invent invalid IDs. Prefer fewer changes over hallucination.

Instruction:
<user instruction>

Context:
{ "todos": [ ... ] }

Respond with JSON ONLY that matches this exact example format:
{
  "operations": [
    {"op": "create", "title": "Buy milk", "scheduledFor": "YYYY-MM-DD", "priority": "high"}
  ]
}
```

Model tips
- Prefer concise instructions; include dates as `YYYY-MM-DD`
- When unsure, the server defaults create scheduledFor to TODAY

Timeouts and CLI compatibility
- End-to-end assistant timeout controlled by `GLOBAL_TIMEOUT_SECS`
- If the local Ollama CLI does not support `--temperature`, the server auto-retries without that flag



