import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

export class DbService {
  constructor(dbPath = './data/app.db') {
    this.dbPath = dbPath;
    this.db = null;
  }

  openIfNeeded() {
    if (this.db) return;
    const dataDir = path.dirname(this.dbPath);
    try { fs.mkdirSync(dataDir, { recursive: true }); } catch {}
    this.db = new Database(this.dbPath);
    try { this.db.pragma('foreign_keys = ON'); } catch {}
    try { this.db.pragma('journal_mode = WAL'); } catch {}
  }

  bootstrapSchema(schemaSql) {
    this.openIfNeeded();
    this.db.exec(schemaSql);
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

  // Minimal Todos subset to validate wiring later
  createTodo({ title, notes = '', scheduledFor = null, timeOfDay = null, priority = 'medium', recurrence = { type: 'none' }, completed = false }) {
    this.openIfNeeded();
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO todos(title, notes, scheduled_for, time_of_day, priority, completed, recurrence, completed_dates, created_at, updated_at)
      VALUES (@title, @notes, @scheduled_for, @time_of_day, @priority, @completed, @recurrence, NULL, @created_at, @updated_at)
    `);
    const info = stmt.run({
      title,
      notes,
      scheduled_for: scheduledFor,
      time_of_day: timeOfDay,
      priority,
      completed: completed ? 1 : 0,
      recurrence: JSON.stringify(recurrence || { type: 'none' }),
      created_at: now,
      updated_at: now,
    });
    return this.getTodoById(info.lastInsertRowid);
  }

  getTodoById(id) {
    this.openIfNeeded();
    const row = this.db.prepare('SELECT * FROM todos WHERE id = ?').get(id);
    if (!row) return null;
    return this._mapTodo(row);
  }

  updateTodo(id, patch) {
    this.openIfNeeded();
    const t = this.getTodoById(id);
    if (!t) throw new Error('not_found');
    const merged = { ...t, ...patch };
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE todos SET title=@title, notes=@notes, scheduled_for=@scheduled_for, time_of_day=@time_of_day, priority=@priority, completed=@completed, recurrence=@recurrence, updated_at=@updated_at WHERE id=@id`).run({
      id,
      title: merged.title,
      notes: merged.notes,
      scheduled_for: merged.scheduledFor ?? null,
      time_of_day: merged.timeOfDay ?? null,
      priority: merged.priority,
      completed: merged.completed ? 1 : 0,
      recurrence: JSON.stringify(merged.recurrence || { type: 'none' }),
      updated_at: now,
    });
    return this.getTodoById(id);
  }

