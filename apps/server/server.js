#!/usr/bin/env node

// Single-server Express app that serves the UI and provides CRUD + search + backlog APIs.
// Persistence uses SQLite (better-sqlite3) at ./data/app.db with schema at apps/server/database/schema.sql.

import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import db from './database/DbService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Paths ---
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(REPO_ROOT, 'data');
const STATIC_DIR = process.env.STATIC_DIR || path.join(REPO_ROOT, 'apps', 'web', 'flutter_app', 'build', 'web');
const SCHEMA_FILE = path.join(REPO_ROOT, 'apps', 'server', 'database', 'schema.sql');

// --- Timezone (fixed semantics) ---
const TIMEZONE = process.env.TZ_NAME || 'America/New_York';

function ymdInTimeZone(date, tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(date);
    const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
    return `${map.year}-${map.month}-${map.day}`;
  } catch {
    // Fallback to local
    const d = date;
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }
}

// Compute Monday–Sunday week range anchored to today in the given timezone
function weekRangeFromToday(tz) {
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
  const daysFromMonday = (jsWeekday + 6) % 7; // Mon->0, Sun->6
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysFromMonday);
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  const ymd = (dt) => `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
  return { fromYmd: ymd(monday), toYmd: ymd(sunday) };
}

// DB-backed helpers
function loadAllTodos() {
  try { return db.listTodos({ from: null, to: null }); } catch { return []; }
}

function listAllTodosRaw() {
  // Use FTS fallback path to get all items deterministically
  try { return db.searchTodos({ q: ' ' }); } catch { return []; }
}

function listAllEventsRaw() {
  try { return db.searchEvents({ q: ' ' }); } catch { return []; }
}

function listAllHabitsRaw() {
  try { return db.searchHabits({ q: ' ' }); } catch { return []; }
}

function filterTodosByWhere(where = {}) {
  const items = listAllTodosRaw().slice();
  let filtered = items;
  // ids
  if (Array.isArray(where.ids) && where.ids.length) {
    const set = new Set(where.ids.map((id) => parseInt(id, 10)));
    filtered = filtered.filter((t) => set.has(t.id));
  }
  // title_contains
  if (typeof where.title_contains === 'string' && where.title_contains.trim()) {
    const q = where.title_contains.toLowerCase();
    filtered = filtered.filter((t) => String(t.title || '').toLowerCase().includes(q));
  }
  // overdue
  if (typeof where.overdue === 'boolean') {
    const todayY = ymd(new Date());
    const isOverdue = (t) => { if (t.completed) return false; if (!t.scheduledFor) return false; return String(t.scheduledFor) < String(todayY); };
    filtered = filtered.filter((t) => isOverdue(t) === where.overdue);
  }
  // scheduled_range
  if (where.scheduled_range && (where.scheduled_range.from || where.scheduled_range.to)) {
    const from = where.scheduled_range.from ? parseYMD(where.scheduled_range.from) : null;
    const to = where.scheduled_range.to ? parseYMD(where.scheduled_range.to) : null;
    filtered = filtered.filter((t) => {
      if (!t.scheduledFor) return false;
      const d = parseYMD(t.scheduledFor);
      if (!d) return false;
      if (from && d < from) return false;
      if (to) {
        const inclusiveEnd = new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1);
        if (d >= inclusiveEnd) return false;
      }
      return true;
    });
  }
  // priority
  if (typeof where.priority === 'string') {
    const p = where.priority.toLowerCase();
    filtered = filtered.filter((t) => String(t.priority || '').toLowerCase() === p);
  }
  // completed
  if (typeof where.completed === 'boolean') {
    filtered = filtered.filter((t) => !!t.completed === where.completed);
  }
  // repeating
  if (typeof where.repeating === 'boolean') {
    const isRepeating = (todo) => !!(todo?.recurrence && todo.recurrence.type && todo.recurrence.type !== 'none');
    filtered = filtered.filter((t) => isRepeating(t) === where.repeating);
  }
  return filtered;
}

function filterItemsByWhere(items, where = {}) {
  let filtered = (Array.isArray(items) ? items.slice() : []);
  if (Array.isArray(where.ids) && where.ids.length) {
    const set = new Set(where.ids.map((id) => parseInt(id, 10)));
    filtered = filtered.filter((t) => set.has(t.id));
  }
  if (typeof where.title_contains === 'string' && where.title_contains.trim()) {
    const q = where.title_contains.toLowerCase();
    filtered = filtered.filter((t) => String(t.title || '').toLowerCase().includes(q));
  }
  if (typeof where.overdue === 'boolean') {
    const todayY = ymd(new Date());
    const isOverdue = (t) => { if (t.completed) return false; if (!t.scheduledFor) return false; return String(t.scheduledFor) < String(todayY); };
    filtered = filtered.filter((t) => isOverdue(t) === where.overdue);
  }
  if (where.scheduled_range && (where.scheduled_range.from || where.scheduled_range.to)) {
    const from = where.scheduled_range.from ? parseYMD(where.scheduled_range.from) : null;
    const to = where.scheduled_range.to ? parseYMD(where.scheduled_range.to) : null;
    filtered = filtered.filter((t) => {
      if (!t.scheduledFor) return false;
      const d = parseYMD(t.scheduledFor);
      if (!d) return false;
      if (from && d < from) return false;
      if (to) {
        const inclusiveEnd = new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1);
        if (d >= inclusiveEnd) return false;
      }
      return true;
    });
  }
  if (typeof where.priority === 'string') {
    const p = where.priority.toLowerCase();
    filtered = filtered.filter((t) => String(t.priority || '').toLowerCase() === p);
  }
  if (typeof where.completed === 'boolean') {
    filtered = filtered.filter((t) => !!t.completed === where.completed);
  }
  if (typeof where.repeating === 'boolean') {
    const isRepeating = (x) => !!(x?.recurrence && x.recurrence.type && x.recurrence.type !== 'none');
    filtered = filtered.filter((t) => isRepeating(t) === where.repeating);
  }
  return filtered;
}

function getAggregatesFromDb() {
  const items = listAllTodosRaw();
  const today = new Date();
  const todayY = ymd(today);
  let overdueCount = 0; let next7DaysCount = 0; let backlogCount = 0; let scheduledCount = 0;
  for (const t of items) {
    if (t.scheduledFor === null) backlogCount++; else scheduledCount++;
    const isOverdue = (!t.completed && t.scheduledFor && String(t.scheduledFor) < String(todayY));
    if (isOverdue) overdueCount++;
    if (t.scheduledFor) {
      const d = parseYMD(t.scheduledFor); if (d) {
        const end = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 7);
        const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        if (d >= start && d <= end) next7DaysCount++;
      }
    }
  }
  return { overdueCount, next7DaysCount, backlogCount, scheduledCount };
}

function buildRouterSnapshots() {
  const { fromYmd, toYmd } = weekRangeFromToday(TIMEZONE);
  const todosWeek = filterTodosByWhere({ scheduled_range: { from: fromYmd, to: toYmd }, completed: false });
  const eventsWeek = filterItemsByWhere(listAllEventsRaw(), { scheduled_range: { from: fromYmd, to: toYmd }, completed: false });
  const habitsWeek = filterItemsByWhere(listAllHabitsRaw(), { scheduled_range: { from: fromYmd, to: toYmd }, completed: false });
  const weekItems = [...todosWeek, ...eventsWeek, ...habitsWeek];
  const backlogTodos = filterTodosByWhere({ completed: false });
  const backlogSample = backlogTodos.filter(t => t.scheduledFor === null).slice(0, 40);
  const compact = (t) => ({ id: t.id, title: t.title, scheduledFor: t.scheduledFor, priority: t.priority });
  return { week: { from: fromYmd, to: toYmd, items: weekItems.map(compact) }, backlog: backlogSample.map(compact) };
}

// Rank top clarify candidates from snapshots by fuzzy title tokens
function topClarifyCandidates(instruction, snapshot, limit = 5) {
  const tokens = String(instruction || '').toLowerCase().split(/[^a-z0-9]+/g).filter(Boolean);
  const all = [...(snapshot.week?.items || []), ...(snapshot.backlog || [])];
  const score = (item) => {
    const title = String(item.title || '').toLowerCase();
    let s = 0;
    for (const t of tokens) if (title.includes(t)) s += 1;
    if (item.priority === 'high') s += 0.25;
    return s;
  };
  return all
    .map(i => ({ i, s: score(i) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map(x => x.i);
}

// Ensure data dir exists and bootstrap DB schema
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
try {
  const schemaSql = fs.readFileSync(SCHEMA_FILE, 'utf8');
  db.bootstrapSchema(schemaSql);
} catch {}

// --- Normalization helpers (forward-compatible defaults) ---
function endOfCurrentYearYmd() {
  try {
    const now = new Date();
    return `${now.getFullYear()}-12-31`;
  } catch { return '2099-12-31'; }
}

function normalizeTodo(todo) {
  try {
    const t = { ...todo };
    if (t.timeOfDay === undefined) t.timeOfDay = null; // null = all-day
    if (!t || typeof t.recurrence !== 'object') {
      t.recurrence = { type: 'none', until: endOfCurrentYearYmd() };
    } else {
      if (!t.recurrence.type) t.recurrence.type = 'none';
      if (t.recurrence.until === undefined) t.recurrence.until = endOfCurrentYearYmd();
    }
    if (t.recurrence.type !== 'none') {
      if (!Array.isArray(t.completedDates)) t.completedDates = [];
    }
    if (typeof t.completed !== 'boolean') t.completed = false;
    return t;
  } catch {
    return todo;
  }
}

function normalizeHabit(habit) {
  try {
    const h = { ...habit };
    if (h.timeOfDay === undefined) h.timeOfDay = null;
    if (!h || typeof h.recurrence !== 'object') {
      // For habits, default to daily to enforce repeating semantics
      h.recurrence = { type: 'daily', until: endOfCurrentYearYmd() };
    } else {
      if (!h.recurrence.type) h.recurrence.type = 'daily';
      if (h.recurrence.until === undefined) h.recurrence.until = endOfCurrentYearYmd();
    }
    if (h.recurrence.type !== 'none') {
      if (!Array.isArray(h.completedDates)) h.completedDates = [];
    }
    if (typeof h.completed !== 'boolean') h.completed = false;
    return h;
  } catch {
    return habit;
  }
}

// Merge/normalize recurrence on a target todo with consistent defaults and transitions
function applyRecurrenceMutation(targetTodo, incomingRecurrence) {
  try {
    const prevType = targetTodo?.recurrence?.type || 'none';
    targetTodo.recurrence = { ...(targetTodo.recurrence || {}), ...(incomingRecurrence || {}) };
    if (targetTodo.recurrence.until === undefined) targetTodo.recurrence.until = endOfCurrentYearYmd();
    if (prevType !== 'none' && targetTodo.recurrence.type === 'none') {
      targetTodo.completedDates = [];
    } else if (targetTodo.recurrence.type !== 'none') {
      if (!Array.isArray(targetTodo.completedDates)) targetTodo.completedDates = [];
    }
  } catch {}
}

function createTodoDb({ title, notes = '', scheduledFor = null, priority = 'medium', timeOfDay = null, recurrence = undefined }) {
  return db.createTodo({ title, notes, scheduledFor, timeOfDay, priority, recurrence: recurrence || { type: 'none' }, completed: false });
}

function findTodoById(id) { return db.getTodoById(parseInt(id, 10)); }

function parseYMD(s) {
  try {
    const [y, m, d] = String(s).split('-').map(v => parseInt(v, 10));
    if (!y || !m || !d) return null;
    return new Date(y, m - 1, d);
  } catch { return null; }
}

function isYmdString(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isValidTimeOfDay(value) {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'string') return false;
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function isValidRecurrence(rec) {
  if (rec === null || rec === undefined) return true;
  if (typeof rec !== 'object') return false;
  const type = rec.type;
  const allowed = ['none', 'daily', 'weekdays', 'weekly', 'every_n_days'];
  if (!allowed.includes(String(type))) return false;
  if (type === 'every_n_days') {
    const n = rec.intervalDays;
    if (!Number.isInteger(n) || n < 1) return false;
  }
  if (!(rec.until === null || rec.until === undefined || isYmdString(rec.until))) return false;
  return true;
}

function ymd(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }

function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }

function daysBetween(a, b) {
  const ms = (new Date(b.getFullYear(), b.getMonth(), b.getDate())) - (new Date(a.getFullYear(), a.getMonth(), a.getDate()));
  return Math.round(ms / (24*60*60*1000));
}

function matchesRule(dateObj, anchorDateObj, recurrence) {
  const type = recurrence?.type || 'none';
  if (type === 'none') return false;
  if (type === 'daily') return true;
  if (type === 'weekdays') {
    const wd = dateObj.getDay(); // 0=Sun..6=Sat
    return wd >= 1 && wd <= 5;
  }
  if (type === 'weekly') {
    return dateObj.getDay() === anchorDateObj.getDay();
  }
  if (type === 'every_n_days') {
    const step = Number(recurrence.intervalDays) || 1;
    const diff = daysBetween(anchorDateObj, dateObj);
    return diff >= 0 && diff % step === 0;
  }
  return false;
}

function expandOccurrences(todo, fromDate, toDate) {
  const occurrences = [];
  const anchor = todo.scheduledFor ? parseYMD(todo.scheduledFor) : null;
  if (!anchor) return occurrences;
  const untilYmd = todo.recurrence?.until ?? undefined; // null = no cap
  const untilDate = (untilYmd && isYmdString(untilYmd)) ? parseYMD(untilYmd) : null;
  const start = new Date(Math.max(fromDate.getTime(), anchor.getTime()));
  const inclusiveEnd = new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate() + 1);
  for (let d = new Date(start); d < inclusiveEnd; d = addDays(d, 1)) {
    if (untilDate && d > untilDate) break;
    if (matchesRule(d, anchor, todo.recurrence)) {
      const dateStr = ymd(d);
      const occCompleted = Array.isArray(todo.completedDates) && todo.completedDates.includes(dateStr);
      occurrences.push({
        id: todo.id,
        masterId: todo.id,
        title: todo.title,
        notes: todo.notes,
        scheduledFor: dateStr,
        timeOfDay: todo.timeOfDay,
        priority: todo.priority,
        completed: !!occCompleted,
        recurrence: todo.recurrence,
        createdAt: todo.createdAt,
        updatedAt: todo.updatedAt,
      });
    }
  }
  return occurrences;
}

// Expand repeating events into per-day occurrences within [from,to]
function expandEventOccurrences(event, fromDate, toDate) {
  const occurrences = [];
  const anchor = event.scheduledFor ? parseYMD(event.scheduledFor) : null;
  if (!anchor) return occurrences;
  const untilYmd = event.recurrence?.until ?? undefined; // null = no cap
  const untilDate = (untilYmd && isYmdString(untilYmd)) ? parseYMD(untilYmd) : null;
  const start = new Date(Math.max(fromDate.getTime(), anchor.getTime()));
  const inclusiveEnd = new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate() + 1);
  for (let d = new Date(start); d < inclusiveEnd; d = addDays(d, 1)) {
    if (untilDate && d > untilDate) break;
    if (matchesRule(d, anchor, event.recurrence)) {
      const dateStr = ymd(d);
      const occCompleted = Array.isArray(event.completedDates) && event.completedDates.includes(dateStr);
      occurrences.push({
        id: event.id,
        masterId: event.id,
        title: event.title,
        notes: event.notes,
        scheduledFor: dateStr,
        startTime: event.startTime ?? null,
        endTime: event.endTime ?? null,
        location: event.location ?? null,
        priority: event.priority,
        completed: !!occCompleted,
        recurrence: event.recurrence,
        createdAt: event.createdAt,
        updatedAt: event.updatedAt,
      });
    }
  }
  return occurrences;
}

// --- Server ---
const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '256kb' }));

// Static assets (Flutter Web build) are mounted AFTER API routes below

// Health
app.get('/health', (_req, res) => { res.json({ ok: true }); });

// Debug: list routes (optional)
if (process.env.ENABLE_DEBUG_ROUTES === 'true') {
  app.get('/__routes', (_req, res) => {
    try {
      const routes = [];
      app._router.stack.forEach((m) => {
        if (m.route && m.route.path) {
          const methods = Object.keys(m.route.methods).filter(Boolean);
          routes.push({ path: m.route.path, methods });
        }
      });
      res.json({ routes });
    } catch (e) {
      res.status(500).json({ error: String(e && e.message ? e.message : e) });
    }
  });
}

// --- CRUD Endpoints ---
// Create
app.post('/api/todos', (req, res) => {
  const { title, notes, scheduledFor, priority, timeOfDay, recurrence } = req.body || {};
  if (typeof title !== 'string' || title.trim() === '') {
    return res.status(400).json({ error: 'invalid_title' });
  }
  // Strict: require recurrence object on create
  if (!(recurrence && typeof recurrence === 'object' && typeof recurrence.type === 'string')) {
    return res.status(400).json({ error: 'missing_recurrence' });
  }
  if (notes !== undefined && typeof notes !== 'string') {
    return res.status(400).json({ error: 'invalid_notes' });
  }
  if (!(scheduledFor === undefined || scheduledFor === null || isYmdString(scheduledFor))) {
    return res.status(400).json({ error: 'invalid_scheduledFor' });
  }
  if (priority !== undefined && !['low', 'medium', 'high'].includes(String(priority))) {
    return res.status(400).json({ error: 'invalid_priority' });
  }
  if (!isValidTimeOfDay(timeOfDay === '' ? null : timeOfDay)) {
    return res.status(400).json({ error: 'invalid_timeOfDay' });
  }
  if (!isValidRecurrence(recurrence)) {
    return res.status(400).json({ error: 'invalid_recurrence' });
  }
  if (recurrence && recurrence.type && recurrence.type !== 'none') {
    if (!(scheduledFor !== null && isYmdString(scheduledFor))) {
      return res.status(400).json({ error: 'missing_anchor_for_recurrence' });
    }
  }

  const todo = createTodoDb({ title: title.trim(), notes: notes || '', scheduledFor: scheduledFor ?? null, priority: priority || 'medium', timeOfDay: (timeOfDay === '' ? null : timeOfDay) ?? null, recurrence: recurrence });
  res.json({ todo });
});

// List (scheduled only within range)
app.get('/api/todos', (req, res) => {
  const { from, to, priority, completed } = req.query;
  if (from !== undefined && !isYmdString(from)) return res.status(400).json({ error: 'invalid_from' });
  if (to !== undefined && !isYmdString(to)) return res.status(400).json({ error: 'invalid_to' });
  if (priority !== undefined && !['low', 'medium', 'high'].includes(String(priority))) {
    return res.status(400).json({ error: 'invalid_priority' });
  }
  let completedBool;
  if (completed !== undefined) {
    if (completed === 'true' || completed === true) completedBool = true;
    else if (completed === 'false' || completed === false) completedBool = false;
    else return res.status(400).json({ error: 'invalid_completed' });
  }

  const fromDate = from ? parseYMD(from) : null;
  const toDate = to ? parseYMD(to) : null;

  let items = db.listTodos({ from: null, to: null }).filter(t => t.scheduledFor !== null);
  if (priority) items = items.filter(t => String(t.priority).toLowerCase() === String(priority).toLowerCase());
  if (completedBool !== undefined) items = items.filter(t => t.completed === completedBool);

  const doExpand = !!(fromDate && toDate);
  if (!doExpand) {
    if (fromDate || toDate) {
      items = items.filter(t => {
        if (!t.scheduledFor) return false;
        const td = parseYMD(t.scheduledFor);
        if (!td) return false;
        if (fromDate && td < fromDate) return false;
        if (toDate) {
          const inclusiveEnd = new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate() + 1);
          if (td >= inclusiveEnd) return false;
        }
        return true;
      });
    }
    return res.json({ todos: items });
  }

  // Expand repeating tasks into per-day occurrences within [from,to]
  const expanded = [];
  for (const t of items) {
    const isRepeating = (t.recurrence && t.recurrence.type && t.recurrence.type !== 'none');
    if (!isRepeating) {
      // include single item if within range
      const td = t.scheduledFor ? parseYMD(t.scheduledFor) : null;
      if (td && (!fromDate || td >= fromDate) && (!toDate || td < new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate() + 1))) {
        expanded.push(t);
      }
    } else {
      expanded.push(...expandOccurrences(t, fromDate, toDate));
    }
  }
  // Apply completed filter post-expansion when provided
  if (completedBool !== undefined) {
    const filtered = expanded.filter(x => x && typeof x.completed === 'boolean' && (x.completed === completedBool));
    return res.json({ todos: filtered });
  }
  res.json({ todos: expanded });
});

// Backlog (unscheduled only)
app.get('/api/todos/backlog', (req, res) => {
  const { priority } = req.query || {};
  if (priority !== undefined && !['low','medium','high'].includes(String(priority))) {
    return res.status(400).json({ error: 'invalid_priority' });
  }
  let items = listAllTodosRaw().filter(t => t.scheduledFor === null);
  if (priority) {
    items = items.filter(t => String(t.priority || '').toLowerCase() === String(priority).toLowerCase());
  }
  res.json({ todos: items });
});

// Search (title or notes, case-insensitive)
app.get('/api/todos/search', (req, res) => {
  const qRaw = String(req.query.query || '');
  const q = qRaw.trim();
  if (q.length === 0) return res.status(400).json({ error: 'invalid_query' });
  let completedBool;
  if (req.query.completed !== undefined) {
    if (req.query.completed === 'true' || req.query.completed === true) completedBool = true;
    else if (req.query.completed === 'false' || req.query.completed === false) completedBool = false;
    else return res.status(400).json({ error: 'invalid_completed' });
  }
  try {
    // FTS5 search when possible; DbService handles fallback behavior
    let items = db.searchTodos({ q, completed: completedBool });
    // For very short queries, DbService returns a broad set; apply substring filter to mimic previous UX
    if (q.length < 2) {
      const ql = q.toLowerCase();
      items = items.filter(t => String(t.title || '').toLowerCase().includes(ql) || String(t.notes || '').toLowerCase().includes(ql));
    }
    // Boosters: overdue +0.5; priority high +0.25, medium +0.1; tie-break by scheduledFor ASC then id ASC
    const todayY = ymdInTimeZone(new Date(), TIMEZONE);
    const score = (t) => {
      let s = 0;
      const overdue = (!t.completed && t.scheduledFor && String(t.scheduledFor) < String(todayY));
      if (overdue) s += 0.5;
      if (t.priority === 'high') s += 0.25;
      else if (t.priority === 'medium') s += 0.1;
      return s;
    };
    items = items.map(t => ({ t, s: score(t) }))
      .sort((a, b) => b.s - a.s || String(a.t.scheduledFor || '').localeCompare(String(b.t.scheduledFor || '')) || (a.t.id - b.t.id))
      .map(x => x.t);
    return res.json({ todos: items });
  } catch (e) {
    return res.status(500).json({ error: 'search_failed' });
  }
});

// Get by id
app.get('/api/todos/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  const t = findTodoById(id);
  if (!t) return res.status(404).json({ error: 'not_found' });
  res.json({ todo: t });
});

// Events (mirror Todos minimal wiring)
app.post('/api/events', (req, res) => {
  const { title, notes, scheduledFor, startTime, endTime, location, priority, recurrence } = req.body || {};
  if (typeof title !== 'string' || title.trim() === '') return res.status(400).json({ error: 'invalid_title' });
  if (startTime !== undefined && !(startTime === null || /^([01]\d|2[0-3]):[0-5]\d$/.test(String(startTime)))) return res.status(400).json({ error: 'invalid_start_time' });
  if (endTime !== undefined && !(endTime === null || /^([01]\d|2[0-3]):[0-5]\d$/.test(String(endTime)))) return res.status(400).json({ error: 'invalid_end_time' });
  if (startTime && endTime && String(endTime) < String(startTime)) return res.status(400).json({ error: 'invalid_time_range' });
  const rec = (recurrence && typeof recurrence === 'object') ? recurrence : { type: 'none' };
  if (rec.type && rec.type !== 'none') {
    if (!(scheduledFor && isYmdString(scheduledFor))) return res.status(400).json({ error: 'missing_anchor_for_recurrence' });
  }
  try {
    const ev = db.createEvent({ title: title.trim(), notes: notes || '', scheduledFor: scheduledFor ?? null, startTime: startTime ?? null, endTime: endTime ?? null, location: location ?? null, priority: priority || 'medium', recurrence: rec, completed: false });
    return res.json({ event: ev });
  } catch (e) { return res.status(500).json({ error: 'create_failed' }); }
});

// Habits (mirror Todos but must be repeating)
app.post('/api/habits', (req, res) => {
  const { title, notes, scheduledFor, priority, timeOfDay, recurrence } = req.body || {};
  if (typeof title !== 'string' || title.trim() === '') return res.status(400).json({ error: 'invalid_title' });
  if (!(scheduledFor !== null && isYmdString(scheduledFor))) return res.status(400).json({ error: 'missing_anchor_for_recurrence' });
  if (!isValidTimeOfDay(timeOfDay === '' ? null : timeOfDay)) return res.status(400).json({ error: 'invalid_timeOfDay' });
  // require recurrence and forbid none
  if (!(recurrence && typeof recurrence === 'object' && typeof recurrence.type === 'string')) return res.status(400).json({ error: 'missing_recurrence' });
  if (!isValidRecurrence(recurrence) || recurrence.type === 'none') return res.status(400).json({ error: 'invalid_recurrence' });
  try {
    const h = db.createHabit({ title: title.trim(), notes: notes || '', scheduledFor, timeOfDay: (timeOfDay === '' ? null : timeOfDay) ?? null, priority: priority || 'medium', recurrence, completed: false });
    return res.json({ habit: h });
  } catch { return res.status(500).json({ error: 'create_failed' }); }
});

app.get('/api/habits', (req, res) => {
  const { from, to, priority, completed } = req.query;
  if (from !== undefined && !isYmdString(from)) return res.status(400).json({ error: 'invalid_from' });
  if (to !== undefined && !isYmdString(to)) return res.status(400).json({ error: 'invalid_to' });
  if (priority !== undefined && !['low','medium','high'].includes(String(priority))) return res.status(400).json({ error: 'invalid_priority' });
  let completedBool;
  if (completed !== undefined) {
    if (completed === 'true' || completed === true) completedBool = true;
    else if (completed === 'false' || completed === false) completedBool = false;
    else return res.status(400).json({ error: 'invalid_completed' });
  }
  const fromDate = from ? parseYMD(from) : null;
  const toDate = to ? parseYMD(to) : null;
  let items = db.listHabits({ from: null, to: null }).filter(h => h.scheduledFor !== null);
  if (priority) items = items.filter(h => String(h.priority).toLowerCase() === String(priority).toLowerCase());
  // Filter masters by range if provided (no expansion here)
  if (fromDate || toDate) {
    items = items.filter(h => {
      if (!h.scheduledFor) return false;
      const hd = parseYMD(h.scheduledFor);
      if (!hd) return false;
      if (fromDate && hd < fromDate) return false;
      if (toDate) {
        const inclusiveEnd = new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate() + 1);
        if (hd >= inclusiveEnd) return false;
      }
      return true;
    });
  }
  if (completedBool !== undefined) items = items.filter(h => h.completed === completedBool);
  // Attach habit stats when both from/to provided
  let fromY = fromDate ? `${fromDate.getFullYear()}-${String(fromDate.getMonth()+1).padStart(2,'0')}-${String(fromDate.getDate()).padStart(2,'0')}` : null;
  let toY = toDate ? `${toDate.getFullYear()}-${String(toDate.getMonth()+1).padStart(2,'0')}-${String(toDate.getDate()).padStart(2,'0')}` : null;
  const withStats = (fromY && toY) ? items.map(h => ({ ...h, ...db.computeHabitStats(h, { from: fromY, to: toY }) })) : items;
  const sorted = withStats.slice().sort((a, b) => {
    const sfa = String(a.scheduledFor || '');
    const sfb = String(b.scheduledFor || '');
    if (sfa !== sfb) return sfa.localeCompare(sfb);
    const at = a.timeOfDay || '';
    const bt = b.timeOfDay || '';
    if (at === '' && bt !== '') return -1;
    if (at !== '' && bt === '') return 1;
    if (at !== bt) return at.localeCompare(bt);
    return (a.id || 0) - (b.id || 0);
  });
  return res.json({ habits: sorted });
});

app.get('/api/habits/search', (req, res) => {
  const qRaw = String(req.query.query || '');
  const q = qRaw.trim();
  if (q.length === 0) return res.status(400).json({ error: 'invalid_query' });
  let completedBool;
  if (req.query.completed !== undefined) {
    if (req.query.completed === 'true' || req.query.completed === true) completedBool = true;
    else if (req.query.completed === 'false' || req.query.completed === false) completedBool = false;
    else return res.status(400).json({ error: 'invalid_completed' });
  }
  try {
    let items = db.searchHabits({ q, completed: completedBool });
    if (q.length < 2) {
      const ql = q.toLowerCase();
      items = items.filter(h => String(h.title || '').toLowerCase().includes(ql) || String(h.notes || '').toLowerCase().includes(ql));
    }
    return res.json({ habits: items });
  } catch (e) {
    return res.status(500).json({ error: 'search_failed' });
  }
});

app.get('/api/habits/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  const h = db.getHabitById(id);
  if (!h) return res.status(404).json({ error: 'not_found' });
  return res.json({ habit: h });
});

// Habit item linking
app.post('/api/habits/:id/items', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  const { todos = [], events = [] } = req.body || {};
  try {
    db.addHabitTodoItems(id, (Array.isArray(todos) ? todos : []).map(Number).filter(Number.isFinite));
    db.addHabitEventItems(id, (Array.isArray(events) ? events : []).map(Number).filter(Number.isFinite));
    return res.status(204).end();
  } catch { return res.status(500).json({ error: 'link_failed' }); }
});

app.delete('/api/habits/:id/items/todo/:todoId', (req, res) => {
  const hid = parseInt(req.params.id, 10);
  const tid = parseInt(req.params.todoId, 10);
  if (!Number.isFinite(hid) || !Number.isFinite(tid)) return res.status(400).json({ error: 'invalid_id' });
  try { db.removeHabitTodoItem(hid, tid); return res.status(204).end(); }
  catch { return res.status(500).json({ error: 'unlink_failed' }); }
});

app.delete('/api/habits/:id/items/event/:eventId', (req, res) => {
  const hid = parseInt(req.params.id, 10);
  const eid = parseInt(req.params.eventId, 10);
  if (!Number.isFinite(hid) || !Number.isFinite(eid)) return res.status(400).json({ error: 'invalid_id' });
  try { db.removeHabitEventItem(hid, eid); return res.status(204).end(); }
  catch { return res.status(500).json({ error: 'unlink_failed' }); }
});

app.patch('/api/habits/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  const { title, notes, scheduledFor, priority, completed, timeOfDay, recurrence } = req.body || {};
  if (title !== undefined && typeof title !== 'string') return res.status(400).json({ error: 'invalid_title' });
  if (notes !== undefined && typeof notes !== 'string') return res.status(400).json({ error: 'invalid_notes' });
  if (!(scheduledFor === undefined || scheduledFor === null || isYmdString(scheduledFor))) return res.status(400).json({ error: 'invalid_scheduledFor' });
  if (priority !== undefined && !['low','medium','high'].includes(String(priority))) return res.status(400).json({ error: 'invalid_priority' });
  if (completed !== undefined && typeof completed !== 'boolean') return res.status(400).json({ error: 'invalid_completed' });
  if (timeOfDay !== undefined && !isValidTimeOfDay(timeOfDay === '' ? null : timeOfDay)) return res.status(400).json({ error: 'invalid_timeOfDay' });
  if (recurrence !== undefined) {
    if (!isValidRecurrence(recurrence)) return res.status(400).json({ error: 'invalid_recurrence' });
    // For habits, recurrence must not be 'none' if provided
    if (recurrence && recurrence.type === 'none') return res.status(400).json({ error: 'invalid_recurrence' });
    if (recurrence && recurrence.type && recurrence.type !== 'none') {
      const anchor = (scheduledFor !== undefined) ? scheduledFor : (db.getHabitById(id)?.scheduledFor ?? null);
      if (!(anchor !== null && isYmdString(anchor))) return res.status(400).json({ error: 'missing_anchor_for_recurrence' });
    }
  }
  try {
    const h = db.updateHabit(id, { title, notes, scheduledFor, timeOfDay, priority, completed, recurrence });
    return res.json({ habit: h });
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (msg === 'not_found') return res.status(404).json({ error: 'not_found' });
    return res.status(500).json({ error: 'update_failed' });
  }
});

app.patch('/api/habits/:id/occurrence', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { occurrenceDate, completed } = req.body || {};
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  if (!isYmdString(occurrenceDate)) return res.status(400).json({ error: 'invalid_occurrenceDate' });
  if (completed !== undefined && typeof completed !== 'boolean') return res.status(400).json({ error: 'invalid_completed' });
  try {
    const updated = db.toggleHabitOccurrence({ id, occurrenceDate, completed: !!completed });
    return res.json({ habit: updated });
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (msg === 'not_repeating') return res.status(400).json({ error: 'not_repeating' });
    if (msg === 'not_found') return res.status(404).json({ error: 'not_found' });
    return res.status(500).json({ error: 'occurrence_failed' });
  }
});
app.get('/api/events', (req, res) => {
  const { from, to, priority, completed } = req.query;
  if (from !== undefined && !isYmdString(from)) return res.status(400).json({ error: 'invalid_from' });
  if (to !== undefined && !isYmdString(to)) return res.status(400).json({ error: 'invalid_to' });
  if (priority !== undefined && !['low','medium','high'].includes(String(priority))) return res.status(400).json({ error: 'invalid_priority' });
  let completedBool;
  if (completed !== undefined) {
    if (completed === 'true' || completed === true) completedBool = true;
    else if (completed === 'false' || completed === false) completedBool = false;
    else return res.status(400).json({ error: 'invalid_completed' });
  }
  try {
    const fromDate = from ? parseYMD(from) : null;
    const toDate = to ? parseYMD(to) : null;
    // Load scheduled masters; filter priority pre-expansion
    let items = db.listEvents({ from: null, to: null, priority: null, completed: null }).filter(e => e.scheduledFor !== null);
    if (priority) items = items.filter(e => String(e.priority).toLowerCase() === String(priority).toLowerCase());

    const doExpand = !!(fromDate && toDate);
    if (!doExpand) {
      // If either from or to provided without both, filter masters by range
      if (fromDate || toDate) {
        items = items.filter(e => {
          if (!e.scheduledFor) return false;
          const ed = parseYMD(e.scheduledFor);
          if (!ed) return false;
          if (fromDate && ed < fromDate) return false;
          if (toDate) {
            const inclusiveEnd = new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate() + 1);
            if (ed >= inclusiveEnd) return false;
          }
          return true;
        });
      }
      if (completedBool !== undefined) items = items.filter(e => e.completed === completedBool);
      // Keep ordering by scheduledFor ASC, startTime ASC nulls-first, id ASC
      const sorted = items.slice().sort((a, b) => {
        const sfa = String(a.scheduledFor || '');
        const sfb = String(b.scheduledFor || '');
        if (sfa !== sfb) return sfa.localeCompare(sfb);
        const at = a.startTime || '';
        const bt = b.startTime || '';
        if (at === '' && bt !== '') return -1;
        if (at !== '' && bt === '') return 1;
        if (at !== bt) return at.localeCompare(bt);
        return (a.id || 0) - (b.id || 0);
      });
      return res.json({ events: sorted });
    }

    // Expand repeating events into per-day occurrences within [from,to]
    const expanded = [];
    for (const e of items) {
      const isRepeating = (e.recurrence && e.recurrence.type && e.recurrence.type !== 'none');
      if (!isRepeating) {
        const ed = e.scheduledFor ? parseYMD(e.scheduledFor) : null;
        if (ed && (!fromDate || ed >= fromDate) && (!toDate || ed < new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate() + 1))) {
          expanded.push(e);
        }
      } else {
        expanded.push(...expandEventOccurrences(e, fromDate, toDate));
      }
    }
    // Apply completed filter post-expansion when provided
    let out = expanded;
    if (completedBool !== undefined) {
      out = expanded.filter(x => x && typeof x.completed === 'boolean' && (x.completed === completedBool));
    }
    // Order: scheduledFor ASC, startTime ASC nulls-first, id ASC
    out = out.slice().sort((a, b) => {
      const sfa = String(a.scheduledFor || '');
      const sfb = String(b.scheduledFor || '');
      if (sfa !== sfb) return sfa.localeCompare(sfb);
      const at = a.startTime || '';
      const bt = b.startTime || '';
      if (at === '' && bt !== '') return -1;
      if (at !== '' && bt === '') return 1;
      if (at !== bt) return at.localeCompare(bt);
      return (a.id || 0) - (b.id || 0);
    });
    return res.json({ events: out });
  } catch (e) { return res.status(500).json({ error: 'db_error' }); }
});

app.get('/api/events/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  const ev = db.getEventById(id);
  if (!ev) return res.status(404).json({ error: 'not_found' });
  return res.json({ event: ev });
});

app.patch('/api/events/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  const { title, notes, scheduledFor, startTime, endTime, location, priority, completed, recurrence } = req.body || {};
  if (title !== undefined && typeof title !== 'string') return res.status(400).json({ error: 'invalid_title' });
  if (notes !== undefined && typeof notes !== 'string') return res.status(400).json({ error: 'invalid_notes' });
  if (!(scheduledFor === undefined || scheduledFor === null || isYmdString(scheduledFor))) return res.status(400).json({ error: 'invalid_scheduledFor' });
  if (priority !== undefined && !['low','medium','high'].includes(String(priority))) return res.status(400).json({ error: 'invalid_priority' });
  if (completed !== undefined && typeof completed !== 'boolean') return res.status(400).json({ error: 'invalid_completed' });
  if (startTime !== undefined && !(startTime === null || /^([01]\d|2[0-3]):[0-5]\d$/.test(String(startTime)))) return res.status(400).json({ error: 'invalid_start_time' });
  if (endTime !== undefined && !(endTime === null || /^([01]\d|2[0-3]):[0-5]\d$/.test(String(endTime)))) return res.status(400).json({ error: 'invalid_end_time' });
  if (startTime && endTime && String(endTime) < String(startTime)) return res.status(400).json({ error: 'invalid_time_range' });
  if (recurrence !== undefined && typeof recurrence !== 'object') return res.status(400).json({ error: 'invalid_recurrence' });
  if (recurrence && recurrence.type && recurrence.type !== 'none') {
    const anchor = (scheduledFor !== undefined) ? scheduledFor : (db.getEventById(id)?.scheduledFor ?? null);
    if (!(anchor !== null && isYmdString(anchor))) return res.status(400).json({ error: 'missing_anchor_for_recurrence' });
  }
  try {
    const ev = db.updateEvent(id, { title, notes, scheduledFor, startTime, endTime, location, priority, completed, recurrence });
    return res.json({ event: ev });
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (msg === 'not_found') return res.status(404).json({ error: 'not_found' });
    return res.status(500).json({ error: 'update_failed' });
  }
});

app.patch('/api/events/:id/occurrence', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { occurrenceDate, completed } = req.body || {};
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  if (!isYmdString(occurrenceDate)) return res.status(400).json({ error: 'invalid_occurrenceDate' });
  try { const ev = db.toggleEventOccurrence({ id, occurrenceDate, completed: !!completed }); return res.json({ event: ev }); }
  catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (msg === 'not_repeating') return res.status(400).json({ error: 'not_repeating' });
    if (msg === 'not_found') return res.status(404).json({ error: 'not_found' });
    return res.status(500).json({ error: 'occurrence_failed' });
  }
});

app.delete('/api/events/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  try { db.deleteEvent(id); return res.json({ ok: true }); }
  catch { return res.status(500).json({ error: 'delete_failed' }); }
});

// Events search
app.get('/api/events/search', (req, res) => {
  const qRaw = String(req.query.query || '');
  const q = qRaw.trim();
  if (q.length === 0) return res.status(400).json({ error: 'invalid_query' });
  let completedBool;
  if (req.query.completed !== undefined) {
    if (req.query.completed === 'true' || req.query.completed === true) completedBool = true;
    else if (req.query.completed === 'false' || req.query.completed === false) completedBool = false;
    else return res.status(400).json({ error: 'invalid_completed' });
  }
  try {
    let items = db.searchEvents({ q, completed: completedBool });
    if (q.length < 2) {
      const ql = q.toLowerCase();
      items = items.filter(e => String(e.title || '').toLowerCase().includes(ql) || String(e.notes || '').toLowerCase().includes(ql) || String(e.location || '').toLowerCase().includes(ql));
    }
    const todayY = ymdInTimeZone(new Date(), TIMEZONE);
    const score = (e) => {
      let s = 0;
      const overdue = (!e.completed && e.scheduledFor && String(e.scheduledFor) < String(todayY));
      if (overdue) s += 0.5;
      if (e.priority === 'high') s += 0.25;
      else if (e.priority === 'medium') s += 0.1;
      return s;
    };
    items = items.map(e => ({ e, s: score(e) }))
      .sort((a, b) => b.s - a.s || String(a.e.scheduledFor || '').localeCompare(String(b.e.scheduledFor || '')) || (a.e.id - b.e.id))
      .map(x => x.e);
    return res.json({ events: items });
  } catch (e) {
    return res.status(500).json({ error: 'search_failed' });
  }
});

// Unified schedule (todos + events; habits added once implemented)
app.get('/api/schedule', (req, res) => {
  const { from, to, kinds, completed, priority } = req.query || {};
  if (!isYmdString(from)) return res.status(400).json({ error: 'invalid_from' });
  if (!isYmdString(to)) return res.status(400).json({ error: 'invalid_to' });
  let completedBool;
  if (completed !== undefined) {
    if (completed === 'true' || completed === true) completedBool = true;
    else if (completed === 'false' || completed === false) completedBool = false;
    else return res.status(400).json({ error: 'invalid_completed' });
  }
  if (priority !== undefined && !['low','medium','high'].includes(String(priority))) return res.status(400).json({ error: 'invalid_priority' });

  const requestedKinds = (() => {
    // Default to tasks + events; client should pass kinds explicitly to include habits
    const csv = String(kinds || 'todo,event').trim();
    const parts = csv.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const set = new Set(parts.length ? parts : ['todo','event']);
    return ['todo','event','habit'].filter(k => set.has(k));
  })();

  try {
    const fromDate = parseYMD(from);
    const toDate = parseYMD(to);
    const inclusiveEnd = new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate() + 1);
    const inRange = (d) => {
      if (!d) return false;
      return (d >= fromDate) && (d < inclusiveEnd);
    };

    const items = [];

    if (requestedKinds.includes('todo')) {
      let todos = db.listTodos({ from: null, to: null }).filter(t => t.scheduledFor !== null);
      if (priority) todos = todos.filter(t => String(t.priority).toLowerCase() === String(priority).toLowerCase());
      // Expand where needed
      for (const t of todos) {
        const isRepeating = (t.recurrence && t.recurrence.type && t.recurrence.type !== 'none');
        if (isRepeating) {
          for (const occ of expandOccurrences(t, fromDate, toDate)) {
            if (completedBool === undefined || occ.completed === completedBool) {
              items.push({
                kind: 'todo',
                id: occ.id,
                masterId: occ.masterId,
                title: occ.title,
                notes: occ.notes,
                scheduledFor: occ.scheduledFor,
                priority: occ.priority,
                completed: occ.completed,
                timeOfDay: occ.timeOfDay ?? null,
                recurrence: occ.recurrence,
                createdAt: occ.createdAt,
                updatedAt: occ.updatedAt,
              });
            }
          }
        } else {
          const td = t.scheduledFor ? parseYMD(t.scheduledFor) : null;
          if (inRange(td) && (completedBool === undefined || t.completed === completedBool)) {
            items.push({
              kind: 'todo',
              id: t.id,
              title: t.title,
              notes: t.notes,
              scheduledFor: t.scheduledFor,
              priority: t.priority,
              completed: t.completed,
              timeOfDay: t.timeOfDay ?? null,
              recurrence: t.recurrence,
              createdAt: t.createdAt,
              updatedAt: t.updatedAt,
            });
          }
        }
      }
    }

    if (requestedKinds.includes('event')) {
      let events = db.listEvents({ from: null, to: null }).filter(e => e.scheduledFor !== null);
      if (priority) events = events.filter(e => String(e.priority).toLowerCase() === String(priority).toLowerCase());
      for (const e of events) {
        const isRepeating = (e.recurrence && e.recurrence.type && e.recurrence.type !== 'none');
        if (isRepeating) {
          for (const occ of expandEventOccurrences(e, fromDate, toDate)) {
            if (completedBool === undefined || occ.completed === completedBool) {
              items.push({
                kind: 'event',
                id: occ.id,
                masterId: occ.masterId,
                title: occ.title,
                notes: occ.notes,
                scheduledFor: occ.scheduledFor,
                priority: occ.priority,
                completed: occ.completed,
                startTime: occ.startTime ?? null,
                endTime: occ.endTime ?? null,
                location: occ.location ?? null,
                recurrence: occ.recurrence,
                createdAt: occ.createdAt,
                updatedAt: occ.updatedAt,
              });
            }
          }
        } else {
          const ed = e.scheduledFor ? parseYMD(e.scheduledFor) : null;
          if (inRange(ed) && (completedBool === undefined || e.completed === completedBool)) {
            items.push({
              kind: 'event',
              id: e.id,
              title: e.title,
              notes: e.notes,
              scheduledFor: e.scheduledFor,
              priority: e.priority,
              completed: e.completed,
              startTime: e.startTime ?? null,
              endTime: e.endTime ?? null,
              location: e.location ?? null,
              recurrence: e.recurrence,
              createdAt: e.createdAt,
              updatedAt: e.updatedAt,
            });
          }
        }
      }
    }

    if (requestedKinds.includes('habit')) {
      let habits = db.listHabits({ from: null, to: null }).filter(h => h.scheduledFor !== null);
      if (priority) habits = habits.filter(h => String(h.priority).toLowerCase() === String(priority).toLowerCase());
      for (const h of habits) {
        // habits must be repeating; always expand
        for (const occ of expandOccurrences(h, fromDate, toDate)) {
          if (completedBool === undefined || occ.completed === completedBool) {
            items.push({
              kind: 'habit',
              id: occ.id,
              masterId: occ.masterId,
              title: occ.title,
              notes: occ.notes,
              scheduledFor: occ.scheduledFor,
              priority: occ.priority,
              completed: occ.completed,
              timeOfDay: occ.timeOfDay ?? null,
              recurrence: occ.recurrence,
              createdAt: occ.createdAt,
              updatedAt: occ.updatedAt,
            });
          }
        }
      }
    }

    // Sort: (scheduledFor ASC, time ASC nulls-first, kind order event<todo<habit, id ASC)
    const kindOrder = { event: 0, todo: 1, habit: 2 };
    items.sort((a, b) => {
      const da = String(a.scheduledFor || '');
      const dbs = String(b.scheduledFor || '');
      if (da !== dbs) return da.localeCompare(dbs);
      const ta = (a.kind === 'event') ? (a.startTime || '') : (a.timeOfDay || '');
      const tb = (b.kind === 'event') ? (b.startTime || '') : (b.timeOfDay || '');
      if (ta === '' && tb !== '') return -1;
      if (ta !== '' && tb === '') return 1;
      if (ta !== tb) return ta.localeCompare(tb);
      const ka = kindOrder[a.kind] ?? 99;
      const kb = kindOrder[b.kind] ?? 99;
      if (ka !== kb) return ka - kb;
      return (a.id || 0) - (b.id || 0);
    });

    return res.json({ items });
  } catch (e) {
    return res.status(500).json({ error: 'schedule_error' });
  }
});

// Goals
app.post('/api/goals', (req, res) => {
  const { title, notes, status, currentProgressValue, targetProgressValue, progressUnit } = req.body || {};
  if (typeof title !== 'string' || title.trim() === '') return res.status(400).json({ error: 'invalid_title' });
  if (status !== undefined && !['active','completed','archived'].includes(String(status))) return res.status(400).json({ error: 'invalid_status' });
  try {
    const g = db.createGoal({ title: title.trim(), notes: notes || '', status: status || 'active', currentProgressValue, targetProgressValue, progressUnit });
    return res.json({ goal: g });
  } catch { return res.status(500).json({ error: 'create_failed' }); }
});

app.get('/api/goals', (req, res) => {
  const { status } = req.query || {};
  if (status !== undefined && !['active','completed','archived'].includes(String(status))) return res.status(400).json({ error: 'invalid_status' });
  try { const list = db.listGoals({ status: status || null }); return res.json({ goals: list }); }
  catch { return res.status(500).json({ error: 'db_error' }); }
});

app.get('/api/goals/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  const g = db.getGoalById(id, { includeItems: String(req.query.includeItems||'false')==='true', includeChildren: String(req.query.includeChildren||'false')==='true' });
  if (!g) return res.status(404).json({ error: 'not_found' });
  return res.json({ goal: g });
});

app.patch('/api/goals/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  const { title, notes, status, currentProgressValue, targetProgressValue, progressUnit } = req.body || {};
  if (title !== undefined && typeof title !== 'string') return res.status(400).json({ error: 'invalid_title' });
  if (notes !== undefined && typeof notes !== 'string') return res.status(400).json({ error: 'invalid_notes' });
  if (status !== undefined && !['active','completed','archived'].includes(String(status))) return res.status(400).json({ error: 'invalid_status' });
  try { const g = db.updateGoal(id, { title, notes, status, currentProgressValue, targetProgressValue, progressUnit }); return res.json({ goal: g }); }
  catch (e) { const msg=String(e&&e.message?e.message:e); if(msg==='not_found') return res.status(404).json({error:'not_found'}); return res.status(500).json({ error: 'update_failed' }); }
});

app.delete('/api/goals/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  try { db.deleteGoal(id); return res.json({ ok: true }); }
  catch { return res.status(500).json({ error: 'delete_failed' }); }
});

app.post('/api/goals/:id/items', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  const { todos = [], events = [] } = req.body || {};
  try {
    db.addGoalTodoItems(id, (Array.isArray(todos)?todos:[]).map(Number).filter(Number.isFinite));
    db.addGoalEventItems(id, (Array.isArray(events)?events:[]).map(Number).filter(Number.isFinite));
    return res.json({ ok: true });
  } catch { return res.status(500).json({ error: 'add_items_failed' }); }
});

app.delete('/api/goals/:goalId/items/todo/:todoId', (req, res) => {
  const gid = parseInt(req.params.goalId, 10);
  const tid = parseInt(req.params.todoId, 10);
  if (!Number.isFinite(gid) || !Number.isFinite(tid)) return res.status(400).json({ error: 'invalid_id' });
  try { db.removeGoalTodoItem(gid, tid); return res.json({ ok: true }); }
  catch { return res.status(500).json({ error: 'remove_item_failed' }); }
});

app.delete('/api/goals/:goalId/items/event/:eventId', (req, res) => {
  const gid = parseInt(req.params.goalId, 10);
  const eid = parseInt(req.params.eventId, 10);
  if (!Number.isFinite(gid) || !Number.isFinite(eid)) return res.status(400).json({ error: 'invalid_id' });
  try { db.removeGoalEventItem(gid, eid); return res.json({ ok: true }); }
  catch { return res.status(500).json({ error: 'remove_item_failed' }); }
});

app.post('/api/goals/:id/children', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  const children = Array.isArray(req.body) ? req.body : [];
  try { db.addGoalChildren(id, children.map(Number).filter(Number.isFinite)); return res.json({ ok: true }); }
  catch { return res.status(500).json({ error: 'add_children_failed' }); }
});

app.delete('/api/goals/:parentId/children/:childId', (req, res) => {
  const pid = parseInt(req.params.parentId, 10);
  const cid = parseInt(req.params.childId, 10);
  if (!Number.isFinite(pid) || !Number.isFinite(cid)) return res.status(400).json({ error: 'invalid_id' });
  try { db.removeGoalChild(pid, cid); return res.json({ ok: true }); }
  catch { return res.status(500).json({ error: 'remove_child_failed' }); }
});

// Update by id
app.patch('/api/todos/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  const { title, notes, scheduledFor, priority, completed, timeOfDay, recurrence } = req.body || {};
  if (title !== undefined && typeof title !== 'string') return res.status(400).json({ error: 'invalid_title' });
  if (notes !== undefined && typeof notes !== 'string') return res.status(400).json({ error: 'invalid_notes' });
  if (!(scheduledFor === undefined || scheduledFor === null || isYmdString(scheduledFor))) {
    return res.status(400).json({ error: 'invalid_scheduledFor' });
  }
  if (priority !== undefined && !['low', 'medium', 'high'].includes(String(priority))) {
    return res.status(400).json({ error: 'invalid_priority' });
  }
  if (completed !== undefined && typeof completed !== 'boolean') {
    return res.status(400).json({ error: 'invalid_completed' });
  }
  if (timeOfDay !== undefined && !isValidTimeOfDay(timeOfDay === '' ? null : timeOfDay)) {
    return res.status(400).json({ error: 'invalid_timeOfDay' });
  }
  if (recurrence !== undefined && !isValidRecurrence(recurrence)) {
    return res.status(400).json({ error: 'invalid_recurrence' });
  }
  // Strict: require recurrence object to be present on update as a policy
  if (!(recurrence && typeof recurrence === 'object' && typeof recurrence.type === 'string')) {
    return res.status(400).json({ error: 'missing_recurrence' });
  }
  if (recurrence && recurrence.type && recurrence.type !== 'none') {
    const anchor = (scheduledFor !== undefined) ? scheduledFor : (findTodoById(id)?.scheduledFor ?? null);
    if (!(anchor !== null && isYmdString(anchor))) {
      return res.status(400).json({ error: 'missing_anchor_for_recurrence' });
    }
  }

  const t = findTodoById(id);
  if (!t) return res.status(404).json({ error: 'not_found' });
  const now = new Date().toISOString();
  if (title !== undefined) t.title = title;
  if (notes !== undefined) t.notes = notes;
  if (scheduledFor !== undefined) t.scheduledFor = scheduledFor;
  if (priority !== undefined) t.priority = priority;
  if (completed !== undefined) t.completed = completed;
  if (timeOfDay !== undefined) t.timeOfDay = (timeOfDay === '' ? null : timeOfDay);
  if (recurrence !== undefined) { applyRecurrenceMutation(t, recurrence); }
  t.updatedAt = now;
  try { const updated = db.updateTodo(id, t); res.json({ todo: updated }); } catch { res.json({ todo: t }); }
});

// Occurrence completion for repeating tasks
app.patch('/api/todos/:id/occurrence', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  const { occurrenceDate, completed } = req.body || {};
  if (!isYmdString(occurrenceDate)) return res.status(400).json({ error: 'invalid_occurrenceDate' });
  if (completed !== undefined && typeof completed !== 'boolean') return res.status(400).json({ error: 'invalid_completed' });
  try {
    const updated = db.toggleTodoOccurrence({ id, occurrenceDate, completed: !!completed });
    return res.json({ todo: updated });
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (msg === 'not_repeating') return res.status(400).json({ error: 'not_repeating' });
    if (msg === 'not_found') return res.status(404).json({ error: 'not_found' });
    return res.status(500).json({ error: 'occurrence_failed' });
  }
});

// Delete by id
app.delete('/api/todos/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  const existing = findTodoById(id);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  db.deleteTodo(id);
  res.json({ ok: true });
});

// --- LLM proposal-and-verify (Ollama) ---
const OLLAMA_MODEL = 'deepcoder:14b';
const OLLAMA_TEMPERATURE = 0.1;
const GLOBAL_TIMEOUT_SECS = parseInt('300', 10);
const CLARIFY_THRESHOLD = 0.45;
const CHAT_THRESHOLD = 0.70;
// Note: bulk operations are not supported; validation rejects them.

// Read-only endpoint to expose the current assistant model (UX badge)
app.get('/api/assistant/model', (_req, res) => {
  res.json({ model: OLLAMA_MODEL });
});


function validateWhere(where) {
  const errors = [];
  if (!where || typeof where !== 'object') return ['invalid_where_object'];
  const w = where;
  if (w.ids !== undefined && !Array.isArray(w.ids)) errors.push('invalid_where_ids');
  if (w.title_contains !== undefined && typeof w.title_contains !== 'string') errors.push('invalid_where_title_contains');
  if (w.overdue !== undefined && typeof w.overdue !== 'boolean') errors.push('invalid_where_overdue');
  if (w.scheduled_range !== undefined) {
    if (typeof w.scheduled_range !== 'object') errors.push('invalid_where_scheduled_range');
    else {
      const r = w.scheduled_range;
      if (r.from !== undefined && !(r.from === null || isYmdString(r.from))) errors.push('invalid_where_scheduled_range_from');
      if (r.to !== undefined && !(r.to === null || isYmdString(r.to))) errors.push('invalid_where_scheduled_range_to');
    }
  }
  if (w.priority !== undefined && !['low','medium','high'].includes(String(w.priority))) errors.push('invalid_where_priority');
  if (w.completed !== undefined && typeof w.completed !== 'boolean') errors.push('invalid_where_completed');
  if (w.repeating !== undefined && typeof w.repeating !== 'boolean') errors.push('invalid_where_repeating');
  return errors;
}

function validateOperation(op) {
  const errors = [];
  if (!op || typeof op !== 'object') return ['invalid_operation_object'];
  // V3 only: derive internal op code
  const kindV3 = op.kind && String(op.kind).toLowerCase();
  const actionV3 = op.action && String(op.action).toLowerCase();
  const inferred = inferOperationShape(op);
  const kind = inferred?.op;
  const allowedKinds = ['create', 'update', 'delete', 'complete', 'complete_occurrence', 'goal_create', 'goal_update', 'goal_delete', 'goal_add_items', 'goal_remove_item', 'goal_add_child', 'goal_remove_child'];
  if (!allowedKinds.includes(kind)) errors.push('invalid_op');
  if (op.priority !== undefined && !['low','medium','high'].includes(String(op.priority))) errors.push('invalid_priority');
  if (op.scheduledFor !== undefined && !(op.scheduledFor === null || isYmdString(op.scheduledFor))) errors.push('invalid_scheduledFor');
  if (op.timeOfDay !== undefined && !isValidTimeOfDay(op.timeOfDay === '' ? null : op.timeOfDay)) errors.push('invalid_timeOfDay');
  if (op.recurrence !== undefined && !isValidRecurrence(op.recurrence)) errors.push('invalid_recurrence');
  // Strict: require recurrence on create/update
  if (kind === 'create' || kind === 'update') {
    if (!(op.recurrence && typeof op.recurrence === 'object' && 'type' in op.recurrence)) {
      errors.push('missing_recurrence');
    }
    // Habits must be repeating
    if (kindV3 === 'habit' && op.recurrence && op.recurrence.type === 'none') {
      errors.push('invalid_recurrence');
    }
  }
  if ((kind === 'update' || kind === 'delete' || kind === 'complete' || kind === 'complete_occurrence')) {
    if (!(Number.isFinite(op.id))) {
      errors.push('missing_or_invalid_id');
    } else {
      const v3Kind = (op.kind && String(op.kind).toLowerCase()) || null;
      // For validation we do not hard-require current existence; apply stage will 404 appropriately.
      // This avoids false negatives for entities created earlier in the same batch.
    }
  }
  if (kind === 'complete_occurrence') {
    if (!isYmdString(op.occurrenceDate)) errors.push('invalid_occurrenceDate');
    if (op.completed !== undefined && typeof op.completed !== 'boolean') errors.push('invalid_completed');
  }
  // Strict: if op targets a repeating task, forbid master complete and require anchor when recurrence changes
  if (kind === 'complete') {
    const t = Number.isFinite(op.id) ? findTodoById(op.id) : null;
    const e = Number.isFinite(op.id) ? db.getEventById(op.id) : null;
    const h = Number.isFinite(op.id) ? db.getHabitById?.(op.id) : null;
    if ((t && t.recurrence && t.recurrence.type && t.recurrence.type !== 'none') ||
        (e && e.recurrence && e.recurrence.type && e.recurrence.type !== 'none') ||
        (h && h.recurrence && h.recurrence.type && h.recurrence.type !== 'none')) {
      errors.push('use_complete_occurrence_for_repeating');
    }
  }
  if (kind === 'create' || kind === 'update') {
    const type = op.recurrence && op.recurrence.type;
    if (type && type !== 'none') {
      // Anchor required for repeating tasks
      const anchor = op.scheduledFor;
      if (!(anchor && isYmdString(anchor))) errors.push('missing_anchor_for_recurrence');
    }
  }
  // Reject bulk operations in V3
  if (op.op === 'bulk_update' || op.op === 'bulk_complete' || op.op === 'bulk_delete' || actionV3?.startsWith('bulk')) {
    errors.push('bulk_operations_removed');
  }
  return errors;
}

function validateProposal(body) {
  if (!body || typeof body !== 'object') return { errors: ['invalid_body'] };
  const operations = Array.isArray(body.operations) ? body.operations.map(o => inferOperationShape(o)).filter(Boolean) : [];
  if (!operations.length) return { errors: ['missing_operations'], operations: [] };
  const results = operations.map(o => ({ op: o, errors: validateOperation(o) }));
  const invalid = results.filter(r => r.errors.length > 0);
  return { operations, results, errors: invalid.length ? ['invalid_operations'] : [] };
}

function inferOperationShape(o) {
  if (!o || typeof o !== 'object') return null;
  const op = { ...o };
  // Map V3 to internal v2-like for execution layer
  if (op.kind && op.action) {
    const kind = String(op.kind).toLowerCase();
    const action = String(op.action).toLowerCase();
    if (kind === 'todo') {
      if (action === 'create') op.op = 'create';
      else if (action === 'update') op.op = 'update';
      else if (action === 'delete') op.op = 'delete';
      else if (action === 'complete') op.op = 'complete';
      else if (action === 'complete_occurrence') op.op = 'complete_occurrence';
    } else if (kind === 'event') {
      // For now, map event ops to todo pipeline placeholders (server uses todo paths); extend later
      if (action === 'create') op.op = 'create';
      else if (action === 'update') op.op = 'update';
      else if (action === 'delete') op.op = 'delete';
      else if (action === 'complete') op.op = 'complete';
      else if (action === 'complete_occurrence') op.op = 'complete_occurrence';
    } else if (kind === 'habit') {
      if (action === 'create') op.op = 'create';
      else if (action === 'update') op.op = 'update';
      else if (action === 'delete') op.op = 'delete';
      else if (action === 'complete') op.op = 'complete';
      else if (action === 'complete_occurrence') op.op = 'complete_occurrence';
    } else if (kind === 'goal') {
      if (action === 'create') op.op = 'goal_create';
      else if (action === 'update') op.op = 'goal_update';
      else if (action === 'delete') op.op = 'goal_delete';
      else if (action === 'add_items') op.op = 'goal_add_items';
      else if (action === 'remove_item') op.op = 'goal_remove_item';
      else if (action === 'add_child') op.op = 'goal_add_child';
      else if (action === 'remove_child') op.op = 'goal_remove_child';
    }
  }
  if (!op.op) {
    const hasId = Number.isFinite(op.id);
    const hasCompleted = typeof op.completed === 'boolean';
    const hasTitleOrNotesOrSchedOrPrio = !!(op.title || op.notes || (op.scheduledFor !== undefined) || op.priority);
    if (!hasId && (op.title || op.scheduledFor !== undefined || op.priority)) {
      op.op = 'create';
      delete op.id;
    } else if (hasId && hasCompleted && !hasTitleOrNotesOrSchedOrPrio) {
      op.op = 'complete';
    } else if (hasId && hasTitleOrNotesOrSchedOrPrio) {
      op.op = 'update';
    }
  }
  // Normalize fields
  if (op.priority && typeof op.priority === 'string') op.priority = op.priority.toLowerCase();
  if (op.scheduledFor === '') op.scheduledFor = null;
  return op;
}

function runOllamaPrompt(prompt) {
  return new Promise((resolve, reject) => {
    if (!OLLAMA_MODEL) return reject(new Error('ollama_model_not_set'));
    const tryArgsList = [
      ['run', OLLAMA_MODEL, '--temperature', String(OLLAMA_TEMPERATURE)],
      ['run', OLLAMA_MODEL], // fallback for CLI versions without temperature flag
    ];
    let attempt = 0;
    const tryOnce = () => {
      const args = tryArgsList[attempt];
      const proc = spawn('ollama', args);
      let out = '';
      let err = '';
      const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} ; reject(new Error('timeout')); }, Math.max(1000, GLOBAL_TIMEOUT_SECS * 1000));
      proc.stdout.on('data', d => out += d.toString());
      proc.stderr.on('data', d => err += d.toString());
      proc.on('close', code => {
        clearTimeout(t);
        if (code === 0) return resolve(out.trim());
        const unknownFlag = /unknown flag/i.test(err) || /flag provided but not defined/i.test(err);
        if (attempt === 0 && unknownFlag) {
          attempt = 1; // retry without temperature
          return tryOnce();
        }
        reject(new Error(`ollama_exit_${code}: ${err}`));
      });
      proc.stdin.end(prompt);
    };
    tryOnce();
  });
}

function isGraniteModel() {
  try { return /granite/i.test(String(OLLAMA_MODEL)); } catch { return false; }
}

function runOllamaWithThinkingIfGranite({ userContent }) {
  // For Granite models that support control messages, send a messages JSON
  // with a control "thinking" directive followed by the user content.
  if (isGraniteModel()) {
    const messagesPayload = JSON.stringify({
      messages: [
        { role: 'control', content: 'thinking' },
        { role: 'user', content: userContent }
      ]
    });
    return runOllamaPrompt(messagesPayload);
  }
  return runOllamaPrompt(userContent);
}

// Attempt HTTP JSON-biased generation via Ollama; falls back to CLI on error at call sites
async function tryRunOllamaJsonFormat({ userContent }) {
  const base = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
  const url = `${base}/api/generate`;
  const payload = { model: OLLAMA_MODEL, prompt: userContent, format: 'json', stream: false };
  const controller = new AbortController();
  const timeoutMs = Math.max(1000, GLOBAL_TIMEOUT_SECS * 1000);
  const timer = setTimeout(() => { try { controller.abort(); } catch {} }, timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`ollama_http_${res.status}`);
    const obj = await res.json();
    const text = String(obj && (obj.response ?? obj.text) || '');
    if (!text) throw new Error('ollama_http_empty');
    return text;
  } finally {
    try { clearTimeout(timer); } catch {}
  }
}

async function runOllamaForJsonPreferred({ userContent }) {
  try {
    return await tryRunOllamaJsonFormat({ userContent });
  } catch {
    return await runOllamaWithThinkingIfGranite({ userContent });
  }
}

// If Granite returns <think>...</think><response>...</response>,
// extract the inner of <response> first, then proceed with JSON parsing.
function extractResponseBody(text) {
  try {
    const match = String(text).match(/<response>([\s\S]*?)<\/response>/i);
    return match ? match[1].trim() : String(text);
  } catch { return String(text); }
}

// Remove Granite-style thinking/response tags from free-form text summaries
function stripGraniteTags(text) {
  try {
    let s = String(text);
    // Drop entire <think>...</think> blocks
    s = s.replace(/<think>[\s\S]*?<\/think>/gi, '');
    // Remove <response> wrappers but keep inner content if any remain
    s = s.replace(/<\/?response>/gi, '');
    return s;
  } catch { return String(text); }
}

// Lenient JSON parsing: try direct parse, then strip code fences, then brace-match first object
function parseJsonLenient(text) {
  const tryParse = (t) => { try { return JSON.parse(t); } catch { return null; } };
  try {
    const body = String(text || '');
    // 1) direct
    let parsed = tryParse(body);
    if (parsed) return parsed;
    // 2) fenced ```json or ```
    if (/```/.test(body)) {
      const unfenced = body.replace(/```json|```/g, '').trim();
      parsed = tryParse(unfenced);
      if (parsed) return parsed;
    }
    // 3) first top-level { ... } object
    const s = body;
    const start = s.indexOf('{');
    if (start !== -1) {
      let depth = 0; let end = -1;
      for (let i = start; i < s.length; i++) {
        const ch = s[i];
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end !== -1) {
        const sliced = s.slice(start, end + 1);
        parsed = tryParse(sliced);
        if (parsed) return parsed;
      }
    }
  } catch {}
  return null;
}

