## Habit App Mind Map (Developers)

This suite maps the algorithms, abstractions, and API couplings across the Habit app. Use it as a high-signal index into the code with deep drill-downs and precise file/line references. Diagrams use Mermaid; links point to source docs and code. All line references below were validated against the current codebase.

### System overview

```mermaid
graph TD
  subgraph Client
    A["Flutter Web UI\napps/web/flutter_app/lib/main.dart"]
    A2["API wrapper\napps/web/flutter_app/lib/api.dart"]
  end
  subgraph Server
    B["Express API\napps/server/server.js"]
    I["In-memory retrieval index\napps/server/todos_index.js"]
  end
  subgraph Persistence
    C[("data/todos.json")]
    D[("data/counter.json")]
    E[("data/audit.jsonl")]
  end
  subgraph LLM
    F[["Ollama local model\ngranite3.3:8b"]]
  end

  A -->|UI state, events| A2
  A2 -->|HTTP JSON| B
  B -->|CRUD/search/backlog| C
  B -->|autoincrement| D
  B -->|append audit| E
  B -->|propose/repair/summarize| F
  B <-.-> I
```

### End-to-end traces

```mermaid
sequenceDiagram
  participant UI as Flutter Web UI
  participant API as Express API
  participant IDX as In-Memory Index
  participant FS as JSON Files
  participant LLM as Ollama (granite3.3:8b)

  rect rgb(245,245,255)
  note over UI,API: CRUD flow (non-LLM)
  UI->>API: POST /api/todos (create)
  API->>API: validate + normalize (server 333:368, 142:160)
  API->>FS: write todos.json + counter.json
  API->>IDX: refresh()
  API-->>UI: { todo }
  end

  rect rgb(245,255,245)
  note over UI,LLM: Assistant (auto)
  UI->>API: GET /api/assistant/message/stream (auto)
  API->>API: runRouter (server 890:942)
  alt decision == clarify
    API-->>UI: event: clarify { question, options }
  else decision == chat
    API->>LLM: chat summary prompt
    LLM-->>API: plain text
    API-->>UI: event: summary; then done
  else decision == plan
    API->>LLM: propose prompt (server 944:961)
    LLM-->>API: raw text (JSON preferred)
    API->>API: parse→infer→validate (server 1188:1214)
    alt invalid
      API->>LLM: repair prompt (server 853:867)
      LLM-->>API: repaired JSON
      API->>API: re-validate
    end
    API-->>UI: event: ops + summary (LLM or deterministic)
  end
  UI->>API: POST /api/llm/dryrun (preview)
  API-->>UI: warnings?
  UI->>API: POST /api/llm/apply (idempotent)
  API->>API: withApplyLock (server 971:973)
  API->>FS: write todos + audit
  API->>IDX: refresh
  API-->>UI: results + summary
  end
```

### Contents
- [API Surface](./api_surface.md): Endpoints, request/response shapes, error contracts, and exact coupling to `apps/web/flutter_app/lib/api.dart`.
- [Data Model](./data_model.md): Todo schema, recurrence, occurrence semantics, persistence files, and invariants.
- [Backend Algorithms](./backend_algorithms.md): Validation, normalization, recurrence expansion, router, proposal/repair, idempotency, and apply lock.
- [LLM Pipeline](./llm_pipeline.md): Prompts, thresholds, parsing/normalization, SSE vs POST flows, and chat vs auto vs plan modes.
- [Client Architecture](./client_architecture.md): Flutter state flows, assistant UX, search overlay, and CRUD interactions.
- [Glossary](./glossary.md): Domain terms and precise meanings used across server and client.

### Primary entry points
- Constraints and assumptions
  - Single-user, single-process server; synchronous JSON persistence
  - No DB, no auth, no remote services beyond local Ollama
  - Strict recurrence policy: recurrence object required on create/update; anchor required for repeating
  - Assistant is safety-bounded by validation and single repair attempt

### Key invariants and contracts

- Recurrence tasks use `completedDates`; occurrence completion toggles this array (server 524:531, 1014:1021). Master-level `completed` is for non-repeating or expanded occurrences only.
- Switching repeating→none clears `completedDates` (server 167:172).
- Time-of-day is `HH:MM` or null; UI treats null as all-day (server 223:227; main.dart 1269:1279).
- Apply path is serialized via `withApplyLock` and idempotent responses are cached ~10 minutes (server 559:569, 971:973, 1132:1133).

- Server: `apps/server/server.js`
- Index engine: `apps/server/todos_index.js`
- Client app: `apps/web/flutter_app/lib/main.dart`
- Client API: `apps/web/flutter_app/lib/api.dart`
- This folder serves as the authoritative architecture overview; previous `docs/handbook/*` has been removed.


