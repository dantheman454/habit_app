## API Surface and Couplings

Audience: backend and client developers. Covers endpoints, payload shapes, validation rules, and concrete coupling to Flutter `api.dart`.

### Cross-cutting concerns

- **Requests/Responses**: JSON; body limit 256kb
- **CORS enabled**: `x-powered-by` disabled
- **Static assets**: Flutter Web build mounted after API routes from `STATIC_DIR`
- **Error responses**: All errors return `{ error: string }` with appropriate HTTP status codes
- **Validation**: Server-side validation with detailed error messages
- **Timezone**: All date operations use `America/New_York` (configurable via `TZ_NAME`)

### Endpoints (server)

#### Health Check
- **GET** `/health` → `{ ok: true }`
  - Simple health check for load balancers and monitoring
  - No authentication required

#### Tasks

**List Tasks**
- **GET** `/api/tasks`
  - **Query Parameters**:
    - `from?: YYYY-MM-DD` - Start date for range filtering
    - `to?: YYYY-MM-DD` - End date for range filtering  
    - `completed?: true|false` - Filter by completion status
    - `status?: pending|completed|skipped` - Filter by task status
    - `context?: school|personal|work` - Filter by context
  - **Behavior**: When both `from` and `to` provided, repeating tasks expanded into per-day occurrences over `[from, to+1d)`; otherwise returns scheduled masters
  - **Response**: `{ tasks: Task[] }`
  - **Example**: `GET /api/tasks?from=2024-01-15&to=2024-01-21&status=pending`
  - **Location**: `apps/server/routes/tasks.js`

**Search Tasks**
- **GET** `/api/tasks/search`
  - **Query Parameters**:
    - `query: string` - Search text (required, min 1 character)
    - `status?: pending|completed|skipped` - Filter by status
    - `context?: school|personal|work` - Filter by context
  - **Response**: `{ tasks: Task[] }`
  - **Features**: FTS5 full-text search on title and notes
  - **Example**: `GET /api/tasks/search?query=meeting&status=pending`
  - **Location**: `apps/server/routes/tasks.js`

**Get Single Task**
- **GET** `/api/tasks/:id`
  - **Response**: `{ task: Task }`
  - **Errors**: `404 not_found` if task doesn't exist
  - **Location**: `apps/server/routes/tasks.js`

**Create Task**
- **POST** `/api/tasks`
  - **Body**:
    ```json
    {
      "title": "string (required)",
      "notes": "string (optional)",
      "scheduledFor": "YYYY-MM-DD|null (optional)",
      "timeOfDay": "HH:MM|null (optional, canonical 24h)",
      "recurrence": {
        "type": "none|daily|weekdays|weekly|every_n_days (required)",
        "intervalDays": "number>=1 (for every_n_days)",
        "until": "YYYY-MM-DD|null (optional)"
      },
      "context": "school|personal|work (optional, defaults to personal)"
    }
    ```
  - **Validation**: `recurrence` object required; if repeating, `scheduledFor` anchor required
  - **Response**: `{ task: Task }`
  - **Example**:
    ```json
    {
      "title": "Daily standup",
      "recurrence": {"type": "daily"},
      "scheduledFor": "2024-01-15",
      "context": "work"
    }
    ```
  - **Location**: `apps/server/routes/tasks.js`

**Update Task**
- **PATCH** `/api/tasks/:id`
  - **Body**: Partial update with any of: `title?`, `notes?`, `scheduledFor?`, `status?`, `timeOfDay?`, `recurrence?`, `context?`
  - **Validation**: `recurrence` object required on update; if repeating, anchor date must exist
  - **Response**: `{ task: Task }`
  - **Example**:
    ```json
    {
      "status": "completed",
      "notes": "Finished early"
    }
    ```
  - **Location**: `apps/server/routes/tasks.js`