function buildSchemaV2Excerpt() {
  // Repurposed for V3 reminder text (no bulk operations)
  return [
    'Schema v3:',
    '- Wrapper: { kind: "todo"|"event"|"goal", action: string, ...payload }',
    '- todo actions: create|update|delete|complete|complete_occurrence',
    '- event actions: create|update|delete|complete|complete_occurrence',
    '- goal actions: create|update|delete|add_items|remove_item|add_child|remove_child',
    'Rules:',
    '- For todo/event create/update, include a recurrence object (use {"type":"none"} for non-repeating).',
    '- For repeating tasks/events (recurrence.type != none), an anchor scheduledFor is REQUIRED.',
    '- For repeating items, do not use master complete; use complete_occurrence with occurrenceDate.',
    '- No bulk operations; emit independent ops, ≤20 per apply.'
  ].join('\n');
}

function buildRepairPrompt({ instruction, originalOps, errors, transcript }) {
  const schema = buildSchemaV2Excerpt();
  const last3 = Array.isArray(transcript) ? transcript.slice(-3) : [];
  const convo = last3.map((t) => `- ${t.role}: ${t.text}`).join('\n');
  const payload = { originalOps, errors };
  return (
    'You proposed operations for a todo app, but some failed validation. Fix them.\n' +
    'Return JSON only with the corrected "operations" array. Do not include explanations.\n\n' +
    `Transcript (last 3):\n${convo}\n` +
    `Original instruction: ${instruction}\n` +
    `Schema reminder: ${schema}\n` +
    'Inputs (JSON):\n' +
    JSON.stringify(payload, null, 2) +
    '\nOutput: {"operations": [...]} (JSON only)'
  );
}

