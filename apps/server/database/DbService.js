import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { ymdInTimeZone } from '../utils/date.js';

export class DbService {
  constructor(dbPath = './data/app.db') {
    this.dbPath = dbPath;
    this.db = null;
  }

  openIfNeeded() {
    if (this.db) return;
    // Allow tests or callers to set APP_DB_PATH after import time.
    // If the database has not been opened yet, adopt the latest env path.
    try {
      const envPath = process.env.APP_DB_PATH;
      if (envPath && String(envPath) !== String(this.dbPath)) {
        this.dbPath = String(envPath);
      }
    } catch {}
    const dataDir = path.dirname(this.dbPath);
    try { fs.mkdirSync(dataDir, { recursive: true }); } catch {}
    this.db = new Database(this.dbPath);
    try { this.db.pragma('foreign_keys = ON'); } catch {}
    try { this.db.pragma('journal_mode = WAL'); } catch {}
  }

  bootstrapSchema(schemaSql) {
    // If APP_DB_PATH changed since initial open, reopen on the new path for isolation (tests)
    try {
      const envPath = process.env.APP_DB_PATH;
      if (envPath && String(envPath) !== String(this.dbPath)) {
        if (this.db) {
          try { this.db.close(); } catch {}
          this.db = null;
        }
        this.dbPath = String(envPath);
      }
    } catch {}
    this.openIfNeeded();
    this.db.exec(schemaSql);
  // Cleanup legacy tables (safe no-op if absent)
  try { this.db.exec('DROP TABLE IF EXISTS assistant_router_cache'); } catch {}
  }

  begin() { this.openIfNeeded(); return this.db.transaction(() => {})(); }
  commit(_tx) { /* better-sqlite3 commits at end of transaction function */ }
  rollback(_tx) { /* handled by throwing inside transaction */ }

  runInTransaction(fn) {
    this.openIfNeeded();
    const tx = this.db.transaction((cb) => cb());
    return tx(fn);
  }

  // Idempotency helpers
  getIdempotentResponse({ idempotencyKey, requestHash }) {
    this.openIfNeeded();
    const row = this.db.prepare('SELECT response FROM idempotency WHERE idempotency_key=@k AND request_hash=@h').get({ k: idempotencyKey, h: requestHash });
    return row ? row.response : null;
  }
  saveIdempotentResponse({ idempotencyKey, requestHash, response }) {
    this.openIfNeeded();
    const ts = new Date().toISOString();
    this.db.prepare('INSERT OR REPLACE INTO idempotency (idempotency_key, request_hash, response, ts) VALUES (@k,@h,@r,@ts)')
      .run({ k: idempotencyKey, h: requestHash, r: JSON.stringify(response), ts });
  }

  // Audit
  logAudit({ action, entity = null, entityId = null, payload = null }) {
    this.openIfNeeded();
    const ts = new Date().toISOString();
    this.db.prepare('INSERT INTO audit_log (ts, action, entity, entity_id, payload) VALUES (@ts,@action,@entity,@entity_id,@payload)')
      .run({ ts, action, entity, entity_id: entityId, payload: typeof payload === 'string' ? payload : (payload ? JSON.stringify(payload) : null) });
  }

