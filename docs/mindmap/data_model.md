## Data Model and Persistence

This document specifies the Todo/Event/Habit/Goal schemas, recurrence semantics, occurrence expansion, and SQLite persistence.

### Persistence (SQLite)

**Database Configuration**:
- **File**: `data/app.db` (created on demand)
- **Schema**: `apps/server/database/schema.sql`
- **Mode**: WAL (Write-Ahead Logging) for concurrent access
- **Foreign Keys**: Enabled with CASCADE deletes
- **FTS5**: Full-text search with automatic triggers

**Core Tables**:
- `todos(id, title, notes, scheduled_for, time_of_day, status, recurrence TEXT(JSON), completed_dates TEXT(JSON), skipped_dates TEXT(JSON), context, created_at, updated_at)`
- `events(id, title, notes, scheduled_for, start_time, end_time, location, completed INTEGER, recurrence TEXT(JSON), completed_dates TEXT(JSON), context, created_at, updated_at)`
- `habits(id, title, notes, scheduled_for, time_of_day, completed INTEGER, recurrence TEXT(JSON), completed_dates TEXT(JSON), context, created_at, updated_at)`
- `goals(id, title, notes, status, current_progress_value REAL, target_progress_value REAL, progress_unit, created_at, updated_at)`

**Linking Tables**:
- `habit_todo_items(habit_id, todo_id)` - Many-to-many: habits ↔ todos
- `habit_event_items(habit_id, event_id)` - Many-to-many: habits ↔ events
- `goal_todo_items(goal_id, todo_id)` - Many-to-many: goals ↔ todos
- `goal_event_items(goal_id, event_id)` - Many-to-many: goals ↔ events
- `goal_hierarchy(parent_goal_id, child_goal_id)` - Self-referencing: goals ↔ goals

**Supporting Tables**:
- `audit_log(id, ts, action, entity, entity_id, payload)` - Operation tracking
- `idempotency(id, idempotency_key, request_hash, response, ts)` - Response caching

**FTS5 Virtual Tables**:
- `todos_fts(title, notes)` - Full-text search for todos
- `events_fts(title, notes, location)` - Full-text search for events
- `habits_fts(title, notes)` - Full-text search for habits
- **Triggers**: Automatic updates on INSERT/UPDATE/DELETE

### Schema Details

#### Todo Schema (Normalized)

```typescript
interface Todo {
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
  completed: boolean;                            // Back-compat derived from status
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
- `completed` boolean derived from `status` for back-compatibility

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

**Key Differences from Todo**:
- Uses `startTime`/`endTime` instead of `timeOfDay`
- Uses `completed` boolean instead of `status` enum
- Includes `location` field for venue information
- No `skippedDates` (events are either completed or not)

#### Habit Schema (Normalized)

```typescript
interface Habit {
  id: number;                                    // Primary key, auto-increment
  title: string;                                 // Required, non-empty
  notes: string;                                 // Optional, defaults to ''
  scheduledFor: string | null;                   // YYYY-MM-DD or null
  timeOfDay: string | null;                      // HH:MM or null
  completed: boolean;                            // Required, defaults to false
  recurrence: Recurrence;                        // Required JSON object (must be repeating)
  completedDates: string[] | null;               // YYYY-MM-DD array for repeating
  context: 'school' | 'personal' | 'work';       // Required, defaults to 'personal'
  createdAt: string;                             // ISO-8601 timestamp
  updatedAt: string;                             // ISO-8601 timestamp
}
```

**Key Differences from Todo**:
- Uses `completed` boolean instead of `status` enum
- API enforces that habits must be repeating (`recurrence.type != 'none'`)
- No `skippedDates` (habits are either completed or not)

**Derived Stats** (when listing with range):
```typescript
interface HabitStats {
  currentStreak: number;                         // Current consecutive days
  longestStreak: number;                         // Longest streak ever
  weekHeatmap: Array<{date: string, completed: boolean}>; // Last 7 days
}
```

#### Goal Schema (Normalized)

```typescript
interface Goal {
  id: number;                                    // Primary key, auto-increment
  title: string;                                 // Required, non-empty
  notes: string;                                 // Optional, defaults to ''
  status: 'active' | 'completed' | 'archived';   // Required, defaults to 'active'
  currentProgressValue: number | null;           // Optional progress tracking
  targetProgressValue: number | null;            // Optional target value
  progressUnit: string | null;                   // Optional unit (e.g., "pages", "hours")
  createdAt: string;                             // ISO-8601 timestamp
  updatedAt: string;                             // ISO-8601 timestamp
}
```

**Key Characteristics**:
- No `context` field (goals are not context-specific)
- No `recurrence` field (goals are not time-based)
- Progress tracking with optional numeric values
- Hierarchical structure via `goal_hierarchy` table

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
4. **Habit Constraint**: Habits must be repeating (`type != 'none'`)

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
        completed: isCompleted(date, master.completedDates),
        status: getStatus(date, master.completedDates, master.skippedDates)
      };
      occurrences.push(occurrence);
    }
  }
  return occurrences;
}
```