function buildRouterPrompt({ instruction, transcript, clarify }) {
  const today = new Date();
  const todayYmd = ymdInTimeZone(today, TIMEZONE);
  const last3 = Array.isArray(transcript) ? transcript.slice(-3) : [];
  const convo = last3.map((t) => `- ${t.role}: ${t.text}`).join('\n');
  const system = `You are an intent router for a todo assistant. Output JSON only with fields:\n` +
    `decision: one of ["chat", "plan", "clarify"],\n` +
    `category: one of ["habit", "goal", "task", "event"],\n` +
    `entities: object, missing: array, confidence: number 0..1, question: string (required when decision=clarify).\n` +
    `If the instruction is ambiguous about time/date or target, choose clarify and ask ONE short question. No prose.\n` +
    `If the user asks to change all items in a clear scope (e.g., "all today", "all of them", "everything this week"), prefer plan.\n` +
    `If a prior clarify question is present, interpret short answers like "all of them", "yes", "all today" as resolving that question and prefer plan.\n` +
    `Use the Context section below (this week Mon–Sun anchored to today, backlog sample, completed=false).`;
  const prior = clarify && clarify.question ? `\nPrior clarify question: ${clarify.question}` : '';
  const snapshots = buildRouterSnapshots();
  const contextJson = JSON.stringify(snapshots);
  const user = `Today: ${todayYmd} (${TIMEZONE})\nTranscript (last 3):\n${convo}${prior}\nContext (this week, Mon–Sun, master-level, backlog sample, completed=false):\n${contextJson}\nUser: ${instruction}`;
  return `${system}\n\n${user}`;
}

