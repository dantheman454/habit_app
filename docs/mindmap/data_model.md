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
- `tasks(id, title, notes, scheduled_for, status, recurrence TEXT(JSON), completed_dates TEXT(JSON), skipped_dates TEXT(JSON), context, created_at, updated_at)`
- `events(id, title, notes, scheduled_for, start_time, end_time, location, recurrence TEXT(JSON), context, created_at, updated_at)`

**Supporting Tables**:
- `audit_log(id, ts, action, entity, entity_id, payload)` - Operation tracking
- `idempotency(id, idempotency_key, request_hash, response, ts)` - Present for potential response caching (not used by current HTTP apply)
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
  startTime: string | null;                      // canonical 24h HH:MM or null
  endTime: string | null;                        // canonical 24h HH:MM or null (may wrap)
  location: string | null;                       // Optional location
  recurrence: Recurrence;                        // Required JSON object
  context: 'school' | 'personal' | 'work';       // Required, defaults to 'personal'
  createdAt: string;                             // ISO-8601 timestamp
  updatedAt: string;                             // ISO-8601 timestamp
}
```

**Key Differences from Task**:
- Uses `startTime`/`endTime` for time scheduling
- No completion status (events do not have completion functionality)
- Includes `location` field for venue information
- No `completedDates` or `skippedDates` (events do not track completion)

**Flutter Model Notes**:
- The Flutter `Task` class includes additional fields: `kind`, `endTime`, `priority`, `masterId`
- Tasks are all-day and have no time field; events use `startTime`/`endTime`
- Operations carry `kind` and `action` fields; legacy `op` may appear in some client paths.

### Recurrence System

#### Recurrence Object

```typescript
interface Recurrence {
  type: 'none' | 'daily' | 'weekdays' | 'weekly' | 'every_n_days';
  intervalDays?: number;                         // >= 1, required for 'every_n_days'
  until?: string | null;                         // YYYY-MM-DD or null (no cap)
}
```

**Note**: Operation validators include `'monthly'` and `'yearly'` types, but these are not implemented in the actual recurrence logic (`utils/recurrence.js`).

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
function expandTaskOccurrences(task, fromDate, toDate) {
  const occurrences = [];
  const anchor = task.scheduledFor ? parseYMD(task.scheduledFor) : null;
  if (!anchor) return occurrences;
  const untilYmd = task.recurrence?.until ?? undefined;
  const untilDate = (untilYmd && isYmdString(untilYmd)) ? parseYMD(untilYmd) : null;
  const inclusiveEnd = new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate() + 1);
  for (let d = new Date(Math.max(fromDate.getTime(), anchor.getTime())); d < inclusiveEnd; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    if (untilDate && d > untilDate) break;
    if (matchesRule(d, anchor, task.recurrence)) {
      const dateStr = ymd(d);
      const occCompleted = Array.isArray(task.completedDates) && task.completedDates.includes(dateStr);
      const occSkipped = Array.isArray(task.skippedDates) && task.skippedDates.includes(dateStr);
      occurrences.push({
        id: task.id,
        masterId: task.id,
        title: task.title,
        notes: task.notes,
        scheduledFor: dateStr,
        completed: !!occCompleted,
        status: occCompleted ? 'completed' : (occSkipped ? 'skipped' : 'pending'),
        recurrence: task.recurrence,
        context: task.context,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      });
    }
  }
  return occurrences;
}
```

**Location**: `apps/server/routes/schedule.js`

#### Status Derivation (Tasks)
- `completedDates.includes(date)` → `status: 'completed'`
- `skippedDates.includes(date)` → `status: 'skipped'`
- Otherwise → `status: 'pending'`

**Note**: The actual implementation also sets `completed: boolean` field based on the same logic for unified schedule views.

### Aggregates (examples)
- Overdue tasks (past due, not completed)
- Next 7 days (scheduled within week)
- Backlog count (unscheduled)
- Total scheduled items

### Data Integrity Invariants
- All dates `YYYY-MM-DD`; times canonical 24h `HH:MM` or null
- Event `endTime` may be less than `startTime` (cross-midnight events)
- Valid context values only
- Repeating items require anchor date



