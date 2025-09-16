# Assistant Chat System Mind Map (Current State)

This document reflects how Mr. Assister works today in the tasks/events app, from user input to validated proposals, previews, and optional apply via MCP with full audit/undo.

## System Architecture Overview

```mermaid
graph TD
  subgraph "Client (Flutter Web)"
    A[User types message] --> B[Assistant Panel]
    B --> C[API Client]
    C --> D[SSE Stream Handler]
    D --> Q[Show ops + previews + summary]
    Q --> R[User clicks Apply (optional)]
  end

  subgraph "Server (Express)"
    E[Assistant route /api/assistant/*] --> F[OpsAgent (Tool‑Calling)]
    F --> H[Validation via OperationProcessor]
    H --> I[Summarization + Previews]
    I -->|SSE events: ops, summary, heartbeat, done| D
    R --> J[MCP HTTP: /api/mcp/tools/call]
    J --> K[OperationProcessor.execute]
  end

  subgraph "LLM (Ollama)"
    L[qwen3‑coder:30b (code+convo)] --> M[Tool JSON]
    M --> N[Extraction + Rounds]
  end

  subgraph "Database (SQLite)"
    S[Tables] --> T[Batch Recorder]
    T --> U[Audit Log + Undo]
  end

  F --> L
  H --> L
  K --> S
```

## Detailed Flow: "update my task for today"

### 1. User Input & Client Processing

**Input**: User types "update my task for today" and clicks Send

**Client State**:
```dart
// In main.dart _sendAssistantMessage()
assistantTranscript.add({'role': 'user', 'text': 'update my task for today'});
assistantSending = true;
// Insert placeholder assistant bubble
assistantTranscript.add({'role': 'assistant', 'text': ''});
assistantStreamingIndex = assistantTranscript.length - 1;
```

**API Call**:
```dart
// Send last 3 turns for context
final recent = assistantTranscript.sublist(assistantTranscript.length - 3);
final res = await api.assistantMessage(
  'update my task for today',
  transcript: recent,
  streamSummary: true,
  onSummary: (s) => { /* Update placeholder bubble */ },
  onStage: (st) => { /* Update progress */ },
  onOps: (ops, version, validCount, invalidCount, previews) => { /* Show operations */ },
  onThinking: (thinking) => { /* Show thinking process */ },
  onTraceId: (correlationId) => { /* Track correlation ID */ }
);
```

**SSE Events**: Server emits `stage`, `ops`, `summary`, `heartbeat`, and `done` (no `result`).
- `stage`: `{ stage: "act", correlationId }`
- `ops`: `{ operations, version: 3, validCount, invalidCount, previews, correlationId }`
- `summary`: `{ text, steps, operations, tools, notes, thinking, correlationId }`
- `previews[]`: `{ key, op, before }` where `before` is fetched for update/delete to enable diff UI.

### 2. OpsAgent Proposal (Tool‑Calling: propose‑only)

```javascript
// runOpsAgentToolCalling() called with:
const oa = await runOpsAgentToolCalling({ 
  taskBrief: message.trim(),
  where, // from options.client.where (POST) or context.where (SSE)
  transcript,
  timezone: TIMEZONE,
  operationProcessor
});
```

### Tool Calling Generation (with focused context)
```javascript
const toolNames = [
  'task.create','task.update','task.delete','task.set_status',
  'event.create','event.update','event.delete'
];
// Each tool's parameters come from OperationRegistry JSON Schemas
```

Focused context is built server‑side from today/week items, UI selection, and indexes:

```json
{
  "tasks": [ { "id": 1, "title": "...", "scheduledFor": "YYYY-MM-DD", "status": "pending" } ],
  "events": [ { "id": 12, "title": "...", "scheduledFor": "YYYY-MM-DD", "startTime": "HH:MM", "endTime": "HH:MM" } ],
  "focused": { "candidates": [ { "kind": "task", "id": 1, "reason": "selected_in_ui" } ] },
  "indexes": {
    "task_by_title_ci": { "email tests": 3 },
    "event_by_title_ci": { "lunch with dad": 42 },
    "id_to_kind": { "3": "task", "42": "event" },
    "id_to_title": { "3": "Email tests", "42": "Lunch with Dad" }
  }
}
```