async function runRouter({ instruction, transcript, clarify }) {
  try {
    const prompt = buildRouterPrompt({ instruction, transcript, clarify });
    const raw = await runOllamaForJsonPreferred({ userContent: prompt });
    const body = extractResponseBody(raw);
    let parsed = parseJsonLenient(body);
    if (parsed && typeof parsed === 'object') {
      let result = {
        decision: String(parsed.decision || 'plan').toLowerCase(),
        category: parsed.category,
        entities: parsed.entities,
        missing: parsed.missing,
        confidence: Number(parsed.confidence || 0),
        question: parsed.question,
      };
      // Confidence-gated routing adjustments
      try {
        const c = Number.isFinite(result.confidence) ? result.confidence : 0;
        if (c < CLARIFY_THRESHOLD) result.decision = 'clarify';
        else if (c < CHAT_THRESHOLD && result.decision === 'plan') result.decision = 'chat';
        // If clarify.selection is present, bias to plan and seed where
        if (clarify && clarify.selection && typeof clarify.selection === 'object') {
          result.decision = 'plan';
          const sel = clarify.selection;
          const where = {};
          if (Array.isArray(sel.ids) && sel.ids.length) where.ids = sel.ids;
          if (sel.priority) where.priority = sel.priority;
          if (sel.date) where.scheduled_range = { from: sel.date, to: sel.date };
          result.where = Object.keys(where).length ? where : result.where;
        }
      } catch {}
      if (result.decision === 'clarify') {
        try {
          const snapshots = buildRouterSnapshots();
          const cands = topClarifyCandidates(instruction, snapshots, 5);
          if (cands.length) {
            const bullets = cands
              .map(c => `#${c.id} "${String(c.title).slice(0, 40)}"${c.scheduledFor ? ` @${c.scheduledFor}` : ''}`)
              .join('; ');
            const q = result.question && String(result.question).trim().length > 0
              ? result.question
              : 'Which item do you mean?';
            result.question = `${q} Options: ${bullets}.`;
            // Also return structured options alongside the decorated question
            result.options = cands.map(c => ({ id: c.id, title: c.title, scheduledFor: (c.scheduledFor ?? null) }));
          }
        } catch {}
      }
      return result;
    }
  } catch {}
  return { decision: 'plan', confidence: 0 };
}

