# Habit App Database ER Diagram

This document captures the current relational structure of the SQLite database used by the server (`data/app.db`). It reflects `apps/server/database/schema.sql`.

## Entity–Relationship Diagram

```mermaid
---
title: Habit App DB ERD
---
erDiagram
    direction LR

    TODOS {
        int id PK
        string title
        string notes
        string scheduled_for "YYYY-MM-DD or NULL"
        string time_of_day "HH:MM or NULL"
        string status "pending|completed|skipped"
        string recurrence "JSON"
        string completed_dates "JSON or NULL"
        string skipped_dates "JSON or NULL"
        string context "school|personal|work"
        string created_at
        string updated_at
    }

    EVENTS {
        int id PK
        string title
        string notes
        string scheduled_for "YYYY-MM-DD or NULL"
        string start_time "HH:MM or NULL"
        string end_time "HH:MM or NULL"
        string location "nullable"
        int completed "0|1"
        string recurrence "JSON"
        string completed_dates "JSON or NULL"
        string context "school|personal|work"
        string created_at
        string updated_at
    }

    GOALS {
        int id PK
        string title
        string notes
        string status "active|completed|archived"
        float current_progress_value "nullable"
        float target_progress_value "nullable"
        string progress_unit "nullable"
        string created_at
        string updated_at
    }

    AUDIT_LOG {
        int id PK
        string ts
        string action
        string entity "nullable"
        int entity_id "nullable"
        string payload "nullable"
    }

    IDEMPOTENCY {
        int id PK
        string idempotency_key
        string request_hash
        string response
        string ts
    }

    OP_BATCHES {
        int id PK
        string correlation_id "UNIQUE"
        string ts
    }

    OP_BATCH_OPS {
        int id PK
        int batch_id FK
        int seq
        string kind
        string action
        string op_json
        string before_json
        string after_json
    }

    GOAL_TODO_ITEMS {
        int goal_id FK
        int todo_id FK
    }

    GOAL_EVENT_ITEMS {
        int goal_id FK
        int event_id FK
    }

    GOAL_HIERARCHY {
        int parent_goal_id FK
        int child_goal_id FK
    }

    TODOS ||--o{ GOAL_TODO_ITEMS : referenced_by
    GOALS ||--o{ GOAL_TODO_ITEMS : has

    EVENTS ||--o{ GOAL_EVENT_ITEMS : referenced_by
    GOALS ||--o{ GOAL_EVENT_ITEMS : has

    GOALS ||--o{ GOAL_HIERARCHY : parent
    GOALS ||--o{ GOAL_HIERARCHY : child

    OP_BATCHES ||--o{ OP_BATCH_OPS : contains
```

## Notes
- Foreign keys on link tables are defined with `ON DELETE CASCADE` in the schema.
- FTS5 virtual tables (`*_fts`) and their triggers are omitted from the ERD for clarity.
- `recurrence` and `completed_dates` are stored as JSON strings in the SQLite tables.
- The server enforces additional rules (e.g., habits should be repeating) at the API level.
- `context` field defaults to 'personal' for todos, events, and habits; goals do not have a context field.
