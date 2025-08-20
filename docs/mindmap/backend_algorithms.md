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
  return {
    ...todo,
    timeOfDay: todo.timeOfDay || null,
    recurrence: normalizeRecurrence(todo.recurrence),
    status: todo.status || 'pending',
    context: todo.context || 'personal',
    completedDates: todo.recurrence?.type !== 'none' ? (todo.completedDates || []) : null,
    skippedDates: todo.recurrence?.type !== 'none' ? (todo.skippedDates || []) : null
  };
}
```

**Recurrence Mutation**:
```javascript
function applyRecurrenceMutation(target, incoming) {
  const newRecurrence = normalizeRecurrence(incoming);
  
  // Clear completion tracking when switching to non-repeating
  if (target.recurrence?.type !== 'none' && newRecurrence.type === 'none') {
    target.completedDates = null;
    target.skippedDates = null;
  }
  
  // Initialize arrays when switching to repeating
  if (target.recurrence?.type === 'none' && newRecurrence.type !== 'none') {
    target.completedDates = [];
    target.skippedDates = [];
  }
  
  target.recurrence = newRecurrence;
  return target;
}
```

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
- Must be repeating (`recurrence.type != 'none'`)
- `recurrence` object required on create and update
- Anchor date required for repeating habits

**Context Validation**:
```javascript
const VALID_CONTEXTS = ['school', 'personal', 'work'];
function isValidContext(context) {
  return VALID_CONTEXTS.includes(String(context));
}
```

#### Operation-Level Validation (MCP Tools)

**Proposal Validation**:
```javascript
function validateProposal(body) {
  if (!body || typeof body !== 'object') return { errors: ['invalid_body'] };
  
  const operations = Array.isArray(body.operations) 
    ? body.operations.map(o => inferOperationShape(o)).filter(Boolean) 
    : [];
    
  if (!operations.length) return { errors: ['missing_operations'], operations: [] };
  
  const results = operations.map(o => ({ op: o, errors: validateOperation(o) }));
  const invalid = results.filter(r => r.errors.length > 0);
  
  return { 
    operations, 
    results, 
    errors: invalid.length ? ['invalid_operations'] : [] 
  };
}
```

**Operation Validation**:
```javascript
function validateOperation(op) {
  const errors = [];
  
  // Basic structure validation
  if (!op || typeof op !== 'object') return ['invalid_operation_object'];
  
  // Operation type validation
  const kind = inferOperationShape(op)?.op;
  const allowedKinds = [
    'create', 'update', 'delete', 'set_status', 'complete', 'complete_occurrence',
    'goal_create', 'goal_update', 'goal_delete', 'goal_add_items', 'goal_remove_item',
    'goal_add_child', 'goal_remove_child'
  ];
  if (!allowedKinds.includes(kind)) errors.push('invalid_op');
  
  // Field validation
  if (op.scheduledFor !== undefined && !(op.scheduledFor === null || isYmdString(op.scheduledFor))) 
    errors.push('invalid_scheduledFor');
    
  if (op.timeOfDay !== undefined && !isValidTimeOfDay(op.timeOfDay === '' ? null : op.timeOfDay)) 
    errors.push('invalid_timeOfDay');
    
  if (op.recurrence !== undefined && !isValidRecurrence(op.recurrence)) 
    errors.push('invalid_recurrence');
  
  // Recurrence requirement for create/update
  if (kind === 'create' || kind === 'update') {
    if (!(op.recurrence && typeof op.recurrence === 'object' && 'type' in op.recurrence)) {
      errors.push('missing_recurrence');
    }
    // Habits must be repeating
    if (op.kind === 'habit' && op.recurrence?.type === 'none') {
      errors.push('invalid_recurrence');
    }
  }
  
  // ID requirement for update/delete operations
  if (['update', 'delete', 'complete', 'complete_occurrence', 'set_status'].includes(kind)) {
    if (!Number.isFinite(op.id)) errors.push('missing_or_invalid_id');
  }
  
  // Todo-specific validation
  if (op.kind === 'todo') {
    if (kind === 'complete' || kind === 'complete_occurrence') {
      errors.push('use_set_status');
    }
    if (kind === 'set_status') {
      const status = String(op.status || '');
      if (!['pending', 'completed', 'skipped'].includes(status)) {
        errors.push('invalid_status');
      }
    }
  }
  
  // Occurrence validation
  if (kind === 'complete_occurrence') {
    if (!isYmdString(op.occurrenceDate)) errors.push('invalid_occurrenceDate');
  }
  
  // Repeating item validation
  if (kind === 'complete') {
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
  
  if (type === 'daily') return true;
  
  if (type === 'weekdays') {
    const wd = dateObj.getDay(); // 0=Sun..6=Sat
    return wd >= 1 && wd <= 5; // Monday through Friday
  }
  
  if (type === 'weekly') {
    return dateObj.getDay() === anchorDateObj.getDay();
  }
  
  if (type === 'every_n_days') {
    const step = Number(recurrence.intervalDays) || 1;
    const diff = daysBetween(anchorDateObj, dateObj);
    return diff >= 0 && diff % step === 0;
  }
  
  return false;
}

function daysBetween(a, b) {
  const ms = (new Date(b.getFullYear(), b.getMonth(), b.getDate())) - 
             (new Date(a.getFullYear(), a.getMonth(), a.getDate()));
  return Math.round(ms / (24*60*60*1000));
}
```

#### Occurrence Expansion Algorithm

```javascript
function expandOccurrences(todo, fromDate, toDate) {
  const occurrences = [];
  const anchor = todo.scheduledFor ? parseYMD(todo.scheduledFor) : null;
  if (!anchor) return occurrences;
  
  const untilYmd = todo.recurrence?.until ?? undefined;
  const untilDate = (untilYmd && isYmdString(untilYmd)) ? parseYMD(untilYmd) : null;
  
  const start = new Date(Math.max(fromDate.getTime(), anchor.getTime()));
  const inclusiveEnd = new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate() + 1);
  
  for (let d = new Date(start); d < inclusiveEnd; d = addDays(d, 1)) {
    if (untilDate && d > untilDate) break;
    
    if (matchesRule(d, anchor, todo.recurrence)) {
      const dateStr = ymd(d);
      const occCompleted = Array.isArray(todo.completedDates) && todo.completedDates.includes(dateStr);
      const occSkipped = Array.isArray(todo.skippedDates) && todo.skippedDates.includes(dateStr);
      
      occurrences.push({
        id: todo.id,
        masterId: todo.id,
        title: todo.title,
        notes: todo.notes,
        scheduledFor: dateStr,
        timeOfDay: todo.timeOfDay,
        completed: !!occCompleted,
        status: occCompleted ? 'completed' : (occSkipped ? 'skipped' : 'pending'),
        recurrence: todo.recurrence,
        context: todo.context,
        createdAt: todo.createdAt,
        updatedAt: todo.updatedAt,
      });
    }
  }
  
  return occurrences;
}
```

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

### Assistant Router and Proposal Pipeline

#### Router Decision Algorithm

**Confidence Thresholds**:
- `CLARIFY_THRESHOLD = 0.45` - Below this forces clarification
- `CHAT_THRESHOLD = 0.70` - Above this allows direct planning

**Router Prompt Structure**:
```javascript
const routerPrompt = {
  system: "You are an intelligent intent router for a todo assistant.",
  developer: `
    OUTPUT FORMAT: Single JSON object only with these fields:
    - decision: "chat" | "plan" | "clarify"
    - confidence: number (0.0 to 1.0)
    - question: string (only for clarify decisions)
    - where: object (only for plan decisions)
    - delegate: object (only for plan decisions)
    - options: array (only for clarify decisions)
    
    DECISION RULES:
    - "clarify": Use when intent is ambiguous about time/date, target selection, or context
    - "plan": Use when intent is clear and actionable
    - "chat": Use for general questions, status inquiries, or non-actionable requests
    
    CONFIDENCE SCORING:
    - 0.9-1.0: Very clear intent with specific details
    - 0.7-0.8: Clear intent with some ambiguity
    - 0.5-0.6: Somewhat clear but needs context
    - 0.3-0.4: Ambiguous, needs clarification
    - 0.0-0.2: Very ambiguous, definitely needs clarification
  `,
  user: `
    Today: ${todayYmd} (${TIMEZONE})
    Current Context: ${JSON.stringify(snapshots, null, 2)}
    Recent Conversation (last 3 turns): ${convo}
    User Input: ${msg}
  `
};
```

**Decision Processing**:
```javascript
function processRouterDecision(parsed, snapshots) {
  let decision = parsed.decision || 'clarify';
  const confidence = Number(parsed.confidence || 0);
  
  // Force clarification if confidence is low
  if (confidence < CLARIFY_THRESHOLD) {
    decision = 'clarify';
  }
  
  // Process where field for plan decisions
  let where = parsed.where || null;
  if (typeof where === 'string' && where.trim()) {
    where = resolveWhereFromString(where, snapshots);
  }
  
  return {
    decision,
    confidence,
    question: parsed.question,
    where,
    delegate: parsed.delegate,
    options: parsed.options || []
  };
}
```

#### Proposal Generation Algorithm

**Proposal Prompt Structure**:
```javascript
const proposalPrompt = `
You are an assistant for a todo app. Output ONLY a single JSON object with key "operations" as an array. No prose.

Each operation MUST include fields: kind (todo|event|goal) and action.
todo actions: create|update|delete|set_status.
For todo/event create/update include recurrence (use {"type":"none"} for non-repeating). 
If recurrence.type != none, scheduledFor is REQUIRED.

No bulk operations. Emit independent operations; limit to ≤20 per apply.
Today's date is ${todayYmd}. Do NOT invent invalid IDs. Prefer fewer changes over hallucination.

Conversation (last 3 turns): ${convo}
Timezone: ${TIMEZONE}
Instruction: ${instruction}

Context: ${JSON.stringify(focusedSnapshot, null, 2)}

Respond with JSON ONLY that matches this exact example format:
{
  "operations": [
    {"kind":"todo","action":"update","id":1,"recurrence":{"type":"none"}}
  ]
}
`;
```

**Operation Inference**:
```javascript
function inferOperationShape(o) {
  if (!o || typeof o !== 'object') return null;
  
  const op = { ...o };
  
  // Map V3 to internal format
  if (op.kind && op.action) {
    const kind = String(op.kind).toLowerCase();
    const action = String(op.action).toLowerCase();
    
    if (kind === 'todo') {
      if (action === 'create') op.op = 'create';
      else if (action === 'update') op.op = 'update';
      else if (action === 'delete') op.op = 'delete';
      else if (action === 'set_status') op.op = 'set_status';
    } else if (kind === 'event') {
      if (action === 'create') op.op = 'create';
      else if (action === 'update') op.op = 'update';
      else if (action === 'delete') op.op = 'delete';
      else if (action === 'complete') op.op = 'complete';
      else if (action === 'complete_occurrence') op.op = 'complete_occurrence';
    } else if (kind === 'habit') {
      if (action === 'create') op.op = 'create';
      else if (action === 'update') op.op = 'update';
      else if (action === 'delete') op.op = 'delete';
      else if (action === 'complete') op.op = 'complete';
      else if (action === 'complete_occurrence') op.op = 'complete_occurrence';
    } else if (kind === 'goal') {
      if (action === 'create') op.op = 'goal_create';
      else if (action === 'update') op.op = 'goal_update';
      else if (action === 'delete') op.op = 'goal_delete';
      else if (action === 'add_items') op.op = 'goal_add_items';
      else if (action === 'remove_item') op.op = 'goal_remove_item';
      else if (action === 'add_child') op.op = 'goal_add_child';
      else if (action === 'remove_child') op.op = 'goal_remove_child';
    }
  }
  
  // Normalize empty strings to null
  if (op.scheduledFor === '') op.scheduledFor = null;
  if (op.timeOfDay === '') op.timeOfDay = null;
  
  return op;
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

#### Summarization Algorithm

**Conversational Summary**:
```javascript
async function generateSummary(operations, issues, timezone) {
  const compactOps = operations.map(op => {
    const parts = [];
    parts.push(op.action || op.op);
    if (op.id) parts.push(`#${op.id}`);
    if (op.title) parts.push(`"${op.title}"`);
    if (op.scheduledFor) parts.push(`@${op.scheduledFor}`);
    return `- ${parts.join(' ')}`;
  }).join('\n');
  
  const summaryPrompt = `
You are a helpful assistant for a todo app. Keep answers concise and clear. Prefer 1–3 short sentences; no lists or JSON.

Proposed operations (count: ${operations.length}):
${compactOps}

${issues.length > 0 ? `Issues: ${issues.join(', ')}` : ''}

Summarize the plan in plain English grounded in the proposed operations above.
  `;
  
  const summary = await convoLLM(summaryPrompt);
  return stripGraniteTags(summary);
}

