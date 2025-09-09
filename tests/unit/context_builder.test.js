import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, beforeEach } from 'node:test';

// Import the default DB instance used by context builder
import db from '../../apps/server/database/DbService.js';
import { buildFocusedContext } from '../../apps/server/llm/context.js';

const ROOT = path.resolve(path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..'));
const SCHEMA_PATH = path.join(ROOT, 'apps', 'server', 'database', 'schema.sql');

function ymd(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${da}`;
}

function nextMonthRange(fromDate = new Date()) {
  const y = fromDate.getFullYear();
  const m = fromDate.getMonth();
  const first = new Date(y, m + 1, 1);
  const last = new Date(y, m + 2, 0);
  const pad = (n) => String(n).padStart(2, '0');
  return { fromYmd: `${first.getFullYear()}-${pad(first.getMonth() + 1)}-${pad(first.getDate())}`, toYmd: `${last.getFullYear()}-${pad(last.getMonth() + 1)}-${pad(last.getDate())}` };
}

beforeEach(() => {
  // Use in-memory DB and bootstrap schema fresh for each test
  process.env.APP_DB_PATH = ':memory:';
  const sql = readFileSync(SCHEMA_PATH, 'utf8');
  db.bootstrapSchema(sql);
});

test('buildFocusedContext: includes view window and next-month events with source tags and normalized indexes', () => {
  const today = new Date();
  const todayY = ymd(today);
  const { fromYmd: nmFrom } = nextMonthRange(today);

  // Create one event in view (today), one in next month, and one outside both
  const eView = db.createEvent({ title: 'Lunch – Meeting', scheduledFor: todayY, startTime: '12:00', endTime: '13:00' });
  const eNext = db.createEvent({ title: 'Project Kickoff', scheduledFor: nmFrom, startTime: '09:00', endTime: '10:00' });
  db.createEvent({ title: 'Old Event', scheduledFor: '2000-01-01', startTime: '08:00', endTime: '09:00' });

  const where = { view: { mode: 'day', fromYmd: todayY, toYmd: todayY } };
  const ctx = buildFocusedContext(where, { timezone: 'America/New_York' });

  // Should include eView and eNext only
  const ids = new Set(ctx.events.map(e => e.id));
  assert.equal(ids.has(eView.id), true);
  assert.equal(ids.has(eNext.id), true);
  assert.equal(ctx.events.length >= 2, true);

  // Source tags present
  const eViewCtx = ctx.events.find(e => e.id === eView.id);
  const eNextCtx = ctx.events.find(e => e.id === eNext.id);
  assert.equal(eViewCtx.source, 'view');
  assert.equal(eNextCtx.source, 'next_month');

  // Normalized title index should include lunch – meeting under a normalized key
  const hasNormalizedKey = Object.keys(ctx.indexes.event_by_title_ci).some(k => k.includes('lunch') && k.includes('meeting'));
  assert.equal(hasNormalizedKey, true);

  // No truncation for small sets
  assert.equal(ctx.meta && ctx.meta.contextTruncated, false);
});

test('buildFocusedContext: applies deterministic truncation order (selected -> view -> next_month)', () => {
  // Cap small to force truncation
  process.env.ASSISTANT_CONTEXT_EVENTS_CAP = '3';

  const today = new Date();
  const todayY = ymd(today);
  const { fromYmd: nmFrom } = nextMonthRange(today);

  // Create events: 1 selected, multiple view, multiple next_month
  const sel = db.createEvent({ title: 'Selected', scheduledFor: todayY, startTime: '10:00', endTime: '10:30' });
  const v1 = db.createEvent({ title: 'View A', scheduledFor: todayY, startTime: '09:00', endTime: '09:30' });
  const v2 = db.createEvent({ title: 'View B', scheduledFor: todayY, startTime: '11:00', endTime: '11:30' });
  const n1 = db.createEvent({ title: 'Next 1', scheduledFor: nmFrom, startTime: '09:00', endTime: '09:30' });
  const n2 = db.createEvent({ title: 'Next 2', scheduledFor: nmFrom, startTime: '10:00', endTime: '10:30' });

  const where = { view: { mode: 'day', fromYmd: todayY, toYmd: todayY }, selected: { events: [sel.id] } };
  const ctx = buildFocusedContext(where, { timezone: 'America/New_York' });

  // Truncated to cap
  assert.equal(ctx.events.length, 3);
  assert.equal(ctx.meta && ctx.meta.contextTruncated, true);

  // First should be selected; remaining should prefer view over next_month
  const first = ctx.events[0];
  assert.equal(first.id, sel.id);

  const remaining = ctx.events.slice(1);
  const remainingSources = remaining.map(e => e.source);
  // Both remaining should be from 'view' given two view events available before next_month
  assert.equal(remainingSources.every(s => s === 'view'), true);
});
