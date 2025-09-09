import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BatchRecorder } from '../../apps/server/utils/batch_recorder.js';
import { DbService } from '../../apps/server/database/DbService.js';

const ROOT = path.resolve(path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..'));
const SCHEMA_PATH = path.join(ROOT, 'apps', 'server', 'database', 'schema.sql');

describe('BatchRecorder', () => {
  /** @type {DbService} */
  let testDb;
  /** @type {BatchRecorder} */
  let batchRecorder;

  before(() => {
    testDb = new DbService(':memory:');
    const sql = readFileSync(SCHEMA_PATH, 'utf8');
    testDb.bootstrapSchema(sql);
    
    // Create a new BatchRecorder instance with the test database
    batchRecorder = new BatchRecorder();
    batchRecorder.dbService = testDb;
  });

  after(() => {
    // DbService handles cleanup automatically
  });

  describe('ensureBatch', () => {
    test('should create new batch with unique correlation ID', async () => {
      const correlationId = 'test-batch-1';
      const batchId = await batchRecorder.ensureBatch(correlationId);
      
      assert.ok(typeof batchId === 'number');
      assert.ok(batchId > 0);
    });

    test('should return existing batch ID for duplicate correlation ID', async () => {
      const correlationId = 'test-batch-duplicate';
      
      const batchId1 = await batchRecorder.ensureBatch(correlationId);
      const batchId2 = await batchRecorder.ensureBatch(correlationId);
      
      assert.equal(batchId1, batchId2);
    });

    test('should create different batch IDs for different correlation IDs', async () => {
      const batchId1 = await batchRecorder.ensureBatch('test-batch-a');
      const batchId2 = await batchRecorder.ensureBatch('test-batch-b');
      
      assert.notEqual(batchId1, batchId2);
    });
  });

  describe('recordOp', () => {
    test('should record operation successfully', async () => {
      const correlationId = 'test-record-op';
      const batchId = await batchRecorder.ensureBatch(correlationId);
      
      const op = {
        kind: 'task',
        action: 'create',
        title: 'Test Task'
      };
      
      const before = null;
      const after = { id: 1, title: 'Test Task', status: 'pending' };
      
      const result = await batchRecorder.recordOp({
        batchId,
        seq: 1,
        op,
        before,
        after
      });
      
      assert.ok(result.changes > 0);
    });

    test('should handle operations without before/after states', async () => {
      const correlationId = 'test-minimal-op';
      const batchId = await batchRecorder.ensureBatch(correlationId);
      
      const op = {
        kind: 'task',
        action: 'delete',
        id: 999
      };
      
      const result = await batchRecorder.recordOp({
        batchId,
        seq: 1,
        op,
        before: null,
        after: null
      });
      
      assert.ok(result.changes > 0);
    });

    test('should record multiple operations in sequence', async () => {
      const correlationId = 'test-multiple-ops';
      const batchId = await batchRecorder.ensureBatch(correlationId);
      
      const ops = [
        { kind: 'task', action: 'create', title: 'Task 1' },
        { kind: 'task', action: 'create', title: 'Task 2' },
        { kind: 'task', action: 'update', id: 1, completed: true }
      ];
      
      for (let i = 0; i < ops.length; i++) {
        const result = await batchRecorder.recordOp({
          batchId,
          seq: i + 1,
          op: ops[i],
          before: null,
          after: { ...ops[i], id: i + 1 }
        });
        assert.ok(result.changes > 0);
      }
    });

    test('should handle operations with unknown kind/action', async () => {
      const correlationId = 'test-unknown-op';
      const batchId = await batchRecorder.ensureBatch(correlationId);
      
      const op = {}; // No kind or action
      
      const result = await batchRecorder.recordOp({
        batchId,
        seq: 1,
        op,
        before: null,
        after: null
      });
      
      assert.ok(result.changes > 0);
    });
  });

  describe('getLastBatch', () => {
    test('should return null when no batches exist', async () => {
      // Clear any existing data first
      testDb.db.exec('DELETE FROM op_batches');
      
      const result = await batchRecorder.getLastBatch();
      assert.equal(result, null);
    });

    test('should return the most recent batch with operations', async () => {
      const correlationId = 'test-get-last';
      const batchId = await batchRecorder.ensureBatch(correlationId);
      
      const ops = [
        { kind: 'task', action: 'create', title: 'Task A' },
        { kind: 'event', action: 'create', title: 'Event B' }
      ];
      
      for (let i = 0; i < ops.length; i++) {
        await batchRecorder.recordOp({
          batchId,
          seq: i + 1,
          op: ops[i],
          before: null,
          after: { ...ops[i], id: i + 1 }
        });
      }
      
      const result = await batchRecorder.getLastBatch();
      
      assert.ok(result);
      assert.equal(result.correlationId, correlationId);
      assert.equal(result.batchId, batchId);
      assert.ok(typeof result.ts === 'string');
      assert.equal(result.ops.length, 2);
      
      // Check first operation
      assert.equal(result.ops[0].seq, 1);
      assert.equal(result.ops[0].kind, 'task');
      assert.equal(result.ops[0].action, 'create');
      assert.equal(result.ops[0].op.title, 'Task A');
      assert.equal(result.ops[0].before, null);
      assert.equal(result.ops[0].after.title, 'Task A');
      
      // Check second operation
      assert.equal(result.ops[1].seq, 2);
      assert.equal(result.ops[1].kind, 'event');
      assert.equal(result.ops[1].action, 'create');
      assert.equal(result.ops[1].op.title, 'Event B');
    });

    test('should return most recent batch when multiple exist', async () => {
      // Create first batch
      const firstBatchId = await batchRecorder.ensureBatch('first-batch');
      await batchRecorder.recordOp({
        batchId: firstBatchId,
        seq: 1,
        op: { kind: 'task', action: 'create', title: 'First' },
        before: null,
        after: null
      });
      
      // Wait a bit to ensure different timestamps
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Create second batch
      const secondBatchId = await batchRecorder.ensureBatch('second-batch');
      await batchRecorder.recordOp({
        batchId: secondBatchId,
        seq: 1,
        op: { kind: 'task', action: 'create', title: 'Second' },
        before: null,
        after: null
      });
      
      const result = await batchRecorder.getLastBatch();
      
      assert.ok(result);
      assert.equal(result.correlationId, 'second-batch');
      assert.equal(result.batchId, secondBatchId);
      assert.equal(result.ops[0].op.title, 'Second');
    });
  });

  describe('clearBatch', () => {
    test('should delete batch and its operations', async () => {
      const correlationId = 'test-clear-batch';
      const batchId = await batchRecorder.ensureBatch(correlationId);
      
      await batchRecorder.recordOp({
        batchId,
        seq: 1,
        op: { kind: 'task', action: 'create', title: 'To be deleted' },
        before: null,
        after: null
      });
      
      // Verify batch exists
      const batchStmt = testDb.db.prepare('SELECT COUNT(*) as count FROM op_batches WHERE correlation_id = ?');
      const opsStmt = testDb.db.prepare('SELECT COUNT(*) as count FROM op_batch_ops WHERE batch_id = ?');
      
      assert.equal(batchStmt.get(correlationId).count, 1);
      assert.equal(opsStmt.get(batchId).count, 1);
      
      // Clear the batch
      const result = await batchRecorder.clearBatch(correlationId);
      assert.ok(result.changes > 0);
      
      // Verify batch is deleted (operations are cascade deleted)
      assert.equal(batchStmt.get(correlationId).count, 0);
      assert.equal(opsStmt.get(batchId).count, 0);
    });

    test('should handle clearing non-existent batch', async () => {
      const result = await batchRecorder.clearBatch('non-existent-batch');
      assert.equal(result.changes, 0);
    });
  });

  describe('integration scenarios', () => {
    test('should handle complete batch lifecycle', async () => {
      const correlationId = 'lifecycle-test';
      
      // 1. Create batch
      const batchId = await batchRecorder.ensureBatch(correlationId);
      assert.ok(batchId);
      
      // 2. Record multiple operations
      const operations = [
        { kind: 'task', action: 'create', title: 'Morning workout' },
        { kind: 'task', action: 'update', id: 1, completed: true },
        { kind: 'event', action: 'create', title: 'Team meeting' }
      ];
      
      for (let i = 0; i < operations.length; i++) {
        await batchRecorder.recordOp({
          batchId,
          seq: i + 1,
          op: operations[i],
          before: i === 1 ? { id: 1, completed: false } : null,
          after: { ...operations[i], id: i + 1 }
        });
      }
      
      // 3. Retrieve batch
      const retrievedBatch = await batchRecorder.getLastBatch();
      assert.equal(retrievedBatch.correlationId, correlationId);
      assert.equal(retrievedBatch.ops.length, 3);
      
      // 4. Verify operation details
      assert.equal(retrievedBatch.ops[0].op.title, 'Morning workout');
      assert.equal(retrievedBatch.ops[1].before.completed, false);
      assert.equal(retrievedBatch.ops[1].after.completed, true);
      assert.equal(retrievedBatch.ops[2].kind, 'event');
      
      // 5. Clear batch
      await batchRecorder.clearBatch(correlationId);
      
      // 6. Verify cleanup
      const afterClear = await batchRecorder.getLastBatch();
      // Should be null or different batch if other tests created more
      if (afterClear) {
        assert.notEqual(afterClear.correlationId, correlationId);
      }
    });
  });
});