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

**Todo Validation Rules**:
- `recurrence` object required on create and update
- If repeating (`type != 'none'`), `scheduledFor` anchor required
- `status` must be one of: `pending`, `completed`, `skipped`
- `context` must be one of: `school`, `personal`, `work`

**Event Validation Rules**:
- `recurrence` object required on create and update
- If repeating, `scheduledFor` anchor required
- `startTime` and `endTime` must be valid HH:MM format
- `endTime` must be after `startTime` if both provided

**Habit Validation Rules**:
- Not applicable (habit endpoints and operations are not exposed)

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
  
  // Basic structure validation
  if (!op || typeof op !== 'object') return ['invalid_operation_object'];
  
  // Operation type validation
  const kind = op.kind && String(op.kind).toLowerCase();
  const action = op.action && String(op.action).toLowerCase();
  const allowedKinds = [
    'create', 'update', 'delete', 'set_status', 'complete', 'complete_occurrence',
    'goal_create', 'goal_update', 'goal_delete', 'goal_add_items', 'goal_remove_item',
    'goal_add_child', 'goal_remove_child'
  ];
  if (!allowedKinds.includes(action)) errors.push('invalid_op');
  
  // Field validation
  if (op.scheduledFor !== undefined && !(op.scheduledFor === null || isYmdString(op.scheduledFor))) 
    errors.push('invalid_scheduledFor');
    
  if (op.timeOfDay !== undefined && !isValidTimeOfDay(op.timeOfDay === '' ? null : op.timeOfDay)) 
    errors.push('invalid_timeOfDay');
    
  if (op.recurrence !== undefined && !isValidRecurrence(op.recurrence)) 
    errors.push('invalid_recurrence');
  
  // Recurrence requirement for create/update
  if (action === 'create' || action === 'update') {
    if (!(op.recurrence && typeof op.recurrence === 'object' && 'type' in op.recurrence)) {
      errors.push('missing_recurrence');
    }
    // Habits must be repeating
    if (op.kind === 'habit' && op.recurrence?.type === 'none') {
      errors.push('invalid_recurrence');
    }
  }
  
  // ID requirement for update/delete operations
  if (['update', 'delete', 'complete', 'complete_occurrence', 'set_status'].includes(action)) {
    if (!Number.isFinite(op.id)) errors.push('missing_or_invalid_id');
  }
  
  // Todo-specific validation
  if (op.kind === 'todo') {
    if (action === 'complete' || action === 'complete_occurrence') {
      errors.push('use_set_status');
    }
    if (action === 'set_status') {
      const status = String(op.status || '');
      if (!['pending', 'completed', 'skipped'].includes(status)) {
        errors.push('invalid_status');
      }
    }
  }
  
  // Occurrence validation
  if (action === 'complete_occurrence') {
    if (!isYmdString(op.occurrenceDate)) errors.push('invalid_occurrenceDate');
  }
  
  // Repeating item validation
  if (action === 'complete') {
    // Check if target is repeating and require complete_occurrence
    if (isRepeatingItem(op.id, op.kind)) {
      errors.push('use_complete_occurrence_for_repeating');
    }
  }
  
  // Bulk operation rejection
  if (op.op?.startsWith('bulk') || op.action?.startsWith('bulk')) {
    errors.push('bulk_operations_removed');
  }
  
  return errors;
}
```

### Recurrence and Occurrences

#### Rule Evaluation Algorithm

```javascript
function matchesRule(dateObj, anchorDateObj, recurrence) {
  const type = recurrence?.type || 'none';
  if (type === 'none') return false;
  
  if (type === 'daily') return daysBetween(anchorDateObj, dateObj) >= 0;
  
  if (type === 'weekdays') {
    const diff = daysBetween(anchorDateObj, dateObj);
    const wd = dateObj.getDay();
    return diff >= 0 && wd >= 1 && wd <= 5;
  }
  
  if (type === 'weekly') {
    const diff = daysBetween(anchorDateObj, dateObj);
    return diff >= 0 && diff % 7 === 0;
  }
  
  if (type === 'every_n_days') {
    const step = Number.isInteger(recurrence.intervalDays) ? recurrence.intervalDays : 0;
    const diff = daysBetween(anchorDateObj, dateObj);
    return step >= 1 && diff >= 0 && diff % step === 0;
  }
  
  return false;
}