function buildProposalPrompt({ instruction, todosSnapshot, transcript }) {
  const today = new Date();
  const todayYmd = ymdInTimeZone(today, TIMEZONE);
  const system = `You are an assistant for a todo app. Output ONLY a single JSON object with key "operations" as an array. No prose.\n` +
    `Each operation MUST include fields: kind (todo|event|goal) and action.\n` +
    `todo actions: create|update|delete|complete|complete_occurrence.\n` +
    `event actions: create|update|delete|complete|complete_occurrence.\n` +
    `goal actions: create|update|delete|add_items|remove_item|add_child|remove_child.\n` +
    `For todo/event create/update include recurrence (use {"type":"none"} for non-repeating). If recurrence.type != none, scheduledFor is REQUIRED.\n` +
    `For complete_occurrence include id (masterId) and occurrenceDate (YYYY-MM-DD).\n` +
    `No bulk operations. Emit independent operations; limit to ≤20 per apply.\n` +
    `Today's date is ${todayYmd}. Do NOT invent invalid IDs. Prefer fewer changes over hallucination.\n` +
    `You may reason internally, but the final output MUST be a single JSON object exactly as specified. Do not include your reasoning or any prose.`;
  const last3 = Array.isArray(transcript) ? transcript.slice(-3) : [];
  const convo = last3.map((t) => `- ${t.role}: ${t.text}`).join('\n');
  const context = JSON.stringify({ todos: todosSnapshot }, null, 2);
  const user = `Conversation (last 3 turns):\n${convo}\n\nTimezone: ${TIMEZONE}\nInstruction:\n${instruction}\n\nContext:\n${context}\n\nRespond with JSON ONLY that matches this exact example format:\n{\n  "operations": [\n    {"kind":"todo","action":"create","title":"<contextually relevant title>","scheduledFor":"${todayYmd}","priority":"high","recurrence":{"type":"none"}}\n  ]\n}`;
  return `${system}\n\n${user}`;
}


