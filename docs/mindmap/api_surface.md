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

#### Todos

**List Todos**
- **GET** `/api/todos`
  - **Query Parameters**:
    - `from?: YYYY-MM-DD` - Start date for range filtering
    - `to?: YYYY-MM-DD` - End date for range filtering  
    - `completed?: true|false` - Filter by completion status
    - `status?: pending|completed|skipped` - Filter by todo status
    - `context?: school|personal|work` - Filter by context
  - **Behavior**: When both `from` and `to` provided, repeating todos expanded into per-day occurrences over `[from, to+1d)`; otherwise returns scheduled masters
  - **Response**: `{ todos: Todo[] }`
  - **Example**: `GET /api/todos?from=2024-01-15&to=2024-01-21&status=pending`

**Backlog (Unscheduled)**
- **GET** `/api/todos/backlog`
  - **Query Parameters**:
    - `status?: pending|completed|skipped` - Filter by status
    - `context?: school|personal|work` - Filter by context
  - **Response**: `{ todos: Todo[] }` (unscheduled only)
  - **Example**: `GET /api/todos/backlog?context=work`

**Search Todos**
- **GET** `/api/todos/search`
  - **Query Parameters**:
    - `query: string` - Search text (required, min 1 character)
    - `status?: pending|completed|skipped` - Filter by status
    - `context?: school|personal|work` - Filter by context
  - **Response**: `{ todos: Todo[] }`
  - **Features**: FTS5 full-text search on title and notes
  - **Example**: `GET /api/todos/search?query=meeting&status=pending`

**Get Single Todo**
- **GET** `/api/todos/:id`
  - **Response**: `{ todo: Todo }`
  - **Errors**: `404 not_found` if todo doesn't exist

**Create Todo**
- **POST** `/api/todos`
  - **Body**:
    ```json
    {
      "title": "string (required)",
      "notes": "string (optional)",
      "scheduledFor": "YYYY-MM-DD|null (optional)",
      "timeOfDay": "HH:MM|null (optional)",
      "recurrence": {
        "type": "none|daily|weekdays|weekly|every_n_days (required)",
        "intervalDays": "number>=1 (for every_n_days)",
        "until": "YYYY-MM-DD|null (optional)"
      },
      "context": "school|personal|work (optional, defaults to personal)"
    }
    ```
  - **Validation**: `recurrence` object required; if repeating, `scheduledFor` anchor required
  - **Response**: `{ todo: Todo }`
  - **Example**:
    ```json
    {
      "title": "Daily standup",
      "recurrence": {"type": "daily"},
      "scheduledFor": "2024-01-15",
      "context": "work"
    }
    ```

**Update Todo**
- **PATCH** `/api/todos/:id`
  - **Body**: Partial update with any of: `title?`, `notes?`, `scheduledFor?`, `status?`, `timeOfDay?`, `recurrence?`, `context?`
  - **Validation**: `recurrence` object required on update; if repeating, anchor date must exist
  - **Response**: `{ todo: Todo }`
  - **Example**:
    ```json
    {
      "status": "completed",
      "notes": "Finished early"
    }
    ```

**Update Todo Occurrence**
- **PATCH** `/api/todos/:id/occurrence`
  - **Body**:
    ```json
    {
      "occurrenceDate": "YYYY-MM-DD (required)",
      "status": "pending|completed|skipped (optional, defaults to completed)"
    }
    ```
  - **Response**: `{ todo: Todo }`
  - **Errors**: `400 not_repeating` if todo is not repeating

**Delete Todo**
- **DELETE** `/api/todos/:id`
  - **Response**: `{ ok: true }`
  - **Cascade**: Removes from linked habits and goals

#### Events

**List Events**
- **GET** `/api/events`
  - **Query Parameters**: Same as todos (`from`, `to`, `completed`, `context`)
  - **Behavior**: Expands repeating events when both `from`/`to` provided
  - **Response**: `{ events: Event[] }`

**Search Events**
- **GET** `/api/events/search`
  - **Query Parameters**:
    - `query: string` - Search text
    - `completed?: true|false` - Filter by completion
    - `context?: school|personal|work` - Filter by context
  - **Response**: `{ events: Event[] }`