#### Status Derivation

**For Todos**:
- `completedDates.includes(date)` → `status: 'completed'`
- `skippedDates.includes(date)` → `status: 'skipped'`
- Otherwise → `status: 'pending'`

**For Events/Habits**:
- `completedDates.includes(date)` → `completed: true`
- Otherwise → `completed: false`

#### Unified Schedule Items

When expanding for unified schedule view, items include:
- `kind: 'todo' | 'event' | 'habit'` - Type identifier
- `timeOfDay` (todos/habits) or `startTime` (events) - Time field
- `masterId` - Reference to original item
- All other fields from master item

### Relationships and Constraints

#### Foreign Key Relationships

```sql
-- Habit linking
habit_todo_items.habit_id → habits.id (CASCADE DELETE)
habit_todo_items.todo_id → todos.id (CASCADE DELETE)

habit_event_items.habit_id → habits.id (CASCADE DELETE)
habit_event_items.event_id → events.id (CASCADE DELETE)

-- Goal linking
goal_todo_items.goal_id → goals.id (CASCADE DELETE)
goal_todo_items.todo_id → todos.id (CASCADE DELETE)

goal_event_items.goal_id → goals.id (CASCADE DELETE)
goal_event_items.event_id → events.id (CASCADE DELETE)

-- Goal hierarchy
goal_hierarchy.parent_goal_id → goals.id (CASCADE DELETE)
goal_hierarchy.child_goal_id → goals.id (CASCADE DELETE)
```

#### Cascade Behavior

- **Delete Todo/Event**: Removed from all linked habits and goals
- **Delete Habit**: Removes all habit-item links
- **Delete Goal**: Removes all goal-item links and child relationships
- **Update Master**: Changes propagate to all linked items

### Aggregates and Snapshots

#### Router Snapshots

**Week Snapshot** (Mon-Sun anchored to today):
```typescript
interface WeekSnapshot {
  items: Array<{
    id: number;
    title: string;
    scheduledFor: string | null;
    kind?: 'todo' | 'event' | 'habit';
  }>;
}
```

**Backlog Snapshot**:
```typescript
interface BacklogSnapshot {
  items: Array<{
    id: number;
    title: string;
    scheduledFor: null;
  }>;
}
```

#### Aggregates

**Count Queries**:
- Overdue items (past due, not completed)
- Next 7 days (scheduled within week)
- Backlog count (unscheduled)
- Total scheduled items

**Habit Statistics**:
- Current streak calculation
- Longest streak tracking
- Week heatmap (last 7 days completion)

### Data Integrity Invariants

#### Core Invariants

1. **Recurrence Consistency**: 
   - Repeating items must have anchor date
   - Non-repeating items have null `completedDates`/`skippedDates`

2. **Status Consistency**:
   - Master status doesn't affect occurrence status
   - Occurrence status derived from date arrays

3. **Time Format Consistency**:
   - All dates: `YYYY-MM-DD` format
   - All times: `HH:MM` format or null
   - End times must be after start times

4. **Context Consistency**:
   - Todos, events, habits must have valid context
   - Goals have no context field

5. **ID Stability**:
   - IDs are stable across edits
   - Expanded occurrences use master ID as `masterId`

#### State Transitions

**Repeating → Non-repeating**:
- Clears `completedDates` and `skippedDates`
- Requires anchor date removal
- Resets to single occurrence

**Non-repeating → Repeating**:
- Initializes empty `completedDates`/`skippedDates` arrays
- Requires anchor date specification
- Enables occurrence tracking

### Durability and Performance

#### Persistence Guarantees

- **ACID Compliance**: SQLite with WAL mode
- **Transaction Safety**: All operations wrapped in transactions
- **Audit Trail**: All assistant operations logged
- **Idempotency**: MCP tool calls deduplicated

#### Performance Optimizations

**Indexes**:
- Primary keys on all tables
- Foreign key indexes for linking tables
- Date range indexes for scheduled items
- Context indexes for filtering

**FTS5 Search**:
- Automatic trigger-based updates
- Full-text search on title, notes, location
- Ranking with relevance scoring

**Query Optimization**:
- Prepared statements for common queries
- Efficient date range filtering
- Minimal data transfer for snapshots

#### Backup and Recovery

- **Database File**: Single SQLite file for easy backup
- **WAL Mode**: Concurrent read/write access
- **Schema Versioning**: Migration scripts for schema changes
- **Data Export**: JSON export capabilities for data portability