function daysBetween(a, b) {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const aMid = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const bMid = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((bMid.getTime() - aMid.getTime()) / MS_PER_DAY);
}
```
- **Location**: `apps/server/utils/recurrence.js`

#### Occurrence Expansion Algorithm

```javascript
function expandOccurrences(master, fromDate, toDate, { ymd, parseYMD } = {}) {
  if (typeof ymd !== 'function' || typeof parseYMD !== 'function') {
    throw new Error('expandOccurrences requires ymd and parseYMD helpers');
  }
  const occurrences = [];
  const anchor = master.scheduledFor ? parseYMD(master.scheduledFor) : null;
  if (!anchor) return occurrences;
  
  const untilYmd = master.recurrence?.until ?? undefined;
  const untilDate = (untilYmd && isYmdString(untilYmd)) ? parseYMD(untilYmd) : null;
  
  const inclusiveEnd = new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate() + 1);
  
  for (let d = new Date(Math.max(fromDate.getTime(), anchor.getTime())); d < inclusiveEnd; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    if (untilDate && d > untilDate) break;
    
    if (matchesRule(d, anchor, master.recurrence)) {
      occurrences.push({
        id: master.id,
        masterId: master.id,
        scheduledFor: ymd(d),
      });
    }
  }
  
  return occurrences;
}
```
- **Location**: `apps/server/utils/recurrence.js`

#### Edge Behaviors

**Expansion Caps**:
- `until` field caps expansion (null/undefined means no cap)
- Expansion stops at `until` date (inclusive)
- No expansion beyond current date range

**Time Ordering**:
- Null/empty time sorts before set time
- All-day items appear before timed items
- Within same time: event < todo < habit

**Performance Considerations**:
- Expansion limited to reasonable date ranges
- Caching of expanded results for repeated queries
- Lazy expansion only when both `from` and `to` provided

### Aggregates

#### Aggregate Calculations

**Overdue Count**:
```javascript
function getOverdueCount() {
  const today = ymdInTimeZone(new Date(), TIMEZONE);
  return db.listTodos({ 
    scheduledFor: { $lt: today },
    status: 'pending'
  }).length;
}
```

**Next 7 Days Count**:
```javascript
function getNext7DaysCount() {
  const today = new Date();
  const nextWeek = addDays(today, 7);
  return db.listTodos({
    scheduledFor: { $gte: ymd(today), $lt: ymd(nextWeek) }
  }).length;
}
```

**Backlog Count**:
```javascript
function getBacklogCount() {
  return db.listTodos({ scheduledFor: null }).length;
}
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

#### Tool Calling Generation Algorithm

**Tool Surface Definition** (limited to todos and events):
```javascript
const operationTools = [
  'todo.create','todo.update','todo.delete','todo.set_status',
  'event.create','event.update','event.delete',
  'habit.create','habit.update','habit.delete','habit.set_occurrence_status'
].map((name) => ({
  type: 'function',
  function: {
    name,
    description: `Execute operation ${name}`,
    parameters: { type: 'object', additionalProperties: true }
  }
}));
```

**Tool Call Processing (proposal)**:
```javascript
function toolCallToOperation(name, args) {
  const [kind, action] = String(name || '').split('.')
    .map(s => String(s || '').trim().toLowerCase());
  return { kind, action, ...(args || {}) };
}

async function processToolCalls(toolCalls, operationProcessor, correlationId) {
  const executedOps = [];
  const notes = { errors: [] };
  
  for (const call of toolCalls) {
    const name = call?.function?.name || call?.name;
    const args = call?.function?.arguments || call?.arguments || {};
    let parsedArgs = args;
    if (typeof args === 'string') {
      try { parsedArgs = JSON.parse(args); } catch { parsedArgs = {}; }
    }
    const op = toolCallToOperation(name, parsedArgs);
    
    try {
      const result = await operationProcessor.processOperations([op], correlationId);
      const ok = result?.results?.[0]?.ok;
      if (ok) executedOps.push(op);
    } catch (e) {
      notes.errors.push(String(e?.message || e));
    }
  }
  
  return { executedOps, notes };
}
```

#### Fallback Behavior

If no valid tool calls are produced but the instruction appears actionable, OpsAgent attempts a minimal inference (e.g., extract an `HH:MM` and apply to a best-matching todo/event). Only validators-approved operations are proposed.

### Operation Execution via Operation Processor

#### Operation Processor Execution Flow

