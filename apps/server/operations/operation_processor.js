import { mkCorrelationId } from '../llm/logging.js';

export class OperationProcessor {
  constructor() {
    this.validators = new Map();
    this.executors = new Map();
    this.formatters = new Map();
    this.operationTypes = new Map();
  }
  
  registerOperationType(type, config) {
    this.operationTypes.set(type, config);
    this.validators.set(type, config.validator);
    this.executors.set(type, config.executor);
    if (config.formatter) {
      this.formatters.set(type, config.formatter);
    }
  }
  
  inferOperationType(op) {
    if (op.kind && op.action) {
      return `${op.kind}_${op.action}`;
    }
    return op.op || 'unknown';
  }
  
  async processOperations(operations, correlationId = mkCorrelationId()) {
    const results = [];
    const summary = { created: 0, updated: 0, deleted: 0, completed: 0 };
    
    for (const op of operations) {
      try {
        const type = this.inferOperationType(op);
        const validator = this.validators.get(type);
        const executor = this.executors.get(type);
        
        if (!validator || !executor) {
          results.push({ ok: false, op, error: 'unknown_operation_type' });
          continue;
        }
        
        const validation = await validator(op);
        if (!validation.valid) {
          results.push({ ok: false, op, error: validation.errors.join(', ') });
          continue;
        }
        
        const result = await executor(op);
        results.push({ ok: true, op, ...result });
        
        // Update summary
        if (result.created) summary.created++;
        if (result.updated) summary.updated++;
        if (result.deleted) summary.deleted++;
        if (result.completed) summary.completed++;
        
      } catch (error) {
        results.push({ ok: false, op, error: String(error) });
      }
    }
    
    return { results, summary, correlationId };
  }

  listOperationTypes() {
    return Array.from(this.operationTypes.keys());
  }

  isHealthy() {
    return this.operationTypes.size > 0;
  }
}
