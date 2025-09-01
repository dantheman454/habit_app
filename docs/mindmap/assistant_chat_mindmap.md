# Assistant Chat System Mind Map

This document provides a comprehensive overview of how the assistant chat works in the task/event application, from user input through execution and feedback.

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
  onStage: (st) => { /* Update progress */ },
  onOps: (ops, version, validCount, invalidCount, previews) => { /* Show operations */ },
  onThinking: (thinking) => { /* Show thinking process */ },
  onTraceId: (correlationId) => { /* Track correlation ID */ }
);
```

**SSE Events**: Server emits `stage`, `ops`, `summary`, `heartbeat`, and `done` events. The `ops` event includes `previews` for operation previews.

### 2. OpsAgent Proposal (Tool-Calling)

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

### Tool Calling Generation (with focused context)
```javascript
const operationTools = [
  'task.create','task.update','task.delete','task.set_status',
  'event.create','event.update','event.delete'
].map((name) => ({
  type: 'function',
  function: {
    name,
    description: `Execute operation ${name}`,
    parameters: schema // JSON Schema from OperationRegistry
  }
}));
```

**Note**: OpsAgent uses `task.create` format for LLM tool calling, while MCP server uses `create_task` format. The OpsAgent converts tool calls to operations internally.

### 3. Operation Validation and Fallback

**Validation Process**:
```javascript
// Each tool call is validated using OperationProcessor
const type = operationProcessor.inferOperationType(op);
const validator = operationProcessor.validators.get(type);
const validation = validator ? await validator(op) : { valid: false, errors: ['unknown_operation_type'] };
```

**Fallback Logic**: If no operations are proposed but intent is actionable, the system attempts to infer operations using:
- Focused context candidates
- Explicit where.id
- Title matching using indexes
- Time extraction from instruction

### 4. Operation Execution (Apply phase via MCP)

**Tool Call Processing**:
```javascript
// Proposals are previewed in the UI; user applies selected ops via MCP
POST /api/mcp/tools/call { name, arguments }
// Note: MCP server uses create_task, update_task format, not task.create format
```

**Operation Processor Execution**:
```javascript
const type = this.inferOperationType(op); // "task_update"
const validator = this.validators.get(type);
const executor = this.executors.get(type);
```

### 5. Database Update and Audit

**Batch Recording**: Each operation is recorded with before/after state for undo capability:
```javascript
await batchRecorder.recordOp({
  batchId,
  seq: Date.now(),
  op,
  before,
  after
});
```

**Audit Trail**: All operations are logged in `audit_log` table for transparency.

## Expected System Behavior Summary
- OpsAgent proposes validated operations with fallback inference
- Operation Processor validates/executes with full audit trail
- DB applies changes and records batches for undo
- Client refreshes UI after apply with correlation tracking

## Client-Side Implementation
- API integration in `apps/web/flutter_app/lib/api.dart`
- SSE handling and updates in `assistant_panel.dart`
- Support for thinking display and correlation ID tracking

## Server-Side Pipeline
- OpsAgent tool-calling in `apps/server/llm/ops_agent.js`
- MCP server tools in `apps/server/mcp/mcp_server.js`
- Operation processing in `apps/server/operations/*`
- Batch recording in `apps/server/utils/batch_recorder.js`

## Integration Points
- Database schema: `apps/server/database/schema.sql`
- Idempotency/audit tables used for robustness
- Correlation ID tracking throughout the pipeline