  // Tasks
  createTask({ title, notes = '', scheduledFor = null, recurrence = { type: 'none' }, status = 'pending', context = 'personal' }) {
    this.openIfNeeded();
    const tz = process.env.TZ_NAME || 'America/New_York';
    const isRepeating = !!(recurrence && recurrence.type && recurrence.type !== 'none');
    if (isRepeating && (scheduledFor === null || scheduledFor === undefined)) {
      throw new Error('missing_anchor_for_recurrence');
    }
    if (!isRepeating && (scheduledFor === null || scheduledFor === undefined)) {
      try { scheduledFor = ymdInTimeZone(new Date(), tz); } catch { scheduledFor = new Date().toISOString().slice(0,10); }
    }
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO tasks(title, notes, scheduled_for, status, recurrence, completed_dates, skipped_dates, context, created_at, updated_at)
      VALUES (@title, @notes, @scheduled_for, @status, @recurrence, NULL, NULL, @context, @created_at, @updated_at)
    `);
    const info = stmt.run({
      title,
      notes,
      scheduled_for: scheduledFor,
      status: String(status || 'pending'),
      recurrence: JSON.stringify(recurrence || { type: 'none' }),
      context: String(context || 'personal'),
      created_at: now,
      updated_at: now,
    });
    return this.getTaskById(info.lastInsertRowid);
  }

  getTaskById(id) {
    this.openIfNeeded();
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    if (!row) return null;
    return this._mapTask(row);
  }

  updateTask(id, patch) {
    this.openIfNeeded();
    const t = this.getTaskById(id);
    if (!t) throw new Error('not_found');
    // Filter out undefined values from patch to avoid overwriting existing data
    const filteredPatch = Object.fromEntries(
      Object.entries(patch).filter(([_, value]) => value !== undefined)
    );
    const merged = { ...t, ...filteredPatch };
    const tz = process.env.TZ_NAME || 'America/New_York';
    const isRepeating = !!(merged.recurrence && merged.recurrence.type && merged.recurrence.type !== 'none');
    if (isRepeating && (merged.scheduledFor === null || merged.scheduledFor === undefined)) {
      throw new Error('missing_anchor_for_recurrence');
    }
    if (!isRepeating && (merged.scheduledFor === null || merged.scheduledFor === undefined)) {
      try { merged.scheduledFor = ymdInTimeZone(new Date(), tz); } catch { merged.scheduledFor = new Date().toISOString().slice(0,10); }
    }
    // Back-compat: if callers pass completed boolean, map to status
    if (Object.prototype.hasOwnProperty.call(patch || {}, 'completed') && patch.completed !== undefined) {
      try { merged.status = patch.completed ? 'completed' : 'pending'; } catch {}
    }
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE tasks SET title=@title, notes=@notes, scheduled_for=@scheduled_for, status=@status, recurrence=@recurrence, context=@context, updated_at=@updated_at WHERE id=@id`).run({
      id,
      title: merged.title,
      notes: merged.notes,
      scheduled_for: merged.scheduledFor ?? null,
      status: String(merged.status || 'pending'),
      recurrence: JSON.stringify(merged.recurrence || { type: 'none' }),
      context: String(merged.context || 'personal'),
      updated_at: now,
    });
    return this.getTaskById(id);
  }

  // Events
  createEvent({ title, notes = '', scheduledFor = null, startTime = null, endTime = null, location = null, recurrence = { type: 'none' }, completed = false, context = 'personal' }) {
    this.openIfNeeded();
    const tz = process.env.TZ_NAME || 'America/New_York';
    const isRepeating = !!(recurrence && recurrence.type && recurrence.type !== 'none');
    if (isRepeating && (scheduledFor === null || scheduledFor === undefined)) {
      throw new Error('missing_anchor_for_recurrence');
    }
    if (!isRepeating && (scheduledFor === null || scheduledFor === undefined)) {
      try { scheduledFor = ymdInTimeZone(new Date(), tz); } catch { scheduledFor = new Date().toISOString().slice(0,10); }
    }
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO events(title, notes, scheduled_for, start_time, end_time, location, recurrence, context, created_at, updated_at)
      VALUES (@title, @notes, @scheduled_for, @start_time, @end_time, @location, @recurrence, @context, @created_at, @updated_at)
    `);
    const info = stmt.run({
      title,
      notes,
      scheduled_for: scheduledFor,
      start_time: startTime,
      end_time: endTime,
      location,
      recurrence: JSON.stringify(recurrence || { type: 'none' }),
      context: String(context || 'personal'),
      created_at: now,
      updated_at: now,
    });
    return this.getEventById(info.lastInsertRowid);
  }


  getEventById(id) {
    this.openIfNeeded();
    const row = this.db.prepare('SELECT * FROM events WHERE id = ?').get(id);
    if (!row) return null;
    return this._mapEvent(row);
  }

  updateEvent(id, patch) {
    this.openIfNeeded();
    const e = this.getEventById(id);
    if (!e) throw new Error('not_found');
    // Filter out undefined values from patch to avoid overwriting existing data
    const filteredPatch = Object.fromEntries(
      Object.entries(patch).filter(([_, value]) => value !== undefined)
    );
    const merged = { ...e, ...filteredPatch };
    const tz = process.env.TZ_NAME || 'America/New_York';
    const isRepeating = !!(merged.recurrence && merged.recurrence.type && merged.recurrence.type !== 'none');
    if (isRepeating && (merged.scheduledFor === null || merged.scheduledFor === undefined)) {
      throw new Error('missing_anchor_for_recurrence');
    }
    if (!isRepeating && (merged.scheduledFor === null || merged.scheduledFor === undefined)) {
      try { merged.scheduledFor = ymdInTimeZone(new Date(), tz); } catch { merged.scheduledFor = new Date().toISOString().slice(0,10); }
    }
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE events SET title=@title, notes=@notes, scheduled_for=@scheduled_for, start_time=@start_time, end_time=@end_time, location=@location, recurrence=@recurrence, context=@context, updated_at=@updated_at WHERE id=@id`).run({
      id,
      title: merged.title,
      notes: merged.notes,
      scheduled_for: merged.scheduledFor ?? null,
      start_time: merged.startTime ?? null,
      end_time: merged.endTime ?? null,
      location: merged.location ?? null,
      recurrence: JSON.stringify(merged.recurrence || { type: 'none' }),
      context: String(merged.context || 'personal'),
      updated_at: now,
    });
    return this.getEventById(id);
  }

  deleteEvent(id) {
    this.openIfNeeded();
    this.db.prepare('DELETE FROM events WHERE id = ?').run(id);
  }

  listEvents({ from = null, to = null, completed = null, context = null } = {}) {
    this.openIfNeeded();
    const cond = ['scheduled_for IS NOT NULL'];
    const params = {};
    if (from) { cond.push('scheduled_for >= @from'); params.from = from; }
    if (to) { cond.push("scheduled_for < date(@to, '+1 day')"); params.to = to; }
    if (completed !== null && completed !== undefined) { cond.push('completed = @completed'); params.completed = completed ? 1 : 0; }
    if (context) { cond.push('context = @context'); params.context = String(context); }
    const sql = `SELECT * FROM events WHERE ${cond.join(' AND ')} ORDER BY scheduled_for ASC, start_time ASC, id ASC`;
    const rows = this.db.prepare(sql).all(params);
    return rows.map(r => this._mapEvent(r));
  }

  searchEvents({ q, completed = null, context = null }) {
    this.openIfNeeded();
    if (!q || String(q).length < 2) {
      const sql = 'SELECT * FROM events ORDER BY id ASC';
      const rows = this.db.prepare(sql).all();
      let items = rows.map(r => this._mapEvent(r));
      if (context) items = items.filter(e => String(e.context) === String(context));
      return items;
    }
    const rows = this.db.prepare('SELECT e.* FROM events e JOIN events_fts f ON f.rowid = e.id WHERE events_fts MATCH @q').all({ q: String(q) });
    let items = rows.map(r => this._mapEvent(r));
    if (context) items = items.filter(e => String(e.context) === String(context));
    return items;
  }

  deleteTask(id) {
    this.openIfNeeded();
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  }

  listTasks({ from = null, to = null, status = null, context = null } = {}) {
    this.openIfNeeded();
    const cond = ['scheduled_for IS NOT NULL'];
    const params = {};
    if (from) { cond.push('scheduled_for >= @from'); params.from = from; }
    if (to) { cond.push("scheduled_for < date(@to, '+1 day')"); params.to = to; }
    if (status) { cond.push('status = @status'); params.status = String(status); }
    if (context) { cond.push('context = @context'); params.context = String(context); }
    const sql = `SELECT * FROM tasks WHERE ${cond.join(' AND ')} ORDER BY scheduled_for ASC, id ASC`;
    const rows = this.db.prepare(sql).all(params);
    return rows.map(r => this._mapTask(r));
  }

  searchTasks({ q, status = null, context = null }) {
    this.openIfNeeded();
    if (!q || String(q).length < 2) {
      const sql = 'SELECT * FROM tasks ORDER BY id ASC';
      const rows = this.db.prepare(sql).all();
      let items = rows.map(r => this._mapTask(r));
      if (status) items = items.filter(t => String(t.status) === String(status));
      if (context) items = items.filter(t => String(t.context) === String(context));
      return items;
    }
    const base = `SELECT t.* FROM tasks t JOIN tasks_fts f ON f.rowid = t.id WHERE tasks_fts MATCH @q`;
    const rows = this.db.prepare(base).all({ q: String(q) });
    let items = rows.map(r => this._mapTask(r));
    if (status) items = items.filter(t => String(t.status) === String(status));
    if (context) items = items.filter(t => String(t.context) === String(context));
    return items;
  }

  // Set per-occurrence status for repeating tasks
  setTaskOccurrenceStatus({ id, occurrenceDate, status }) {
    this.openIfNeeded();
    const t = this.getTaskById(id);
    if (!t) throw new Error('not_found');
    const type = t.recurrence && t.recurrence.type;
    if (!type || type === 'none') throw new Error('not_repeating');
    const comp = Array.isArray(t.completedDates) ? t.completedDates.slice() : [];
    const skip = Array.isArray(t.skippedDates) ? t.skippedDates.slice() : [];
    const rm = (list) => { const i = list.indexOf(occurrenceDate); if (i !== -1) list.splice(i, 1); };
    if (status === 'completed') {
      if (!comp.includes(occurrenceDate)) comp.push(occurrenceDate);
      rm(skip);
    } else if (status === 'skipped') {
      if (!skip.includes(occurrenceDate)) skip.push(occurrenceDate);
      rm(comp);
    } else {
      // pending: remove from both
      rm(comp); rm(skip);
    }
    const now = new Date().toISOString();
    this.db.prepare('UPDATE tasks SET completed_dates=@completed_dates, skipped_dates=@skipped_dates, updated_at=@updated_at WHERE id=@id').run({ id, completed_dates: JSON.stringify(comp), skipped_dates: JSON.stringify(skip), updated_at: now });
    return this.getTaskById(id);
  }

  // Back-compat wrapper: behave like old toggle with boolean completed
  toggleTaskOccurrence({ id, occurrenceDate, completed }) {
    const status = (completed === undefined) ? 'completed' : (completed ? 'completed' : 'pending');
    return this.setTaskOccurrenceStatus({ id, occurrenceDate, status });
  }

  // Helpers
  _mapTask(r) {
    return {
      id: r.id,
      title: r.title,
      notes: r.notes,
      scheduledFor: r.scheduled_for,
      
      status: String(r.status || 'pending'),
      recurrence: (() => { try { return JSON.parse(r.recurrence || '{"type":"none"}'); } catch { return { type: 'none' }; } })(),
      completedDates: (() => { try { return r.completed_dates ? JSON.parse(r.completed_dates) : null; } catch { return null; } })(),
      skippedDates: (() => { try { return r.skipped_dates ? JSON.parse(r.skipped_dates) : null; } catch { return null; } })(),
      context: r.context,
      // Back-compat boolean derived from status
      completed: String(r.status || 'pending') === 'completed',
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  _mapEvent(r) {
    return {
      id: r.id,
      title: r.title,
      notes: r.notes,
      scheduledFor: r.scheduled_for,
      startTime: r.start_time,
      endTime: r.end_time,
      location: r.location,
      
      recurrence: (() => { try { return JSON.parse(r.recurrence || '{"type":"none"}'); } catch { return { type: 'none' }; } })(),
      context: r.context,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

}

const instance = new DbService(process.env.APP_DB_PATH || './data/app.db');
export default instance;


