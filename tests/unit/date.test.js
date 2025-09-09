import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ymd, parseYMD, weekRangeFromToday, ymdInTimeZone } from '../../apps/server/utils/date.js';

describe('Date utilities', () => {
  describe('ymd', () => {
    test('should format date correctly', () => {
      const date = new Date(2025, 8, 15); // September 15, 2025
      const result = ymd(date);
      assert.equal(result, '2025-09-15');
    });

    test('should handle single digit months and days', () => {
      const date = new Date(2025, 0, 5); // January 5, 2025
      const result = ymd(date);
      assert.equal(result, '2025-01-05');
    });

    test('should handle leap year dates', () => {
      const date = new Date(2024, 1, 29); // February 29, 2024 (leap year)
      const result = ymd(date);
      assert.equal(result, '2024-02-29');
    });
  });

  describe('parseYMD', () => {
    test('should parse valid date string', () => {
      const result = parseYMD('2025-09-15');
      assert.ok(result instanceof Date);
      assert.equal(result.getFullYear(), 2025);
      assert.equal(result.getMonth(), 8); // 0-indexed
      assert.equal(result.getDate(), 15);
    });

    test('should reject invalid format', () => {
      assert.equal(parseYMD('2025-9-15'), null);
      assert.equal(parseYMD('25-09-15'), null);
      assert.equal(parseYMD('2025/09/15'), null);
      assert.equal(parseYMD('invalid'), null);
    });

    test('should reject invalid dates', () => {
      assert.equal(parseYMD('2025-13-01'), null); // Invalid month
      assert.equal(parseYMD('2025-02-30'), null); // Invalid day for February
      assert.equal(parseYMD('2025-04-31'), null); // Invalid day for April
    });

    test('should handle leap year validation', () => {
      assert.ok(parseYMD('2024-02-29')); // Valid leap year
      assert.equal(parseYMD('2023-02-29'), null); // Invalid non-leap year
    });

    test('should reject non-string input', () => {
      assert.equal(parseYMD(null), null);
      assert.equal(parseYMD(undefined), null);
      assert.equal(parseYMD(123), null);
      assert.equal(parseYMD({}), null);
    });
  });

  describe('weekRangeFromToday', () => {
    test('should return valid week range', () => {
      const result = weekRangeFromToday('UTC');
      assert.ok(typeof result.fromYmd === 'string');
      assert.ok(typeof result.toYmd === 'string');
      assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(result.fromYmd));
      assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(result.toYmd));
      
      // From should be <= to
      assert.ok(result.fromYmd <= result.toYmd);
    });

    test('should handle different timezones', () => {
      const utcResult = weekRangeFromToday('UTC');
      const pstResult = weekRangeFromToday('America/Los_Angeles');
      
      // Results should be valid date strings
      assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(utcResult.fromYmd));
      assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(pstResult.fromYmd));
    });

    test('should handle invalid timezone gracefully', () => {
      const result = weekRangeFromToday('Invalid/Timezone');
      assert.ok(typeof result.fromYmd === 'string');
      assert.ok(typeof result.toYmd === 'string');
    });
  });

  describe('ymdInTimeZone', () => {
    test('should format date in specified timezone', () => {
      const date = new Date('2025-09-15T12:00:00Z');
      const result = ymdInTimeZone(date, 'UTC');
      assert.equal(result, '2025-09-15');
    });

    test('should handle timezone differences', () => {
      const date = new Date('2025-09-15T02:00:00Z'); // 2 AM UTC
      const utcResult = ymdInTimeZone(date, 'UTC');
      const pstResult = ymdInTimeZone(date, 'America/Los_Angeles');
      
      assert.equal(utcResult, '2025-09-15');
      // PST is UTC-8, so 2 AM UTC becomes 6 PM previous day PST
      assert.equal(pstResult, '2025-09-14');
    });

    test('should handle various timezones', () => {
      const date = new Date('2025-09-15T12:00:00Z');
      
      const timezones = [
        'UTC',
        'America/New_York',
        'Europe/London',
        'Asia/Tokyo'
      ];

      timezones.forEach(tz => {
        const result = ymdInTimeZone(date, tz);
        assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(result));
      });
    });
  });
});