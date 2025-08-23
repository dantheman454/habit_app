## Backend Algorithms and Policies

This document enumerates server-side algorithms and strict policies. References map to functions/behaviors to reduce churn.

### Validation and Normalization

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

#### Normalization Helpers

**Recurrence Normalization**:
```javascript
function normalizeRecurrence(recurrence) {
  return {
    type: recurrence.type || 'none',
    intervalDays: recurrence.type === 'every_n_days' ? (recurrence.intervalDays || 1) : undefined,
    until: recurrence.until || null
  };
}
```

**Todo Normalization**:
```javascript
function normalizeTodo(todo) {
  const t = { ...todo };
  if (t.timeOfDay === undefined) t.timeOfDay = null;
  if (!t || typeof t.recurrence !== 'object') {
    t.recurrence = { type: 'none', until: endOfCurrentYearYmd() };
  } else {
    if (!t.recurrence.type) t.recurrence.type = 'none';
    if (t.recurrence.until === undefined) t.recurrence.until = endOfCurrentYearYmd();
  }
  if (t.recurrence.type !== 'none') {
    if (!Array.isArray(t.completedDates)) t.completedDates = [];
  }
  if (typeof t.completed !== 'boolean') t.completed = false;
  return t;
}
```
- **Location**: `apps/server/utils/normalize.js`

**Habit Normalization**:
```javascript
function normalizeHabit(habit) {
  const h = { ...habit };
  if (h.timeOfDay === undefined) h.timeOfDay = null;
  if (!h || typeof h.recurrence !== 'object') {
    h.recurrence = { type: 'daily', until: endOfCurrentYearYmd() };
  } else {
    if (!h.recurrence.type) h.recurrence.type = 'daily';
    if (h.recurrence.until === undefined) h.recurrence.until = endOfCurrentYearYmd();
  }
  if (!Array.isArray(h.completedDates)) h.completedDates = [];
  if (typeof h.completed !== 'boolean') h.completed = false;
  return h;
}
```
- **Location**: `apps/server/utils/normalize.js`

**Recurrence Mutation**:
```javascript
function applyRecurrenceMutation(targetTodo, incomingRecurrence) {
  const t = targetTodo;
  const nextType = incomingRecurrence?.type || 'none';
  const prevType = t?.recurrence?.type || 'none';
  t.recurrence = { ...(t.recurrence || {}), ...(incomingRecurrence || {}) };
  if (prevType === 'none' && nextType !== 'none') {
    t.completedDates = Array.isArray(t.completedDates) ? t.completedDates : [];
    t.skippedDates = Array.isArray(t.skippedDates) ? t.skippedDates : [];
  }
  if (nextType === 'none') {
    delete t.completedDates;
    delete t.skippedDates;
  }
  return t;
}
```
- **Location**: `apps/server/utils/normalize.js`

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
- Must be repeating (recurrence.type cannot be 'none')
- `recurrence` object required on create and update
- Anchor date required for repeating habits

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

### Snapshots and Aggregates

#### Router Snapshot Generation

```javascript
function buildRouterSnapshots({ timezone }) {
  const today = new Date();
  const weekRange = weekRangeFromToday(timezone);
  
  // Week snapshot (Mon-Sun)
  const weekItems = db.listTodos({ 
    from: weekRange.fromYmd, 
    to: weekRange.toYmd,
    status: 'pending'
  }).map(item => ({
    id: item.id,
    title: item.title,
    scheduledFor: item.scheduledFor,
    kind: 'todo'
  }));
  
  // Backlog sample (unscheduled)
  const backlogItems = db.listTodos({ 
    scheduledFor: null,
    status: 'pending'
  }).slice(0, 10).map(item => ({
    id: item.id,
    title: item.title,
    scheduledFor: null,
    kind: 'todo'
  }));
  
  return {
    week: { items: weekItems },
    backlog: backlogItems
  };
}
```

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

### Assistant Router and Tool Calling Pipeline

