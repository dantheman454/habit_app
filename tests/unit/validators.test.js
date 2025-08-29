import { describe, it, test } from 'node:test';
import assert from 'node:assert';
import { OperationValidators } from '../../apps/server/operations/validators.js';

describe('OperationValidators', () => {
  describe('taskCreate', () => {
    test('should validate valid task creation', () => {
      const op = {
        title: 'Test Task',
        notes: 'Test notes',
        scheduledFor: '2025-08-18',
        timeOfDay: '14:30',
        recurrence: { type: 'none' }
      };
      
      const result = OperationValidators.taskCreate(op);
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.errors.length, 0);
    });
    
    test('should reject missing title', () => {
      const op = {
        notes: 'Test notes'
      };
      
      const result = OperationValidators.taskCreate(op);
      assert.strictEqual(result.valid, false);
      assert(result.errors.some(e => e.includes('Title is required')));
    });
    
    test('should reject empty title', () => {
      const op = {
        title: '   '
      };
      
      const result = OperationValidators.taskCreate(op);
      assert.strictEqual(result.valid, false);
      assert(result.errors.some(e => e.includes('Title is required')));
    });
    
    test('should reject title too long', () => {
      const op = {
        title: 'a'.repeat(256)
      };
      
      const result = OperationValidators.taskCreate(op);
      assert.strictEqual(result.valid, false);
      assert(result.errors.some(e => e.includes('255 characters')));
    });
    
    test('should reject invalid date format', () => {
      const op = {
        title: 'Test Task',
        scheduledFor: 'invalid-date'
      };
      
      const result = OperationValidators.taskCreate(op);
      assert.strictEqual(result.valid, false);
      assert(result.errors.some(e => e.includes('valid date')));
    });
    
    test('should reject invalid time format', () => {
      const op = {
        title: 'Test Task',
        timeOfDay: '25:00'
      };
      
      const result = OperationValidators.taskCreate(op);
      assert.strictEqual(result.valid, false);
      assert(result.errors.some(e => e.includes('valid time')));
    });
  });
  
  describe('taskUpdate', () => {
    test('should validate valid task update', () => {
      const op = {
        id: 1,
        title: 'Updated Task'
      };
      
      const result = OperationValidators.taskUpdate(op);
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.errors.length, 0);
    });
    
    test('should reject missing ID', () => {
      const op = {
        title: 'Updated Task'
      };
      
      const result = OperationValidators.taskUpdate(op);
      assert.strictEqual(result.valid, false);
      assert(result.errors.some(e => e.includes('Valid ID is required')));
    });
    
    test('should reject invalid ID', () => {
      const op = {
        id: 0,
        title: 'Updated Task'
      };
      
      const result = OperationValidators.taskUpdate(op);
      assert.strictEqual(result.valid, false);
      assert(result.errors.some(e => e.includes('Valid ID is required')));
    });
  });
  
  describe('taskDelete', () => {
    test('should validate valid task delete', () => {
      const op = { id: 1 };
      
      const result = OperationValidators.taskDelete(op);
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.errors.length, 0);
    });
    
    test('should reject missing ID', () => {
      const op = {};
      
      const result = OperationValidators.taskDelete(op);
      assert.strictEqual(result.valid, false);
      assert(result.errors.some(e => e.includes('Valid ID is required')));
    });
  });
  
  describe('eventCreate', () => {
    test('should validate valid event creation', () => {
      const op = {
        title: 'Test Event',
        scheduledFor: '2025-08-18',
        startTime: '14:30',
        endTime: '15:30',
        location: 'Conference Room'
      };
      
      const result = OperationValidators.eventCreate(op);
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.errors.length, 0);
    });
    
    test('should reject missing scheduledFor', () => {
      const op = {
        title: 'Test Event'
      };
      
      const result = OperationValidators.eventCreate(op);
      assert.strictEqual(result.valid, true); // scheduledFor is now optional
      assert.strictEqual(result.errors.length, 0);
    });
    
    test('should reject invalid time range', () => {
      const op = {
        title: 'Test Event',
        scheduledFor: '2025-08-18',
        startTime: '15:30',
        endTime: '14:30' // end before start
      };
      
      const result = OperationValidators.eventCreate(op);
      assert.strictEqual(result.valid, false);
      assert(result.errors.some(e => e.includes('endTime must be after startTime')));
    });
  });
  
  describe('Helper methods', () => {
    test('isValidDate should validate correct dates', () => {
      assert.strictEqual(OperationValidators.isValidDate('2025-08-18'), true);
      assert.strictEqual(OperationValidators.isValidDate('2025-12-31'), true);
      assert.strictEqual(OperationValidators.isValidDate('invalid'), false);
      assert.strictEqual(OperationValidators.isValidDate('2025/08/18'), false);
      assert.strictEqual(OperationValidators.isValidDate(123), false);
    });
    
    test('isValidTime should validate correct times', () => {
      assert.strictEqual(OperationValidators.isValidTime('14:30'), true);
      assert.strictEqual(OperationValidators.isValidTime('09:05'), true);
      assert.strictEqual(OperationValidators.isValidTime('23:59'), true);
      assert.strictEqual(OperationValidators.isValidTime('25:00'), false);
      assert.strictEqual(OperationValidators.isValidTime('14:60'), false);
      assert.strictEqual(OperationValidators.isValidTime('invalid'), false);
    });
    
    test('isValidDuration should validate correct durations', () => {
      assert.strictEqual(OperationValidators.isValidDuration(60), true);
      assert.strictEqual(OperationValidators.isValidDuration(1), true);
      assert.strictEqual(OperationValidators.isValidDuration(0), false);
      assert.strictEqual(OperationValidators.isValidDuration(-1), false);
      assert.strictEqual(OperationValidators.isValidDuration(1.5), false);
      assert.strictEqual(OperationValidators.isValidDuration('60'), false);
    });
    
    test('isValidRecurrence should validate correct recurrences', () => {
      assert.strictEqual(OperationValidators.isValidRecurrence({ type: 'none' }), true);
      assert.strictEqual(OperationValidators.isValidRecurrence({ type: 'daily' }), true);
      assert.strictEqual(OperationValidators.isValidRecurrence({ 
        type: 'every_n_days', 
        intervalDays: 3 
      }), true);
      assert.strictEqual(OperationValidators.isValidRecurrence({ 
        type: 'every_n_days', 
        intervalDays: 0 
      }), false);
      assert.strictEqual(OperationValidators.isValidRecurrence({ type: 'invalid' }), false);
      assert.strictEqual(OperationValidators.isValidRecurrence(null), false);
    });
  });
});
