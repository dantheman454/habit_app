# Assistant Chat System Mind Map

This document provides a comprehensive overview of how the assistant chat works in the habit application, from user input through execution and feedback.

## System Architecture Overview

```mermaid
graph TD
    subgraph "Client (Flutter Web)"
        A[User Input] --> B[Assistant Panel]
        B --> C[API Client]
        C --> D[SSE Stream Handler]
    end
    
    subgraph "Server (Express)"
        E[OpsAgent (tool-calling)] --> H[Validation]
        H --> I[Summarization]
        I --> J[Apply Operations (MCP → OperationProcessor)]
    end
    
    subgraph "LLM (Ollama)"
        K[Local Model] --> L[JSON Generation]
        L --> M[Response Parsing]
    end
    
    subgraph "Database"
        N[SQLite] --> O[Audit Log]
        N --> P[Idempotency Cache]
    end
    
    C -->|HTTP/SSE| E
    E --> K
    H --> K
    I --> K
    J --> N
```

## Detailed Flow Analysis: "update my task for today"

### 1. User Input & Client Processing

**Input**: User types "update my task for today" and clicks Send

**Client State**:
```dart
// In main.dart _sendAssistantMessage()
assistantTranscript.add({'role': 'user', 'text': 'update my task for today'});
assistantSending = true;
// Insert placeholder assistant bubble
assistantTranscript.add({'role': 'assistant', 'text': ''});
assistantStreamingIndex = assistantTranscript.length - 1;
```

**API Call**:
```dart
// Send last 3 turns for context
final recent = assistantTranscript.sublist(assistantTranscript.length - 3);
final res = await api.assistantMessage(
  'update my task for today',
  transcript: recent,
  streamSummary: true,
  onSummary: (s) => { /* Update placeholder bubble */ },
  onClarify: (q, options) => { /* Handle clarification */ },
  onStage: (st) => { /* Update progress */ },
  onOps: (ops, version, validCount, invalidCount) => { /* Show operations */ }
);
```

### 2. OpsAgent Proposal (Tool-Calling)

**OpsAgent Input**:
```javascript
// runOpsAgentToolCalling() called with:
const oa = await runOpsAgentToolCalling({ 
  taskBrief: message.trim(),
  where: {},
  transcript,
  timezone: TIMEZONE,
  operationProcessor
});
```

### 4. OpsAgent with Processor

**OpsAgent Input**:
```javascript
// runOpsAgentToolCalling() called with:
const oa = await runOpsAgentToolCalling({ 
  taskBrief: ca.delegate?.taskBrief || message.trim(), 
  where: ca.where, 
  transcript, 
  timezone: TIMEZONE,
  operationProcessor 
});
```

**Tool Calling Generation** (with focused context):
```javascript
// buildFocusedContext() with where
const focusedWhere = { title_contains: "task" }; // Focus on tasks
const focusedContext = buildFocusedContext(focusedWhere, { timezone });

// Tool surface definition (habits excluded)
const operationTools = [
  'todo.create','todo.update','todo.delete','todo.set_status',
  'event.create','event.update','event.delete'
].map((name) => ({
  type: 'function',
  function: {
    name,
    description: `Execute operation ${name}`,
    parameters: { type: 'object', additionalProperties: true }
  }
}));

// Prompt sent to LLM (qwen3:30b):
You are an operations executor for a todo application. Use tools to perform user actions precisely. Never invent IDs. Validate dates (YYYY-MM-DD) and times (HH:MM). Keep operations under 20 total.

Task: update my task for today
Where: {"title_contains":"task"}
Focused Context: [context with tasks matching "task"]
Recent Conversation: - user: update my task for today

Use tools to perform the requested action.
```

**Expected LLM Response**:
```json
{
  "tool_calls": [
    {
      "id": "call_1",
      "function": {
        "name": "todo.update",
        "arguments": {
          "id": 1,
          "recurrence": {"type": "none"}
        }
      }
    }
  ]
}
```

