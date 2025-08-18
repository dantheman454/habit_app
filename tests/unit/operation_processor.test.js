import { describe, it, test, beforeEach } from 'node:test';
import assert from 'node:assert';
import { OperationProcessor } from '../../apps/server/operations/operation_processor.js';

describe('OperationProcessor', () => {
  let processor;

  beforeEach(() => {
    processor = new OperationProcessor();
  });

  test('should register operation types correctly', () => {
    const mockValidator = () => ({ valid: true });
    const mockExecutor = () => ({ result: 'success' });
    
    processor.registerOperationType('todo_create', {
      validator: mockValidator,
      executor: mockExecutor
    });
    
    assert.strictEqual(processor.validators.get('todo_create'), mockValidator);
    assert.strictEqual(processor.executors.get('todo_create'), mockExecutor);
    assert(processor.listOperationTypes().includes('todo_create'));
  });

  test('should infer operation type from kind and action', () => {
    const op = { kind: 'todo', action: 'create', title: 'Test' };
    const type = processor.inferOperationType(op);
    assert.strictEqual(type, 'todo_create');
  });

  test('should infer operation type from op field', () => {
    const op = { op: 'create', title: 'Test' };
    const type = processor.inferOperationType(op);
    assert.strictEqual(type, 'create');
  });

  test('should return unknown for unrecognized operations', () => {
    const op = { title: 'Test' };
    const type = processor.inferOperationType(op);
    assert.strictEqual(type, 'unknown');
  });

  test('should process valid operations successfully', async () => {
    const mockValidator = () => ({ valid: true });
    const mockExecutor = () => ({ todo: {}, created: true });
    
    processor.registerOperationType('todo_create', {
      validator: mockValidator,
      executor: mockExecutor
    });
    
    const operations = [{ kind: 'todo', action: 'create', title: 'Test' }];
    const result = await processor.processOperations(operations);
    
    assert.strictEqual(result.results.length, 1);
    assert.strictEqual(result.results[0].ok, true);
    assert.strictEqual(result.summary.created, 1);
    assert(result.correlationId);
  });

  test('should handle validation failures', async () => {
    const mockValidator = () => ({ valid: false, errors: ['invalid_title'] });
    const mockExecutor = () => ({ todo: {}, created: true });
    
    processor.registerOperationType('todo_create', {
      validator: mockValidator,
      executor: mockExecutor
    });
    
    const operations = [{ kind: 'todo', action: 'create', title: '' }];
    const result = await processor.processOperations(operations);
    
    assert.strictEqual(result.results.length, 1);
    assert.strictEqual(result.results[0].ok, false);
    assert.strictEqual(result.results[0].error, 'invalid_title');
    assert.strictEqual(result.summary.created, 0);
  });

  test('should handle unknown operation types', async () => {
    const operations = [{ kind: 'unknown', action: 'create' }];
    const result = await processor.processOperations(operations);
    
    assert.strictEqual(result.results.length, 1);
    assert.strictEqual(result.results[0].ok, false);
    assert.strictEqual(result.results[0].error, 'unknown_operation_type');
  });

  test('should handle executor errors', async () => {
    const mockValidator = () => ({ valid: true });
    const mockExecutor = () => { throw new Error('database_error'); };
    
    processor.registerOperationType('todo_create', {
      validator: mockValidator,
      executor: mockExecutor
    });
    
    const operations = [{ kind: 'todo', action: 'create', title: 'Test' }];
    const result = await processor.processOperations(operations);
    
    assert.strictEqual(result.results.length, 1);
    assert.strictEqual(result.results[0].ok, false);
    assert.strictEqual(result.results[0].error, 'Error: database_error');
  });

  test('should update summary correctly', async () => {
    const mockValidator = () => ({ valid: true });
    const createExecutor = () => ({ todo: {}, created: true });
    const updateExecutor = () => ({ todo: {}, updated: true });
    const deleteExecutor = () => ({ deleted: true });
    const completeExecutor = () => ({ todo: {}, completed: true });
    
    processor.registerOperationType('todo_create', {
      validator: mockValidator,
      executor: createExecutor
    });
    processor.registerOperationType('todo_update', {
      validator: mockValidator,
      executor: updateExecutor
    });
    processor.registerOperationType('todo_delete', {
      validator: mockValidator,
      executor: deleteExecutor
    });
    processor.registerOperationType('todo_complete', {
      validator: mockValidator,
      executor: completeExecutor
    });
    
    const operations = [
      { kind: 'todo', action: 'create', title: 'Test 1' },
      { kind: 'todo', action: 'update', id: 1, title: 'Test 2' },
      { kind: 'todo', action: 'delete', id: 1 },
      { kind: 'todo', action: 'complete', id: 2 }
    ];
    
    const result = await processor.processOperations(operations);
    
    assert.strictEqual(result.summary.created, 1);
    assert.strictEqual(result.summary.updated, 1);
    assert.strictEqual(result.summary.deleted, 1);
    assert.strictEqual(result.summary.completed, 1);
  });

  test('should be healthy when operation types are registered', () => {
    assert.strictEqual(processor.isHealthy(), false);
    
    processor.registerOperationType('todo_create', {
      validator: () => ({ valid: true }),
      executor: () => ({ created: true })
    });
    
    assert.strictEqual(processor.isHealthy(), true);
  });

  test('should list registered operation types', () => {
    processor.registerOperationType('todo_create', {
      validator: () => ({ valid: true }),
      executor: () => ({ created: true })
    });
    processor.registerOperationType('todo_update', {
      validator: () => ({ valid: true }),
      executor: () => ({ updated: true })
    });
    
    const types = processor.listOperationTypes();
    assert(types.includes('todo_create'));
    assert(types.includes('todo_update'));
    assert.strictEqual(types.length, 2);
  });
});