**Create Event**
- **POST** `/api/events`
  - **Body**:
    ```json
    {
      "title": "string (required)",
      "notes": "string (optional)",
      "scheduledFor": "YYYY-MM-DD|null (optional)",
      "startTime": "HH:MM|null (optional)",
      "endTime": "HH:MM|null (optional)",
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

**Update Event Occurrence**
- **PATCH** `/api/events/:id/occurrence`
  - **Body**:
    ```json
    {
      "occurrenceDate": "YYYY-MM-DD (required)",
      "completed": "boolean (optional)"
    }
    ```
  - **Response**: `{ event: Event }`

#### Habits

**List Habits**
- **GET** `/api/habits`
  - **Query Parameters**: `from?`, `to?`, `completed?`, `context?`
  - **Stats**: When both `from`/`to` provided, includes derived stats: `currentStreak`, `longestStreak`, `weekHeatmap`
  - **Response**: `{ habits: Habit[] }`

**Create Habit**
- **POST** `/api/habits`
  - **Validation**: Must be repeating (recurrence.type cannot be 'none')
  - **Body**: Same as events but with `timeOfDay` instead of `startTime`/`endTime`
  - **Response**: `{ habit: Habit }`

**Link Items to Habit**
- **POST** `/api/habits/:id/items`
  - **Body**:
    ```json
    {
      "todos": [1, 2, 3],
      "events": [4, 5, 6]
    }
    ```
  - **Response**: `204 No Content`

#### Goals

**List Goals**
- **GET** `/api/goals`
  - **Query Parameters**:
    - `status?: active|completed|archived` - Filter by status
  - **Response**: `{ goals: Goal[] }`

**Get Goal with Details**
- **GET** `/api/goals/:id`
  - **Query Parameters**:
    - `includeItems?: boolean` - Include linked todos/events
    - `includeChildren?: boolean` - Include child goals
  - **Response**: `{ goal: Goal }`

**Create Goal**
- **POST** `/api/goals`
  - **Body**:
    ```json
    {
      "title": "string (required)",
      "notes": "string (optional)",
      "status": "active|completed|archived (optional, defaults to active)",
      "currentProgressValue": "number (optional)",
      "targetProgressValue": "number (optional)",
      "progressUnit": "string (optional)"
    }
    ```
  - **Response**: `{ goal: Goal }`

**Link Items to Goal**
- **POST** `/api/goals/:id/items`
  - **Body**:
    ```json
    {
      "todos": [1, 2, 3],
      "events": [4, 5, 6]
    }
    ```
  - **Response**: `{ ok: true }`

**Add Child Goals**
- **POST** `/api/goals/:id/children`
  - **Body**: `[childId1, childId2, ...]`
  - **Response**: `{ ok: true }`

#### Unified Schedule

**Get Unified Schedule**
- **GET** `/api/schedule`
  - **Query Parameters**:
    - `from: YYYY-MM-DD` - Start date (required)
    - `to: YYYY-MM-DD` - End date (required)
    - `kinds: string` - Comma-separated list: `todo,event,habit`
    - `completed?: true|false` - Filter by completion
    - `status_todo?: pending|completed|skipped` - Filter todos by status
  - **Response**: `{ items: Array }` with unified items containing `kind: 'todo'|'event'|'habit'`
  - **Behavior**: Expands repeating items into per-day occurrences

#### Unified Search

**Search Across All Types**
- **GET** `/api/search`
  - **Query Parameters**:
    - `q: string` - Search query (required)
    - `scope?: todo|event|habit|all` - Search scope (default: all)
    - `completed?: true|false` - Filter by completion
    - `status_todo?: pending|completed|skipped` - Filter todos by status
    - `limit?: number` - Result limit (default: 30)
  - **Response**: `{ items: Array }` with unified items
  - **Features**: FTS5 search across todos, events, and habits

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

**Assistant Message (SSE Stream)**
- **GET** `/api/assistant/message/stream`
  - **Query Parameters**: Same as POST endpoint
  - **Response**: Server-Sent Events stream with events:
    - `stage`: Current processing stage
    - `clarify`: Clarification question and options
    - `ops`: Proposed operations with validation
    - `summary`: Human-readable summary
    - `result`: Final result
    - `heartbeat`: Keep-alive (every 10s)
    - `done`: Stream completion

**LLM Health Check**
- **GET** `/api/llm/health`
  - **Response**: `{ ok: true, models, configured, convoPresent, codePresent }`

**LLM Quality Report**
- **GET** `/api/llm/quality`
  - **Response**: `{ ok: true, report }`

**LLM Message (Direct)**
- **POST** `/api/llm/message`
  - **Body**:
    ```json
    {
      "message": "string (required)",
      "transcript": "Array (optional)"
    }
    ```
  - **Response**: `{ ok: true, text, correlationId }`

#### MCP Tools

**List Available Tools**
- **GET** `/api/mcp/tools`
  - **Response**: `{ tools: Tool[] }`

**List Resources**
- **GET** `/api/mcp/resources`
  - **Response**: `{ resources: Resource[] }`

**Get Resource Content**
- **GET** `/api/mcp/resources/:type/:name`
  - **Response**: `{ uri, content }`

**Execute Tool**
- **POST** `/api/mcp/tools/call`
  - **Body**:
    ```json
    {
      "name": "string (required)",
      "arguments": "object (required)"
    }
    ```
  - **Response**: `{ content, isError }`
  - **Features**: Idempotency support via `Idempotency-Key` header

### Validation Rules

**Todo Validation**:
- `recurrence` object required on create and update
- If repeating (`type != 'none'`), `scheduledFor` anchor required
- `status` must be one of: `pending`, `completed`, `skipped`
- `context` must be one of: `school`, `personal`, `work`

**Event Validation**:
- `recurrence` object required on create and update
- If repeating, `scheduledFor` anchor required
- `startTime` and `endTime` must be valid `HH:MM` format
- `endTime` must be after `startTime` if both provided

**Habit Validation**:
- Must be repeating (recurrence.type cannot be 'none')
- `recurrence` object required on create and update
- Anchor date required for repeating habits

**General Validation**:
- All dates must be `YYYY-MM-DD` format
- All times must be `HH:MM` format or null
- IDs must be positive integers
- Titles cannot be empty strings

### Client API Functions (Flutter api.dart)

**Todo Operations**:
- `fetchScheduled({ from, to, status?, context? })` → `List<Todo>`
- `fetchScheduledAllTime({ status?, context? })` → `List<Todo>`
- `fetchBacklog({ status?, context? })` → `List<Todo>`
- `searchTodos(query, { status?, context?, cancelToken? })` → `List<Todo>`
- `createTodo(data)` → `Todo`
- `updateTodo(id, patch)` → `Todo`
- `setTodoOccurrenceStatus(id, occurrenceDate, status)` → `Todo`
- `deleteTodo(id)` → `void`

**Event Operations**:
- `listEvents({ context? })` → `List<Event>`
- `searchEvents(query, { completed?, context?, cancelToken? })` → `List<Event>`
- `createEvent(data)` → `Event`
- `updateEvent(id, patch)` → `Event`
- `toggleEventOccurrence(id, occurrenceDate, completed)` → `Event`
- `deleteEvent(id)` → `void`

**Habit Operations**:
- `listHabits({ from?, to?, context? })` → `List<Habit>` (with stats)
- `searchHabits(query, { completed?, context?, cancelToken? })` → `List<Habit>`
- `createHabit(data)` → `Habit`
- `updateHabit(id, patch)` → `Habit`
- `toggleHabitOccurrence(id, occurrenceDate, completed)` → `Habit`
- `linkHabitItems(habitId, { todos?, events? })` → `void`
- `unlinkHabitTodo(habitId, todoId)` → `void`
- `unlinkHabitEvent(habitId, eventId)` → `void`

**Goal Operations**:
- `listGoals({ status? })` → `List<Goal>`
- `getGoal(id, { includeItems?, includeChildren? })` → `Goal`
- `createGoal(data)` → `Goal`
- `updateGoal(id, patch)` → `Goal`
- `deleteGoal(id)` → `void`
- `addGoalItems(goalId, { todos?, events? })` → `void`
- `removeGoalTodoItem(goalId, todoId)` → `void`
- `removeGoalEventItem(goalId, eventId)` → `void`
- `addGoalChild(goalId, childIds)` → `void`
- `removeGoalChild(parentId, childId)` → `void`

**Unified Operations**:
- `fetchSchedule({ from, to, kinds, completed?, statusTodo? })` → `List<dynamic>`
- `searchUnified(query, { scope?, completed?, statusTodo?, limit?, cancelToken? })` → `List<dynamic>`

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
- `invalid_recurrence` - Recurrence object is malformed
- `missing_anchor_for_recurrence` - Anchor date required for repeating items
- `invalid_completed` - Completed field is invalid
- `invalid_status` - Status value is invalid
- `invalid_id` - ID is missing or invalid
- `not_found` - Resource not found
- `not_repeating` - Item is not repeating (for occurrence operations)
- `invalid_occurrenceDate` - Occurrence date is invalid
- `use_set_status` - Use set_status instead of complete for todos
- `invalid_context` - Context value is invalid
- `invalid_from` - From date is invalid
- `invalid_to` - To date is invalid
- `invalid_query` - Search query is invalid

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
  kind: 'todo' | 'event' | 'habit' | 'goal',
  action: 'create' | 'update' | 'delete' | 'set_status' | 'complete' | 'complete_occurrence' | 'goal_create' | 'goal_update' | 'goal_delete' | 'goal_add_items' | 'goal_remove_item' | 'goal_add_child' | 'goal_remove_child',
  id?: number,
  title?: string,
  notes?: string,
  scheduledFor?: string | null,
  timeOfDay?: string | null,
  recurrence?: Recurrence,
  status?: string,
  occurrenceDate?: string,
  // ... other fields
}
```