### 3. Operation Execution (Apply phase via MCP)

**Tool Call Processing**:
```javascript
// Proposals are previewed in the UI; user applies selected ops via MCP
POST /api/mcp/tools/call { name, arguments }
```

**Operation Processor Execution**:
```javascript
// OperationProcessor.processOperations()
const type = this.inferOperationType(op); // "todo_update"
const validator = this.validators.get(type);
const executor = this.executors.get(type);

// Validate operation
const validation = await validator(op);
if (!validation.valid) {
  results.push({ ok: false, op, error: validation.errors.join(', ') });
  continue;
}

// Execute operation
const result = await executor(op);
results.push({ ok: true, op, ...result });
```

### 4. Database Update

**Database Update**:
```sql
-- Update in SQLite (example)
UPDATE todos 
SET updated_at = '2024-01-15T10:30:00.000Z'
WHERE id = 1;
```

**Response**:
```javascript
{
  "content": {
    "ok": true,
    "todo": {
      "id": 1,
      "title": "Review project proposal",
      "scheduledFor": "2024-01-15",
      "updatedAt": "2024-01-15T10:30:00.000Z"
    }
  },
  "isError": false
}
```

### 5. Final UI Update

**Client Refresh**:
```dart
// _refreshAll() called after successful apply
await _refreshAll(); // Refreshes scheduled list

// UI shows updated task
```

## Expected System Behavior Summary

For the query "update my task for today":

1. **OpsAgent (tool-calling)**: Proposes validated operations
2. **Operation Processor (apply via MCP)**: Validate/execute selected operations
3. **Database**: Apply changes and record batch for undo
4. **Feedback**: Stream ops+summary; refresh UI after apply

**Key Safety Features**:
- Confidence thresholds prevent incorrect assumptions
- Tool calling ensures precise operation execution
- Validation ensures data integrity
- Transaction wrapping prevents partial updates
- Audit logging for transparency

**User Experience**:
- Real-time streaming feedback
- Clear operation preview
- Immediate UI updates after execution

## User Experience Flow

### 1. Input & Streaming
- **Entry Point**: `AssistantPanel` widget in Flutter Web
- **Input Method**: Text field with "Send" button
- **Streaming**: Real-time updates via Server-Sent Events (SSE)
- **Fallback**: Automatic fallback to POST if SSE fails

### 2. Conversation Management
- **Transcript**: Limited to last 3 turns for context
- **State**: Maintains conversation history in memory
- **Clarification**: Not implemented in current SSE flow (no `clarify` events emitted)

## Server-Side Pipeline

### 1. ConversationAgent (`runConversationAgent`)
```javascript
// Orchestrates the entire assistant flow
// Decision types: 'chat', 'act'
// Confidence thresholds: CONFIDENCE_THRESHOLD = 0.5
```
- **Location**: `apps/server/llm/conversation_agent.js`

**Input Context**:
- Current week snapshot (Mon-Sun)
- Backlog sample
- Last 3 conversation turns
- Prior clarification state

**Output**:
- `decision`: routing choice
- `confidence`: 0-1 confidence score
- `where`: context for action decisions

### 3. OpsAgent with Processor (`runOpsAgentToolCalling`)
**Tool Calling**:
- Native tool calling with Qwen model
- Tool surface defined with operation types
- Automatic tool call execution
- Error handling and repair
- **Location**: `apps/server/llm/ops_agent.js`

**Validation Checks**:
- Recurrence presence and shape
- Anchor dates for repeating items
- Time format validation
- ID existence checks
- Operation limits

**Repair Process**:
- Single repair attempt with error context
- Schema reminder injection
- Fallback to valid subset if repair fails

### 4. Operation Processor
**Operation Types**:
- `todo_create`, `todo_update`, `todo_delete`, `todo_set_status`
- `event_create`, `event_update`, `event_delete`
- **Location**: `apps/server/operations/operation_processor.js`