function stripGraniteTags(text) {
  return text
    .replace(/<granite:.*?>/g, '')
    .replace(/<\/granite:.*?>/g, '')
    .replace(/```.*?```/gs, '')
    .trim();
}
```

### Operation Execution via MCP Tools

#### MCP Tool Execution Flow

```javascript
class OperationProcessor {
  constructor(mcpServer, db) {
    this.mcpServer = mcpServer;
    this.db = db;
  }
  
  async executeOperations(operations) {
    const results = [];
    
    for (const op of operations) {
      try {
        const result = await this.executeOperation(op);
        results.push({ success: true, result });
      } catch (error) {
        results.push({ success: false, error: error.message });
      }
    }
    
    return results;
  }
  
  async executeOperation(op) {
    const toolName = this.mapOperationToTool(op);
    const args = this.mapOperationToArgs(op);
    
    return await this.mcpServer.handleToolCall(toolName, args);
  }
  
  mapOperationToTool(op) {
    const kind = op.kind || 'todo';
    const action = op.action || op.op;
    
    switch (action) {
      case 'create': return `${kind}.create`;
      case 'update': return `${kind}.update`;
      case 'delete': return `${kind}.delete`;
      case 'set_status': return `${kind}.set_status`;
      case 'complete': return `${kind}.complete`;
      case 'complete_occurrence': return `${kind}.complete_occurrence`;
      default: throw new Error(`Unknown operation: ${action}`);
    }
  }
}
```

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
- `invalid_title` - Title is missing or empty
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

#### MCP Tool Errors

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



