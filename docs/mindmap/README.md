## Task/Event App Mind Map (Developers)

This hub aligns the docs with the current implementation. It's the quickest path to the right code and concepts. Diagrams use Mermaid; we reference functions/sections instead of line numbers to reduce churn.

### System overview

```mermaid
graph TD
  subgraph "Client (Flutter Web)"
    A["Flutter Web UI\napps/web/flutter_app/lib/main.dart\nState: ViewMode, MainView, SmartList"]
    A2["API wrapper\napps/web/flutter_app/lib/api.dart\nDio client, SSE support"]
    A3["Widgets\nassistant_panel.dart, sidebar.dart, task_row.dart\nReal-time updates"]
  end
  subgraph "Server (Express.js)"
    B["Express API\napps/server/server.js\nREST endpoints, SSE streaming"]
    B2["MCP Server\napps/server/mcp/mcp_server.js\nTool execution, validation"]
    B3["LLM Pipeline\napps/server/llm/ops_agent.js, apps/server/llm/chat.js\nOpsAgent (tool-calling), Chat fallback"]
    B4["Operation Processor\napps/server/operations/operation_processor.js, apps/server/operations/operation_registry.js\nValidation, execution, transactions"]
  end
  subgraph "Persistence (SQLite)"
    P[("SQLite (data/app.db)\nTables: tasks, events\nAudit_log, idempotency, op_batches\nFTS5 virtual tables")]
  end
  subgraph "LLM (Ollama)"
    F[["Ollama local model\nhardcoded (convo=qwen3-coder:30b, tool=qwen3-coder:30b)\nQwen-optimized prompts and parsing"]]
  end

  A --> A2
  A2 -->|"HTTP JSON + SSE"| B
  A2 -->|"MCP tool calls"| B2
  B -->|"CRUD/search/schedule"| P
  B -->|"assistant apply + audit + idempotency"| P
  B3 -->|"tool prompts"| F
  B2 -->|"tool execution + transactions"| P
  B4 -->|"operation validation + execution"| P
```

### End-to-end trace (happy path)

```mermaid
sequenceDiagram
  participant UI as "Flutter Web UI"
  participant API as "Express API"
  participant OPS as "OpsAgent (tool-calling)"
  participant DB as "SQLite data/app.db"
  participant LLM as "Ollama model"

  Note over UI,LLM: Create Task Flow
  UI->>API: POST /api/tasks {title, recurrence, context}
  API->>DB: INSERT with validation
  API-->>UI: {task} with generated id

  Note over UI,LLM: Assistant Proposal Flow
  UI->>API: GET /api/assistant/message/stream?message="update task"
  API->>OPS: runOpsAgentToolCalling (focused context, tool surface)
  OPS->>LLM: Tool-calling prompt (qwen3:30b)
  LLM-->>OPS: tool_calls JSON (e.g., task.update)
  API-->>UI: SSE: ops (validated proposals) and summary
  UI->>API: POST /api/mcp/tools/call (apply selected ops)
  API->>DB: Execute via Operation Processor (transaction + audit)
  API-->>UI: Apply results
```

### Architecture Principles

**Single Responsibility**: Each component has a clear, focused purpose
- **Client**: State management, UI rendering, user interaction
- **Server**: API routing, validation, business logic orchestration
- **MCP Server**: Tool execution, validation
- **Operation Processor**: Operation validation, execution, transaction management
- **LLM Pipeline**: Intent understanding, operation generation
- **Database**: Data persistence, relationships, search

**Loose Coupling**: Components communicate through well-defined interfaces
- HTTP JSON APIs for client-server communication
- MCP protocol for tool execution
- Operation processor for validation and execution
- Structured prompts for LLM interaction
- SQLite for data persistence

**Safety First**: Multiple layers of validation and error handling
- Client-side input validation
- Server-side schema validation
- Operation processor validation
- LLM response parsing and repair
- Database constraints and transactions
- Idempotency for operation safety

### Contents
- [API Surface](./api_surface.md): Endpoints, shapes, errors, and Flutter API coupling.
- [Data Model](./data_model.md): SQLite tables and normalized shapes; recurrence and occurrence semantics; unified schedule.
- [Backend Algorithms](./backend_algorithms.md): Validation, recurrence, OpsAgent tool-calling, proposal/fallback, batch-based undo.
- [Assistant Chat Mindmap](./assistant_chat_mindmap.md): Prompts, thresholds, parsing, SSE vs POST, chat/auto/plan.
- [Client Architecture](./client_architecture.md): Flutter state flows, assistant UX, search overlay, CRUD.
- [Glossary](./glossary.md): Domain terms aligned with code.