function appendAudit(entry) {
  try { db.logAudit(entry); } catch {}
}

async function withDbTransaction(fn) { return db.runInTransaction(fn); }

app.post('/api/llm/apply', async (req, res) => {
  const { operations } = req.body || {};
  const idempoKey = req.headers['idempotency-key'] || req.body?.idempotencyKey;
  if (Array.isArray(operations) && operations.length > 20) {
    return res.status(400).json({ error: 'too_many_operations', max: 20 });
  }
  const requestHash = (() => { try { return Buffer.from(JSON.stringify(operations || [])).toString('base64'); } catch { return ''; } })();
  try {
    const cached = (idempoKey && requestHash) ? db.getIdempotentResponse({ idempotencyKey: idempoKey, requestHash }) : null;
    if (cached) { try { return res.json(JSON.parse(cached)); } catch { return res.json(cached); } }
  } catch {}
  // Map V3 ops before validation
  const shapedOps = Array.isArray(operations) ? operations.map(o => inferOperationShape(o)).filter(Boolean) : [];
  const validation = validateProposal({ operations: shapedOps });
  if (validation.errors.length) {
    return res.status(400).json({ error: 'invalid_operations', detail: validation, message: 'Some operations were invalid. The assistant may be attempting unsupported or inconsistent changes.' });
  }
  const results = [];
  let created = 0, updated = 0, deleted = 0, completed = 0;
  await withDbTransaction(async () => {
    let mutatedSinceRefresh = false;
    for (const op of shapedOps) {
      try {
        // Event-kind V3 handling
        if (op.kind && String(op.kind).toLowerCase() === 'event' && op.op === 'create') {
          const ev = db.createEvent({
            title: String(op.title || '').trim(),
            notes: op.notes || '',
            scheduledFor: op.scheduledFor ?? null,
            startTime: (op.startTime === '' ? null : op.startTime) ?? null,
            endTime: (op.endTime === '' ? null : op.endTime) ?? null,
            location: op.location ?? null,
            priority: op.priority || 'medium',
            recurrence: op.recurrence,
            completed: false,
          });
          results.push({ ok: true, op, event: ev });
          appendAudit({ action: 'event_create', op, result: 'ok', id: ev.id });
        } else if (op.kind && String(op.kind).toLowerCase() === 'event' && op.op === 'update') {
          const id = parseInt(op.id, 10);
          if (!Number.isFinite(id)) throw new Error('missing_or_invalid_id');
          const ev = db.updateEvent(id, {
            title: op.title,
            notes: op.notes,
            scheduledFor: op.scheduledFor,
            startTime: (op.startTime === '' ? null : op.startTime),
            endTime: (op.endTime === '' ? null : op.endTime),
            location: op.location,
            priority: op.priority,
            completed: op.completed,
            recurrence: op.recurrence,
          });
          results.push({ ok: true, op, event: ev });
          appendAudit({ action: 'event_update', op, result: 'ok', id });
        } else if (op.kind && String(op.kind).toLowerCase() === 'event' && op.op === 'delete') {
          const id = parseInt(op.id, 10);
          if (!Number.isFinite(id)) throw new Error('missing_or_invalid_id');
          db.deleteEvent(id);
          results.push({ ok: true, op });
          appendAudit({ action: 'event_delete', op, result: 'ok', id });
        } else if (op.kind && String(op.kind).toLowerCase() === 'event' && op.op === 'complete') {
          const id = parseInt(op.id, 10);
          if (!Number.isFinite(id)) throw new Error('missing_or_invalid_id');
          const current = db.getEventById(id);
          if (!current) throw new Error('not_found');
          const ev = db.updateEvent(id, { completed: (op.completed === undefined) ? true : !!op.completed });
          results.push({ ok: true, op, event: ev });
          appendAudit({ action: 'event_complete', op, result: 'ok', id });
        } else if (op.kind && String(op.kind).toLowerCase() === 'event' && op.op === 'complete_occurrence') {
          const id = parseInt(op.id, 10);
          if (!Number.isFinite(id)) throw new Error('missing_or_invalid_id');
          const ev = db.toggleEventOccurrence({ id, occurrenceDate: op.occurrenceDate, completed: (op.completed === undefined) ? true : !!op.completed });
          results.push({ ok: true, op, event: ev });
          appendAudit({ action: 'event_complete_occurrence', op, result: 'ok', id });
        } else if (op.kind && String(op.kind).toLowerCase() === 'habit' && op.op === 'create') {
          const h = db.createHabit({
            title: String(op.title || '').trim(),
            notes: op.notes || '',
            scheduledFor: op.scheduledFor ?? null,
            timeOfDay: (op.timeOfDay === '' ? null : op.timeOfDay) ?? null,
            priority: op.priority || 'medium',
            recurrence: op.recurrence,
            completed: false,
          });
          results.push({ ok: true, op, habit: h });
          appendAudit({ action: 'habit_create', op, result: 'ok', id: h.id });
        } else if (op.kind && String(op.kind).toLowerCase() === 'habit' && op.op === 'update') {
          const id = parseInt(op.id, 10);
          if (!Number.isFinite(id)) throw new Error('missing_or_invalid_id');
          const h = db.updateHabit(id, {
            title: op.title,
            notes: op.notes,
            scheduledFor: op.scheduledFor,
            timeOfDay: (op.timeOfDay === '' ? null : op.timeOfDay),
            priority: op.priority,
            completed: op.completed,
            recurrence: op.recurrence,
          });
          results.push({ ok: true, op, habit: h });
          appendAudit({ action: 'habit_update', op, result: 'ok', id });
        } else if (op.kind && String(op.kind).toLowerCase() === 'habit' && op.op === 'delete') {
          const id = parseInt(op.id, 10);
          if (!Number.isFinite(id)) throw new Error('missing_or_invalid_id');
          db.deleteHabit(id);
          results.push({ ok: true, op });
          appendAudit({ action: 'habit_delete', op, result: 'ok', id });
        } else if (op.kind && String(op.kind).toLowerCase() === 'habit' && op.op === 'complete') {
          const id = parseInt(op.id, 10);
          if (!Number.isFinite(id)) throw new Error('missing_or_invalid_id');
          const current = db.getHabitById(id);
          if (!current) throw new Error('not_found');
          const h = db.updateHabit(id, { completed: (op.completed === undefined) ? true : !!op.completed });
          results.push({ ok: true, op, habit: h });
          appendAudit({ action: 'habit_complete', op, result: 'ok', id });
        } else if (op.kind && String(op.kind).toLowerCase() === 'habit' && op.op === 'complete_occurrence') {
          const id = parseInt(op.id, 10);
          if (!Number.isFinite(id)) throw new Error('missing_or_invalid_id');
          const h = db.toggleHabitOccurrence({ id, occurrenceDate: op.occurrenceDate, completed: (op.completed === undefined) ? true : !!op.completed });
          results.push({ ok: true, op, habit: h });
          appendAudit({ action: 'habit_complete_occurrence', op, result: 'ok', id });
        } else if (op.op === 'create') {
          const t = createTodoDb({ title: String(op.title || '').trim(), notes: op.notes || '', scheduledFor: op.scheduledFor ?? null, priority: op.priority || 'medium', timeOfDay: (op.timeOfDay === '' ? null : op.timeOfDay) ?? null, recurrence: op.recurrence });
          mutatedSinceRefresh = true; results.push({ ok: true, op, todo: t }); created++;
          appendAudit({ action: 'create', op, result: 'ok', id: t.id });
        } else if (op.op === 'update') {
          const t = findTodoById(op.id); if (!t) throw new Error('not_found');
          const now = new Date().toISOString();
          if (op.title !== undefined) t.title = op.title;
          if (op.notes !== undefined) t.notes = op.notes;
          if (op.scheduledFor !== undefined) t.scheduledFor = op.scheduledFor;
          if (op.priority !== undefined) t.priority = op.priority;
          if (op.completed !== undefined) t.completed = !!op.completed;
          if (op.timeOfDay !== undefined) t.timeOfDay = (op.timeOfDay === '' ? null : op.timeOfDay);
          if (op.recurrence !== undefined) { applyRecurrenceMutation(t, op.recurrence); }
          t.updatedAt = now; mutatedSinceRefresh = true; results.push({ ok: true, op, todo: t }); updated++;
          appendAudit({ action: 'update', op, result: 'ok', id: t.id });
        } else if (op.op === 'delete') {
          const existing = findTodoById(op.id); if (!existing) throw new Error('not_found');
          db.deleteTodo(op.id); mutatedSinceRefresh = true; results.push({ ok: true, op }); deleted++;
          appendAudit({ action: 'delete', op, result: 'ok', id: existing?.id });
        } else if (op.op === 'complete') {
          const t = findTodoById(op.id); if (!t) throw new Error('not_found');
          t.completed = op.completed === undefined ? true : !!op.completed; t.updatedAt = new Date().toISOString(); mutatedSinceRefresh = true; results.push({ ok: true, op, todo: t }); completed++;
          appendAudit({ action: 'complete', op, result: 'ok', id: t.id });
        } else if (op.op === 'complete_occurrence') {
          const t = findTodoById(op.id); if (!t) throw new Error('not_found');
          if (!(t.recurrence && t.recurrence.type && t.recurrence.type !== 'none')) throw new Error('not_repeating');
          if (!Array.isArray(t.completedDates)) t.completedDates = [];
          const idx = t.completedDates.indexOf(op.occurrenceDate);
          const shouldComplete = (op.completed === undefined) ? true : !!op.completed;
          if (shouldComplete) { if (idx === -1) t.completedDates.push(op.occurrenceDate); }
          else { if (idx !== -1) t.completedDates.splice(idx, 1); }
          t.updatedAt = new Date().toISOString(); mutatedSinceRefresh = true; results.push({ ok: true, op, todo: t }); completed++;
          appendAudit({ action: 'complete_occurrence', op, result: 'ok', id: t.id });
        } else if (
          op.op === 'goal_create' || op.op === 'goal_update' || op.op === 'goal_delete' ||
          op.op === 'goal_add_items' || op.op === 'goal_remove_item' ||
          op.op === 'goal_add_child' || op.op === 'goal_remove_child'
        ) {
          if (op.op === 'goal_create') {
            const g = db.createGoal({ title: String(op.title || '').trim(), notes: op.notes || '', status: op.status || 'active', currentProgressValue: op.currentProgressValue ?? null, targetProgressValue: op.targetProgressValue ?? null, progressUnit: op.progressUnit ?? null });
            results.push({ ok: true, op, goal: g });
            appendAudit({ action: 'goal_create', op, result: 'ok', id: g.id });
          } else if (op.op === 'goal_update') {
            const id = parseInt(op.id, 10);
            if (!Number.isFinite(id)) throw new Error('missing_or_invalid_id');
            const g = db.updateGoal(id, { title: op.title, notes: op.notes, status: op.status, currentProgressValue: op.currentProgressValue, targetProgressValue: op.targetProgressValue, progressUnit: op.progressUnit });
            results.push({ ok: true, op, goal: g });
            appendAudit({ action: 'goal_update', op, result: 'ok', id });
          } else if (op.op === 'goal_delete') {
            const id = parseInt(op.id, 10);
            if (!Number.isFinite(id)) throw new Error('missing_or_invalid_id');
            db.deleteGoal(id);
            results.push({ ok: true, op });
            appendAudit({ action: 'goal_delete', op, result: 'ok', id });
          } else if (op.op === 'goal_add_items') {
            const id = parseInt(op.id, 10);
            if (!Number.isFinite(id)) throw new Error('missing_or_invalid_id');
            const todoIds = Array.isArray(op.todos) ? op.todos.map(x => parseInt((x && x.id) ?? x, 10)).filter(Number.isFinite) : [];
            const eventIds = Array.isArray(op.events) ? op.events.map(x => parseInt((x && x.id) ?? x, 10)).filter(Number.isFinite) : [];
            if (todoIds.length) db.addGoalTodoItems(id, todoIds);
            if (eventIds.length) db.addGoalEventItems(id, eventIds);
            results.push({ ok: true, op, added: { todos: todoIds.length, events: eventIds.length } });
            appendAudit({ action: 'goal_add_items', op, result: 'ok', id });
          } else if (op.op === 'goal_remove_item') {
            const id = parseInt(op.id, 10);
            if (!Number.isFinite(id)) throw new Error('missing_or_invalid_id');
            if (Number.isFinite(op.todoId)) db.removeGoalTodoItem(id, parseInt(op.todoId, 10));
            else if (Number.isFinite(op.eventId)) db.removeGoalEventItem(id, parseInt(op.eventId, 10));
            else throw new Error('missing_item_id');
            results.push({ ok: true, op });
            appendAudit({ action: 'goal_remove_item', op, result: 'ok', id });
          } else if (op.op === 'goal_add_child') {
            const id = parseInt(op.id, 10);
            if (!Number.isFinite(id)) throw new Error('missing_or_invalid_id');
            const childId = parseInt(op.childId, 10);
            if (!Number.isFinite(childId)) throw new Error('missing_child_id');
            db.addGoalChildren(id, [childId]);
            results.push({ ok: true, op });
            appendAudit({ action: 'goal_add_child', op, result: 'ok', id });
          } else if (op.op === 'goal_remove_child') {
            const id = parseInt(op.id, 10);
            if (!Number.isFinite(id)) throw new Error('missing_or_invalid_id');
            const childId = parseInt(op.childId, 10);
            if (!Number.isFinite(childId)) throw new Error('missing_child_id');
            db.removeGoalChild(id, childId);
            results.push({ ok: true, op });
            appendAudit({ action: 'goal_remove_child', op, result: 'ok', id });
          }
        } else {
          results.push({ ok: false, op, error: 'invalid_op' });
          appendAudit({ action: 'invalid', op, result: 'invalid' });
        }
      } catch (e) {
        results.push({ ok: false, op, error: String(e && e.message ? e.message : e) });
        appendAudit({ action: op?.op || 'unknown', op, result: 'error', error: String(e && e.message ? e.message : e) });
      }
    }
  });
  const response = { results, summary: { created, updated, deleted, completed } };
  try { if (idempoKey && requestHash) db.saveIdempotentResponse({ idempotencyKey: idempoKey, requestHash, response }); } catch {}
  res.json(response);
});

