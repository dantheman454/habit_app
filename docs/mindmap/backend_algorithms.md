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
Validation for event times uses route-level checks and operation validators, not utils. Canonical pattern `^([01]\d|2[0-3]):[0-5]\d$` is enforced in `apps/server/routes/events.js` and `apps/server/operations/validators.js`.

**Recurrence Validation**:
Allowed types across the system: `none`, `daily`, `weekdays`, `weekly`, `every_n_days`. Both endpoints and operation validators use the same set.
- **Interval validation**: `intervalDays >= 1` for `every_n_days`
- **Until validation**: Must be valid YYYY-MM-DD or null
- **Location**: `apps/server/utils/recurrence.js`

#### Normalization

Normalization helpers are not present in the current codebase; endpoints and operation validators enforce shapes directly.

#### Endpoint-Level Validation

**Task Validation Rules**:
- `recurrence` object required on create; optional on update
- If repeating (`type != 'none'`), `scheduledFor` anchor required
- `status` must be one of: `pending`, `completed`, `skipped`
- `context` must be one of: `school`, `personal`, `work`

**Event Validation Rules**:
- `recurrence` object required on create; optional on update
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

#### Orchestrator and Routing

The system includes a feature-flagged orchestrator that can choose between Ops and Chat:
- Heuristic routing is always available; LLM classifier is optional.
- Hybrid mode can adopt LLM decide/clarify with fingerprinting.
- Location: `apps/server/llm/orchestrator.js`

### Assistant Tool-Calling Pipeline

Tool surface is limited to tasks and events only. Name format in LLM tool-calling:
- `task.create`, `task.update`, `task.delete`, `task.set_status`
- `event.create`, `event.update`, `event.delete`

#### Tool-Calling and Validation

The OpsAgent uses structured tool-calling with the following process:
- **Tool surface**: Limited to tasks and events with predefined schemas
- **Validation**: Each tool call is validated using OperationProcessor validators
- **Error handling**: Invalid operations are logged but not executed
- **Proposal-only**: All operations are proposed for user approval, never auto-applied

### Operation Execution via Operation Processor

`OperationProcessor` validates and executes operations using registered validators/executors. Multi-op requests wrap in a DB transaction.

### Auditing and Undo

Batch recording captures per-op before/after for undo. An idempotency table exists, but HTTP apply does not currently read/write it.

### Error Messages Catalog (selected)

- `invalid_title`, `missing_recurrence`, `invalid_notes`, `invalid_scheduledFor`, `invalid_recurrence`, `invalid_status`, `missing_or_invalid_id`, `bulk_operations_removed`, `invalid_occurrenceDate`, `invalid_context`, `update_failed`, `delete_failed`, `search_failed`, `db_error`, `assistant_failure`, `not_supported`.



