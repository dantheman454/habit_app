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
    parameters: { type: 'object', additionalProperties: true }
  }
}));
```

## Operation Execution (Apply phase via MCP)

**Tool Call Processing**:
```javascript
// Proposals are previewed in the UI; user applies selected ops via MCP
POST /api/mcp/tools/call { name, arguments }
```

**Operation Processor Execution**:
```javascript
const type = this.inferOperationType(op); // "task_update"
const validator = this.validators.get(type);
const executor = this.executors.get(type);
```

## Database Update

Example shown in server tests; updates written to SQLite tables `tasks` / `events` and logged in `audit_log`.

## Expected System Behavior Summary
- OpsAgent proposes validated operations
- Operation Processor validates/executes
- DB applies changes and records batches
- Client refreshes UI after apply

## Client-Side Implementation
- API integration in `apps/web/flutter_app/lib/api.dart`
- SSE handling and updates in `assistant_panel.dart`

## Server-Side Pipeline
- OpsAgent tool-calling in `apps/server/llm/ops_agent.js`
- MCP server tools in `apps/server/mcp/mcp_server.js`
- Operation processing in `apps/server/operations/*`

## Integration Points
- Database schema: `apps/server/database/schema.sql`
- Idempotency/audit tables used for robustness