// --- Assistant chat (two-call pipeline) ---
function buildConversationalSummaryPrompt({ instruction, operations, todosSnapshot, transcript }) {
  const today = new Date();
  const todayYmd = ymdInTimeZone(today, TIMEZONE);
  const compactOps = operations.map((op) => {
    const parts = [];
    parts.push(op.op);
    if (Number.isFinite(op.id)) parts.push(`#${op.id}`);
    if (op.title) parts.push(`"${String(op.title).slice(0, 60)}"`);
    if (op.scheduledFor !== undefined) parts.push(`@${op.scheduledFor === null ? 'unscheduled' : op.scheduledFor}`);
    if (op.priority) parts.push(`prio:${op.priority}`);
    if (typeof op.completed === 'boolean') parts.push(op.completed ? '[done]' : '[undone]');
    return `- ${parts.join(' ')}`;
  }).join('\n');
  const last3 = Array.isArray(transcript) ? transcript.slice(-3) : [];
  const convo = last3.map((t) => `- ${t.role}: ${t.text}`).join('\n');
  const system = `You are a helpful assistant for a todo app. Keep answers concise and clear. Prefer 1–3 short sentences; allow a short paragraph when needed. No markdown, no lists, no JSON.`;
  const context = `Conversation (last 3 turns):\n${convo}\n\nToday: ${todayYmd} (${TIMEZONE})\nProposed operations (count: ${operations.length}):\n${compactOps}`;
  const user = `User instruction:\n${instruction}`;
  const task = `Summarize the plan in plain English grounded in the proposed operations above. If there are no valid operations, briefly explain and suggest what to clarify.`;
  return `${system}\n\n${context}\n\n${user}\n\n${task}`;
}

function buildDeterministicSummaryText(operations) {
  if (!Array.isArray(operations) || operations.length === 0) return 'No actionable changes detected.';
  let created = 0, updated = 0, deleted = 0, completed = 0;
  const createdTitles = [];
  const dates = new Set();
  for (const op of operations) {
    if (op.op === 'create') { created++; if (op.title) createdTitles.push(op.title); if (op.scheduledFor) dates.add(op.scheduledFor); }
    else if (op.op === 'update') { updated++; if (op.scheduledFor) dates.add(op.scheduledFor); }
    else if (op.op === 'delete') { deleted++; }
    else if (op.op === 'complete') { completed++; }
  }
  const parts = [];
  if (created) parts.push(`creating ${created} task${created === 1 ? '' : 's'}`);
  if (updated) parts.push(`updating ${updated}`);
  if (deleted) parts.push(`deleting ${deleted}`);
  if (completed) parts.push(`completing ${completed}`);
  let s = parts.length ? `${parts.join(', ')}.` : 'No actionable changes detected.';
  if (createdTitles.length) {
    const preview = createdTitles.slice(0, 2).join(', ');
    s = `${s} (${preview}${createdTitles.length > 2 ? ', …' : ''})`;
  }
  if (dates.size) s = `${s} Target: ${Array.from(dates).slice(0, 2).join(', ')}.`;
  return s.trim();
}

// Lightweight chat-only prompt (no operations)
// Chat-only prompt removed; only auto pipeline is supported.

