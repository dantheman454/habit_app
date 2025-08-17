#!/usr/bin/env node

// Full reset and seed: removes existing DB files and seeds only todos and events
// - 30 todos
// - 15 events
// All scheduled within the next two weeks (including today)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const dataDir = path.join(repoRoot, 'data');
const defaultDbPath = path.join(dataDir, 'app.db');
const dbPath = process.env.APP_DB_PATH || defaultDbPath;
const schemaPath = path.join(repoRoot, 'apps', 'server', 'database', 'schema.sql');

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

function randInt(min, max) { // inclusive
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomChoice(list) { return list[Math.floor(Math.random() * list.length)]; }


function endOfYearYmd() {
  const n = new Date();
  return `${n.getFullYear()}-12-31`;
}

function randomRecurrence() {
  // Mostly non-repeating for simple demo; some repeating for variety
  const r = Math.random();
  if (r < 0.8) return { type: 'none', until: endOfYearYmd() };
  const kind = randomChoice(['daily', 'weekdays', 'weekly', 'every_n_days']);
  if (kind === 'every_n_days') {
    return { type: 'every_n_days', intervalDays: randInt(2, 5), until: endOfYearYmd() };
  }
  return { type: kind, until: endOfYearYmd() };
}

function randomTitle() {
  const verbs = ['Plan', 'Write', 'Review', 'Clean', 'Organize', 'Call', 'Email', 'Draft', 'Buy', 'Prepare'];
  const objs = ['report', 'inbox', 'workspace', 'groceries', 'notes', 'proposal', 'schedule', 'budget', 'tests', 'backup'];
  return `${randomChoice(verbs)} ${randomChoice(objs)}`;
}

function randomTodoTimeOrNull() {
  const opts = [null, '08:00', '10:00', '12:00', '15:00', '18:00'];
  return randomChoice(opts);
}

function pickDateWithinNextTwoWeeks() {
  const today = new Date();
  const offset = randInt(0, 13); // 0..13 inclusive => 14 days window
  return ymd(addDays(today, offset));
}

function wipeDbFiles() {
  try { fs.mkdirSync(path.dirname(dbPath), { recursive: true }); } catch {}
  for (const f of [dbPath, `${dbPath}-shm`, `${dbPath}-wal`]) {
    try { fs.unlinkSync(f); } catch {}
  }
}

function bootstrapSchema(db) {
  const sql = fs.readFileSync(schemaPath, 'utf8');
  db.exec(sql);
}

function seedTodos(db, count) {
  const nowIso = new Date().toISOString();
  const insert = db.prepare(`
  INSERT INTO todos(title, notes, scheduled_for, time_of_day, completed, recurrence, completed_dates, created_at, updated_at)
  VALUES (@title, @notes, @scheduled_for, @time_of_day, @completed, @recurrence, @completed_dates, @created_at, @updated_at)
  `);
  const tx = db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const scheduledFor = pickDateWithinNextTwoWeeks();
      const rec = randomRecurrence();
      const payload = {
        title: randomTitle(),
        notes: '',
        scheduled_for: scheduledFor,
        time_of_day: randomTodoTimeOrNull(),
        completed: 0,
        recurrence: JSON.stringify(rec),
        completed_dates: null,
        created_at: nowIso,
        updated_at: nowIso,
      };
      insert.run(payload);
    }
  });
  tx();
  return db.prepare('SELECT COUNT(*) as c FROM todos').get().c;
}

function randomEventWindow() {
  // Start between 7:00 and 19:00; duration 30–120 minutes, aligned to 30-min slots
  const startHour = randInt(7, 19);
  const startMin = randomChoice([0, 30]);
  const durMins = randomChoice([30, 60, 60, 90, 120]);
  const endHourRaw = startHour * 60 + startMin + durMins;
  const endHour = Math.min(23 * 60 + 30, endHourRaw); // cap within day
  const h1 = String(Math.floor((startHour * 60 + startMin) / 60)).padStart(2, '0');
  const m1 = String((startHour * 60 + startMin) % 60).padStart(2, '0');
  const h2 = String(Math.floor(endHour / 60)).padStart(2, '0');
  const m2 = String(endHour % 60).padStart(2, '0');
  return { start: `${h1}:${m1}`, end: `${h2}:${m2}` };
}

function randomLocation() {
  const places = ['Office', 'Zoom', 'Cafe', 'Library', 'Gym', 'Home'];
  return randomChoice(places);
}

function seedEvents(db, count) {
  const nowIso = new Date().toISOString();
  const insert = db.prepare(`
  INSERT INTO events(title, notes, scheduled_for, start_time, end_time, location, completed, recurrence, completed_dates, created_at, updated_at)
  VALUES (@title, @notes, @scheduled_for, @start_time, @end_time, @location, @completed, @recurrence, @completed_dates, @created_at, @updated_at)
  `);
  const tx = db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const scheduledFor = pickDateWithinNextTwoWeeks();
      const { start, end } = randomEventWindow();
      const rec = randomRecurrence();
      const payload = {
        title: `${randomTitle()} (Event)`,
        notes: '',
        scheduled_for: scheduledFor,
        start_time: start,
        end_time: end,
        location: randomLocation(),
        completed: 0,
        recurrence: JSON.stringify(rec),
        completed_dates: null,
        created_at: nowIso,
        updated_at: nowIso,
      };
      insert.run(payload);
    }
  });
  tx();
  return db.prepare('SELECT COUNT(*) as c FROM events').get().c;
}

function main() {
  // 1) full reset
  wipeDbFiles();
  const db = new Database(dbPath);
  try { db.pragma('foreign_keys = ON'); } catch {}
  try { db.pragma('journal_mode = WAL'); } catch {}
  // 2) rebuild schema
  bootstrapSchema(db);
  // 3) seed only todos and events
  const todoCount = seedTodos(db, 30);
  const eventCount = seedEvents(db, 15);
  db.close();
  console.log(`Seed complete: ${todoCount} todos, ${eventCount} events -> ${dbPath}`);
}

try { main(); }
catch (e) { console.error('Seeding failed:', e); process.exit(1); }
