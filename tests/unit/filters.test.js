import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { filterTasksByWhere, getAggregatesFromDb } from '../../apps/server/utils/filters.js';

describe('Filter utilities', () => {
  const mockTasks = [
    {
      id: 1,
      title: 'Buy groceries',
      status: 'pending',
      scheduledFor: '2025-09-15',
      context: 'personal',
      recurrence: { type: 'none' }
    },
    {
      id: 2,
      title: 'Weekly meeting',
      status: 'completed',
      scheduledFor: '2025-09-10',
      context: 'work',
      recurrence: { type: 'weekly' }
    },
    {
      id: 3,
      title: 'Project deadline',
      status: 'pending',
      scheduledFor: '2025-09-05', // Overdue
      context: 'work',
      recurrence: { type: 'none' }
    },
    {
      id: 4,
      title: 'Backlog task',
      status: 'pending',
      scheduledFor: null,
      context: 'personal',
      recurrence: { type: 'none' }
    },
    {
      id: 5,
      title: 'Daily exercise',
      status: 'skipped',
      scheduledFor: '2025-09-12',
      context: 'health',
      recurrence: { type: 'daily' }
    }
  ];

  const mockDbService = {
    listAllTasksRaw: () => mockTasks
  };

  describe('filterTasksByWhere', () => {
    test('should return all tasks when no filters applied', () => {
      const result = filterTasksByWhere({}, mockDbService);
      assert.equal(result.length, 5);
    });

    test('should filter by IDs', () => {
      const result = filterTasksByWhere({ ids: [1, 3] }, mockDbService);
      assert.equal(result.length, 2);
      assert.equal(result[0].id, 1);
      assert.equal(result[1].id, 3);
    });

    test('should filter by title contains (case insensitive)', () => {
      const result = filterTasksByWhere({ title_contains: 'MEET' }, mockDbService);
      assert.equal(result.length, 1);
      assert.equal(result[0].title, 'Weekly meeting');
    });

    test('should filter by overdue status', () => {
      // Mock today as 2025-09-15 for consistent testing
      const originalNow = Date.now;
      Date.now = () => new Date('2025-09-15').getTime();
      
      try {
        const overdueResult = filterTasksByWhere({ overdue: true }, mockDbService);
        const notOverdueResult = filterTasksByWhere({ overdue: false }, mockDbService);
        
        // Task 3 should be overdue (scheduled for 2025-09-05, before today)
        assert.ok(overdueResult.some(t => t.id === 3));
        // Completed and skipped tasks should not be considered overdue
        assert.ok(!overdueResult.some(t => t.status === 'completed' || t.status === 'skipped'));
      } finally {
        Date.now = originalNow;
      }
    });

    test('should filter by scheduled date range', () => {
      const result = filterTasksByWhere({
        scheduled_range: {
          from: '2025-09-10',
          to: '2025-09-15'
        }
      }, mockDbService);
      
      // Should include tasks 1, 2, and 5 (all between 2025-09-10 and 2025-09-15)
      assert.equal(result.length, 3);
      assert.ok(result.some(t => t.id === 1));
      assert.ok(result.some(t => t.id === 2));
      assert.ok(result.some(t => t.id === 5));
      // Should not include task 3 (before range) or task 4 (no scheduled date)
      assert.ok(!result.some(t => t.id === 3));
      assert.ok(!result.some(t => t.id === 4));
    });

    test('should filter by status', () => {
      const pendingResult = filterTasksByWhere({ status: 'pending' }, mockDbService);
      const completedResult = filterTasksByWhere({ status: 'completed' }, mockDbService);
      
      assert.equal(pendingResult.length, 3);
      assert.equal(completedResult.length, 1);
      assert.equal(completedResult[0].id, 2);
    });

    test('should filter by context', () => {
      const workResult = filterTasksByWhere({ context: 'work' }, mockDbService);
      const personalResult = filterTasksByWhere({ context: 'personal' }, mockDbService);
      
      assert.equal(workResult.length, 2);
      assert.equal(personalResult.length, 2);
    });

    test('should filter by completed boolean', () => {
      const completedResult = filterTasksByWhere({ completed: true }, mockDbService);
      const notCompletedResult = filterTasksByWhere({ completed: false }, mockDbService);
      
      assert.equal(completedResult.length, 1);
      assert.equal(completedResult[0].status, 'completed');
      assert.equal(notCompletedResult.length, 4);
    });

    test('should filter by repeating status', () => {
      const repeatingResult = filterTasksByWhere({ repeating: true }, mockDbService);
      const nonRepeatingResult = filterTasksByWhere({ repeating: false }, mockDbService);
      
      // Tasks 2 and 5 have recurrence types other than 'none'
      assert.equal(repeatingResult.length, 2);
      assert.ok(repeatingResult.some(t => t.id === 2));
      assert.ok(repeatingResult.some(t => t.id === 5));
      
      assert.equal(nonRepeatingResult.length, 3);
    });

    test('should combine multiple filters', () => {
      const result = filterTasksByWhere({
        status: 'pending',
        context: 'work'
      }, mockDbService);
      
      // Only task 3 should match (pending + work context)
      assert.equal(result.length, 1);
      assert.equal(result[0].id, 3);
    });

    test('should handle empty lists gracefully', () => {
      const emptyDbService = { listAllTasksRaw: () => [] };
      const result = filterTasksByWhere({ status: 'pending' }, emptyDbService);
      assert.equal(result.length, 0);
    });
  });

  describe('getAggregatesFromDb', () => {
    test('should calculate task aggregates correctly', () => {
      // Mock today as 2025-09-15 for consistent testing
      const originalNow = Date.now;
      Date.now = () => new Date('2025-09-15').getTime();
      
      try {
        const result = getAggregatesFromDb(mockDbService);
        
        // backlogCount: tasks with scheduledFor === null (task 4)
        assert.equal(result.backlogCount, 1);
        
        // scheduledCount: tasks with scheduledFor !== null (tasks 1, 2, 3, 5)
        assert.equal(result.scheduledCount, 4);
        
        // overdueCount: pending tasks with scheduledFor < today (task 3)
        assert.equal(result.overdueCount, 1);
        
        // next7DaysCount: tasks scheduled within next 7 days from today
        // Task 1 is scheduled for 2025-09-15 (today), so it should be included
        assert.ok(result.next7DaysCount >= 1);
      } finally {
        Date.now = originalNow;
      }
    });

    test('should handle empty task list', () => {
      const emptyDbService = { listAllTasksRaw: () => [] };
      const result = getAggregatesFromDb(emptyDbService);
      
      assert.equal(result.backlogCount, 0);
      assert.equal(result.scheduledCount, 0);
      assert.equal(result.overdueCount, 0);
      assert.equal(result.next7DaysCount, 0);
    });

    test('should not count completed/skipped tasks as overdue', () => {
      const tasksWithOverdueCompleted = [
        {
          id: 1,
          status: 'completed',
          scheduledFor: '2025-09-01' // Past date but completed
        },
        {
          id: 2,
          status: 'skipped',
          scheduledFor: '2025-09-01' // Past date but skipped
        },
        {
          id: 3,
          status: 'pending',
          scheduledFor: '2025-09-01' // Past date and pending
        }
      ];

      const testDbService = { listAllTasksRaw: () => tasksWithOverdueCompleted };
      
      const originalNow = Date.now;
      Date.now = () => new Date('2025-09-15').getTime();
      
      try {
        const result = getAggregatesFromDb(testDbService);
        // Only the pending task should count as overdue
        assert.equal(result.overdueCount, 1);
      } finally {
        Date.now = originalNow;
      }
    });
  });
});