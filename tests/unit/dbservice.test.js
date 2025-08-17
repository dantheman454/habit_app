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
  // priority removed

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

  // delete
  db.deleteTodo(t1.id);
  assert.equal(db.getTodoById(t1.id), null);
});

test('events: create/get/update/list/search/toggle occurrence/delete', () => {
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
  // repeating occurrence toggle
  const e2 = db.createEvent({ title: 'Standup', scheduledFor: today, startTime: '10:00', endTime: '10:15', recurrence: { type: 'daily' } });
  const e2T = db.toggleEventOccurrence({ id: e2.id, occurrenceDate: today, completed: true });
  assert.ok(Array.isArray(e2T.completedDates) && e2T.completedDates.includes(today));
  db.deleteEvent(e1.id);
  assert.equal(db.getEventById(e1.id), null);
});

test('habits: CRUD + list/search/toggle occurrence', () => {
  const today = ymd();
  // create repeating habit
  const h1 = db.createHabit({ title: 'Meditate', scheduledFor: today, recurrence: { type: 'daily' } });
  assert.ok(h1 && h1.id);
  const g = db.getHabitById(h1.id);
  assert.equal(g.title, 'Meditate');
  // update
  const up = db.updateHabit(h1.id, { notes: '10 min' });
  assert.equal(up.notes, '10 min');
  // list within range
  const list = db.listHabits({ from: today, to: today });
  assert.ok(list.find(x => x.id === h1.id));
  // search
  const s = db.searchHabits({ q: 'meditate' });
  assert.ok(s.some(x => x.id === h1.id));
  // toggle occurrence
  const toggled = db.toggleHabitOccurrence({ id: h1.id, occurrenceDate: today, completed: true });
  assert.ok(Array.isArray(toggled.completedDates) && toggled.completedDates.includes(today));
  // delete
  db.deleteHabit(h1.id);
  assert.equal(db.getHabitById(h1.id), null);
});

test('habits: compute stats over range', () => {
  const today = ymd();
  const yesterday = ymd(new Date(Date.now() - 24*60*60*1000));
  const twoAgo = ymd(new Date(Date.now() - 2*24*60*60*1000));
  const h = db.createHabit({ title: 'Stats Habit', scheduledFor: today, recurrence: { type: 'daily' } });
  // Mark a 3-day current streak
  db.toggleHabitOccurrence({ id: h.id, occurrenceDate: twoAgo, completed: true });
  db.toggleHabitOccurrence({ id: h.id, occurrenceDate: yesterday, completed: true });
  db.toggleHabitOccurrence({ id: h.id, occurrenceDate: today, completed: true });
  const got = db.getHabitById(h.id);
  const from = ymd(new Date(Date.now() - 6*24*60*60*1000));
  const to = today;
  const stats = db.computeHabitStats(got, { from, to });
  assert.equal(typeof stats.currentStreak, 'number');
  assert.ok(stats.currentStreak >= 1);
  assert.equal(typeof stats.longestStreak, 'number');
  assert.ok(Array.isArray(stats.weekHeatmap));
  assert.ok(stats.weekHeatmap.length >= 1 && stats.weekHeatmap.length <= 7);
});

test('habits: link/unlink todos and events', () => {
  const today = ymd();
  const h = db.createHabit({ title: 'Linker', scheduledFor: today, recurrence: { type: 'daily' } });
  const t = db.createTodo({ title: 'T link', recurrence: { type: 'none' } });
  const e = db.createEvent({ title: 'E link', recurrence: { type: 'none' } });
  // Link
  db.addHabitTodoItems(h.id, [t.id]);
  db.addHabitEventItems(h.id, [e.id]);
  // Verify via direct SQL
  const c1 = db.db.prepare('SELECT COUNT(*) AS c FROM habit_todo_items WHERE habit_id=? AND todo_id=?').get(h.id, t.id).c;
  const c2 = db.db.prepare('SELECT COUNT(*) AS c FROM habit_event_items WHERE habit_id=? AND event_id=?').get(h.id, e.id).c;
  assert.equal(c1, 1);
  assert.equal(c2, 1);
  // Unlink
  db.removeHabitTodoItem(h.id, t.id);
  db.removeHabitEventItem(h.id, e.id);
  const c1b = db.db.prepare('SELECT COUNT(*) AS c FROM habit_todo_items WHERE habit_id=? AND todo_id=?').get(h.id, t.id).c;
  const c2b = db.db.prepare('SELECT COUNT(*) AS c FROM habit_event_items WHERE habit_id=? AND event_id=?').get(h.id, e.id).c;
  assert.equal(c1b, 0);
  assert.equal(c2b, 0);
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