#### Router Decision Algorithm

**Confidence Thresholds**:
- `CONFIDENCE_THRESHOLD = 0.5` - Below this forces chat mode

**Router Prompt Structure**:
```javascript
const routerPrompt = {
  system: "You are an intelligent intent router for a todo assistant. Your job is to determine if the user wants to perform an action or just ask a question.",
  user: `
    Today: ${todayYmd} (${TIMEZONE})
    Available Items: ${JSON.stringify(snapshots, null, 2)}
    Recent Conversation: ${convo}
    User Input: ${msg}

    OUTPUT FORMAT: Single JSON object only with these fields:
    - decision: "chat" | "act"
    - confidence: number (0.0 to 1.0)
    - where: object (only for act decisions, optional)

    DECISION RULES:
    - "act": Use when user wants to perform a concrete action (create, update, delete, complete, etc.)
    - "chat": Use for questions, status inquiries, general conversation, or unclear requests

    CONFIDENCE SCORING:
    - 0.8-1.0: Very clear actionable intent
    - 0.6-0.7: Clear actionable intent with some context
    - 0.4-0.5: Somewhat clear but could be ambiguous
    - 0.0-0.3: Unclear or definitely a question

    Is this an actionable request or a question? Respond with JSON only:
  `
};
```
- **Location**: `apps/server/llm/router.js`

**Decision Processing**:
```javascript
function processRouterDecision(parsed, snapshots) {
  let decision = parsed.decision || 'chat';
  const confidence = Number(parsed.confidence || 0);
  
  // Force chat if confidence is low
  if (confidence < CONFIDENCE_THRESHOLD) {
    decision = 'chat';
  }
  
  // Process where field for act decisions
  let where = parsed.where || null;
  if (typeof where === 'string' && where.trim()) {
    where = { title_contains: where };
  }
  
  return {
    decision,
    confidence,
    where
  };
}
```
- **Location**: `apps/server/llm/router.js`

#### Tool Calling Generation Algorithm

**Tool Surface Definition**:
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

**Tool Call Processing**:
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

#### Repair Algorithm

**Single Repair Attempt**:
```javascript
async function attemptRepair(operations, errors, transcript) {
  const repairPrompt = `
You are a JSON repair assistant. The following operations failed validation:

Operations: ${JSON.stringify(operations, null, 2)}
Errors: ${JSON.stringify(errors, null, 2)}

Conversation context: ${JSON.stringify(transcript, null, 2)}

Please fix the operations to resolve all validation errors. Return ONLY valid JSON with the corrected operations array.
  `;
  
  const repairResponse = await codeLLM(repairPrompt);
  const repaired = extractFirstJson(repairResponse);
  
  if (!repaired || !Array.isArray(repaired.operations)) {
    return { success: false, operations: [] };
  }
  
  // Re-validate repaired operations
  const validation = validateProposal(repaired);
  if (validation.errors.length > 0) {
    return { success: false, operations: [] };
  }
  
  return { success: true, operations: repaired.operations };
}
```

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

### Idempotency and Auditing

#### Idempotency Implementation

```javascript
function generateIdempotencyKey(operations) {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify(operations));
  return hash.digest('hex');
}

async function checkIdempotency(idempotencyKey, requestHash) {
  const cached = await db.getIdempotencyResponse(idempotencyKey, requestHash);
  if (cached) {
    return JSON.parse(cached.response);
  }
  return null;
}

async function cacheResponse(idempotencyKey, requestHash, response) {
  await db.cacheIdempotencyResponse(idempotencyKey, requestHash, JSON.stringify(response));
}
```

#### Audit Logging

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

// Audit points
logAuditEntry('conversation_agent.input', null, null, { instruction, transcript });
logAuditEntry('conversation_agent.output', null, null, result);
logAuditEntry('operation_execution', 'todo', todoId, { operation: 'create', data });
logAuditEntry('validation_error', null, null, { errors, operations });
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



