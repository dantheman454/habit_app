## Backend Algorithms and Policies

This document enumerates server-side algorithms and strict policies. References map to functions/behaviors to reduce churn.

### Validation

#### Primitive Validators

**Date Validation**:
```javascript
function isYmdString(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}
```
- **Pattern**: `^\d{4}-\d{2}-\d{2}$` (YYYY-MM-DD)
- **Usage**: All date fields (`scheduledFor`, `until`, `occurrenceDate`)
- **Null handling**: Returns `false` for null/undefined
- **Location**: `apps/server/utils/recurrence.js`

**Time Validation**:
```javascript
function isValidTimeOfDay(value) {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'string') return false;
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}
```
- **Pattern**: `^([01]\d|2[0-3]):[0-5]\d$` (canonical 24h HH:MM, 00:00-23:59)
- **Usage**: `timeOfDay`, `startTime`, `endTime`
- **Null handling**: Returns `true` for null/undefined (all-day items)
- **Location**: `apps/server/utils/recurrence.js`

**Recurrence Validation**:
```javascript
function isValidRecurrence(rec) {
  if (rec === null || rec === undefined) return true;
  if (typeof rec !== 'object') return false;
  
  const type = rec.type;
  const allowed = ['none', 'daily', 'weekdays', 'weekly', 'every_n_days'];
  if (!allowed.includes(String(type))) return false;
  
  if (type === 'every_n_days') {
    const n = rec.intervalDays;
    if (!Number.isInteger(n) || n < 1) return false;
  }
  
  if (!(rec.until === null || rec.until === undefined || isYmdString(rec.until))) return false;
  return true;
}
```
- **Type validation**: Only allowed recurrence types (note: operation validators include 'monthly', 'yearly' but utils/recurrence.js does not)
- **Interval validation**: `intervalDays >= 1` for `every_n_days`
- **Until validation**: Must be valid YYYY-MM-DD or null
- **Location**: `apps/server/utils/recurrence.js`

#### Normalization

Normalization helpers are not present in the current codebase; endpoints and operation validators enforce shapes directly.

#### Endpoint-Level Validation

**Task Validation Rules**:
- `recurrence` object required on create and update
- If repeating (`type != 'none'`), `scheduledFor` anchor required
- `status` must be one of: `pending`, `completed`, `skipped`
- `context` must be one of: `school`, `personal`, `work`

**Event Validation Rules**:
- `recurrence` object required on create and update
- If repeating, `scheduledFor` anchor required
- `startTime` and `endTime` must be valid canonical 24h HH:MM format
- Cross‑midnight allowed: `endTime` may be less than `startTime` (wrap to next day)

**Context Validation**:
```javascript
const VALID_CONTEXTS = ['school', 'personal', 'work'];
function isValidContext(context) {
  return VALID_CONTEXTS.includes(String(context));
}
```

#### Operation-Level Validation (Operation Processor)

**Operation Validation**: Uses `OperationValidators` class with specific validators for each operation type:
- `taskCreate`, `taskUpdate`, `taskDelete`, `taskSetStatus`
- `eventCreate`, `eventUpdate`, `eventDelete`

Each validator returns `{ valid: boolean, errors: string[] }` and validates:
- Required fields (title, id for updates/deletes)
- Field types and formats (dates, times, recurrence)
- Business rules (anchor dates for repeating items)
- Context values and status enums

**Note**: Operation validators include `'monthly'` and `'yearly'` recurrence types in their validation, but these are not implemented in the actual recurrence logic.

**Location**: `apps/server/operations/validators.js`

### Recurrence and Occurrences

See `apps/server/utils/recurrence.js` for rule evaluation and expansion helpers.

### Aggregates

#### Aggregate Calculations

Aggregate calculations are implemented in `apps/server/utils/filters.js` and include:
- Overdue tasks (past due, not completed)
- Next 7 days (scheduled within week)
- Backlog count (unscheduled)
- Total scheduled items

#### Ambiguity Detection

```javascript
function detectAmbiguity(taskBrief, context) {
  const lowerBrief = taskBrief.toLowerCase();
  const actionWords = ['update', 'change', 'modify', 'complete', 'delete', 'remove', 'set', 'create', 'add'];
  const hasAction = actionWords.some(word => lowerBrief.includes(word));
  
  if (!hasAction) {
    return { needsClarification: false };
  }
  
  const items = context.focused || [];
  if (items.length > 1 && !lowerBrief.match(/#\d+/)) {
    return {
      needsClarification: true,
      question: "Which item do you want to work with?",
      options: items.slice(0, 5).map(item => ({
        id: item.id,
        title: item.title,
        scheduledFor: item.scheduledFor
      }))
    };
  }
  const titleMatches = items.filter(item => 
    item.title && lowerBrief.includes(item.title.toLowerCase())
  );
  if (titleMatches.length > 1) {
    return {
      needsClarification: true,
      question: "Which item do you mean?",
      options: titleMatches.map(item => ({
        id: item.id,
        title: item.title,
        scheduledFor: item.scheduledFor
      }))
    };
  }
  return { needsClarification: false };
}
```
- **Location**: `apps/server/llm/ops_agent.js`

### Assistant Tool-Calling Pipeline

Tool surface is limited to tasks and events only. Name format in LLM tool-calling:
- `task.create`, `task.update`, `task.delete`, `task.set_status`
- `event.create`, `event.update`, `event.delete`

### Operation Execution via Operation Processor

`OperationProcessor` validates and executes operations using registered validators/executors. Multi-op requests wrap in a DB transaction.

### Auditing and Undo

Batch recording captures per-op before/after for undo. Idempotency table caches apply responses.

### Error Messages Catalog (selected)

- `invalid_title`, `missing_recurrence`, `invalid_notes`, `invalid_scheduledFor`, `invalid_timeOfDay`, `invalid_recurrence`, `invalid_status`, `missing_or_invalid_id`, `bulk_operations_removed`, `invalid_occurrenceDate`, `invalid_context`, `update_failed`, `delete_failed`, `search_failed`, `db_error`, `assistant_failure`, `not_supported`.



