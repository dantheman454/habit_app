# Habit App Database ER Diagram

This document captures the current relational structure of the SQLite database used by the server (`data/app.db`). It reflects `apps/server/database/schema.sql`.

## Entity–Relationship Diagram

```mermaid
---
title: Habit App DB ERD
---
erDiagram
    direction LR

    TASKS {
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

    OP_BATCHES ||--o{ OP_BATCH_OPS : contains
```

## Notes
- Foreign keys on link tables are defined with `ON DELETE CASCADE` in the schema.
- FTS5 virtual tables and their triggers are omitted from the ERD for clarity.
- `recurrence` and `completed_dates` are stored as JSON strings in the SQLite tables.
