#!/usr/bin/env node

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

function weekRangeFromToday(tz) {
  try {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(now);
    const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
    const y = parseInt(map.year, 10);
    const m = parseInt(map.month, 10);
    const d = parseInt(map.day, 10);
    const today = new Date(y, m - 1, d);
    const jsWeekday = today.getDay(); // 0=Sun..6=Sat
    // NEW: Sunday-based calculation
    const daysFromSunday = jsWeekday; // Sun->0, Mon->1, Tue->2, etc.
    const sunday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysFromSunday);
    const saturday = new Date(sunday.getFullYear(), sunday.getMonth(), sunday.getDate() + 6);
    return { fromYmd: ymd(sunday), toYmd: ymd(saturday) };
  } catch {
    // Fallback to local
    const now = new Date();
    const jsWeekday = now.getDay();
    // NEW: Sunday-based calculation
    const daysFromSunday = jsWeekday;
    const sunday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysFromSunday);
    const saturday = new Date(sunday.getFullYear(), sunday.getMonth(), sunday.getDate() + 6);
    return { fromYmd: ymd(sunday), toYmd: ymd(saturday) };
  }
}

function endOfYearYmd() {
  const n = new Date();
  return `${n.getFullYear()}-12-31`;
}

function randomChoice(list) { return list[Math.floor(Math.random() * list.length)]; }

function randomTimeOrNull() {
  const opts = [null, '08:00', '12:00', '18:00'];
  return randomChoice(opts);
}

function randomRecurrence(forDate) {
  // 80% none, 20% one of daily|weekdays|weekly|every_n_days
  const r = Math.random();
  if (r < 0.8) return { type: 'none', until: endOfYearYmd() };
  const kind = randomChoice(['daily', 'weekdays', 'weekly', 'every_n_days']);
  if (kind === 'every_n_days') {
    return { type: 'every_n_days', intervalDays: 2 + Math.floor(Math.random() * 4), until: endOfYearYmd() };
  }
  return { type: kind, until: endOfYearYmd() };
}

function randomTitle(i) {
  const verbs = ['Plan', 'Write', 'Review', 'Clean', 'Organize', 'Call', 'Email', 'Draft', 'Buy', 'Prepare'];
  const objs = ['report', 'inbox', 'workspace', 'groceries', 'notes', 'proposal', 'schedule', 'budget', 'tests', 'backup'];
  return `${randomChoice(verbs)} ${randomChoice(objs)}`;
}

function pickDateWithinWeek(fromYmd, toYmd) {
  const [fy, fm, fd] = fromYmd.split('-').map(n => parseInt(n, 10));
  const start = new Date(fy, fm - 1, fd);
  const idx = Math.floor(Math.random() * 7);
  const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + idx);
  return ymd(d);
}

function seedTodos(db, count, tz) {
  const { fromYmd, toYmd } = weekRangeFromToday(tz);
  const nowIso = new Date().toISOString();
  const insert = db.prepare(`
  INSERT INTO todos(title, notes, scheduled_for, time_of_day, completed, recurrence, completed_dates, created_at, updated_at)
  VALUES (@title, @notes, @scheduled_for, @time_of_day, @completed, @recurrence, @completed_dates, @created_at, @updated_at)
  `);
  const tx = db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const scheduledFor = pickDateWithinWeek(fromYmd, toYmd);
      const rec = randomRecurrence(scheduledFor);
      const completed = Math.random() < 0.3 ? 1 : 0;
      const payload = {
        title: randomTitle(i),
        notes: '',
        scheduled_for: scheduledFor,
        time_of_day: randomTimeOrNull(),
        completed,
        recurrence: JSON.stringify(rec),
        completed_dates: null,
        created_at: nowIso,
        updated_at: nowIso,
      };
      insert.run(payload);
    }
  });
  tx();
  const cnt = db.prepare('SELECT COUNT(*) as c FROM todos').get().c;
  return { fromYmd, toYmd, count: cnt };
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

function main() {
  const tz = process.env.TZ_NAME || 'America/New_York';
  // Replace without backup: wipe and rebuild
  wipeDbFiles();
  const db = new Database(dbPath);
  try { db.pragma('foreign_keys = ON'); } catch {}
  try { db.pragma('journal_mode = WAL'); } catch {}
  bootstrapSchema(db);
  const info = seedTodos(db, 30, tz);
  db.close();
  console.log(`Seeded ${info.count} todos for week ${info.fromYmd}..${info.toYmd} into ${dbPath}`);
}

try { main(); }
catch (e) { console.error('Seeding failed:', e); process.exit(1); }