### Constraints and assumptions
- **Single-user, single-process server**: No multi-tenancy or clustering
- **SQLite persistence**: `data/app.db` with WAL mode enabled
- **No authentication**: Local development focus
- **Ollama local model**: Requires local Ollama instance running
- **Strict recurrence policy**: Recurrence object required on create/update; anchor required when repeating
- **Assistant safety**: Validation + single repair attempt; no bulk operations
- **Operations via MCP tools**: No direct apply/dryrun endpoints
- **Context field support**: 'school', 'personal', 'work' with 'personal' as default
- **Timezone handling**: Fixed to `America/New_York` (configurable via `TZ_NAME`)
- **Goals removed**: Goals entities and endpoints removed during migration

### Invariants and contracts
- **Recurrence semantics**: Repeating tasks track per-day completion via `completedDates`; set occurrence status via MCP `set_task_status` + `occurrenceDate`
- **State transitions**: Changing repeating→none clears `completedDates`
- **Time formats**: Times are `HH:MM` or null; dates are `YYYY-MM-DD`
- **Audit trail**: Assistant operations executed through MCP tool calls; all actions logged
- **Status fields**: Tasks use `status` field ('pending'|'completed'|'skipped'); events use `completed` boolean
- **Search capabilities**: FTS5 virtual tables provide full-text search for tasks and events
- **Idempotency**: MCP tool calls deduplicate by `Idempotency-Key` + request hash

### Key files and their responsibilities

**Server Layer**:
- `apps/server/server.js`: Express app, REST endpoints, SSE streaming, request validation
- `apps/server/app.js`: Express app setup, route mounting, middleware configuration
- `apps/server/mcp/mcp_server.js`: MCP protocol implementation, tool registry, execution engine
- `apps/server/database/DbService.js`: Database operations, connection management
- `apps/server/database/schema.sql`: SQLite schema definition, constraints, indexes

**LLM Pipeline**:
- `apps/server/llm/clients.js`: Ollama client wrappers, model configuration, Qwen-optimized helpers
- `apps/server/llm/ops_agent.js`: Tool-calling OpsAgent (proposes validated operations; no router step)
- `apps/server/llm/chat.js`: Chat responder for conversational replies (fallback when ops fail)
- `apps/server/llm/qwen_utils.js`: Prompt builders and response parsing
- `apps/server/llm/json_extract.js`: JSON extraction utilities
- `apps/server/llm/logging.js`: Correlated I/O logging helpers

**Operation Processing**:
- `apps/server/operations/operation_processor.js`: Operation validation, execution, transaction management
- `apps/server/operations/operation_registry.js`: Operation type registration and schema definitions
- `apps/server/operations/validators.js`: Operation validation logic
- `apps/server/operations/executors.js`: Operation execution logic

**Client Layer**:
- `apps/web/flutter_app/lib/main.dart`: Main app state, navigation, data loading
- `apps/web/flutter_app/lib/api.dart`: HTTP client, SSE handling, API abstraction
- `apps/web/flutter_app/lib/widgets/assistant_panel.dart`: Assistant UI, real-time updates
- `apps/web/flutter_app/lib/models.dart`: Shared enums and data structures

**Documentation**:
- `docs/mindmap/`: This comprehensive documentation hub

### Development workflow

**Local Setup**:
1. Install dependencies: `npm install` (server), `flutter pub get` (client)
2. Start Ollama: `ollama serve` (requires qwen3:30b model)
3. Start server: `npm start` (runs on port 3000)
4. Build client: `flutter build web` (served by Express)

**Key Environment Variables**:
- `OLLAMA_HOST`: Ollama host (default: 127.0.0.1)
- `OLLAMA_PORT`: Ollama port (default: 11434)
- `TZ_NAME`: Timezone (default: America/New_York)
  - Models are hardcoded: convo=`qwen3-coder:30b`, tool=`qwen3-coder:30b`

**Testing**:
- Unit tests: `npm test` (server), `flutter test` (client)
- Integration tests: `tests/run.js`
- Manual testing: Full-stack development server