  // Events
  createEvent({ title, notes = '', scheduledFor = null, startTime = null, endTime = null, location = null, priority = 'medium', recurrence = { type: 'none' }, completed = false }) {
    this.openIfNeeded();
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO events(title, notes, scheduled_for, start_time, end_time, location, priority, completed, recurrence, completed_dates, created_at, updated_at)
      VALUES (@title, @notes, @scheduled_for, @start_time, @end_time, @location, @priority, @completed, @recurrence, NULL, @created_at, @updated_at)
    `);
    const info = stmt.run({
      title,
      notes,
      scheduled_for: scheduledFor,
      start_time: startTime,
      end_time: endTime,
      location,
      priority,
      completed: completed ? 1 : 0,
      recurrence: JSON.stringify(recurrence || { type: 'none' }),
      created_at: now,
      updated_at: now,
    });
    return this.getEventById(info.lastInsertRowid);
  }

  // Habits (parity with todos)
  createHabit({ title, notes = '', scheduledFor = null, timeOfDay = null, priority = 'medium', recurrence = { type: 'daily' }, completed = false }) {
    this.openIfNeeded();
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO habits(title, notes, scheduled_for, time_of_day, priority, completed, recurrence, completed_dates, created_at, updated_at)
      VALUES (@title, @notes, @scheduled_for, @time_of_day, @priority, @completed, @recurrence, NULL, @created_at, @updated_at)
    `);
    const info = stmt.run({
      title,
      notes,
      scheduled_for: scheduledFor,
      time_of_day: timeOfDay,
      priority,
      completed: completed ? 1 : 0,
      recurrence: JSON.stringify(recurrence || { type: 'daily' }),
      created_at: now,
      updated_at: now,
    });
    return this.getHabitById(info.lastInsertRowid);
  }

  getHabitById(id) {
    this.openIfNeeded();
    const row = this.db.prepare('SELECT * FROM habits WHERE id = ?').get(id);
    if (!row) return null;
    return this._mapHabit(row);
  }

  updateHabit(id, patch) {
    this.openIfNeeded();
    const h = this.getHabitById(id);
    if (!h) throw new Error('not_found');
    const merged = { ...h, ...patch };
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE habits SET title=@title, notes=@notes, scheduled_for=@scheduled_for, time_of_day=@time_of_day, priority=@priority, completed=@completed, recurrence=@recurrence, updated_at=@updated_at WHERE id=@id`).run({
      id,
      title: merged.title,
      notes: merged.notes,
      scheduled_for: merged.scheduledFor ?? null,
      time_of_day: merged.timeOfDay ?? null,
      priority: merged.priority,
      completed: merged.completed ? 1 : 0,
      recurrence: JSON.stringify(merged.recurrence || { type: 'daily' }),
      updated_at: now,
    });
    return this.getHabitById(id);
  }

  deleteHabit(id) {
    this.openIfNeeded();
    this.db.prepare('DELETE FROM habits WHERE id = ?').run(id);
  }

  listHabits({ from = null, to = null, priority = null, completed = null } = {}) {
    this.openIfNeeded();
    const cond = ['scheduled_for IS NOT NULL'];
    const params = {};
    if (from) { cond.push('scheduled_for >= @from'); params.from = from; }
    if (to) { cond.push("scheduled_for < date(@to, '+1 day')"); params.to = to; }
    if (priority) { cond.push('priority = @priority'); params.priority = priority; }
    if (completed !== null && completed !== undefined) { cond.push('completed = @completed'); params.completed = completed ? 1 : 0; }
    const sql = `SELECT * FROM habits WHERE ${cond.join(' AND ')} ORDER BY scheduled_for ASC, time_of_day ASC, id ASC`;
    const rows = this.db.prepare(sql).all(params);
    return rows.map(r => this._mapHabit(r));
  }

  // Habit links (organizational composition)
  addHabitTodoItems(habitId, todoIds) {
    this.openIfNeeded();
    const stmt = this.db.prepare('INSERT OR IGNORE INTO habit_todo_items (habit_id, todo_id) VALUES (@h,@t)');
    const tx = this.db.transaction((ids) => { for (const tid of ids) stmt.run({ h: habitId, t: tid }); });
    tx(todoIds);
  }
  removeHabitTodoItem(habitId, todoId) {
    this.openIfNeeded();
    this.db.prepare('DELETE FROM habit_todo_items WHERE habit_id=@h AND todo_id=@t').run({ h: habitId, t: todoId });
  }
  addHabitEventItems(habitId, eventIds) {
    this.openIfNeeded();
    const stmt = this.db.prepare('INSERT OR IGNORE INTO habit_event_items (habit_id, event_id) VALUES (@h,@e)');
    const tx = this.db.transaction((ids) => { for (const eid of ids) stmt.run({ h: habitId, e: eid }); });
    tx(eventIds);
  }
  removeHabitEventItem(habitId, eventId) {
    this.openIfNeeded();
    this.db.prepare('DELETE FROM habit_event_items WHERE habit_id=@h AND event_id=@e').run({ h: habitId, e: eventId });
  }

  // Habit stats from completed_dates
  computeHabitStats(habit, { from, to }) {
    const completed = Array.isArray(habit.completedDates) ? habit.completedDates.slice().sort() : [];
    // weekHeatmap over [from,to] if provided; else last 7 days ending today
    const fromDate = from ? new Date(from) : (() => { const d=new Date(); d.setDate(d.getDate()-6); d.setHours(0,0,0,0); return d; })();
    const toDate = to ? new Date(to) : (() => { const d=new Date(); d.setHours(0,0,0,0); return d; })();
    const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const dayCount = Math.max(1, Math.min(7, Math.round((new Date(toDate.getFullYear(),toDate.getMonth(),toDate.getDate()) - new Date(fromDate.getFullYear(),fromDate.getMonth(),fromDate.getDate()))/(24*60*60*1000)) + 1));
    const heat = [];
    for (let i = 0; i < dayCount; i++) {
      const d = new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate() + i);
      heat.push({ date: ymd(d), completed: completed.includes(ymd(d)) });
    }
    // current and longest streaks from all-time list
    const set = new Set(completed);
    // helper: walk backwards from today
    const today = new Date(); today.setHours(0,0,0,0);
    let current = 0;
    for (let i = 0; ; i++) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
      const k = ymd(d);
      if (set.has(k)) current++; else break;
      if (i > 3660) break; // safety cap
    }
    // longest: scan sorted dates
    let longest = 0; let run = 0; let prev = null;
    for (const ds of completed) {
      if (prev) {
        const p = new Date(prev); const c = new Date(ds);
        const diff = Math.round((new Date(c.getFullYear(),c.getMonth(),c.getDate()) - new Date(p.getFullYear(),p.getMonth(),p.getDate()))/(24*60*60*1000));
        run = (diff === 1) ? run + 1 : 1;
      } else { run = 1; }
      if (run > longest) longest = run;
      prev = ds;
    }
    return { currentStreak: current, longestStreak: longest, weekHeatmap: heat };
  }

  searchHabits({ q, completed = null }) {
    this.openIfNeeded();
    if (!q || String(q).length < 2) {
      const rows = this.db.prepare('SELECT * FROM habits ORDER BY id ASC').all();
      let items = rows.map(r => this._mapHabit(r));
      if (completed !== null && completed !== undefined) items = items.filter(h => !!h.completed === !!completed);
      return items;
    }
    const rows = this.db.prepare('SELECT h.* FROM habits h JOIN habits_fts f ON f.rowid = h.id WHERE habits_fts MATCH @q').all({ q: String(q) });
    let items = rows.map(r => this._mapHabit(r));
    if (completed !== null && completed !== undefined) items = items.filter(h => !!h.completed === !!completed);
    return items;
  }

  toggleHabitOccurrence({ id, occurrenceDate, completed }) {
    this.openIfNeeded();
    const h = this.getHabitById(id);
    if (!h) throw new Error('not_found');
    const type = h.recurrence && h.recurrence.type;
    if (!type || type === 'none') throw new Error('not_repeating');
    const arr = Array.isArray(h.completedDates) ? h.completedDates.slice() : [];
    const idx = arr.indexOf(occurrenceDate);
    const shouldComplete = (completed === undefined) ? true : !!completed;
    if (shouldComplete) { if (idx === -1) arr.push(occurrenceDate); }
    else if (idx !== -1) { arr.splice(idx, 1); }
    const now = new Date().toISOString();
    this.db.prepare('UPDATE habits SET completed_dates=@completed_dates, updated_at=@updated_at WHERE id=@id').run({ id, completed_dates: JSON.stringify(arr), updated_at: now });
    return this.getHabitById(id);
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
    const merged = { ...e, ...patch };
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE events SET title=@title, notes=@notes, scheduled_for=@scheduled_for, start_time=@start_time, end_time=@end_time, location=@location, priority=@priority, completed=@completed, recurrence=@recurrence, updated_at=@updated_at WHERE id=@id`).run({
      id,
      title: merged.title,
      notes: merged.notes,
      scheduled_for: merged.scheduledFor ?? null,
      start_time: merged.startTime ?? null,
      end_time: merged.endTime ?? null,
      location: merged.location ?? null,
      priority: merged.priority,
      completed: merged.completed ? 1 : 0,
      recurrence: JSON.stringify(merged.recurrence || { type: 'none' }),
      updated_at: now,
    });
    return this.getEventById(id);
  }

  deleteEvent(id) {
    this.openIfNeeded();
    this.db.prepare('DELETE FROM events WHERE id = ?').run(id);
  }

  listEvents({ from = null, to = null, priority = null, completed = null } = {}) {
    this.openIfNeeded();
    const cond = ['scheduled_for IS NOT NULL'];
    const params = {};
    if (from) { cond.push('scheduled_for >= @from'); params.from = from; }
    if (to) { cond.push("scheduled_for < date(@to, '+1 day')"); params.to = to; }
    if (priority) { cond.push('priority = @priority'); params.priority = priority; }
    if (completed !== null && completed !== undefined) { cond.push('completed = @completed'); params.completed = completed ? 1 : 0; }
    const sql = `SELECT * FROM events WHERE ${cond.join(' AND ')} ORDER BY scheduled_for ASC, start_time ASC, id ASC`;
    const rows = this.db.prepare(sql).all(params);
    return rows.map(r => this._mapEvent(r));
  }

  searchEvents({ q, completed = null }) {
    this.openIfNeeded();
    if (!q || String(q).length < 2) {
      const sql = 'SELECT * FROM events ORDER BY id ASC';
      const rows = this.db.prepare(sql).all();
      let items = rows.map(r => this._mapEvent(r));
      if (completed !== null && completed !== undefined) items = items.filter(e => !!e.completed === !!completed);
      return items;
    }
    const rows = this.db.prepare('SELECT e.* FROM events e JOIN events_fts f ON f.rowid = e.id WHERE events_fts MATCH @q').all({ q: String(q) });
    let items = rows.map(r => this._mapEvent(r));
    if (completed !== null && completed !== undefined) items = items.filter(e => !!e.completed === !!completed);
    return items;
  }

  toggleEventOccurrence({ id, occurrenceDate, completed }) {
    this.openIfNeeded();
    const e = this.getEventById(id);
    if (!e) throw new Error('not_found');
    const type = e.recurrence && e.recurrence.type;
    if (!type || type === 'none') throw new Error('not_repeating');
    const arr = Array.isArray(e.completedDates) ? e.completedDates.slice() : [];
    const idx = arr.indexOf(occurrenceDate);
    const shouldComplete = (completed === undefined) ? true : !!completed;
    if (shouldComplete) {
      if (idx === -1) arr.push(occurrenceDate);
    } else if (idx !== -1) {
      arr.splice(idx, 1);
    }
    const now = new Date().toISOString();
    this.db.prepare('UPDATE events SET completed_dates=@completed_dates, updated_at=@updated_at WHERE id=@id').run({
      id,
      completed_dates: JSON.stringify(arr),
      updated_at: now,
    });
    return this.getEventById(id);
  }

  deleteTodo(id) {
    this.openIfNeeded();
    this.db.prepare('DELETE FROM todos WHERE id = ?').run(id);
  }

  listTodos({ from = null, to = null, priority = null, completed = null } = {}) {
    this.openIfNeeded();
    const cond = ['scheduled_for IS NOT NULL'];
    const params = {};
    if (from) { cond.push('scheduled_for >= @from'); params.from = from; }
    if (to) { cond.push("scheduled_for < date(@to, '+1 day')"); params.to = to; }
    if (priority) { cond.push('priority = @priority'); params.priority = priority; }
    if (completed !== null && completed !== undefined) { cond.push('completed = @completed'); params.completed = completed ? 1 : 0; }
    const sql = `SELECT * FROM todos WHERE ${cond.join(' AND ')} ORDER BY scheduled_for ASC, time_of_day ASC, id ASC`;
    const rows = this.db.prepare(sql).all(params);
    return rows.map(r => this._mapTodo(r));
  }

  searchTodos({ q, completed = null }) {
    this.openIfNeeded();
    if (!q || String(q).length < 2) {
      const sql = 'SELECT * FROM todos ORDER BY id ASC';
      const rows = this.db.prepare(sql).all();
      return rows.map(r => this._mapTodo(r));
    }
    const base = `SELECT t.* FROM todos t JOIN todos_fts f ON f.rowid = t.id WHERE todos_fts MATCH @q`;
    const rows = this.db.prepare(base).all({ q: String(q) });
    let items = rows.map(r => this._mapTodo(r));
    if (completed !== null && completed !== undefined) items = items.filter(t => !!t.completed === !!completed);
    return items;
  }

  toggleTodoOccurrence({ id, occurrenceDate, completed }) {
    this.openIfNeeded();
    const t = this.getTodoById(id);
    if (!t) throw new Error('not_found');
    const type = t.recurrence && t.recurrence.type;
    if (!type || type === 'none') throw new Error('not_repeating');
    const arr = Array.isArray(t.completedDates) ? t.completedDates.slice() : [];
    const idx = arr.indexOf(occurrenceDate);
    const shouldComplete = (completed === undefined) ? true : !!completed;
    if (shouldComplete) {
      if (idx === -1) arr.push(occurrenceDate);
    } else if (idx !== -1) {
      arr.splice(idx, 1);
    }
    const now = new Date().toISOString();
    this.db.prepare('UPDATE todos SET completed_dates=@completed_dates, updated_at=@updated_at WHERE id=@id').run({
      id,
      completed_dates: JSON.stringify(arr),
      updated_at: now,
    });
    return this.getTodoById(id);
  }

  // Helpers
  _mapTodo(r) {
    return {
      id: r.id,
      title: r.title,
      notes: r.notes,
      scheduledFor: r.scheduled_for,
      timeOfDay: r.time_of_day,
      priority: r.priority,
      completed: !!r.completed,
      recurrence: (() => { try { return JSON.parse(r.recurrence || '{"type":"none"}'); } catch { return { type: 'none' }; } })(),
      completedDates: (() => { try { return r.completed_dates ? JSON.parse(r.completed_dates) : null; } catch { return null; } })(),
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
      priority: r.priority,
      completed: !!r.completed,
      recurrence: (() => { try { return JSON.parse(r.recurrence || '{"type":"none"}'); } catch { return { type: 'none' }; } })(),
      completedDates: (() => { try { return r.completed_dates ? JSON.parse(r.completed_dates) : null; } catch { return null; } })(),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  _mapHabit(r) {
    return {
      id: r.id,
      title: r.title,
      notes: r.notes,
      scheduledFor: r.scheduled_for,
      timeOfDay: r.time_of_day,
      priority: r.priority,
      completed: !!r.completed,
      recurrence: (() => { try { return JSON.parse(r.recurrence || '{"type":"daily"}'); } catch { return { type: 'daily' }; } })(),
      completedDates: (() => { try { return r.completed_dates ? JSON.parse(r.completed_dates) : null; } catch { return null; } })(),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  _mapGoal(r) {
    return {
      id: r.id,
      title: r.title,
      notes: r.notes,
      status: r.status,
      currentProgressValue: r.current_progress_value,
      targetProgressValue: r.target_progress_value,
      progressUnit: r.progress_unit,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  // Goals
  createGoal({ title, notes = '', status = 'active', currentProgressValue = null, targetProgressValue = null, progressUnit = null }) {
    this.openIfNeeded();
    const now = new Date().toISOString();
    const info = this.db.prepare(`
      INSERT INTO goals(title, notes, status, current_progress_value, target_progress_value, progress_unit, created_at, updated_at)
      VALUES (@title, @notes, @status, @cpv, @tpv, @unit, @created_at, @updated_at)
    `).run({ title, notes, status, cpv: currentProgressValue, tpv: targetProgressValue, unit: progressUnit, created_at: now, updated_at: now });
    return this.getGoalById(info.lastInsertRowid);
  }

  getGoalById(id, { includeItems = false, includeChildren = false } = {}) {
    this.openIfNeeded();
    const row = this.db.prepare('SELECT * FROM goals WHERE id = ?').get(id);
    if (!row) return null;
    const goal = this._mapGoal(row);
    if (includeItems) {
      const todos = this.db.prepare('SELECT t.* FROM goal_todo_items g JOIN todos t ON t.id=g.todo_id WHERE g.goal_id=?').all(id).map((r) => this._mapTodo(r));
      const events = this.db.prepare('SELECT e.* FROM goal_event_items g JOIN events e ON e.id=g.event_id WHERE g.goal_id=?').all(id).map((r) => this._mapEvent(r));
      goal.items = { todos, events };
    }
    if (includeChildren) {
      const children = this.db.prepare('SELECT child_goal_id as id FROM goal_hierarchy WHERE parent_goal_id=?').all(id).map(r => r.id);
      goal.children = children;
    }
    return goal;
  }

  listGoals({ status = null } = {}) {
    this.openIfNeeded();
    const cond = [];
    const params = {};
    if (status) { cond.push('status=@status'); params.status = status; }
    const sql = `SELECT * FROM goals${cond.length ? ' WHERE ' + cond.join(' AND ') : ''} ORDER BY id ASC`;
    return this.db.prepare(sql).all(params).map(r => this._mapGoal(r));
  }

  updateGoal(id, patch) {
    this.openIfNeeded();
    const g = this.getGoalById(id);
    if (!g) throw new Error('not_found');
    const now = new Date().toISOString();
    const merged = { ...g, ...patch };
    this.db.prepare(`UPDATE goals SET title=@title, notes=@notes, status=@status, current_progress_value=@cpv, target_progress_value=@tpv, progress_unit=@unit, updated_at=@updated_at WHERE id=@id`).run({
      id,
      title: merged.title,
      notes: merged.notes,
      status: merged.status,
      cpv: merged.currentProgressValue ?? null,
      tpv: merged.targetProgressValue ?? null,
      unit: merged.progressUnit ?? null,
      updated_at: now,
    });
    return this.getGoalById(id);
  }

  deleteGoal(id) {
    this.openIfNeeded();
    this.db.prepare('DELETE FROM goals WHERE id = ?').run(id);
  }

  addGoalTodoItems(goalId, todoIds) {
    this.openIfNeeded();
    const stmt = this.db.prepare('INSERT OR IGNORE INTO goal_todo_items (goal_id, todo_id) VALUES (@g,@t)');
    const tx = this.db.transaction((ids) => { for (const tid of ids) stmt.run({ g: goalId, t: tid }); });
    tx(todoIds);
  }
  removeGoalTodoItem(goalId, todoId) {
    this.openIfNeeded();
    this.db.prepare('DELETE FROM goal_todo_items WHERE goal_id=@g AND todo_id=@t').run({ g: goalId, t: todoId });
  }
  addGoalEventItems(goalId, eventIds) {
    this.openIfNeeded();
    const stmt = this.db.prepare('INSERT OR IGNORE INTO goal_event_items (goal_id, event_id) VALUES (@g,@e)');
    const tx = this.db.transaction((ids) => { for (const eid of ids) stmt.run({ g: goalId, e: eid }); });
    tx(eventIds);
  }
  removeGoalEventItem(goalId, eventId) {
    this.openIfNeeded();
    this.db.prepare('DELETE FROM goal_event_items WHERE goal_id=@g AND event_id=@e').run({ g: goalId, e: eventId });
  }
  addGoalChildren(parentId, childIds) {
    this.openIfNeeded();
    const stmt = this.db.prepare('INSERT OR IGNORE INTO goal_hierarchy (parent_goal_id, child_goal_id) VALUES (@p,@c)');
    const tx = this.db.transaction((ids) => { for (const cid of ids) stmt.run({ p: parentId, c: cid }); });
    tx(childIds);
  }
  removeGoalChild(parentId, childId) {
    this.openIfNeeded();
    this.db.prepare('DELETE FROM goal_hierarchy WHERE parent_goal_id=@p AND child_goal_id=@c').run({ p: parentId, c: childId });
  }
}

const instance = new DbService(process.env.APP_DB_PATH || './data/app.db');
export default instance;