Notes
- OpsAgent uses `task.create`/`event.update` tool names. MCP server uses `create_task`/`update_event` names. Conversion happens on the server when applying.
- Tasks are all‑day (no start/end time). Events carry `startTime`/`endTime`.
- Event completion is not a tool; task completion uses `task.set_status` (optionally `occurrenceDate`).

### 3. Validation and Fallback

**Validation Process**:
```javascript
// Each tool call is validated using OperationProcessor
const type = operationProcessor.inferOperationType(op);
const validator = operationProcessor.validators.get(type);
const validation = validator ? await validator(op) : { valid: false, errors: ['unknown_operation_type'] };
```

If the model doesn’t emit tool calls, the system returns concise guidance text. No hidden auto-inference or implicit operations are performed.

### 4. Apply Phase (MCP) — user‑driven

**Tool Call Processing**:
```javascript
// Proposals are previewed in the UI; user applies selected ops via MCP
POST /api/mcp/tools/call { name, arguments }
// Note: MCP server uses create_task, update_task format, not task.create format
```

**Operation Processor Execution**:
```javascript
const type = this.inferOperationType(op); // "task_update"
const validator = this.validators.get(type);
const executor = this.executors.get(type);
```

Security: `/api/mcp/tools/call` can be protected with `MCP_SHARED_SECRET` sent as `x-mcp-token`.

Undo: last applied batch can be reversed via `/api/assistant/undo_last`.

### 5. Database Update, Audit, and Undo

**Batch Recording**: Each operation is recorded with before/after state for undo capability:
```javascript
await batchRecorder.recordOp({
  batchId,
  seq: Date.now(),
  op,
  before,
  after
});
```

**Audit Trail**: All operations are logged and associated with a correlation ID. Undo reconstructs inverse operations and applies them in reverse order.

## Fallback to Conversational Chat
If the OpsAgent throws an error (e.g., model is unavailable), the server falls back to `runChat()` which replies conversationally and explicitly does not modify data. That’s when you might see text like “the system doesn’t support modifying data.”

## Expected System Behavior Summary
- Assistant proposes validated operations; the UI previews them
- User chooses to apply ops; server executes via MCP and OperationProcessor
- Full audit trail with correlation ID and undo support
- If OpsAgent errors, fallback Chat answers but performs no changes

## Client-Side Implementation
- API integration in `apps/web/flutter_app/lib/api.dart`
- Assistant panel subscribes to SSE and updates stages, previews, summary, and thinking
- Apply button calls MCP tool(s) with correlation ID

## Server-Side Pipeline
- OpsAgent tool-calling in `apps/server/llm/ops_agent.js` (MAX_ROUNDS=5, MAX_OPS=20, strict JSON)
- Focused context in `apps/server/llm/context.js` (today/week snapshots, selection, indexes)
- MCP server tools in `apps/server/mcp/mcp_server.js` (create/update/delete for tasks/events, set_task_status)
- Operation processing in `apps/server/operations/*` via `OperationProcessor`
- Batch recording and undo in `apps/server/utils/batch_recorder.js`

## Integration Points
- Database schema: `apps/server/database/schema.sql`
- Correlation ID tracked end‑to‑end (SSE + MCP + audit)
- Timezone: default `America/New_York` (TZ_NAME)

## Model & Prompting
- Local LLM via Ollama using `qwen3-coder:30b` for both convo and tool‑calling.
- Strict tool prompt requires a single JSON object with optional `<think>` blocks that are stripped from final text.

## Known Constraints (today)
- Assistant proposes; it does not auto‑apply
- Tasks are all‑day; events carry times; event completion isn’t supported
- Title matching and focused candidates reduce ambiguity; IDs are never invented
