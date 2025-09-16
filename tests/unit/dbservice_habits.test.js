import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, before } from 'node:test';
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

function ymd(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${da}`;
}

test('habits: create/get/update/list/search/delete', () => {
  const today = ymd();
  const h = db.createHabit({ title: 'Water', notes: '8 glasses', startedOn: today, recurrence: { type: 'daily' }, weeklyTargetCount: 5, context: 'personal' });
  assert.ok(h && h.id);
  const got = db.getHabitById(h.id);
  assert.equal(got?.title, 'Water');

  const upd = db.updateHabit(h.id, { notes: '10 glasses' });
  assert.equal(upd.notes, '10 glasses');

  const list = db.listHabits({ context: 'personal' });
  assert.ok(Array.isArray(list) && list.some(x => x.id === h.id));

  const search = db.searchHabits({ q: 'water', context: 'personal' });
  assert.ok(search.some(x => x.id === h.id));

  db.deleteHabit(h.id);
  assert.equal(db.getHabitById(h.id), null);
});

test('habit logs: upsert/list/delete', () => {
  const today = ymd();
  const h = db.createHabit({ title: 'Read', startedOn: today, recurrence: { type: 'none' }, weeklyTargetCount: null, context: 'personal' });
  const d1 = today;
  const up1 = db.upsertHabitLog({ habitId: h.id, date: d1, done: true, note: null });
  assert.equal(up1.done, true);
  const logs = db.listHabitLogs({ habitId: h.id, from: today, to: today });
  assert.ok(logs.some(l => l.date === d1 && l.done === true));
  db.deleteHabitLog({ habitId: h.id, date: d1 });
  const logsAfter = db.listHabitLogs({ habitId: h.id, from: today, to: today });
  assert.equal(logsAfter.some(l => l.date === d1), false);
});


