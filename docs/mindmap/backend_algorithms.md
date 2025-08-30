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
- **Pattern**: `^([01]\d|2[0-3]):[0-5]\d$` (HH:MM, 00:00-23:59)
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
- **Type validation**: Only allowed recurrence types
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
- `startTime` and `endTime` must be valid HH:MM format
- `endTime` must be after `startTime` if both provided

**Context Validation**:
```javascript
const VALID_CONTEXTS = ['school', 'personal', 'work'];
function isValidContext(context) {
  return VALID_CONTEXTS.includes(String(context));
}
```

#### Operation-Level Validation (Operation Processor)

**Operation Validation**:
```javascript
function validateOperation(op) {
  const errors = [];
  
  if (!op || typeof op !== 'object') return ['invalid_operation_object'];
  
  const kind = op.kind && String(op.kind).toLowerCase();
  const action = op.action && String(op.action).toLowerCase();
  const allowedActions = [
    'create', 'update', 'delete', 'set_status'
  ];
  if (!allowedActions.includes(action)) errors.push('invalid_op');
  
  if (op.scheduledFor !== undefined && !(op.scheduledFor === null || isYmdString(op.scheduledFor))) 
    errors.push('invalid_scheduledFor');
    
  if (op.timeOfDay !== undefined && !isValidTimeOfDay(op.timeOfDay === '' ? null : op.timeOfDay)) 
    errors.push('invalid_timeOfDay');
    
  if (op.recurrence !== undefined && !isValidRecurrence(op.recurrence)) 
    errors.push('invalid_recurrence');
  
  if (['update', 'delete', 'set_status'].includes(action)) {
    if (!Number.isFinite(op.id)) errors.push('missing_or_invalid_id');
  }
  
  if (kind === 'task' && action === 'set_status') {
    const status = String(op.status || '');
    if (!['pending', 'completed', 'skipped'].includes(status)) {
      errors.push('invalid_status');
    }
  }
  
  if (op.occurrenceDate !== undefined && !(op.occurrenceDate === null || isYmdString(op.occurrenceDate))) {
    errors.push('invalid_occurrenceDate');
  }
  
  if (op.op?.startsWith('bulk') || op.action?.startsWith('bulk')) {
    errors.push('bulk_operations_removed');
  }
  
  return errors;
}
```

### Recurrence and Occurrences

See `apps/server/utils/recurrence.js` for rule evaluation and expansion helpers.

### Aggregates

#### Aggregate Calculations




```



#### Clarify Candidate Ranking

```javascript
function topClarifyCandidates(instruction, snapshots, limit = 5) {
  const allItems = [
    ...(snapshots.week?.items || []),
    ...(snapshots.backlog || [])
  ];
  
  // Token-based ranking
  const tokens = instruction.toLowerCase().split(/\s+/);
  const scored = allItems.map(item => {
    let score = 0;
    const itemText = item.title.toLowerCase();
    
    tokens.forEach(token => {
      if (itemText.includes(token)) score += 1;
    });
    
    return { ...item, score };
  });
  
  return scored
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
```

### Assistant Tool-Calling Pipeline

Tool surface is limited to tasks and events only. Name format in LLM tool-calling:
- `task.create`, `task.update`, `task.delete`, `task.set_status`
- `event.create`, `event.update`, `event.delete`

### Operation Execution via Operation Processor

`OperationProcessor` validates and executes operations using registered validators/executors. Multi-op requests wrap in a DB transaction.

### Auditing and Undo

Batch recording captures per-op before/after for undo. Idempotency table caches apply responses.

### Error Messages Catalog (selected)

- `invalid_title`, `missing_recurrence`, `invalid_notes`, `invalid_scheduledFor`, `invalid_timeOfDay`, `invalid_recurrence`, `invalid_status`, `missing_or_invalid_id`, `bulk_operations_removed`.



