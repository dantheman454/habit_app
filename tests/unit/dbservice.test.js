// Unit tests for DbService using an in-memory SQLite database
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, before, after } from 'node:test';
import { DbService } from '../../apps/server/database/DbService.js';

const ROOT = path.resolve(path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..'));
const SCHEMA_PATH = path.join(ROOT, 'apps', 'server', 'database', 'schema.sql');

/** @type {DbService} */
let db;

before(() => {
  db = new DbService(':memory:');
  const sql = readFileSync(SCHEMA_PATH, 'utf8');
  db.bootstrapSchema(sql);
});

after(() => {
  // better-sqlite3 closes automatically on GC; no explicit close on our wrapper
});

function ymd(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${da}`;
}

test('todos: create/get/update/delete + search + list + toggle occurrence', () => {
  const today = ymd();
  // create non-repeating
  const t1 = db.createTodo({ title: 'Buy milk', notes: '2%', scheduledFor: today, recurrence: { type: 'none' } });
  assert.ok(t1 && t1.id);
  const got = db.getTodoById(t1.id);
  assert.equal(got.title, 'Buy milk');

  // update
  const up = db.updateTodo(t1.id, { notes: 'whole', completed: true });
  assert.equal(up.notes, 'whole');
  assert.equal(up.completed, true);

  // list within range
  const list = db.listTodos({ from: today, to: today });
  assert.ok(list.find(x => x.id === t1.id));

  // search FTS
  const fts = db.searchTodos({ q: 'milk' });
  assert.ok(fts.some(x => x.id === t1.id));
  // search fallback (short query)
  const fallback = db.searchTodos({ q: 'm' });
  assert.ok(Array.isArray(fallback) && fallback.length >= 1);

  // create repeating and toggle occurrence
  const t2 = db.createTodo({ title: 'Repeat task', scheduledFor: today, recurrence: { type: 'weekly' } });
  const toggled = db.toggleTodoOccurrence({ id: t2.id, occurrenceDate: today, completed: true });
  assert.ok(Array.isArray(toggled.completedDates) && toggled.completedDates.includes(today));

  // switch the same occurrence to skipped via new status API, ensure completed removed and skipped added
  const afterSkip = db.setTodoOccurrenceStatus({ id: t2.id, occurrenceDate: today, status: 'skipped' });
  assert.equal(Array.isArray(afterSkip.completedDates) && afterSkip.completedDates.includes(today), false);
  assert.ok(Array.isArray(afterSkip.skippedDates) && afterSkip.skippedDates.includes(today));

  // delete
  db.deleteTodo(t1.id);
  assert.equal(db.getTodoById(t1.id), null);
});

test('events: create/get/update/list/search/delete', () => {
  const today = ymd();
  const e1 = db.createEvent({ title: 'Meeting', scheduledFor: today, startTime: '09:00', endTime: '10:00', recurrence: { type: 'none' } });
  assert.ok(e1 && e1.id);
  const eGet = db.getEventById(e1.id);
  assert.equal(eGet.startTime, '09:00');
  const eUpd = db.updateEvent(e1.id, { notes: 'Scrum' });
  const list = db.listEvents({ from: today, to: today });
  assert.ok(list.some(x => x.id === e1.id));
  const search = db.searchEvents({ q: 'meeting' });
  assert.ok(search.some(x => x.id === e1.id));
  // event occurrence completion not supported
  db.deleteEvent(e1.id);
  assert.equal(db.getEventById(e1.id), null);
});

test('goals: CRUD + items/children linking + cascades', () => {
  const g1 = db.createGoal({ title: 'Goal A' });
  const g2 = db.createGoal({ title: 'Goal B' });
  assert.ok(g1.id && g2.id);
  // children
  db.addGoalChildren(g1.id, [g2.id]);
  const withChild = db.getGoalById(g1.id, { includeChildren: true });
  assert.ok(Array.isArray(withChild.children) && withChild.children.includes(g2.id));
  // items
  const t = db.createTodo({ title: 'Linked', recurrence: { type: 'none' } });
  const e = db.createEvent({ title: 'Linked E', recurrence: { type: 'none' } });
  db.addGoalTodoItems(g1.id, [t.id]);
  db.addGoalEventItems(g1.id, [e.id]);
  const withItems = db.getGoalById(g1.id, { includeItems: true });
  assert.ok(withItems.items && withItems.items.todos.some(x => x.id === t.id));
  assert.ok(withItems.items.events.some(x => x.id === e.id));
  // remove links
  db.removeGoalTodoItem(g1.id, t.id);
  db.removeGoalEventItem(g1.id, e.id);
  const withItems2 = db.getGoalById(g1.id, { includeItems: true });
  assert.equal(withItems2.items.todos.some(x => x.id === t.id), false);
  assert.equal(withItems2.items.events.some(x => x.id === e.id), false);
  // delete cascades (goal hierarchy rows should go when parent deleted)
  db.deleteGoal(g1.id);
  assert.equal(db.getGoalById(g1.id), null);
});

test('idempotency cache: round-trip save/get', () => {
  const key = 'unit-key-1';
  const hash = 'abc123';
  const response = { ok: true, ts: new Date().toISOString() };
  db.saveIdempotentResponse({ idempotencyKey: key, requestHash: hash, response });
  const got = db.getIdempotentResponse({ idempotencyKey: key, requestHash: hash });
  assert.ok(typeof got === 'string');
  const parsed = JSON.parse(got);
  assert.equal(parsed.ok, true);
});

test('transactions: rollback on error', () => {
  let threw = false;
  try {
    db.runInTransaction(() => {
      db.createTodo({ title: 'tx1', recurrence: { type: 'none' } });
      throw new Error('boom');
    });
  } catch {
    threw = true;
  }
  assert.equal(threw, true);
  // Ensure the insert did not persist (search should not find 'tx1')
  const results = db.searchTodos({ q: 'tx1' });
  assert.equal(results.some(x => x.title === 'tx1'), false);
});