// Shared helper: propose → validate → (attempt repair) → return ops and annotations
async function runProposalAndRepair({ instruction, transcript, focusedWhere, mode = 'post', onValidating, onOps, onRepairing }) {
  // Snapshot selection
  const aggregates = getAggregatesFromDb();
  const topK = focusedWhere ? filterTodosByWhere(focusedWhere).slice(0, 50) : listAllTodosRaw().slice(0, 40);
  const snapshot = focusedWhere ? { focused: topK, aggregates } : { topK, aggregates };

  // Propose
  const prompt1 = buildProposalPrompt({ instruction: instruction.trim(), todosSnapshot: snapshot, transcript });
  const raw1 = await runOllamaForJsonPreferred({ userContent: prompt1 });
  const raw1MaybeResponse = extractResponseBody(raw1);
  let parsed1 = parseJsonLenient(raw1MaybeResponse);
  let ops = [];
  if (Array.isArray(parsed1)) ops = parsed1;
  else if (parsed1 && Array.isArray(parsed1.operations)) ops = parsed1.operations;
  else if (parsed1 && Array.isArray(parsed1.actions)) ops = parsed1.actions;
  if (!ops.length && parsed1 && typeof parsed1 === 'object') ops = [parsed1];
  ops = ops.filter(o => o && typeof o === 'object').map(o => {
    const m = { ...o };
    if (!m.op && typeof m.action === 'string') m.op = m.action;
    if (!m.op && typeof m.type === 'string') m.op = m.type;
    return inferOperationShape(m);
  }).filter(Boolean);

  // Validate initial
  let validation = validateProposal({ operations: ops });
  let annotatedAll = validation.results.map(r => ({ op: r.op, errors: r.errors }));
  try {
    const summary = {
      valid: validation.results.filter(r => r.errors.length === 0).length,
      invalid: validation.results.filter(r => r.errors.length > 0).length,
    };
    appendAudit({ action: 'assistant_understanding', results: annotatedAll, summary });
  } catch {}
  if (typeof onValidating === 'function') {
    try { onValidating(); } catch {}
  }
  if (typeof onOps === 'function') {
    try {
      onOps(1, annotatedAll, validation.results.filter(r => r.errors.length === 0).length, validation.results.filter(r => r.errors.length > 0).length);
    } catch {}
  }

  // Attempt single repair if needed
  if (validation.errors.length) {
    try { appendAudit({ action: 'repair_attempted', mode }); } catch {}
    if (typeof onRepairing === 'function') {
      try { onRepairing(); } catch {}
    }
    try {
      const repairPrompt = buildRepairPrompt({ instruction: instruction.trim(), originalOps: ops, errors: validation.results, transcript });
      const rawRepair = await runOllamaForJsonPreferred({ userContent: repairPrompt });
      const body = extractResponseBody(rawRepair);
      let parsedR = parseJsonLenient(body);
      const repairedOps = (parsedR && Array.isArray(parsedR.operations)) ? parsedR.operations : [];
      const shaped = repairedOps.filter(o => o && typeof o === 'object').map(o => inferOperationShape(o)).filter(Boolean);
      const reValidation = validateProposal({ operations: shaped });
      if (!reValidation.errors.length) {
        ops = shaped;
        validation = reValidation;
        annotatedAll = reValidation.results.map(r => ({ op: r.op, errors: r.errors }));
        try { appendAudit({ action: 'repair_success', mode, repaired_ops: shaped.length }); } catch {}
        if (typeof onOps === 'function') {
          try {
            onOps(2, annotatedAll, validation.results.filter(r => r.errors.length === 0).length, validation.results.filter(r => r.errors.length > 0).length);
          } catch {}
        }
      } else {
        try { appendAudit({ action: 'repair_failed', mode, remaining_invalid: reValidation.results.filter(r => r.errors.length > 0).length }); } catch {}
        // keep original valid subset
        ops = validation.results.filter(r => r.errors.length === 0).map(r => r.op);
      }
    } catch {
      ops = validation.results.filter(r => r.errors.length === 0).map(r => r.op);
      try { appendAudit({ action: 'repair_error', mode }); } catch {}
    }
  }

  return { ops, annotatedAll, validation };
}

app.post('/api/assistant/message', async (req, res) => {
  try {
    const { message, transcript = [], options = {} } = req.body || {};
    if (typeof message !== 'string' || message.trim() === '') {
      return res.status(400).json({ error: 'invalid_message' });
    }
    // Auto pipeline: router → (clarify|plan) → proposal → validate/repair → summarize
    const route = await runRouter({ instruction: message.trim(), transcript, clarify: options && options.clarify });
    try { appendAudit({ action: 'router_decision', mode: 'post', decision: route.decision, confidence: route.confidence, question: route.question || null }); } catch {}
    if (route.decision === 'clarify' && route.question) {
      return res.json({ requiresClarification: true, question: route.question });
    }
    if (route.decision === 'chat') {
      // Return a concise chat answer without generating operations
      try {
        const today = new Date();
        const todayYmd = ymdInTimeZone(today, TIMEZONE);
        const system = `You are a helpful assistant for a todo app. Keep answers concise and clear. Prefer 1–3 short sentences; no lists or JSON.`;
        const last3 = Array.isArray(transcript) ? transcript.slice(-3) : [];
        const convo = last3.map((t) => `- ${t.role}: ${t.text}`).join('\n');
        const user = `Today: ${todayYmd} (${TIMEZONE})\nConversation (last 3 turns):\n${convo}\nUser: ${message.trim()}`;
        const prompt = `${system}\n\n${user}`;
        const raw = await runOllamaWithThinkingIfGranite({ userContent: prompt });
        let text = stripGraniteTags(String(raw || ''));
        text = text.replace(/```[\s\S]*?```/g, '').trim();
        text = text.replace(/[\r\n]+/g, ' ').trim();
        if (!text) text = 'Okay.';
        return res.json({ text, operations: [] });
      } catch (e) {
        return res.json({ text: 'Okay.', operations: [] });
      }
    }

    const { ops, annotatedAll, validation } = await runProposalAndRepair({
      instruction: message,
      transcript,
      focusedWhere: (route && route.where && !Array.isArray(route.where) && typeof route.where === 'object') ? route.where : null,
      mode: 'post'
    });

    // Call 2 — conversational summary
    let text;
    let usedFallback = false;
    try {
      const prompt2 = buildConversationalSummaryPrompt({ instruction: message.trim(), operations: ops, todosSnapshot: listAllTodosRaw(), transcript });
      const raw2 = await runOllamaWithThinkingIfGranite({ userContent: prompt2 });
      // Extract a clean plain-text summary
      let s2 = stripGraniteTags(String(raw2 || ''));
      s2 = s2.replace(/```[\s\S]*?```/g, '').trim();
      s2 = s2.replace(/[\r\n]+/g, ' ').trim();
      const invalidCount = validation.results.filter(r => r.errors.length > 0).length;
      text = invalidCount > 0 ? `${s2} (Note: filtered ${invalidCount} invalid operation${invalidCount === 1 ? '' : 's'}.)` : s2;
      if (!text) throw new Error('empty_text');
    } catch (e) {
      usedFallback = true;
      text = buildDeterministicSummaryText(ops);
      appendAudit({ action: 'assistant_message', conversational_fallback: true, error: String(e && e.message ? e.message : e) });
    }

    // POST endpoint returns final JSON; streaming is served by GET /api/assistant/message/stream
    res.json({ text, operations: annotatedAll });
  } catch (err) {
    res.status(502).json({ error: 'assistant_failure', detail: String(err && err.message ? err.message : err) });
  }
});

// SSE-friendly GET endpoint for browsers (streams summary and final result)
app.get('/api/assistant/message/stream', async (req, res) => {
  try {
    const message = String(req.query.message || '');
    const transcriptParam = req.query.transcript;
    const transcript = (() => {
      try { return Array.isArray(transcriptParam) ? transcriptParam : JSON.parse(String(transcriptParam || '[]')); } catch { return []; }
    })();
    if (message.trim() === '') return res.status(400).json({ error: 'invalid_message' });
    const clarify = (() => { try { return JSON.parse(String(req.query.clarify || 'null')); } catch { return null; } })();
    const route = await runRouter({ instruction: message.trim(), transcript, clarify });
    try { appendAudit({ action: 'router_decision', mode: 'sse', decision: route.decision, confidence: route.confidence, question: route.question || null }); } catch {}
    if (route.decision === 'clarify' && route.question) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
      const send = (event, data) => { res.write(`event: ${event}\n`); res.write(`data: ${data}\n\n`); };
      send('clarify', JSON.stringify({ question: route.question, options: Array.isArray(route.options) ? route.options.map(o => ({ id: o.id, title: o.title, scheduledFor: o.scheduledFor ?? null })) : [] }));
      send('done', 'true');
      return res.end();
    }
    if (route.decision === 'chat') {
      // Stream just a chat summary and done
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
      const send = (event, data) => { res.write(`event: ${event}\n`); res.write(`data: ${data}\n\n`); };
      const today = new Date();
      const todayYmd = ymdInTimeZone(today, TIMEZONE);
      const system = `You are a helpful assistant for a todo app. Keep answers concise and clear. Prefer 1–3 short sentences; no lists or JSON.`;
      const transcriptParam = req.query.transcript;
      const transcript = (() => { try { return Array.isArray(transcriptParam) ? transcriptParam : JSON.parse(String(transcriptParam || '[]')); } catch { return []; } })();
      const last3 = Array.isArray(transcript) ? transcript.slice(-3) : [];
      const convo = last3.map((t) => `- ${t.role}: ${t.text}`).join('\n');
      const user = `Today: ${todayYmd} (${TIMEZONE})\nConversation (last 3 turns):\n${convo}\nUser: ${String(req.query.message || '').trim()}`;
      const prompt = `${system}\n\n${user}`;
      try {
        const raw = await runOllamaWithThinkingIfGranite({ userContent: prompt });
        let text = stripGraniteTags(String(raw || ''));
        text = text.replace(/```[\s\S]*?```/g, '').trim();
        text = text.replace(/[\r\n]+/g, ' ').trim();
        send('summary', JSON.stringify({ text }));
      } catch {
        send('summary', JSON.stringify({ text: 'Okay.' }));
      }
      send('result', JSON.stringify({ text: '', operations: [] }));
      send('done', 'true');
      return res.end();
    }

    // Establish SSE for plan path
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    const send = (event, data) => { res.write(`event: ${event}\n`); res.write(`data: ${data}\n\n`); };
    send('stage', JSON.stringify({ stage: 'routing' }));
    // If router provided a narrowing where, prefer a focused snapshot for proposals
    let focusedWhere = null;
    try {
      if (route && route.where && !Array.isArray(route.where) && typeof route.where === 'object') {
        focusedWhere = route.where;
      }
    } catch {}
    send('stage', JSON.stringify({ stage: 'proposing' }));
    send('summary', JSON.stringify({ text: 'Planning…' }));
    const heartbeat = setInterval(() => {
      try { send('heartbeat', JSON.stringify({ ts: new Date().toISOString() })); } catch {}
    }, 10000);
    res.on('close', () => { try { clearInterval(heartbeat); } catch {} });

    const { ops: validOps, annotatedAll, validation } = await runProposalAndRepair({
      instruction: message,
      transcript,
      focusedWhere,
      mode: 'sse',
      onValidating: () => send('stage', JSON.stringify({ stage: 'validating' })),
      onOps: (version, operations, validCount, invalidCount) => send('ops', JSON.stringify({ version, operations, validCount, invalidCount })),
      onRepairing: () => send('stage', JSON.stringify({ stage: 'repairing' }))
    });

    // Call 2 — conversational summary
    let text;
    try {
      send('stage', JSON.stringify({ stage: 'summarizing' }));
      const prompt2 = buildConversationalSummaryPrompt({ instruction: message.trim(), operations: validOps, todosSnapshot: listAllTodosRaw(), transcript });
      const raw2 = await runOllamaWithThinkingIfGranite({ userContent: prompt2 });
      let s2 = stripGraniteTags(String(raw2 || ''));
      s2 = s2.replace(/```[\s\S]*?```/g, '').trim();
      s2 = s2.replace(/[\r\n]+/g, ' ').trim();
      if (!s2) throw new Error('empty_text');
      text = s2;
    } catch (e) {
      text = buildDeterministicSummaryText(validOps);
      appendAudit({ action: 'assistant_message', conversational_fallback: true, error: String(e && e.message ? e.message : e) });
    }

    // Stream SSE (headers already set)
    send('summary', JSON.stringify({ text }));
    send('result', JSON.stringify({ text, operations: annotatedAll }));
    send('done', 'true');
    try { clearInterval(heartbeat); } catch {}
    return res.end();
  } catch (err) {
    try { res.status(502).json({ error: 'assistant_failure', detail: String(err && err.message ? err.message : err) }); } catch {}
  }
});

// Dry-run endpoint: validate and preview without mutating
app.post('/api/llm/dryrun', async (req, res) => {
  try {
    const { operations } = req.body || {};
    if (Array.isArray(operations) && operations.length > 20) {
      return res.status(400).json({ error: 'too_many_operations', max: 20 });
    }
    const validation = validateProposal({ operations });
    const results = [];
    let created = 0, updated = 0, deleted = 0, completed = 0;
    for (const r of (validation.results || [])) {
      const op = r.op;
      const errs = r.errors;
      const entry = { op, valid: errs.length === 0, errors: errs };
      if (entry.valid) {
        if (op.op === 'create' || op.op?.startsWith('goal_')) updated++;
        else if (op.op === 'update') updated++;
        else if (op.op === 'delete') deleted++;
        else if (op.op === 'complete' || op.op === 'complete_occurrence') completed++;
      }
      results.push(entry);
    }
    return res.json({ results, summary: { created, updated, deleted, completed } });
  } catch (e) {
    return res.status(400).json({ error: 'dryrun_failed', detail: String(e && e.message ? e.message : e) });
  }
});

// Mount static assets last so API routes are matched first
app.use(express.static(STATIC_DIR));

// Error handler
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'internal_error' });
});

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '127.0.0.1';
app.listen(PORT, HOST, () => {
  console.log(`Server listening at http://${HOST}:${PORT}`);
});


