## Glossary

This glossary defines key terms and concepts used throughout the Task/Event App system. Each term includes a definition, usage context, and references to relevant documentation sections.

### Core Data Concepts

**Anchor (date)**: The `scheduledFor` date on a repeating master that determines recurrence alignment. Required when `recurrence.type != 'none'`. This date serves as the reference point for calculating all future occurrences of a repeating item.

- **Usage**: Used in recurrence expansion algorithms to determine which dates match the recurrence rule
- **Example**: A weekly task with anchor `2024-01-15` (Monday) will occur every Monday
- **Reference**: See [Data Model](./data_model.md#recurrence-system) for detailed recurrence rules

**Occurrence**: A per-day instance expanded from a repeating master within a range. Has `masterId = id`, `scheduledFor = occurrence date`. For tasks, `status` is derived from `completedDates` and `skippedDates`; for events, `completed` derives from `completedDates`. Occurrences are view constructs.

- **Usage**: Generated on-demand when listing items with date ranges
- **Example**: A daily task creates 7 occurrences when viewing a week range
- **Reference**: See [Data Model](./data_model.md#occurrence-expansion) for expansion algorithm

**CompletedDates**: Array of `YYYY-MM-DD` on repeating masters marking which occurrences were completed. For tasks, toggled by `/api/tasks/:id/occurrence` and by `set_status` in apply operations.

- **Usage**: Tracks completion state for individual occurrences of repeating items
- **Example**: `["2024-01-15", "2024-01-17"]` indicates occurrences on those dates were completed
- **Reference**: See [API Surface](./api_surface.md#update-task-occurrence) for endpoint usage

**Backlog**: Tasks with `scheduledFor = null`. Served by filtering `/api/tasks` with no date range.

- **Usage**: Represents unscheduled tasks that need to be assigned dates
- **Example**: "Write documentation" with no scheduled date appears in backlog
- **Reference**: See [Client Architecture](./client_architecture.md#data-loading-patterns) for loading patterns

### System Architecture Terms

**Unified schedule**: Range-based view that merges tasks and events. Items carry `kind` and kind-specific time fields; repeating items are expanded within `[from,to]` range.

- **Usage**: Provides a single view of all scheduled items across types
- **Example**: Shows tasks and events together in chronological order
- **Reference**: See [API Surface](./api_surface.md#unified-schedule) for endpoint details

**Bulk operations**: Not supported. Proposals attempting `bulk_*` are rejected with `bulk_operations_removed` error.

- **Usage**: Safety measure to prevent accidental mass changes
- **Example**: `bulk_delete` or `bulk_update` operations are rejected
- **Reference**: See [Backend Algorithms](./backend_algorithms.md#operation-level-validation) for validation rules

**Router**: Removed. Assistant uses a single tool-calling OpsAgent path.

**Tool calling**: Native LLM tool calling with Qwen model for operation proposal. Uses a predefined tool surface limited to tasks and events.

- **Usage**: Executes operations directly through LLM tool calls
- **Example**: `task.update` tool call with arguments for updating a task
- **Reference**: See [Assistant Chat Mindmap](./assistant_chat_mindmap.md#tool-calling-generation-algorithm) for implementation

### Data Integrity and Safety

**Idempotency**: MCP tool calls deduplicate by `x-correlation-id` + request hash to avoid re-applying the same changes.

- **Usage**: Prevents duplicate operations from network retries or user double-clicks
- **Example**: Same operation with same correlation ID returns cached result
- **Reference**: See [Backend Algorithms](./backend_algorithms.md#idempotency-implementation) for implementation

**Audit log**: Append-only records of assistant and CRUD actions written during operation execution.

- **Usage**: Provides transparency and debugging for all system changes
- **Example**: Logs every task creation, update, and deletion
- **Reference**: See [Data Model](./data_model.md#supporting-tables) for schema details

### Entity Types

**Context**: Categorization field for tasks and events. Values: 'school', 'personal', 'work' with 'personal' as default.

- **Usage**: Filter and organize items by life area
- **Example**: Work tasks vs personal tasks for different focus modes
- **Reference**: See [API Surface](./api_surface.md#validation-rules) for validation rules

### Communication Protocols

**SSE events**: Streaming assistant emits `stage`, `ops`, `summary`, periodic `heartbeat`, and `done`. The `ops` event includes `previews` for operation previews.

- **Usage**: Real-time communication between server and client during assistant interactions
- **Example**: `stage: "executing"` followed by `ops: [...]` with operations
- **Reference**: See [Assistant Chat Mindmap](./assistant_chat_mindmap.md#sse-stream-handling) for implementation

**Operation types**:
- **Tasks**: `create|update|delete|set_status`
- **Events**: `create|update|delete`

- **Usage**: Define what actions can be performed on each entity type
- **Example**: `{"kind": "task", "action": "set_status", "id": 1, "status": "completed"}`
- **Reference**: See [Backend Algorithms](./backend_algorithms.md#operation-validation) for validation rules

### Data Formats

**Time formats**: 
- **Dates**: `YYYY-MM-DD` format (e.g., "2024-01-15")
- **Times**: `startTime`, `endTime` are canonical 24h `HH:MM` or null; events may wrap across midnight. Tasks are all-day and have no time.

- **Usage**: Standardized format for date/time fields
- **Example**: Task → `scheduledFor: "2024-01-15"`; Event → `startTime: "09:00"`
- **Reference**: See [Backend Algorithms](./backend_algorithms.md#primitive-validators) for validation

**Recurrence**: `{ type: 'none'|'daily'|'weekdays'|'weekly'|'every_n_days', intervalDays?, until? }`; for repeating, anchor required and `until` may be null (no cap).

- **Usage**: Define how often an item repeats
- **Example**: `{"type": "daily", "until": "2024-12-31"}` for daily until year end
- **Note**: Operation validators include `'monthly'` and `'yearly'` types, but these are not implemented in the actual recurrence logic
- **Reference**: See [Data Model](./data_model.md#recurrence-system) for detailed types and rules

### Performance and Optimization

**FTS5**: Full-Text Search version 5, SQLite's built-in search engine used for searching tasks and events.

- **Usage**: Provides fast text search across titles, notes, and locations
- **Example**: Search "meeting" finds tasks and events containing that word
- **Reference**: See [Data Model](./data_model.md#fts5-virtual-tables) for implementation

**WAL mode**: Write-Ahead Logging, SQLite's journaling mode that enables concurrent read/write access.

- **Usage**: Allows multiple database connections without blocking
- **Example**: Server can read data while writing audit logs
- **Reference**: See [Data Model](./data_model.md#database-configuration) for configuration

### Error Handling

**Validation errors**: Server-side checks that ensure data integrity and business rule compliance.

- **Usage**: Prevent invalid data from entering the system
- **Example**: `missing_recurrence` when creating task without recurrence object
- **Reference**: See [Backend Algorithms](./backend_algorithms.md#error-messages-catalog) for complete list

**Repair attempts**: Single LLM-powered attempt to fix invalid operations before rejecting them.

- **Usage**: Improve user experience by automatically correcting common mistakes
- **Example**: Fixing malformed recurrence objects or missing required fields
- **Reference**: See [Backend Algorithms](./backend_algorithms.md#repair-algorithm) for implementation

### Development and Testing

**Test hooks**: Development-only flags that control system behavior for testing purposes.

- **Usage**: Enable/disable features during development and testing
- **Example**: `TestHooks.skipRefresh` to prevent data loading during tests
- **Reference**: See [Client Architecture](./client_architecture.md#test-hooks) for available hooks

**Debug panel**: Development-only UI component that shows system state and provides testing controls.

- **Usage**: Monitor application state and trigger actions during development
- **Example**: Shows current view mode, context, and item counts
- **Note**: Currently documented but not implemented in the codebase
- **Reference**: See [Client Architecture](./client_architecture.md#development-tools) for documentation

### Cross-References

For detailed implementation information, see:
- [API Surface](./api_surface.md) - Endpoint specifications and usage
- [Data Model](./data_model.md) - Database schema and relationships
- [Backend Algorithms](./backend_algorithms.md) - Server-side logic and validation
- [Assistant Chat Mindmap](./assistant_chat_mindmap.md) - LLM integration and conversation flow
- [Client Architecture](./client_architecture.md) - Flutter implementation and UI patterns
- [ER Diagram](./er_diagram.md) - Visual database structure representation



