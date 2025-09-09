// Unit tests for OpsAgent fallback inference (create/update) without a real LLM
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

test('ops_agent fallback: create event for today at noon', async () => {
  const today = ymd();
  const where = { view: { mode: 'day', fromYmd: today, toYmd: today } };
  const r = await runOpsAgentToolCalling({
    taskBrief: 'add an event for today called Lunch with Dad at noon',
    where,
    transcript: [],
    timezone: 'America/New_York',
    operationProcessor: op
  });
  assert.ok(Array.isArray(r.operations));
  const create = r.operations.find(o => o.kind === 'event' && (o.action === 'create' || o.op === 'create'));
  assert.ok(create, 'expected an event.create');
  assert.equal(create.scheduledFor, today);
  assert.equal(create.startTime, '12:00');
  assert.equal(create.endTime, '13:00');
  assert.ok(String(create.title || '').toLowerCase().includes('lunch'));
});

test('ops_agent fallback: update event time when asked to move to 1 pm', async () => {
  const today = ymd();
  // Seed an event in DB so the focused context can find a candidate
  const seeded = db.createEvent({ title: 'Lunch with Dad', scheduledFor: today, startTime: '12:00', endTime: '13:00', recurrence: { type: 'none' } });
  assert.ok(seeded && seeded.id);
  const where = { view: { mode: 'day', fromYmd: today, toYmd: today } };
  const r = await runOpsAgentToolCalling({
    taskBrief: 'move lunch to 1 pm',
    where,
    transcript: [],
    timezone: 'America/New_York',
    operationProcessor: op
  });
  assert.ok(Array.isArray(r.operations));
  const upd = r.operations.find(o => o.kind === 'event' && (o.action === 'update' || o.op === 'update'));
  assert.ok(upd, 'expected an event.update');
  assert.equal(upd.id, seeded.id);
  assert.equal(upd.startTime, '13:00');
});
