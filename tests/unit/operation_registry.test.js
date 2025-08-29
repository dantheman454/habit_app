import { describe, it, test, beforeEach } from 'node:test';
import assert from 'node:assert';
import { OperationRegistry } from '../../apps/server/operations/operation_registry.js';
import { OperationProcessor } from '../../apps/server/operations/operation_processor.js';

describe('OperationRegistry', () => {
  let registry;
  let processor;
  let mockDbService;

  beforeEach(() => {
    mockDbService = {
      tasks: {},
      events: {},
      habits: {}
    };
    registry = new OperationRegistry(mockDbService);
    processor = new OperationProcessor();
  });

  test('should register all operation types', () => {
    registry.registerAllOperations(processor);
    
    const registeredTypes = processor.listOperationTypes();
    const expectedTypes = registry.getRegisteredOperationTypes();
    
    assert.strictEqual(registeredTypes.length, expectedTypes.length);
    expectedTypes.forEach(type => {
      assert(registeredTypes.includes(type), `Missing operation type: ${type}`);
    });
  });

  test('should provide operation schemas', () => {
    const taskCreateSchema = registry.getOperationSchema('task_create');
    
    assert(taskCreateSchema);
    assert.strictEqual(taskCreateSchema.type, 'object');
    assert(taskCreateSchema.properties.title);
    assert.strictEqual(taskCreateSchema.properties.title.type, 'string');
    assert(taskCreateSchema.required.includes('title'));
  });

  test('should provide operation documentation', () => {
    const taskCreateDoc = registry.getOperationDocumentation('task_create');
    
    assert(taskCreateDoc);
    assert.strictEqual(taskCreateDoc.description, 'Create a new task item');
    assert(Array.isArray(taskCreateDoc.examples));
    assert(taskCreateDoc.examples.length > 0);
  });

  test('should return null for unknown operation types', () => {
    const unknownSchema = registry.getOperationSchema('unknown_operation');
    const unknownDoc = registry.getOperationDocumentation('unknown_operation');
    
    assert.strictEqual(unknownSchema, null);
    assert.strictEqual(unknownDoc, null);
  });

  test('should provide schemas for all operation types', () => {
    const operationTypes = registry.getRegisteredOperationTypes();
    
    operationTypes.forEach(type => {
      const schema = registry.getOperationSchema(type);
      assert(schema, `Missing schema for operation type: ${type}`);
      assert.strictEqual(schema.type, 'object');
      assert(schema.properties);
    });
  });

  test('should provide documentation for all operation types', () => {
    const operationTypes = registry.getRegisteredOperationTypes();
    
    operationTypes.forEach(type => {
      const doc = registry.getOperationDocumentation(type);
      assert(doc, `Missing documentation for operation type: ${type}`);
      assert(doc.description);
      assert(Array.isArray(doc.examples));
    });
  });

  test('should have valid JSON schemas', () => {
    const operationTypes = registry.getRegisteredOperationTypes();
    
    operationTypes.forEach(type => {
      const schema = registry.getOperationSchema(type);
      
      // Check basic schema structure
      assert(schema.type === 'object');
      assert(schema.properties);
      assert(Array.isArray(schema.required));
      
      // Check that all required properties exist in properties
      schema.required.forEach(prop => {
        assert(schema.properties[prop], `Required property ${prop} missing from properties in ${type}`);
      });
    });
  });

  test('should have consistent operation examples', () => {
    const operationTypes = registry.getRegisteredOperationTypes();
    
    operationTypes.forEach(type => {
      const doc = registry.getOperationDocumentation(type);
      
      doc.examples.forEach(example => {
        assert(example.description);
        assert(example.operation);
        assert(example.operation.kind);
        assert(example.operation.action);
      });
    });
  });
});
