import db from '../database/DbService.js';
import { OperationRegistry } from '../operations/operation_registry.js';

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
    const registry = new OperationRegistry(db);
    const addContextIfApplicable = (opType, schema) => {
      try {
        const needsContext = /^(task|event)_(create|update)$/.test(opType);
        const clone = schema ? JSON.parse(JSON.stringify(schema)) : { type: 'object', properties: {} };
        if (needsContext) {
          clone.properties = clone.properties || {};
          if (!clone.properties.context) {
            clone.properties.context = { type: 'string', enum: ['school','personal','work'] };
          }
        }
        return clone;
      } catch {
        return schema;
      }
    };

    const defineTool = (name, description, opType) => {
      const base = registry.getOperationSchema(opType) || { type: 'object', additionalProperties: true };
      const inputSchema = addContextIfApplicable(opType, base);
      this.tools.set(name, { name, description, inputSchema });
    };

    defineTool('create_task', 'Create a new task item', 'task_create');
    defineTool('update_task', 'Update an existing task item', 'task_update');
    defineTool('delete_task', 'Delete a task item', 'task_delete');
    defineTool('set_task_status', 'Set the status of a task item', 'task_set_status');

    // Event tools
    defineTool('create_event', 'Create a new event', 'event_create');
    defineTool('update_event', 'Update an existing event', 'event_update');
    defineTool('delete_event', 'Delete an event', 'event_delete');

    // Habit tools removed during migration (tasks/events only)
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
    const mSetStatus = name.match(/^set_(task|event)_status$/);
    if (mSetStatus) {
      return { kind: mSetStatus[1], action: 'set_status', ...args };
    }
    const mCrud = name.match(/^(create|update|delete)_(task|event)$/);
    if (mCrud) {
      return { kind: mCrud[2], action: mCrud[1], ...args };
    }
    // Fallback to naive first-two-tokens mapping
    const parts = String(name).split('_');
    const action = parts[0] || 'create';
    const kind = parts[1] || 'task';
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

## Task Operations

### create_task
Create a new task item with the specified properties.

### update_task
Update an existing task item by ID.

### delete_task
Delete a task item by ID.

### set_task_status
Set the status of a task item (pending, completed, skipped). For repeating tasks, use occurrenceDate to set status for a specific occurrence.

## Event Operations

### create_event, update_event, delete_event
Manage calendar events with start/end times, location, and recurrence. Event completion is not supported.
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
