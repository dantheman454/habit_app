import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractFirstJson } from '../../apps/server/llm/json_extract.js';

test('extractFirstJson: handles code fences and prose', () => {
  const s = "Here is output:\n```json\n{\n  \"a\": 1, \n  \"b\": [2,3]\n}\n```\nthanks";
  const j = extractFirstJson(s);
  assert.equal(j.a, 1);
  assert.deepEqual(j.b, [2,3]);
});

test('extractFirstJson: returns null when no JSON', () => {
  assert.equal(extractFirstJson('no json here'), null);
});

test('extractFirstJson: finds first top-level object', () => {
  const s = "noise [1,2]\n {\"x\":\"y\"} tail";
  const j = extractFirstJson(s);
  assert.equal(Array.isArray(j), true);
});