**Update Task Occurrence**
- **PATCH** `/api/tasks/:id/occurrence`
  - **Body**:
    ```json
    {
      "occurrenceDate": "YYYY-MM-DD (required)",
      "status": "pending|completed|skipped (optional, defaults to completed)"
    }
    ```
  - **Response**: `{ task: Task }`
  - **Errors**: `400 not_repeating` if task is not repeating
  - **Location**: `apps/server/routes/tasks.js`

**Delete Task**
- **DELETE** `/api/tasks/:id`
  - **Response**: `{ ok: true }`
  - **Cascade**: None

#### Events

**List Events**
- **GET** `/api/events`
  - **Query Parameters**: Same as tasks (`from`, `to`, `completed`, `context`)
  - **Behavior**: Expands repeating events when both `from`/`to` provided
  - **Response**: `{ events: Event[] }`
  - **Location**: `apps/server/routes/events.js`

**Search Events**
- **GET** `/api/events/search`
  - **Query Parameters**:
    - `query: string` - Search text
    - `completed?: true|false` - Filter by completion
    - `context?: school|personal|work` - Filter by context
  - **Response**: `{ events: Event[] }`
  - **Location**: `apps/server/routes/events.js`

**Create Event**
- **POST** `/api/events`
  - **Body**:
    ```json
    {
      "title": "string (required)",
      "notes": "string (optional)",
      "scheduledFor": "YYYY-MM-DD|null (optional)",
      "startTime": "HH:MM|null (optional, canonical 24h)",
      "endTime": "HH:MM|null (optional, canonical 24h; may wrap < start)",
      "location": "string (optional)",
      "recurrence": {
        "type": "none|daily|weekdays|weekly|every_n_days (required)",
        "intervalDays": "number>=1 (for every_n_days)",
        "until": "YYYY-MM-DD|null (optional)"
      },
      "context": "school|personal|work (optional, defaults to personal)"
    }
    ```
  - **Response**: `{ event: Event }`
  - **Location**: `apps/server/routes/events.js`

**Update Event Occurrence**
- Not supported (returns `400 not_supported`)
- **Location**: `apps/server/routes/events.js`

#### Unified Schedule

**Get Unified Schedule**
- **GET** `/api/schedule`
  - **Query Parameters**:
    - `from: YYYY-MM-DD` - Start date (required)
    - `to: YYYY-MM-DD` - End date (required)
    - `kinds: string` - Comma-separated list: `task,event`
    - `completed?: true|false` - Filter events by completion
    - `status_task?: pending|completed|skipped` - Filter tasks by status
  - **Response**: `{ items: Array }` with unified items containing `kind: 'task'|'event'`
  - **Behavior**: Expands repeating items into per-day occurrences
  - **Location**: `apps/server/routes/schedule.js`

#### Unified Search

**Search Across All Types**
- **GET** `/api/search`
  - **Query Parameters**:
    - `q: string` - Search query (required)
    - `scope?: task|event|all` - Search scope (default: all)
    - `completed?: true|false` - Filter events by completion
    - `status_task?: pending|completed|skipped` - Filter tasks by status
    - `limit?: number` - Result limit (default: 30)
  - **Response**: `{ items: Array }` with unified items
  - **Features**: FTS5 search across tasks and events
  - **Location**: `apps/server/routes/search.js`

#### Assistant and LLM

**Assistant Message (POST)**
- **POST** `/api/assistant/message`
  - **Body**:
    ```json
    {
      "message": "string (required)",
      "transcript": "Array (optional)",
      "options": {
        "clarify": {
          "selection": {
            "ids": [1, 2, 3],
            "date": "2024-01-15"
          }
        }
      }
    }
    ```
  - **Response**: `{ text, operations, steps, tools, notes, correlationId }`
  - **Location**: `apps/server/routes/assistant.js`

**Assistant Message (SSE Stream)**
- **GET** `/api/assistant/message/stream`
  - **Query Parameters**: Same as POST endpoint
  - **Response**: Server-Sent Events stream with events:
    - `stage`: Current processing stage
    - `ops`: Proposed operations with validation and previews
    - `summary`: Human-readable summary
    - `heartbeat`: Keep-alive (every 10s)
    - `done`: Stream completion
  - **Location**: `apps/server/routes/assistant.js`
  
  Note: Dedicated LLM routes are not exposed in the current server.

