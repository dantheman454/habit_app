// Unit tests for OpsAgent simplified behavior (no heuristic fallback)
import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import path from 'node:path';
import { readFileSync } from 'node:fs';

import db from '../../apps/server/database/DbService.js';
import { OperationProcessor } from '../../apps/server/operations/operation_processor.js';
import { OperationRegistry } from '../../apps/server/operations/operation_registry.js';
import { runOpsAgentToolCalling } from '../../apps/server/llm/ops_agent.js';

function ymd(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${da}`;
}

const ROOT = path.resolve(path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..'));
const SCHEMA_PATH = path.join(ROOT, 'apps', 'server', 'database', 'schema.sql');

/** @type {OperationProcessor} */
let op;

before(() => {
  // Ensure test DB is bootstrapped on the shared DbService instance
  const sql = readFileSync(SCHEMA_PATH, 'utf8');
  db.bootstrapSchema(sql);
  op = new OperationProcessor();
  op.setDbService(db);
  const reg = new OperationRegistry(db);
  reg.registerAllOperations(op);
});

test('ops_agent provides guidance when no valid tool_calls are present', async () => {
  const today = ymd();
  const where = { view: { mode: 'day', fromYmd: today, toYmd: today } };
  const r = await runOpsAgentToolCalling({
    taskBrief: 'do something with lunch',
    where,
    transcript: [],
    timezone: 'America/New_York',
    operationProcessor: op
  });
  assert.ok(Array.isArray(r.operations));
  assert.equal(r.operations.length, 0);
  assert.ok(typeof r.text === 'string' && r.text.length > 0);
  const hasNoOpsError = Array.isArray(r.notes?.errors) && r.notes.errors.some(e => e && (e.error === 'no_operations_proposed'));
  assert.ok(hasNoOpsError, 'expected no_operations_proposed error note');
});
