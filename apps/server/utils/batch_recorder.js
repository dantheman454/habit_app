import db from '../database/DbService.js';

export class BatchRecorder {
  constructor() {
    this.dbService = db;
  }

  async ensureBatch(correlationId) {
    this.dbService.openIfNeeded();
    const ts = new Date().toISOString();
    
    // Try to insert new batch
    try {
      const stmt = this.dbService.db.prepare(
        'INSERT INTO op_batches (correlation_id, ts) VALUES (?, ?)'
      );
      const result = stmt.run(correlationId, ts);
      return result.lastInsertRowid;
    } catch (error) {
      // If correlation_id already exists, get the existing batch
      if (error.message.includes('UNIQUE constraint failed')) {
        const stmt = this.dbService.db.prepare(
          'SELECT id FROM op_batches WHERE correlation_id = ?'
        );
        const row = stmt.get(correlationId);
        return row ? row.id : null;
      }
      throw error;
    }
  }

  async recordOp({ batchId, seq, op, before, after }) {
    this.dbService.openIfNeeded();
    
    const stmt = this.dbService.db.prepare(`
      INSERT INTO op_batch_ops (batch_id, seq, kind, action, op_json, before_json, after_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    
    return stmt.run(
      batchId,
      seq,
      op.kind || 'unknown',
      op.action || 'unknown',
      JSON.stringify(op),
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null
    );
  }

  async getLastBatch() {
    this.dbService.openIfNeeded();
    
    // Get the most recent batch
    const batchStmt = this.dbService.db.prepare(`
      SELECT id, correlation_id, ts 
      FROM op_batches 
      ORDER BY id DESC 
      LIMIT 1
    `);
    const batch = batchStmt.get();
    
    if (!batch) {
      return null;
    }
    
    // Get all operations for this batch
    const opsStmt = this.dbService.db.prepare(`
      SELECT seq, kind, action, op_json, before_json, after_json
      FROM op_batch_ops 
      WHERE batch_id = ? 
      ORDER BY seq
    `);
    const ops = opsStmt.all(batch.id);
    
    return {
      correlationId: batch.correlation_id,
      batchId: batch.id,
      ts: batch.ts,
      ops: ops.map(op => ({
        seq: op.seq,
        kind: op.kind,
        action: op.action,
        op: JSON.parse(op.op_json),
        before: op.before_json ? JSON.parse(op.before_json) : null,
        after: op.after_json ? JSON.parse(op.after_json) : null
      }))
    };
  }

  async clearBatch(correlationId) {
    this.dbService.openIfNeeded();
    
    const stmt = this.dbService.db.prepare(
      'DELETE FROM op_batches WHERE correlation_id = ?'
    );
    return stmt.run(correlationId);
  }
}

// Export singleton instance
export const batchRecorder = new BatchRecorder();
