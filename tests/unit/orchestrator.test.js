import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import path from 'node:path';
import fs from 'node:fs';

import db from '../../apps/server/database/DbService.js';
import { routeAssistant, routeAssistantHybrid, __setClassifier } from '../../apps/server/llm/orchestrator.js';

const ROOT = path.resolve(path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..'));
const SCHEMA_PATH = path.join(ROOT, 'apps', 'server', 'database', 'schema.sql');

beforeEach(() => {
  // fresh DB
  const testDataDir = path.join(ROOT, 'data', 'test');
  try { fs.mkdirSync(testDataDir, { recursive: true }); } catch {}
  const dbPath = path.join(testDataDir, 'app.db');
  process.env.APP_DB_PATH = dbPath;
  try { for (const f of ['app.db','app.db-shm','app.db-wal']) { fs.existsSync(path.join(testDataDir, f)) && fs.unlinkSync(path.join(testDataDir, f)); } } catch {}
  const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.bootstrapSchema(sql);
});

test('heuristic: question routes to chat, action routes to ops', () => {
  const q = routeAssistant({ message: 'What are my tasks today?', where: {}, transcript: [] });
  assert.equal(q.decision, 'chat');
  const a = routeAssistant({ message: 'Add a task called Laundry', where: {}, transcript: [] });
  assert.equal(a.decision, 'ops');
});

test('hybrid: produces a stable fingerprint for traceability', async () => {
  process.env.ORCHESTRATOR_CLASSIFIER_ENABLED = '0';
  const msg = 'Create a task for tomorrow to call mom';
  const r1 = await routeAssistantHybrid({ message: msg, where: { view: { mode: 'day' } }, transcript: [] });
  assert.ok(r1.fingerprint);
  assert.equal(typeof r1.decision, 'string');
  const r2 = await routeAssistantHybrid({ message: msg, where: { view: { mode: 'day' } }, transcript: [] });
  assert.equal(r2.fingerprint, r1.fingerprint);
});

test('hybrid: adopts LLM classifier when enabled', async () => {
  // Inject a fake classifier
  __setClassifier(async () => ({ decision: 'chat', reason: 'fake_classifier', confidence: 0.9 }));
  process.env.ORCHESTRATOR_CLASSIFIER_ENABLED = '1';
  const r = await routeAssistantHybrid({ message: 'Can you show me my schedule?', where: {}, transcript: [] });
  assert.equal(r.decision, 'chat');
});

test('hybrid: supports clarify decision with question and hints passthrough', async () => {
  __setClassifier(async () => ({ decision: 'clarify', reason: 'ambiguous', confidence: 0.7, clarifyQuestion: 'Which task do you mean?', hints: { kind: 'task' } }));
  process.env.ORCHESTRATOR_CLASSIFIER_ENABLED = '1';
  const r = await routeAssistantHybrid({ message: 'update it', where: {}, transcript: [] });
  assert.equal(r.decision, 'clarify');
  assert.equal(typeof r.clarifyQuestion, 'string');
  assert.equal(r.hints.kind, 'task');
});

test('hybrid: adopts router timeout fallback to chat when classifier returns router_timeout', async () => {
  // Fake classifier simulating a timeout-handled return
  __setClassifier(async () => ({ decision: 'chat', reason: 'router_timeout', confidence: null }));
  process.env.ORCHESTRATOR_CLASSIFIER_ENABLED = '1';
  const r = await routeAssistantHybrid({ message: 'please update my task', where: {}, transcript: [] });
  assert.equal(r.decision, 'chat');
  assert.equal(r.reason, 'router_timeout');
});
