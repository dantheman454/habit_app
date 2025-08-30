## Data Model and Persistence

This document specifies the Task/Event schemas, recurrence semantics, occurrence expansion, and SQLite persistence.

### Persistence (SQLite)

**Database Configuration**:
- **File**: `data/app.db` (created on demand)
- **Schema**: `apps/server/database/schema.sql`
- **Mode**: WAL (Write-Ahead Logging) for concurrent access
- **Foreign Keys**: Enabled with CASCADE deletes
- **FTS5**: Full-text search with automatic triggers

**Core Tables**:
- `tasks(id, title, notes, scheduled_for, time_of_day, status, recurrence TEXT(JSON), completed_dates TEXT(JSON), skipped_dates TEXT(JSON), context, created_at, updated_at)`
- `events(id, title, notes, scheduled_for, start_time, end_time, location, completed INTEGER, recurrence TEXT(JSON), completed_dates TEXT(JSON), context, created_at, updated_at)`

**Supporting Tables**:
- `audit_log(id, ts, action, entity, entity_id, payload)` - Operation tracking
- `idempotency(id, idempotency_key, request_hash, response, ts)` - Response caching
- `op_batches(id, correlation_id, ts)` - Batch header for propose/apply pipeline
- `op_batch_ops(id, batch_id, seq, kind, action, op_json, before_json, after_json)` - Per-op before/after for undo

**FTS5 Virtual Tables**:
- `tasks_fts(title, notes)` - Full-text search for tasks
- `events_fts(title, notes, location)` - Full-text search for events
- **Triggers**: Automatic updates on INSERT/UPDATE/DELETE

### Schema Details

#### Task Schema (Normalized)

```typescript
interface Task {
  id: number;                                    // Primary key, auto-increment
  title: string;                                 // Required, non-empty
  notes: string;                                 // Optional, defaults to ''
  scheduledFor: string | null;                   // YYYY-MM-DD or null for backlog
  timeOfDay: string | null;                      // HH:MM or null (all-day)
  status: 'pending' | 'completed' | 'skipped';   // Required, defaults to 'pending'
  recurrence: Recurrence;                        // Required JSON object
  completedDates: string[] | null;               // YYYY-MM-DD array for repeating
  skippedDates: string[] | null;                 // YYYY-MM-DD array for repeating
  context: 'school' | 'personal' | 'work';       // Required, defaults to 'personal'
  createdAt: string;                             // ISO-8601 timestamp
  updatedAt: string;                             // ISO-8601 timestamp
}
```

**Database Constraints**:
- `title NOT NULL` - Title is required
- `status CHECK(status IN ('pending','completed','skipped'))` - Valid status values
- `context CHECK(context IN ('school', 'personal', 'work'))` - Valid context values
- `recurrence NOT NULL DEFAULT '{"type":"none"}'` - Recurrence required with default

**Normalization Rules**:
- Default `timeOfDay` to null for all-day items
- Ensure `recurrence` object with `type` field
- Default `until` to null when absent (no expansion cap)
- For repeating items: ensure `completedDates`/`skippedDates` arrays exist
- Master `status` defaults to 'pending' for new items
- `context` field defaults to 'personal' if not specified

#### Event Schema (Normalized)

```typescript
interface Event {
  id: number;                                    // Primary key, auto-increment
  title: string;                                 // Required, non-empty
  notes: string;                                 // Optional, defaults to ''
  scheduledFor: string | null;                   // YYYY-MM-DD or null
  startTime: string | null;                      // HH:MM or null
  endTime: string | null;                        // HH:MM or null
  location: string | null;                       // Optional location
  completed: boolean;                            // Required, defaults to false
  recurrence: Recurrence;                        // Required JSON object
  completedDates: string[] | null;               // YYYY-MM-DD array for repeating
  context: 'school' | 'personal' | 'work';       // Required, defaults to 'personal'
  createdAt: string;                             // ISO-8601 timestamp
  updatedAt: string;                             // ISO-8601 timestamp
}
```

**Key Differences from Task**:
- Uses `startTime`/`endTime` instead of `timeOfDay`
- Uses `completed` boolean instead of `status` enum
- Includes `location` field for venue information
- No `skippedDates` (events are either completed or not)

### Recurrence System

#### Recurrence Object

```typescript
interface Recurrence {
  type: 'none' | 'daily' | 'weekdays' | 'weekly' | 'every_n_days';
  intervalDays?: number;                         // >= 1, required for 'every_n_days'
  until?: string | null;                         // YYYY-MM-DD or null (no cap)
}
```

#### Recurrence Types

**`none`**: Single occurrence
- No expansion
- No anchor date required
- `completedDates`/`skippedDates` are null

**`daily`**: Every day
- Expands to every day from anchor
- Requires `scheduledFor` anchor date
- Continues until `until` date or indefinitely

**`weekdays`**: Monday through Friday
- Expands to weekdays only
- Requires `scheduledFor` anchor date
- Skips weekends automatically

**`weekly`**: Same day of week
- Expands to same weekday as anchor
- Requires `scheduledFor` anchor date
- Example: anchor on Monday → every Monday

**`every_n_days`**: Every N days
- Expands every N days from anchor
- Requires `scheduledFor` anchor and `intervalDays >= 1`
- Example: `intervalDays: 3` → every 3rd day

#### Recurrence Rules

1. **Anchor Requirement**: `scheduledFor` is REQUIRED when `type != 'none'`
2. **Expansion Cap**: `until` field caps expansion (null = no cap)
3. **Interval Validation**: `intervalDays` must be integer >= 1 for `every_n_days`

### Occurrence Expansion

#### Expansion Algorithm

```javascript
function expandOccurrences(master, fromDate, toDate) {
  const occurrences = [];
  const anchor = parseYMD(master.scheduledFor);
  const untilDate = master.recurrence.until ? parseYMD(master.recurrence.until) : null;
  
  for (let date = fromDate; date < toDate; date = addDays(date, 1)) {
    if (untilDate && date > untilDate) break;
    if (matchesRule(date, anchor, master.recurrence)) {
      const occurrence = {
        ...master,
        masterId: master.id,
        scheduledFor: ymd(date),
        status: getStatus(date, master.completedDates, master.skippedDates)
      };
      occurrences.push(occurrence);
    }
  }
  return occurrences;
}
```

#### Status Derivation (Tasks)
- `completedDates.includes(date)` → `status: 'completed'`
- `skippedDates.includes(date)` → `status: 'skipped'`
- Otherwise → `status: 'pending'`

### Aggregates (examples)
- Overdue tasks (past due, not completed)
- Next 7 days (scheduled within week)
- Backlog count (unscheduled)
- Total scheduled items

### Data Integrity Invariants
- All dates `YYYY-MM-DD`; times `HH:MM` or null
- Event `endTime` after `startTime`
- Valid context values only
- Repeating items require anchor date



