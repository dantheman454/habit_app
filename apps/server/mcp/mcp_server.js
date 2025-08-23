export class HabitusMCPServer {
  constructor(expressApp) {
    this.expressApp = expressApp;
    this.operationProcessor = null; // Will be set by setOperationProcessor
    this.tools = new Map();
    this.resources = new Map();
    
    this.setupDefaultTools();
    this.setupDefaultResources();
  }

  setOperationProcessor(processor) {
    this.operationProcessor = processor;
  }

  setupDefaultTools() {
    this.tools.set('create_todo', {
      name: 'create_todo',
      description: 'Create a new todo item',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          notes: { type: 'string' },
          scheduledFor: { type: 'string', format: 'date' },
          timeOfDay: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' },
          recurrence: { type: 'object' }
        },
        required: ['title', 'recurrence']
      }
    });

    this.tools.set('update_todo', {
      name: 'update_todo',
      description: 'Update an existing todo item',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          title: { type: 'string' },
          notes: { type: 'string' },
          scheduledFor: { type: 'string', format: 'date' },
          timeOfDay: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' },
          recurrence: { type: 'object' }
        },
        required: ['id']
      }
    });

    this.tools.set('delete_todo', {
      name: 'delete_todo',
      description: 'Delete a todo item',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer' }
        },
        required: ['id']
      }
    });

    this.tools.set('set_todo_status', {
      name: 'set_todo_status',
      description: 'Set the status of a todo item',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          status: { type: 'string', enum: ['pending', 'completed', 'skipped'] },
          occurrenceDate: { type: 'string', format: 'date' }
        },
        required: ['id', 'status']
      }
    });

    this.tools.set('complete_todo_occurrence', {
      name: 'complete_todo_occurrence',
      description: 'Mark a specific occurrence of a recurring todo as completed',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          occurrenceDate: { type: 'string', format: 'date' },
          completed: { type: 'boolean' }
        },
        required: ['id', 'occurrenceDate']
      }
    });

    // Event tools (minimal alignment)
    this.tools.set('create_event', {
      name: 'create_event',
      description: 'Create a new event',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          notes: { type: 'string' },
          scheduledFor: { type: 'string', format: 'date' },
          startTime: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' },
          endTime: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' },
          location: { type: 'string' },
          recurrence: { type: 'object' },
        },
        required: ['title']
      }
    });

    this.tools.set('update_event', {
      name: 'update_event',
      description: 'Update an existing event',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          title: { type: 'string' },
          notes: { type: 'string' },
          scheduledFor: { type: 'string', format: 'date' },
          startTime: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' },
          endTime: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' },
          location: { type: 'string' },
          recurrence: { type: 'object' },
        },
        required: ['id']
      }
    });

    this.tools.set('delete_event', {
      name: 'delete_event',
      description: 'Delete an event',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'integer' } },
        required: ['id']
      }
    });

    // Habit tools (minimal alignment)
    this.tools.set('create_habit', {
      name: 'create_habit',
      description: 'Create a new habit',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          notes: { type: 'string' },
          scheduledFor: { type: 'string', format: 'date' },
          timeOfDay: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' },
          recurrence: { type: 'object' }
        },
        required: ['title']
      }
    });

    this.tools.set('update_habit', {
      name: 'update_habit',
      description: 'Update a habit',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          title: { type: 'string' },
          notes: { type: 'string' },
          scheduledFor: { type: 'string', format: 'date' },
          timeOfDay: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' },
          recurrence: { type: 'object' }
        },
        required: ['id']
      }
    });

    this.tools.set('delete_habit', {
      name: 'delete_habit',
      description: 'Delete a habit',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'integer' } },
        required: ['id']
      }
    });

    this.tools.set('set_habit_occurrence_status', {
      name: 'set_habit_occurrence_status',
      description: 'Set the status of a specific occurrence of a recurring habit',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          occurrenceDate: { type: 'string', format: 'date' },
          status: { type: 'string', enum: ['pending', 'completed', 'skipped'] }
        },
        required: ['id', 'occurrenceDate', 'status']
      }
    });
  }

  setupDefaultResources() {
    this.resources.set('habitus://schemas/operations', {
      uri: 'habitus://schemas/operations',
      name: 'Operation Schemas',
      description: 'JSON schemas for all supported operations',
      mimeType: 'application/json'
    });

    this.resources.set('habitus://docs/operations', {
      uri: 'habitus://docs/operations',
      name: 'Operation Documentation',
      description: 'Documentation for all supported operations',
      mimeType: 'text/markdown'
    });
  }

  async listAvailableTools() {
    return Array.from(this.tools.values());
  }

  async listAvailableResources() {
    return Array.from(this.resources.values());
  }

  async handleToolCall(name, args) {
    if (!this.operationProcessor) {
      throw new Error('Operation processor not set');
    }

    // Convert MCP tool call to operation format
    const operation = this.convertToolCallToOperation(name, args);
    
    // Process through operation processor
    const result = await this.operationProcessor.processOperations([operation]);
    
    // For HTTP calls, return the result directly
    // For WebSocket calls, wrap in content structure
    return result;
  }

  convertToolCallToOperation(name, args) {
    // Suffix-aware mappings for better alignment with operation types
    const mSetStatus = name.match(/^set_(todo|event|habit)_status$/);
    if (mSetStatus) {
      return { kind: mSetStatus[1], action: 'set_status', ...args };
    }
    const mSetOccurrenceStatus = name.match(/^set_(todo|habit)_occurrence_status$/);
    if (mSetOccurrenceStatus) {
      return { kind: mSetOccurrenceStatus[1], action: 'set_occurrence_status', ...args };
    }
    const mCompleteOcc = name.match(/^complete_(todo|habit)_occurrence$/);
    if (mCompleteOcc) {
      return { kind: mCompleteOcc[1], action: 'complete_occurrence', ...args };
    }
    const mCrud = name.match(/^(create|update|delete)_(todo|event|habit)$/);
    if (mCrud) {
      return { kind: mCrud[2], action: mCrud[1], ...args };
    }
    // Fallback to naive first-two-tokens mapping
    const parts = String(name).split('_');
    const action = parts[0] || 'create';
    const kind = parts[1] || 'todo';
    return { kind, action, ...args };
  }

  async readResource(uri) {
    switch (uri) {
      case 'habitus://schemas/operations':
        return {
          contents: [
            {
              uri: uri,
              mimeType: 'application/json',
              text: JSON.stringify(await this.listAvailableTools(), null, 2)
            }
          ]
        };
      case 'habitus://docs/operations':
        return {
          contents: [
            {
              uri: uri,
              mimeType: 'text/markdown',
              text: `# Habitus Operations Documentation

This document describes all available operations in the Habitus system.

## Todo Operations

### create_todo
Creates a new todo item with the specified properties.

### update_todo
Updates an existing todo item by ID.

### delete_todo
Deletes a todo item by ID.

### set_todo_status
Sets the status of a todo item (pending, completed, skipped). For repeating todos, use occurrenceDate to set status for a specific occurrence.

### complete_todo_occurrence
Marks a specific occurrence of a recurring todo as completed.

## Event Operations

### create_event, update_event, delete_event
Manage calendar events with start/end times, location, and recurrence. Event completion is not supported.

## Habit Operations

### create_habit, update_habit, delete_habit
Manage habits with scheduling, time of day, and recurrence (must be repeating).

### set_habit_occurrence_status
Sets the status of a specific occurrence of a recurring habit (pending, completed, skipped).
`
            }
          ]
        };
      default:
        throw new Error(`Resource not found: ${uri}`);
    }
  }

  handleWebSocketConnection(ws) {
    // Handle WebSocket connection for MCP communication
    ws.on('message', async (message) => {
      try {
        const data = JSON.parse(message);
        let response;
        
        switch (data.method) {
          case 'tools/list':
            response = {
              jsonrpc: '2.0',
              id: data.id,
              result: {
                tools: await this.listAvailableTools()
              }
            };
            break;
          case 'tools/call':
            const result = await this.handleToolCall(data.params.name, data.params.arguments);
            response = {
              jsonrpc: '2.0',
              id: data.id,
              result: {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify(result, null, 2)
                  }
                ]
              }
            };
            break;
          case 'resources/list':
            response = {
              jsonrpc: '2.0',
              id: data.id,
              result: {
                resources: await this.listAvailableResources()
              }
            };
            break;
          case 'resources/read':
            const resource = await this.readResource(data.params.uri);
            response = {
              jsonrpc: '2.0',
              id: data.id,
              result: resource
            };
            break;
          default:
            response = {
              jsonrpc: '2.0',
              id: data.id,
              error: {
                code: -32601,
                message: 'Method not found'
              }
            };
        }
        
        ws.send(JSON.stringify(response));
      } catch (error) {
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32603,
            message: 'Internal error',
            data: error.message
          }
        }));
      }
    });
  }
}