```javascript
class OperationProcessor {
  constructor() {
    this.validators = new Map();
    this.executors = new Map();
    this.formatters = new Map();
    this.operationTypes = new Map();
    this.dbService = null;
  }
  
  async processOperations(operations, correlationId = mkCorrelationId()) {
    const results = [];
    const summary = { created: 0, updated: 0, deleted: 0, completed: 0 };
    
    // If we have multiple operations and a database service, wrap in transaction
    if (operations.length > 1 && this.dbService) {
      try {
        return await this.dbService.runInTransaction(async () => {
          return await this._processOperationsInternal(operations, correlationId);
        });
      } catch (error) {
        return {
          results: [{ ok: false, error: `Transaction failed: ${String(error)}` }],
          summary: { created: 0, updated: 0, deleted: 0, completed: 0 },
          correlationId
        };
      }
    } else {
      return await this._processOperationsInternal(operations, correlationId);
    }
  }
  
  async _processOperationsInternal(operations, correlationId) {
    const results = [];
    const summary = { created: 0, updated: 0, deleted: 0, completed: 0 };
    
    for (const op of operations) {
      try {
        const type = this.inferOperationType(op);
        const validator = this.validators.get(type);
        const executor = this.executors.get(type);
        
        if (!validator || !executor) {
          results.push({ ok: false, op, error: 'unknown_operation_type' });
          continue;
        }
        
        const validation = await validator(op);
        if (!validation.valid) {
          results.push({ ok: false, op, error: validation.errors.join(', ') });
          continue;
        }
        
        const result = await executor(op);
        results.push({ ok: true, op, ...result });
        
        // Update summary
        if (result.created) summary.created++;
        if (result.updated) summary.updated++;
        if (result.deleted) summary.deleted++;
        if (result.completed) summary.completed++;
        
      } catch (error) {
        results.push({ ok: false, op, error: String(error) });
      }
    }
    
    return { results, summary, correlationId };
  }
  
  inferOperationType(op) {
    if (op.kind && op.action) {
      return `${op.kind}_${op.action}`;
    }
    return op.op || 'unknown';
  }
}
```
- **Location**: `apps/server/operations/operation_processor.js`

#### Transaction Management

```javascript
async function executeWithTransaction(operations) {
  const transaction = db.beginTransaction();
  
  try {
    const results = [];
    
    for (const op of operations) {
      const result = await executeOperation(op, transaction);
      results.push(result);
    }
    
    await transaction.commit();
    return results;
    
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}
```

### Auditing and Undo

```javascript
function logAuditEntry(action, entity, entityId, payload, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    action,
    entity,
    entity_id: entityId,
    payload: JSON.stringify(payload),
    correlation_id: meta.correlationId
  };
  
  db.insertAuditLog(entry);
}

// Propose/apply pipeline records per-op before/after in batch tables for undo
batchRecorder.ensureBatch(correlationId);
batchRecorder.recordOp({ batchId, op, before, after });
// Undo last batch via /api/assistant/undo_last
```

### Error Messages Catalog

#### Endpoint Validation Errors

**Field Validation**:
- `invalid_title` - Title is missing or invalid
- `missing_recurrence` - Recurrence object is required
- `invalid_notes` - Notes field is invalid type
- `invalid_scheduledFor` - Date format is invalid
- `invalid_timeOfDay` - Time format is invalid
- `invalid_recurrence` - Recurrence object is malformed
- `missing_anchor_for_recurrence` - Anchor date required for repeating items
- `invalid_completed` - Completed field is invalid boolean
- `invalid_status` - Status value is invalid
- `invalid_id` - ID is missing or invalid
- `invalid_context` - Context value is invalid
- `invalid_from` - From date is invalid
- `invalid_to` - To date is invalid
- `invalid_query` - Search query is invalid

**Business Logic Errors**:
- `not_found` - Resource doesn't exist
- `not_repeating` - Item is not repeating (for occurrence operations)
- `invalid_occurrenceDate` - Occurrence date is invalid
- `use_set_status` - Use set_status instead of complete for todos
- `use_complete_occurrence_for_repeating` - Use complete_occurrence for repeating items

**Event-Specific Errors**:
- `invalid_start_time` - Start time format is invalid
- `invalid_end_time` - End time format is invalid
- `invalid_time_range` - End time must be after start time

#### Operation Processor Errors

**Operation Validation**:
- `invalid_operations` - Operations array is invalid
- `invalid_op` - Operation type is not allowed
- `missing_or_invalid_id` - ID is missing or invalid
- `id_not_found` - Referenced item doesn't exist
- `invalid_operation_object` - Operation object is malformed
- `invalid_body` - Request body is invalid
- `missing_operations` - No operations provided

**Business Rule Violations**:
- `bulk_operations_removed` - Bulk operations are not supported
- `too_many_operations` - Operation count exceeds limit (20)
- `use_set_status` - Use set_status for todos instead of complete
- `use_complete_occurrence_for_repeating` - Use complete_occurrence for repeating items

#### Performance Considerations

**Validation Performance**:
- Early return on first validation error
- Cached validation results for repeated operations
- Efficient regex patterns for date/time validation

**Expansion Performance**:
- Lazy expansion only when needed
- Caching of expanded results
- Limit expansion to reasonable date ranges

**Audit Performance**:
- Asynchronous audit logging
- Batch audit entries when possible
- Indexed audit log queries

**Idempotency Performance**:
- Fast hash-based key generation
- Indexed idempotency table lookups
- Automatic cleanup of old entries



