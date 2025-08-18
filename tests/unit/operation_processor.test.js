import { test, describe } from 'node:test';
import assert from 'node:assert';
import { OperationProcessor } from '../../apps/server/operations/operation_processor.js';

// Mock database service
class MockDbService {
  constructor() {
    this.transactionCalls = 0;
    this.shouldFail = false;
  }
  
  runInTransaction(fn) {
    this.transactionCalls++;
    if (this.shouldFail) {
      throw new Error('Transaction failed');
    }
    return fn();
  }
}

describe('OperationProcessor', () => {
  test('should register operation types correctly', async () => {
    const processor = new OperationProcessor();
    const mockValidator = (op) => ({ valid: true, errors: [] });
    const mockExecutor = (op) => ({ created: true });
    
    processor.registerOperationType('test_create', {
      validator: mockValidator,
      executor: mockExecutor
    });
    
    assert.strictEqual(processor.listOperationTypes().length, 1);
    assert.strictEqual(processor.listOperationTypes()[0], 'test_create');
  });

  test('should infer operation type from kind and action', async () => {
    const processor = new OperationProcessor();
    const op = { kind: 'todo', action: 'create' };
    const type = processor.inferOperationType(op);
    assert.strictEqual(type, 'todo_create');
  });

  test('should infer operation type from op field', async () => {
    const processor = new OperationProcessor();
    const op = { op: 'custom_operation' };
    const type = processor.inferOperationType(op);
    assert.strictEqual(type, 'custom_operation');
  });

  test('should return unknown for unrecognized operations', async () => {
    const processor = new OperationProcessor();
    const op = {};
    const type = processor.inferOperationType(op);
    assert.strictEqual(type, 'unknown');
  });

  test('should process valid operations successfully', async () => {
    const processor = new OperationProcessor();
    const mockValidator = (op) => ({ valid: true, errors: [] });
    const mockExecutor = (op) => ({ created: true });
    
    processor.registerOperationType('todo_create', {
      validator: mockValidator,
      executor: mockExecutor
    });
    
    const operations = [{ kind: 'todo', action: 'create', title: 'Test' }];
    const result = await processor.processOperations(operations);
    
    assert.strictEqual(result.results.length, 1);
    assert.strictEqual(result.results[0].ok, true);
    assert.strictEqual(result.summary.created, 1);
  });

  test('should handle validation failures', async () => {
    const processor = new OperationProcessor();
    const mockValidator = (op) => ({ valid: false, errors: ['Invalid operation'] });
    const mockExecutor = (op) => ({ created: true });
    
    processor.registerOperationType('todo_create', {
      validator: mockValidator,
      executor: mockExecutor
    });
    
    const operations = [{ kind: 'todo', action: 'create' }];
    const result = await processor.processOperations(operations);
    
    assert.strictEqual(result.results.length, 1);
    assert.strictEqual(result.results[0].ok, false);
    assert.strictEqual(result.results[0].error, 'Invalid operation');
  });

  test('should handle unknown operation types', async () => {
    const processor = new OperationProcessor();
    const operations = [{ kind: 'unknown', action: 'create' }];
    const result = await processor.processOperations(operations);
    
    assert.strictEqual(result.results.length, 1);
    assert.strictEqual(result.results[0].ok, false);
    assert.strictEqual(result.results[0].error, 'unknown_operation_type');
  });

  test('should handle executor errors', async () => {
    const processor = new OperationProcessor();
    const mockValidator = (op) => ({ valid: true, errors: [] });
    const mockExecutor = (op) => { throw new Error('Executor failed'); };
    
    processor.registerOperationType('todo_create', {
      validator: mockValidator,
      executor: mockExecutor
    });
    
    const operations = [{ kind: 'todo', action: 'create', title: 'Test' }];
    const result = await processor.processOperations(operations);
    
    assert.strictEqual(result.results.length, 1);
    assert.strictEqual(result.results[0].ok, false);
    assert.strictEqual(result.results[0].error, 'Error: Executor failed');
  });

  test('should update summary correctly', async () => {
    const processor = new OperationProcessor();
    const mockValidator = (op) => ({ valid: true, errors: [] });
    const mockExecutor = (op) => {
      if (op.action === 'create') return { created: true };
      if (op.action === 'update') return { updated: true };
      if (op.action === 'delete') return { deleted: true };
      return { completed: true };
    };
    
    processor.registerOperationType('todo_create', {
      validator: mockValidator,
      executor: mockExecutor
    });
    processor.registerOperationType('todo_update', {
      validator: mockValidator,
      executor: mockExecutor
    });
    processor.registerOperationType('todo_delete', {
      validator: mockValidator,
      executor: mockExecutor
    });
    processor.registerOperationType('todo_complete', {
      validator: mockValidator,
      executor: mockExecutor
    });
    
    const operations = [
      { kind: 'todo', action: 'create', title: 'Test 1' },
      { kind: 'todo', action: 'update', id: 1, title: 'Test 2' },
      { kind: 'todo', action: 'delete', id: 1 },
      { kind: 'todo', action: 'complete', id: 1 }
    ];
    const result = await processor.processOperations(operations);
    
    assert.strictEqual(result.summary.created, 1);
    assert.strictEqual(result.summary.updated, 1);
    assert.strictEqual(result.summary.deleted, 1);
    assert.strictEqual(result.summary.completed, 1);
  });

  test('should be healthy when operation types are registered', async () => {
    const processor = new OperationProcessor();
    assert.strictEqual(processor.isHealthy(), false);
    
    processor.registerOperationType('test', {
      validator: (op) => ({ valid: true, errors: [] }),
      executor: (op) => ({ created: true })
    });
    
    assert.strictEqual(processor.isHealthy(), true);
  });

  test('should list registered operation types', async () => {
    const processor = new OperationProcessor();
    processor.registerOperationType('todo_create', {
      validator: (op) => ({ valid: true, errors: [] }),
      executor: (op) => ({ created: true })
    });
    processor.registerOperationType('todo_update', {
      validator: (op) => ({ valid: true, errors: [] }),
      executor: (op) => ({ updated: true })
    });
    
    const types = processor.listOperationTypes();
    assert.strictEqual(types.length, 2);
    assert(types.includes('todo_create'));
    assert(types.includes('todo_update'));
  });

  test('should use transactions for multiple operations when database service is available', async () => {
    const processor = new OperationProcessor();
    const mockDb = new MockDbService();
    processor.setDbService(mockDb);
    
    const mockValidator = (op) => ({ valid: true, errors: [] });
    const mockExecutor = (op) => ({ created: true });
    
    processor.registerOperationType('todo_create', {
      validator: mockValidator,
      executor: mockExecutor
    });
    
    const operations = [
      { kind: 'todo', action: 'create', title: 'Test 1' },
      { kind: 'todo', action: 'create', title: 'Test 2' }
    ];
    
    const result = await processor.processOperations(operations);
    
    // Should have called runInTransaction once
    assert.strictEqual(mockDb.transactionCalls, 1);
    assert.strictEqual(result.results.length, 2);
    assert.strictEqual(result.results[0].ok, true);
    assert.strictEqual(result.results[1].ok, true);
  });

  test('should not use transactions for single operations', async () => {
    const processor = new OperationProcessor();
    const mockDb = new MockDbService();
    processor.setDbService(mockDb);
    
    const mockValidator = (op) => ({ valid: true, errors: [] });
    const mockExecutor = (op) => ({ created: true });
    
    processor.registerOperationType('todo_create', {
      validator: mockValidator,
      executor: mockExecutor
    });
    
    const operations = [{ kind: 'todo', action: 'create', title: 'Test' }];
    
    const result = await processor.processOperations(operations);
    
    // Should not have called runInTransaction
    assert.strictEqual(mockDb.transactionCalls, 0);
    assert.strictEqual(result.results.length, 1);
    assert.strictEqual(result.results[0].ok, true);
  });

  test('should handle transaction failures gracefully', async () => {
    const processor = new OperationProcessor();
    const mockDb = new MockDbService();
    mockDb.shouldFail = true;
    processor.setDbService(mockDb);
    
    const mockValidator = (op) => ({ valid: true, errors: [] });
    const mockExecutor = (op) => ({ created: true });
    
    processor.registerOperationType('todo_create', {
      validator: mockValidator,
      executor: mockExecutor
    });
    
    const operations = [
      { kind: 'todo', action: 'create', title: 'Test 1' },
      { kind: 'todo', action: 'create', title: 'Test 2' }
    ];
    
    const result = await processor.processOperations(operations);
    
    // Should have called runInTransaction once
    assert.strictEqual(mockDb.transactionCalls, 1);
    assert.strictEqual(result.results.length, 1);
    assert.strictEqual(result.results[0].ok, false);
    assert(result.results[0].error.includes('Transaction failed'));
  });
});
