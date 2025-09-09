import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { 
  isYmdString, 
  isValidRecurrence, 
  daysBetween, 
  matchesRule, 
  expandOccurrences 
} from '../../apps/server/utils/recurrence.js';
import { ymd, parseYMD } from '../../apps/server/utils/date.js';

describe('Recurrence utilities', () => {
  describe('isYmdString', () => {
    test('should validate correct YMD strings', () => {
      assert.equal(isYmdString('2025-09-15'), true);
      assert.equal(isYmdString('2024-02-29'), true);
      assert.equal(isYmdString('1999-12-31'), true);
    });

    test('should reject invalid YMD strings', () => {
      assert.equal(isYmdString('2025-9-15'), false);
      assert.equal(isYmdString('25-09-15'), false);
      assert.equal(isYmdString('2025/09/15'), false);
      assert.equal(isYmdString('invalid'), false);
      assert.equal(isYmdString(''), false);
      // Note: isYmdString only validates format, not actual date validity
      // so '2025-13-01' would pass format check (that's handled elsewhere)
    });

    test('should reject non-string values', () => {
      assert.equal(isYmdString(null), false);
      assert.equal(isYmdString(undefined), false);
      assert.equal(isYmdString(123), false);
      assert.equal(isYmdString({}), false);
      assert.equal(isYmdString([]), false);
    });
  });

  describe('isValidRecurrence', () => {
    test('should accept null and undefined', () => {
      assert.equal(isValidRecurrence(null), true);
      assert.equal(isValidRecurrence(undefined), true);
    });

    test('should validate basic recurrence types', () => {
      assert.equal(isValidRecurrence({ type: 'none' }), true);
      assert.equal(isValidRecurrence({ type: 'daily' }), true);
      assert.equal(isValidRecurrence({ type: 'weekdays' }), true);
      assert.equal(isValidRecurrence({ type: 'weekly' }), true);
    });

    test('should validate every_n_days with valid intervals', () => {
      assert.equal(isValidRecurrence({ type: 'every_n_days', intervalDays: 1 }), true);
      assert.equal(isValidRecurrence({ type: 'every_n_days', intervalDays: 7 }), true);
      assert.equal(isValidRecurrence({ type: 'every_n_days', intervalDays: 30 }), true);
    });

    test('should reject every_n_days with invalid intervals', () => {
      assert.equal(isValidRecurrence({ type: 'every_n_days', intervalDays: 0 }), false);
      assert.equal(isValidRecurrence({ type: 'every_n_days', intervalDays: -1 }), false);
      assert.equal(isValidRecurrence({ type: 'every_n_days', intervalDays: 1.5 }), false);
      assert.equal(isValidRecurrence({ type: 'every_n_days', intervalDays: 'invalid' }), false);
      assert.equal(isValidRecurrence({ type: 'every_n_days' }), false); // Missing intervalDays
    });

    test('should validate until dates', () => {
      assert.equal(isValidRecurrence({ type: 'daily', until: null }), true);
      assert.equal(isValidRecurrence({ type: 'daily', until: undefined }), true);
      assert.equal(isValidRecurrence({ type: 'daily', until: '2025-12-31' }), true);
    });

    test('should reject invalid until dates', () => {
      // Note: isValidRecurrence uses isYmdString which only checks format
      // Actual date validation (like month 13) is not done in isYmdString
      assert.equal(isValidRecurrence({ type: 'daily', until: 'invalid' }), false);
      assert.equal(isValidRecurrence({ type: 'daily', until: 123 }), false);
      assert.equal(isValidRecurrence({ type: 'daily', until: '2025/12/31' }), false); // Wrong format
    });

    test('should reject invalid types', () => {
      assert.equal(isValidRecurrence({ type: 'invalid' }), false);
      assert.equal(isValidRecurrence({ type: '' }), false);
      assert.equal(isValidRecurrence({ type: 123 }), false);
      assert.equal(isValidRecurrence({}), false); // Missing type
    });

    test('should reject non-object values', () => {
      assert.equal(isValidRecurrence('string'), false);
      assert.equal(isValidRecurrence(123), false);
      assert.equal(isValidRecurrence([]), false);
    });
  });

  describe('daysBetween', () => {
    test('should calculate days between dates correctly', () => {
      const date1 = new Date(2025, 8, 15); // Sep 15, 2025
      const date2 = new Date(2025, 8, 20); // Sep 20, 2025
      const date3 = new Date(2025, 8, 10); // Sep 10, 2025
      
      assert.equal(daysBetween(date1, date2), 5);
      assert.equal(daysBetween(date2, date1), -5);
      assert.equal(daysBetween(date1, date1), 0);
      assert.equal(daysBetween(date3, date1), 5);
    });

    test('should handle month boundaries', () => {
      const lastDayAug = new Date(2025, 7, 31); // Aug 31, 2025
      const firstDaySep = new Date(2025, 8, 1); // Sep 1, 2025
      
      assert.equal(daysBetween(lastDayAug, firstDaySep), 1);
    });

    test('should handle year boundaries', () => {
      const lastDay2024 = new Date(2024, 11, 31); // Dec 31, 2024
      const firstDay2025 = new Date(2025, 0, 1); // Jan 1, 2025
      
      assert.equal(daysBetween(lastDay2024, firstDay2025), 1);
    });
  });

  describe('matchesRule', () => {
    const anchorDate = new Date(2025, 8, 15); // Monday, Sep 15, 2025

    test('should handle none type', () => {
      assert.equal(matchesRule(anchorDate, anchorDate, { type: 'none' }), false);
      assert.equal(matchesRule(anchorDate, anchorDate, null), false);
      assert.equal(matchesRule(anchorDate, anchorDate, undefined), false);
    });

    test('should handle daily recurrence', () => {
      const nextDay = new Date(2025, 8, 16);
      const prevDay = new Date(2025, 8, 14);
      
      assert.equal(matchesRule(anchorDate, anchorDate, { type: 'daily' }), true);
      assert.equal(matchesRule(nextDay, anchorDate, { type: 'daily' }), true);
      assert.equal(matchesRule(prevDay, anchorDate, { type: 'daily' }), false);
    });

    test('should handle weekdays recurrence', () => {
      const tuesday = new Date(2025, 8, 16); // Sep 16, 2025 (Tuesday)
      const saturday = new Date(2025, 8, 20); // Sep 20, 2025 (Saturday)
      const sunday = new Date(2025, 8, 21); // Sep 21, 2025 (Sunday)
      
      assert.equal(matchesRule(anchorDate, anchorDate, { type: 'weekdays' }), true); // Monday
      assert.equal(matchesRule(tuesday, anchorDate, { type: 'weekdays' }), true); // Tuesday
      assert.equal(matchesRule(saturday, anchorDate, { type: 'weekdays' }), false); // Saturday
      assert.equal(matchesRule(sunday, anchorDate, { type: 'weekdays' }), false); // Sunday
    });

    test('should handle weekly recurrence', () => {
      const nextWeek = new Date(2025, 8, 22); // Sep 22, 2025 (next Monday)
      const twoWeeksLater = new Date(2025, 8, 29); // Sep 29, 2025
      const notWeekly = new Date(2025, 8, 18); // Sep 18, 2025 (Thursday)
      
      assert.equal(matchesRule(anchorDate, anchorDate, { type: 'weekly' }), true);
      assert.equal(matchesRule(nextWeek, anchorDate, { type: 'weekly' }), true);
      assert.equal(matchesRule(twoWeeksLater, anchorDate, { type: 'weekly' }), true);
      assert.equal(matchesRule(notWeekly, anchorDate, { type: 'weekly' }), false);
    });

    test('should handle every_n_days recurrence', () => {
      const threeDaysLater = new Date(2025, 8, 18); // Sep 18, 2025
      const sixDaysLater = new Date(2025, 8, 21); // Sep 21, 2025
      const fourDaysLater = new Date(2025, 8, 19); // Sep 19, 2025
      
      const every3Days = { type: 'every_n_days', intervalDays: 3 };
      
      assert.equal(matchesRule(anchorDate, anchorDate, every3Days), true); // Day 0
      assert.equal(matchesRule(threeDaysLater, anchorDate, every3Days), true); // Day 3
      assert.equal(matchesRule(sixDaysLater, anchorDate, every3Days), true); // Day 6
      assert.equal(matchesRule(fourDaysLater, anchorDate, every3Days), false); // Day 4
    });

    test('should handle invalid every_n_days intervals', () => {
      const nextDay = new Date(2025, 8, 16);
      
      assert.equal(matchesRule(nextDay, anchorDate, { type: 'every_n_days', intervalDays: 0 }), false);
      assert.equal(matchesRule(nextDay, anchorDate, { type: 'every_n_days', intervalDays: -1 }), false);
      assert.equal(matchesRule(nextDay, anchorDate, { type: 'every_n_days' }), false);
    });
  });

  describe('expandOccurrences', () => {
    const masterTask = {
      id: 1,
      scheduledFor: '2025-09-15',
      recurrence: { type: 'daily' }
    };

    test('should expand daily occurrences', () => {
      const fromDate = new Date(2025, 8, 15); // Sep 15, 2025
      const toDate = new Date(2025, 8, 17); // Sep 17, 2025
      
      const occurrences = expandOccurrences(masterTask, fromDate, toDate, { ymd, parseYMD });
      
      assert.equal(occurrences.length, 3); // 15th, 16th, 17th
      assert.equal(occurrences[0].scheduledFor, '2025-09-15');
      assert.equal(occurrences[1].scheduledFor, '2025-09-16');
      assert.equal(occurrences[2].scheduledFor, '2025-09-17');
      
      occurrences.forEach(occ => {
        assert.equal(occ.id, masterTask.id);
        assert.equal(occ.masterId, masterTask.id);
      });
    });

    test('should respect until date', () => {
      const masterWithUntil = {
        ...masterTask,
        recurrence: { type: 'daily', until: '2025-09-16' }
      };
      
      const fromDate = new Date(2025, 8, 15);
      const toDate = new Date(2025, 8, 20);
      
      const occurrences = expandOccurrences(masterWithUntil, fromDate, toDate, { ymd, parseYMD });
      
      assert.equal(occurrences.length, 2); // Only 15th and 16th
      assert.equal(occurrences[occurrences.length - 1].scheduledFor, '2025-09-16');
    });

    test('should handle weekly recurrence', () => {
      const weeklyTask = {
        ...masterTask,
        recurrence: { type: 'weekly' }
      };
      
      const fromDate = new Date(2025, 8, 15); // Sep 15, 2025 (Monday)
      const toDate = new Date(2025, 8, 29); // Sep 29, 2025 (two weeks later)
      
      const occurrences = expandOccurrences(weeklyTask, fromDate, toDate, { ymd, parseYMD });
      
      assert.equal(occurrences.length, 3); // 15th, 22nd, 29th
      assert.equal(occurrences[0].scheduledFor, '2025-09-15');
      assert.equal(occurrences[1].scheduledFor, '2025-09-22');
      assert.equal(occurrences[2].scheduledFor, '2025-09-29');
    });

    test('should handle every_n_days recurrence', () => {
      const everyThreeDaysTask = {
        ...masterTask,
        recurrence: { type: 'every_n_days', intervalDays: 3 }
      };
      
      const fromDate = new Date(2025, 8, 15);
      const toDate = new Date(2025, 8, 24);
      
      const occurrences = expandOccurrences(everyThreeDaysTask, fromDate, toDate, { ymd, parseYMD });
      
      assert.equal(occurrences.length, 4); // 15th, 18th, 21st, 24th
      assert.equal(occurrences[0].scheduledFor, '2025-09-15');
      assert.equal(occurrences[1].scheduledFor, '2025-09-18');
      assert.equal(occurrences[2].scheduledFor, '2025-09-21');
      assert.equal(occurrences[3].scheduledFor, '2025-09-24');
    });

    test('should return empty array for non-repeating tasks', () => {
      const nonRepeatingTask = {
        ...masterTask,
        recurrence: { type: 'none' }
      };
      
      const fromDate = new Date(2025, 8, 15);
      const toDate = new Date(2025, 8, 17);
      
      const occurrences = expandOccurrences(nonRepeatingTask, fromDate, toDate, { ymd, parseYMD });
      assert.equal(occurrences.length, 0);
    });

    test('should return empty array for tasks without scheduled date', () => {
      const unscheduledTask = {
        ...masterTask,
        scheduledFor: null
      };
      
      const fromDate = new Date(2025, 8, 15);
      const toDate = new Date(2025, 8, 17);
      
      const occurrences = expandOccurrences(unscheduledTask, fromDate, toDate, { ymd, parseYMD });
      assert.equal(occurrences.length, 0);
    });

    test('should throw error when helpers are missing', () => {
      const fromDate = new Date(2025, 8, 15);
      const toDate = new Date(2025, 8, 17);
      
      assert.throws(() => {
        expandOccurrences(masterTask, fromDate, toDate);
      }, /expandOccurrences requires ymd and parseYMD helpers/);
      
      assert.throws(() => {
        expandOccurrences(masterTask, fromDate, toDate, { ymd });
      }, /expandOccurrences requires ymd and parseYMD helpers/);
    });

    test('should limit expansion to date range', () => {
      const fromDate = new Date(2025, 8, 17); // Start after anchor date
      const toDate = new Date(2025, 8, 19);
      
      const occurrences = expandOccurrences(masterTask, fromDate, toDate, { ymd, parseYMD });
      
      assert.equal(occurrences.length, 3); // 17th, 18th, 19th
      assert.equal(occurrences[0].scheduledFor, '2025-09-17');
      // Should not include the anchor date (15th) since it's before fromDate
    });
  });
});