### Endpoint → Client Usage Map

| Endpoint | Client Function | Notes |
|----------|----------------|-------|
| `GET /api/todos` | `fetchScheduled`, `fetchScheduledAllTime` | Range vs all-time |
| `GET /api/todos/backlog` | `fetchBacklog` | Unscheduled only |
| `GET /api/todos/search` | `searchTodos` | FTS5 search |
| `POST /api/todos` | `createTodo` | Requires recurrence |
| `PATCH /api/todos/:id` | `updateTodo` | Partial updates |
| `PATCH /api/todos/:id/occurrence` | `setTodoOccurrenceStatus` | For repeating todos |
| `DELETE /api/todos/:id` | `deleteTodo` | Cascade deletes |
| `GET /api/events` | `listEvents` | With optional expansion |
| `GET /api/events/search` | `searchEvents` | FTS5 search |
| `POST /api/events` | `createEvent` | Requires recurrence |
| `PATCH /api/events/:id` | `updateEvent` | Partial updates |
| `PATCH /api/events/:id/occurrence` | `toggleEventOccurrence` | For repeating events |
| `DELETE /api/events/:id` | `deleteEvent` | Cascade deletes |
| `GET /api/habits` | `listHabits` | With stats when range provided |
| `GET /api/habits/search` | `searchHabits` | FTS5 search |
| `POST /api/habits` | `createHabit` | Must be repeating |
| `PATCH /api/habits/:id` | `updateHabit` | Partial updates |
| `PATCH /api/habits/:id/occurrence` | `toggleHabitOccurrence` | For repeating habits |
| `POST /api/habits/:id/items` | `linkHabitItems` | Link todos/events |
| `DELETE /api/habits/:id/items/*` | `unlinkHabitTodo`, `unlinkHabitEvent` | Unlink items |
| `GET /api/goals` | `listGoals` | With status filtering |
| `GET /api/goals/:id` | `getGoal` | With optional includes |
| `POST /api/goals` | `createGoal` | No recurrence required |
| `PATCH /api/goals/:id` | `updateGoal` | Partial updates |
| `DELETE /api/goals/:id` | `deleteGoal` | Cascade deletes |
| `POST /api/goals/:id/items` | `addGoalItems` | Link todos/events |
| `DELETE /api/goals/:id/items/*` | `removeGoalTodoItem`, `removeGoalEventItem` | Unlink items |
| `POST /api/goals/:id/children` | `addGoalChild` | Add child goals |
| `DELETE /api/goals/:id/children/*` | `removeGoalChild` | Remove child goals |
| `GET /api/schedule` | `fetchSchedule` | Unified schedule view |
| `GET /api/search` | `searchUnified` | Cross-type search |
| `POST /api/assistant/message` | `assistantMessage` | Non-streaming |
| `GET /api/assistant/message/stream` | `assistantMessage` | SSE streaming |
| `POST /api/mcp/tools/call` | `applyOperationsMCP`, `dryRunOperationsMCP` | Tool execution |