#### MCP Tools

**List Available Tools**
- **GET** `/api/mcp/tools`
  - **Response**: `{ tools: Tool[] }`
  - **Location**: `apps/server/server.js`

**List Resources**
- **GET** `/api/mcp/resources`
  - **Response**: `{ resources: Resource[] }`
  - **Location**: `apps/server/server.js`

**Get Resource Content**
- **GET** `/api/mcp/resources/:type/:name`
  - **Response**: `{ uri, content }`
  - **Location**: `apps/server/server.js`

**Execute Tool**
- **POST** `/api/mcp/tools/call`
  - **Body**:
    ```json
    {
      "name": "string (required)",
      "arguments": "object (required)"
    }
    ```
  - **Response**: Operation processor result object (e.g., `{ results, summary, correlationId }`)
  - **Location**: `apps/server/server.js`

### Validation Rules

**Task Validation**:
- `recurrence` object required on create and update
- If repeating (`type != 'none'`), `scheduledFor` anchor required
- `status` must be one of: `pending`, `completed`, `skipped`
- `context` must be one of: `school`, `personal`, `work`

**Event Validation**:
- `recurrence` object required on create and update
- If repeating, `scheduledFor` anchor required
- `startTime` and `endTime` must be valid `HH:MM` format (canonical 24h)
- Cross‑midnight allowed: `endTime` may be less than `startTime` (wrap to next day)

 

**General Validation**:
- All dates must be `YYYY-MM-DD` format
- All times must be canonical 24h `HH:MM` format or null
- IDs must be positive integers
- Titles cannot be empty strings

### Client API Functions (Flutter api.dart)

**Task Operations**:
- `fetchScheduled({ from, to, status?, context? })` → `List<Task>`
- `fetchScheduledAllTime({ status?, context? })` → `List<Task>`
- `searchTasks(query, { status?, context?, cancelToken? })` → `List<Task>`
- `createTask(data)` → `Task`
- `updateTask(id, patch)` → `Task`
- `setTaskOccurrenceStatus(id, occurrenceDate, status)` → `Task`
- `deleteTask(id)` → `void`

**Event Operations**:
- `listEvents({ context? })` → `List<Event>`
- `searchEvents(query, { completed?, context?, cancelToken? })` → `List<Event>`
- `createEvent(data)` → `Event`
- `updateEvent(id, patch)` → `Event`
- `deleteEvent(id)` → `void` (occurrence toggle not supported)

**Unified Operations**:
- `fetchSchedule({ from, to, kinds, completed?, statusTask? })` → `List<dynamic>`
- `searchUnified(query, { scope?, completed?, statusTask?, limit?, cancelToken? })` → `List<dynamic>`

**Assistant Operations**:
- `assistantMessage(message, { transcript?, streamSummary?, onSummary?, onClarify?, onStage?, onOps? })` → `Map<String, dynamic>`
- `applyOperationsMCP(operations)` → `List<Map<String, dynamic>>`
- `dryRunOperationsMCP(operations)` → `List<Map<String, dynamic>>`

**MCP Operations**:
- `listMCPTools()` → `List<Map<String, dynamic>>`
- `listMCPResources()` → `List<Map<String, dynamic>>`
- `readMCPResource(type, name)` → `Map<String, dynamic>?`
- `callMCPTool(name, arguments)` → `Map<String, dynamic>`

### Error Handling

