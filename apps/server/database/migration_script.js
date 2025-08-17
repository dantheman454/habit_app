#!/usr/bin/env node
// One-off migration: drop `priority` columns from todos, events, habits.
// Safe to run multiple times; if columns already absent, it no-ops.

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const DB_PATH = process.env.APP_DB_PATH || path.join(process.cwd(), 'data', 'app.db');

function hasColumn(db, table, col) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => String(r.name) === String(col));
}

function execMany(db, sql) {
  const stmts = sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const s of stmts) db.prepare(s).run();
}

function migrate() {
  // Ensure parent folder exists
  try { fs.mkdirSync(path.dirname(DB_PATH), { recursive: true }); } catch {}
  const db = new Database(DB_PATH);
  try { db.pragma('foreign_keys = ON'); } catch {}
  try { db.pragma('journal_mode = WAL'); } catch {}

  const needTodos = hasColumn(db, 'todos', 'priority');
  const needEvents = hasColumn(db, 'events', 'priority');
  const needHabits = hasColumn(db, 'habits', 'priority');
  if (!needTodos && !needEvents && !needHabits) {
    console.log('[migration] No priority columns detected; nothing to do.');
    return;
  }

  console.log('[migration] Starting priority column removal transaction...');

  const tx = db.transaction(() => {
    // todos
    if (needTodos) {
      execMany(db, `
        CREATE TABLE IF NOT EXISTS todos_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          notes TEXT NOT NULL DEFAULT '',
          scheduled_for TEXT NULL,
          time_of_day TEXT NULL,
          completed INTEGER NOT NULL DEFAULT 0,
          recurrence TEXT NOT NULL DEFAULT '{"type":"none"}',
          completed_dates TEXT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO todos_new (id, title, notes, scheduled_for, time_of_day, completed, recurrence, completed_dates, created_at, updated_at)
        SELECT id, title, notes, scheduled_for, time_of_day, completed, recurrence, completed_dates, created_at, updated_at FROM todos;
        DROP TABLE todos;
        ALTER TABLE todos_new RENAME TO todos;
      `);
    }

    // events
    if (needEvents) {
      execMany(db, `
        CREATE TABLE IF NOT EXISTS events_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          notes TEXT NOT NULL DEFAULT '',
          scheduled_for TEXT NULL,
          start_time TEXT NULL,
          end_time TEXT NULL,
          location TEXT NULL,
          completed INTEGER NOT NULL DEFAULT 0,
          recurrence TEXT NOT NULL DEFAULT '{"type":"none"}',
          completed_dates TEXT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
  );
        DROP TABLE events;
        ALTER TABLE events_new RENAME TO events;
      `);
    }

    // habits
    if (needHabits) {
      execMany(db, `
        CREATE TABLE IF NOT EXISTS habits_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          notes TEXT NOT NULL DEFAULT '',
          scheduled_for TEXT NULL,
          time_of_day TEXT NULL,
          completed INTEGER NOT NULL DEFAULT 0,
          recurrence TEXT NOT NULL DEFAULT '{"type":"none"}',
          completed_dates TEXT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO habits_new (id, title, notes, scheduled_for, time_of_day, completed, recurrence, completed_dates, created_at, updated_at)
        SELECT id, title, notes, scheduled_for, time_of_day, completed, recurrence, completed_dates, created_at, updated_at FROM habits;
        DROP TABLE habits;
        ALTER TABLE habits_new RENAME TO habits;
      `);
    }

    // Recreate FTS triggers that were dropped with base tables
    execMany(db, `
      CREATE TRIGGER IF NOT EXISTS todos_ai AFTER INSERT ON todos BEGIN
        INSERT INTO todos_fts(rowid, title, notes) VALUES (new.id, new.title, new.notes);
      END;
      CREATE TRIGGER IF NOT EXISTS todos_ad AFTER DELETE ON todos BEGIN
        INSERT INTO todos_fts(todos_fts, rowid, title, notes) VALUES('delete', old.id, old.title, old.notes);
      END;
      CREATE TRIGGER IF NOT EXISTS todos_au AFTER UPDATE ON todos BEGIN
        INSERT INTO todos_fts(todos_fts, rowid, title, notes) VALUES('delete', old.id, old.title, old.notes);
        INSERT INTO todos_fts(rowid, title, notes) VALUES (new.id, new.title, new.notes);
      END;

      CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
        INSERT INTO events_fts(rowid, title, notes, location) VALUES (new.id, new.title, new.notes, new.location);
      END;
      CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
        INSERT INTO events_fts(events_fts, rowid, title, notes, location) VALUES('delete', old.id, old.title, old.notes, old.location);
      END;
      CREATE TRIGGER IF NOT EXISTS events_au AFTER UPDATE ON events BEGIN
        INSERT INTO events_fts(events_fts, rowid, title, notes, location) VALUES('delete', old.id, old.title, old.notes, old.location);
        INSERT INTO events_fts(rowid, title, notes, location) VALUES (new.id, new.title, new.notes, new.location);
      END;

      CREATE TRIGGER IF NOT EXISTS habits_ai AFTER INSERT ON habits BEGIN
        INSERT INTO habits_fts(rowid, title, notes) VALUES (new.id, new.title, new.notes);
      END;
      CREATE TRIGGER IF NOT EXISTS habits_ad AFTER DELETE ON habits BEGIN
        INSERT INTO habits_fts(habits_fts, rowid, title, notes) VALUES('delete', old.id, old.title, old.notes);
      END;
      CREATE TRIGGER IF NOT EXISTS habits_au AFTER UPDATE ON habits BEGIN
        INSERT INTO habits_fts(habits_fts, rowid, title, notes) VALUES('delete', old.id, old.title, old.notes);
        INSERT INTO habits_fts(rowid, title, notes) VALUES (new.id, new.title, new.notes);
      END;
    `);
  });

  tx();
  console.log('[migration] Completed successfully.');
}

try {
  migrate();
} catch (e) {
  console.error('[migration] Failed:', e?.message || e);
  process.exit(1);
}
