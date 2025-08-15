#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const dataDir = path.join(repoRoot, 'data');
const dbPath = path.join(dataDir, 'app.db');
const schemaPath = path.join(repoRoot, 'apps', 'server', 'database', 'schema.sql');

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch {}
}

function normalizeTodo(t) {
  const nowIso = new Date().toISOString();
  const rec = (t && typeof t.recurrence === 'object') ? t.recurrence : { type: 'none' };
  return {
    title: String(t.title || '').trim(),
    notes: String(t.notes || ''),
    scheduledFor: t.scheduledFor ?? null,
    timeOfDay: t.timeOfDay ?? null,
    priority: ['low','medium','high'].includes(String(t.priority)) ? t.priority : 'medium',
    completed: !!t.completed,
    recurrence: rec,
    completedDates: Array.isArray(t.completedDates) ? t.completedDates : null,
    createdAt: t.createdAt || nowIso,
    updatedAt: t.updatedAt || nowIso,
  };
}

function bootstrapSchema(db) {
  const sql = fs.readFileSync(schemaPath, 'utf8');
  db.exec(sql);
}

function main() {
  ensureDir(dataDir);
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  bootstrapSchema(db);

  const todosPath = path.join(dataDir, 'todos.json');
  if (fs.existsSync(todosPath)) {
    const list = readJson(todosPath);
    const insert = db.prepare(`
      INSERT INTO todos(title, notes, scheduled_for, time_of_day, priority, completed, recurrence, completed_dates, created_at, updated_at)
      VALUES (@title, @notes, @scheduled_for, @time_of_day, @priority, @completed, @recurrence, @completed_dates, @created_at, @updated_at)
    `);
    const tx = db.transaction((rows) => {
      for (const raw of rows) {
        const t = normalizeTodo(raw);
        insert.run({
          title: t.title,
          notes: t.notes,
          scheduled_for: t.scheduledFor,
          time_of_day: t.timeOfDay,
          priority: t.priority,
          completed: t.completed ? 1 : 0,
          recurrence: JSON.stringify(t.recurrence),
          completed_dates: t.completedDates ? JSON.stringify(t.completedDates) : null,
          created_at: t.createdAt,
          updated_at: t.updatedAt,
        });
      }
    });
    tx(list);
  }

  const auditPath = path.join(dataDir, 'audit.jsonl');
  if (fs.existsSync(auditPath)) {
    const append = db.prepare(`INSERT INTO audit_log (ts, action, entity, entity_id, payload) VALUES (@ts, @action, @entity, @entity_id, @payload)`);
    const lines = fs.readFileSync(auditPath, 'utf8').split(/\r?\n/).filter(Boolean);
    const tx = db.transaction((rows) => {
      for (const line of rows) {
        try {
          const obj = JSON.parse(line);
          append.run({
            ts: obj.ts || new Date().toISOString(),
            action: obj.action || 'unknown',
            entity: obj.entity || null,
            entity_id: Number.isFinite(obj.id) ? obj.id : null,
            payload: line,
          });
        } catch {
          append.run({ ts: new Date().toISOString(), action: 'unknown', entity: null, entity_id: null, payload: line });
        }
      }
    });
    tx(lines);
  }

  db.close();
  console.log('Migration complete. DB at', dbPath);
}

try { main(); }
catch (e) { console.error('Migration failed:', e); process.exit(1); }