**Common Error Codes**:
- `invalid_title` - Title is missing or invalid
- `missing_recurrence` - Recurrence object is required
- `invalid_notes` - Notes field is invalid
- `invalid_scheduledFor` - Date format is invalid
- `invalid_timeOfDay` - Time format is invalid
- `invalid_start_time` - Start time format is invalid (events)
- `invalid_end_time` - End time format is invalid (events)
- `invalid_recurrence` - Recurrence object is malformed
- `missing_anchor_for_recurrence` - Anchor date required for repeating items
- `invalid_completed` - Completed field is invalid
- `invalid_status` - Status value is invalid
- `invalid_status_task` - Task status value is invalid (unified endpoints)
- `invalid_id` - ID is missing or invalid
- `not_found` - Resource not found
- `not_repeating` - Item is not repeating (for occurrence operations)
- `invalid_occurrenceDate` - Occurrence date is invalid
- `use_set_status` - Use set_status instead of complete for tasks
- `invalid_context` - Context value is invalid
- `invalid_from` - From date is invalid
- `invalid_to` - To date is invalid
- `invalid_query` - Search query is invalid
- `invalid_scope` - Search scope is invalid (task|event|all)
- `invalid_body` - Request body is malformed
- `invalid_message` - Assistant message is invalid
- `invalid_where_ids` - Where clause IDs are invalid
- `invalid_where_title_contains` - Where clause title contains is invalid
- `invalid_where_overdue` - Where clause overdue filter is invalid
- `invalid_where_scheduled_range` - Where clause scheduled range is invalid
- `invalid_where_scheduled_range_from` - Where clause scheduled range from date is invalid
- `invalid_where_scheduled_range_to` - Where clause scheduled range to date is invalid
- `invalid_where_completed` - Where clause completed filter is invalid
- `invalid_where_repeating` - Where clause repeating filter is invalid
- `invalid_operations` - Operations array is invalid
- `create_failed` - Event creation failed

**HTTP Status Codes**:
- `200` - Success
- `204` - Success (no content)
- `400` - Bad request (validation errors)
- `404` - Not found
- `500` - Internal server error

### Types

**Recurrence Object**:
```typescript
{
  type: 'none' | 'daily' | 'weekdays' | 'weekly' | 'every_n_days',
  intervalDays?: number, // >= 1, required for every_n_days
  until?: string | null  // YYYY-MM-DD or null
}
```

**LlmOperation**:
```typescript
{
  kind: 'task' | 'event',
  action: 'create' | 'update' | 'delete' | 'set_status',
  id?: number,
  title?: string,
  notes?: string,
  scheduledFor?: string | null,
  timeOfDay?: string | null, // For tasks
  startTime?: string | null, // For events
  endTime?: string | null,   // For events
  location?: string | null,  // For events
  recurrence?: Recurrence,
  status?: string,           // For tasks: 'pending' | 'completed' | 'skipped'
  completed?: boolean,       // For events
  occurrenceDate?: string,   // For set_status operations
  context?: 'school' | 'personal' | 'work'
}
```

### Endpoint → Client Usage Map

| Endpoint | Client Function | Notes |
|----------|----------------|-------|
| `GET /api/tasks` | `fetchScheduled`, `fetchScheduledAllTime` | Range vs all-time |
| `GET /api/tasks/search` | `searchTasks` | FTS5 search |
| `POST /api/tasks` | `createTask` | Requires recurrence |
| `PATCH /api/tasks/:id` | `updateTask` | Partial updates |
| `PATCH /api/tasks/:id/occurrence` | `setTaskOccurrenceStatus` | For repeating tasks |
| `DELETE /api/tasks/:id` | `deleteTask` | Cascade deletes |
| `GET /api/events` | `listEvents` | With optional expansion |
| `GET /api/events/search` | `searchEvents` | FTS5 search |
| `POST /api/events` | `createEvent` | Requires recurrence |
| `PATCH /api/events/:id` | `updateEvent` | Partial updates |
| `DELETE /api/events/:id` | `deleteEvent` | Cascade deletes |

| `GET /api/schedule` | `fetchSchedule` | Unified schedule view |
| `GET /api/search` | `searchUnified` | Cross-type search |
| `POST /api/assistant/message` | `assistantMessage` | Non-streaming |
| `GET /api/assistant/message/stream` | `assistantMessage` | SSE streaming |
| `POST /api/mcp/tools/call` | `applyOperationsMCP`, `dryRunOperationsMCP` | Tool execution |