**Execution Flow**:
1. Infer operation type from kind/action
2. Validate operation using registered validators
3. Execute operation using registered executors
4. Return results with success/failure status

## Client-Side Implementation

### 1. API Integration (`api.dart`)
```dart
Future<Map<String, dynamic>> assistantMessage(
  String message, {
  List<Map<String, String>> transcript = const [],
  bool streamSummary = false,
  void Function(String text)? onSummary,
  void Function(String question, List<Map<String, dynamic>> options)? onClarify,
  void Function(String stage)? onStage,
  void Function(List<Map<String, dynamic>> operations, int version, int validCount, int invalidCount)? onOps,
})
```
- **Location**: `apps/web/flutter_app/lib/api.dart`

### 2. SSE Event Handling
**Event Types**:
- `stage`: Current processing stage
- `ops`: Proposed operations with validation results and previews
- `summary`: Final summary text
- `heartbeat`: Connection keep-alive
- `done`: Stream completion

### 3. UI Components (`assistant_panel.dart`)
**Key Features**:
- Real-time streaming updates
- Operation grouping by type (todo/event/goal)
- Validation error display
- Interactive clarification selection (planned)
- Operation diff view
- Apply/Discard controls
- **Location**: `apps/web/flutter_app/lib/widgets/assistant_panel.dart`

## Clarification System

### 1. Trigger Conditions
- Low confidence (< 0.5)
- Ambiguous time/date references
- Unclear target selection
- Missing context

### 2. Selection Options
**Structured Choices**:
- Item IDs with titles and dates
- Date quick-selects (today/unscheduled)

**Selection State**:
- `selectedClarifyIds`: Set of selected item IDs
- `selectedClarifyDate`: Date filter

### 3. Bias Injection
When clarification selection is provided:
- Routes to 'act' decision
- Seeds `where` context for tool calling
- Focuses on selected items/date

## Operation Execution

### 1. Apply Process (Operation Processor)
**Safety Checks**:
- Operation count limit (≤20)
- Idempotency key support
- Transaction wrapping
- Audit logging

**Execution Flow**:
1. Convert operations to tool calls
2. Validate each operation
3. Execute operations through processor
4. Log audit entries during execution
5. Return aggregated results

### 2. Dry-Run Support (Operation Validation)
- Preview without execution
- Operation schema validation
- No state changes
- No audit logging

## Error Handling & Resilience

### 1. Client-Side Fallbacks
- SSE → POST fallback on connection errors
- Graceful degradation for unsupported features
- Retry logic for transient failures

### 2. Server-Side Robustness
- JSON parsing with lenient fallbacks
- Qwen model compatibility
- Deterministic fallback summaries
- Comprehensive error logging

### 3. Validation Layers
- Schema validation
- Business rule enforcement
- Database constraint checking
- Idempotency protection

## Performance Considerations

### 1. Streaming Benefits
- Real-time feedback
- Progressive disclosure
- Connection efficiency
- User engagement

### 2. Context Optimization
- Limited transcript (last 3 turns)
- Focused snapshots
- Selective data loading
- Cached responses

### 3. LLM Efficiency
- Structured prompts
- JSON-first parsing
- Qwen compatibility
- Local model usage

## Security & Safety

### 1. Input Validation
- Message length limits
- JSON structure validation
- Operation count caps
- ID existence verification

### 2. Execution Safety
- Transaction isolation
- Audit trail
- Idempotency protection
- Error boundaries

### 3. Model Safety
- No bulk operations
- Recurrence enforcement
- Anchor date requirements
- Validation repair limits

## Integration Points

### 1. Database Schema
- `audit_log`: Operation tracking
- `idempotency`: Response caching
- Main tables: todos, events, habits, goals

### 2. External Dependencies
- Ollama local model (qwen3:30b)
- SSE implementation
- JSON parsing utilities

### 3. UI Integration
- Main app state management
- Real-time updates
- Navigation coordination