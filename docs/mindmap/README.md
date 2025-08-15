## Habit App Mind Map (Developers)

This suite maps the algorithms, abstractions, and API couplings across the Habit app. Use it as a high-signal index into the code with deep drill-downs. Diagrams use Mermaid; links point to source docs and code. Where possible, we reference functions/sections instead of exact line numbers to reduce churn.

### System overview

```mermaid
graph TD
  subgraph "Client"
    A["Flutter Web UI\napps/web/flutter_app/lib/main.dart"]
    A2["API wrapper\napps/web/flutter_app/lib/api.dart"]
  end
  subgraph "Server"
    B["Express API\napps/server/server.js"]
  end
  subgraph "Persistence"
    P[("SQLite (data/app.db)\nTables: todos, events, goals, audit_log, idempotency")]
  end
  subgraph "LLM"
    F[["Ollama local model\ngranite3.3:8b"]]
  end

  A --> A2
  A2 -->|"HTTP JSON"| B
  B -->|"CRUD/search/backlog"| P
  B -->|"assistant apply audit + idempotency"| P
  B -->|"propose/repair/summarize"| F
```

### End-to-end traces

```mermaid
sequenceDiagram
  participant UI as "Flutter Web UI"
  participant API as "Express API"
  participant DB as "SQLite data/app.db"
  participant LLM as "Ollama granite3.3:8b"

  UI->>API: POST /api/todos (create)
  API->>API: validate and normalize
  API->>DB: insert todo
  API-->>UI: {todo}

  UI->>API: GET /api/assistant/message/stream
  API->>API: run router
  alt clarify
    API-->>UI: clarify question and options
  else chat
    API->>LLM: chat prompt
    LLM-->>API: summary text
    API-->>UI: summary
  else plan
    API->>LLM: propose prompt
    LLM-->>API: JSON operations
    API->>API: parse validate repair
    API-->>UI: operations and summary
  end
  UI->>API: POST /api/llm/dryrun
  API-->>UI: results and summary
  UI->>API: POST /api/llm/apply
  API->>DB: mutate todos events goals
  API->>DB: insert audit log and upsert idempotency
  API-->>UI: results and summary
```

### Contents
- [API Surface](./api_surface.md): Endpoints, request/response shapes, error contracts, and coupling to `apps/web/flutter_app/lib/api.dart`.
- [Data Model](./data_model.md): SQLite tables and mapped shapes; recurrence and occurrence semantics.
- [Backend Algorithms](./backend_algorithms.md): Validation, normalization, recurrence expansion, router, proposal/repair, idempotency, and auditing.
- [LLM Pipeline](./llm_pipeline.md): Prompts, thresholds, parsing/normalization, SSE vs POST flows, and chat vs auto vs plan modes.
- [Client Architecture](./client_architecture.md): Flutter state flows, assistant UX, search overlay, and CRUD interactions.
- [Glossary](./glossary.md): Domain terms and precise meanings used across server and client.

### Primary entry points
- Constraints and assumptions
  - Single-user, single-process server; SQLite persistence in `data/app.db`
  - No auth; Ollama runs locally
  - Strict recurrence policy: recurrence object required on create/update; anchor required for repeating
  - Assistant is safety-bounded by validation and single repair attempt; bulk operations are not supported

### Key invariants and contracts

- Repeating tasks/events track per-day completion in `completedDates`; occurrence completion toggles this array (see `/api/*/:id/occurrence` and `complete_occurrence` op). Master-level `completed` applies to non-repeating.
- Switching repeating→none clears `completedDates`; default recurrence `until` is applied when missing.
- Time-of-day is `HH:MM` or null; UI treats null as all-day.
- Apply is idempotent (header `Idempotency-Key` supported) and writes to `audit_log`.

- Server: `apps/server/server.js`
- Client app: `apps/web/flutter_app/lib/main.dart`
- Client API: `apps/web/flutter_app/lib/api.dart`
- This folder serves as the authoritative architecture overview.


