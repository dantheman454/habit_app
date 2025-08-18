import { describe, it, test, beforeEach } from 'node:test';
import assert from 'node:assert';
import { HabitusMCPServer } from '../../apps/server/mcp/mcp_server.js';

describe('HabitusMCPServer', () => {
  let mcpServer;
  let mockExpressApp;

  beforeEach(() => {
    mockExpressApp = {};
    mcpServer = new HabitusMCPServer(mockExpressApp);
  });

  test('should initialize with tools and resources', () => {
    assert(mcpServer.tools instanceof Map);
    assert(mcpServer.resources instanceof Map);
    assert(mcpServer.operationProcessor === null);
  });

  test('should list available tools', async () => {
    const tools = await mcpServer.listAvailableTools();
    
    assert(Array.isArray(tools));
    assert(tools.length > 0);
    
    // Check for expected todo tools
    const toolNames = tools.map(t => t.name);
    assert(toolNames.includes('create_todo'));
    assert(toolNames.includes('update_todo'));
    assert(toolNames.includes('delete_todo'));
    assert(toolNames.includes('set_todo_status'));
    assert(toolNames.includes('complete_todo'));
    assert(toolNames.includes('complete_todo_occurrence'));
  });

  test('should convert tool call to operation format', () => {
    const toolCall = {
      title: 'Test Todo',
      notes: 'Test notes',
      recurrence: { type: 'none' }
    };
    
    const operation = mcpServer.convertToolCallToOperation('create_todo', toolCall);
    
    assert.strictEqual(operation.kind, 'todo');
    assert.strictEqual(operation.action, 'create');
    assert.strictEqual(operation.title, 'Test Todo');
    assert.strictEqual(operation.notes, 'Test notes');
    assert.deepStrictEqual(operation.recurrence, { type: 'none' });
  });

  test('should list available resources', async () => {
    const resources = await mcpServer.listAvailableResources();
    
    assert(Array.isArray(resources));
    assert(resources.length > 0);
    
    const resourceUris = resources.map(r => r.uri);
    assert(resourceUris.includes('habitus://schemas/operations'));
    assert(resourceUris.includes('habitus://docs/operations'));
  });

  test('should read operation schemas resource', async () => {
    const result = await mcpServer.readResource('habitus://schemas/operations');
    
    assert(result.contents);
    assert(result.contents.length === 1);
    assert.strictEqual(result.contents[0].mimeType, 'application/json');
    
    const schemas = JSON.parse(result.contents[0].text);
    assert(Array.isArray(schemas));
  });

  test('should read operation documentation resource', async () => {
    const result = await mcpServer.readResource('habitus://docs/operations');
    
    assert(result.contents);
    assert(result.contents.length === 1);
    assert.strictEqual(result.contents[0].mimeType, 'text/markdown');
    assert(result.contents[0].text.includes('# Habitus Operations Documentation'));
  });

  test('should throw error for unknown resource', async () => {
    await assert.rejects(
      async () => {
        await mcpServer.readResource('habitus://unknown/resource');
      },
      /Resource not found/
    );
  });

  test('should handle tool call with operation processor', async () => {
    const mockProcessor = {
      processOperations: async (operations) => {
        return {
          results: [{ ok: true, op: operations[0] }],
          summary: { created: 1, updated: 0, deleted: 0, completed: 0 }
        };
      }
    };
    
    mcpServer.setOperationProcessor(mockProcessor);
    
    const result = await mcpServer.handleToolCall('create_todo', {
      title: 'Test',
      recurrence: { type: 'none' }
    });
    
    assert(result.content);
    assert(result.content.length === 1);
    assert.strictEqual(result.content[0].type, 'text');
    
    const parsed = JSON.parse(result.content[0].text);
    assert(parsed.results);
    assert(parsed.summary);
  });

  test('should throw error when operation processor not set', async () => {
    await assert.rejects(
      async () => {
        await mcpServer.handleToolCall('create_todo', { title: 'Test' });
      },
      /Operation processor not set/
    );
  });
});
