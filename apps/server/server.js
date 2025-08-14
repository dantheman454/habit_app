#!/usr/bin/env node

// Single-server Express app that serves the UI and provides CRUD + search + backlog APIs.
// Persistence uses JSON files in ./data. Designed to replace web/server.js + src/server.js bridge.

import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import * as todosIndex from './todos_index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Paths ---
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(REPO_ROOT, 'data');
const TODOS_FILE = path.join(DATA_DIR, 'todos.json');
const COUNTER_FILE = path.join(DATA_DIR, 'counter.json');
const STATIC_DIR = process.env.STATIC_DIR || path.join(REPO_ROOT, 'apps', 'web', 'flutter_app', 'build', 'web');

// --- Timezone (fixed semantics) ---
const TIMEZONE = process.env.TZ_NAME || 'America/New_York';
const AUTO_MODE_ENABLED = String(process.env.ASSISTANT_AUTO_MODE_ENABLED || 'true').toLowerCase() !== 'false';

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

// Build compact router snapshots for this week and backlog sample
function buildRouterSnapshots() {
  const { fromYmd, toYmd } = weekRangeFromToday(TIMEZONE);
  const weekItems = todosIndex.filterByWhere({
    scheduled_range: { from: fromYmd, to: toYmd },
    completed: false,
  });
  const backlogAll = todosIndex.filterByWhere({ completed: false });
  const backlogSample = backlogAll.filter(t => t.scheduledFor === null).slice(0, 40);
  const compact = (t) => ({ id: t.id, title: t.title, scheduledFor: t.scheduledFor, priority: t.priority });
  return {
    week: { from: fromYmd, to: toYmd, items: weekItems.map(compact) },
    backlog: backlogSample.map(compact),
  };
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

// Ensure data dir exists
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

// --- Persistence helpers (sync for simplicity) ---
function loadTodos() {
  try {
    if (fs.existsSync(TODOS_FILE)) {
      const s = fs.readFileSync(TODOS_FILE, 'utf8');
      const arr = JSON.parse(s);
      return Array.isArray(arr) ? arr : [];
    }
  } catch (e) { console.error('loadTodos error:', e); }
  return [];
}

function saveTodos(todos) {
  try {
    fs.writeFileSync(TODOS_FILE, JSON.stringify(todos, null, 2));
  } catch (e) { console.error('saveTodos error:', e); }
}

function loadNextId() {
  try {
    if (fs.existsSync(COUNTER_FILE)) {
      const s = fs.readFileSync(COUNTER_FILE, 'utf8');
      const obj = JSON.parse(s);
      if (obj && Number.isFinite(obj.nextId)) return obj.nextId;
    }
  } catch (e) { console.error('loadNextId error:', e); }
  return 1;
}

function saveNextId(nextId) {
  try { fs.writeFileSync(COUNTER_FILE, JSON.stringify({ nextId }, null, 2)); }
  catch (e) { console.error('saveNextId error:', e); }
}

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

let todos = loadTodos();
// One-time write-back migration: normalize loaded records and persist once
try {
  const normalized = Array.isArray(todos) ? todos.map(normalizeTodo) : [];
  todos = normalized;
  saveTodos(todos);
} catch {}
let nextId = loadNextId();

// Initialize retrieval index
try { todosIndex.init(todos); todosIndex.setTimeZone(TIMEZONE); } catch {}

function createTodo({ title, notes = '', scheduledFor = null, priority = 'medium', timeOfDay = null, recurrence = undefined }) {
  const now = new Date().toISOString();
  const todo = normalizeTodo({
    id: nextId++,
    title,
    notes,
    scheduledFor,
    priority,
    timeOfDay,
    recurrence,
    completed: false,
    createdAt: now,
    updatedAt: now,
  });
  saveNextId(nextId);
  return todo;
}

function findTodoById(id) {
  const iid = parseInt(id, 10);
  return todos.find(t => t.id === iid);
}

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

// --- Server ---
const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '256kb' }));

// Static assets (Flutter Web build) are mounted AFTER API routes below

// Health
app.get('/health', (_req, res) => { res.json({ ok: true }); });

// Debug: list routes (temporary)
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

  const todo = createTodo({ title: title.trim(), notes: notes || '', scheduledFor: scheduledFor ?? null, priority: priority || 'medium', timeOfDay: (timeOfDay === '' ? null : timeOfDay) ?? null, recurrence: recurrence });
  todos.push(todo);
  saveTodos(todos);
  try { todosIndex.refresh(todos); todosIndex.setTimeZone(TIMEZONE); } catch {}
  res.json({ todo });
});

// List (scheduled only within range)
app.get('/api/todos', (req, res) => {
  const { from, to, priority, completed, expand } = req.query;
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

  let items = todos.filter(t => t.scheduledFor !== null);
  if (priority) items = items.filter(t => String(t.priority).toLowerCase() === String(priority).toLowerCase());
  if (completedBool !== undefined) items = items.filter(t => t.completed === completedBool);

  const doExpand = ((String(expand).toLowerCase() === 'true' || expand === true) || true) && fromDate && toDate;
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
  res.json({ todos: expanded });
});

// Backlog (unscheduled only)
app.get('/api/todos/backlog', (_req, res) => {
  const items = todos.filter(t => t.scheduledFor === null);
  res.json({ todos: items });
});

// Search (title or notes, case-insensitive)
app.get('/api/todos/search', (req, res) => {
  const q = String(req.query.query || '').toLowerCase().trim();
  if (!q) return res.status(400).json({ error: 'invalid_query' });
  let completedBool;
  if (req.query.completed !== undefined) {
    if (req.query.completed === 'true' || req.query.completed === true) completedBool = true;
    else if (req.query.completed === 'false' || req.query.completed === false) completedBool = false;
    else return res.status(400).json({ error: 'invalid_completed' });
  }
  let items = todos;
  if (completedBool !== undefined) items = items.filter(t => t.completed === completedBool);
  items = items.filter(t => String(t.title || '').toLowerCase().includes(q) || String(t.notes || '').toLowerCase().includes(q));
  res.json({ todos: items });
});

// Get by id
app.get('/api/todos/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  const t = findTodoById(id);
  if (!t) return res.status(404).json({ error: 'not_found' });
  res.json({ todo: t });
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
  if (recurrence !== undefined) {
    const prevType = t.recurrence?.type || 'none';
    t.recurrence = { ...t.recurrence, ...recurrence };
    // Normalize defaults: until default only if undefined
    if (t.recurrence.until === undefined) t.recurrence.until = endOfCurrentYearYmd();
    if (prevType !== 'none' && t.recurrence.type === 'none') {
      // moving repeating -> none: clear completedDates
      t.completedDates = [];
    } else if (t.recurrence.type !== 'none') {
      if (!Array.isArray(t.completedDates)) t.completedDates = [];
    }
  }
  t.updatedAt = now;
  saveTodos(todos);
  try { todosIndex.refresh(todos); todosIndex.setTimeZone(TIMEZONE); } catch {}
  res.json({ todo: t });
});

// Occurrence completion for repeating tasks
app.patch('/api/todos/:id/occurrence', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  const { occurrenceDate, completed } = req.body || {};
  if (!isYmdString(occurrenceDate)) return res.status(400).json({ error: 'invalid_occurrenceDate' });
  if (completed !== undefined && typeof completed !== 'boolean') return res.status(400).json({ error: 'invalid_completed' });
  const t = findTodoById(id);
  if (!t) return res.status(404).json({ error: 'not_found' });
  if (!(t.recurrence && t.recurrence.type && t.recurrence.type !== 'none')) {
    return res.status(400).json({ error: 'not_repeating' });
  }
  if (!Array.isArray(t.completedDates)) t.completedDates = [];
  const idx = t.completedDates.indexOf(occurrenceDate);
  const shouldComplete = (completed === undefined) ? true : !!completed;
  if (shouldComplete) {
    if (idx === -1) t.completedDates.push(occurrenceDate);
  } else {
    if (idx !== -1) t.completedDates.splice(idx, 1);
  }
  t.updatedAt = new Date().toISOString();
  saveTodos(todos);
  try { todosIndex.refresh(todos); todosIndex.setTimeZone(TIMEZONE); } catch {}
  res.json({ todo: t });
});

// Delete by id
app.delete('/api/todos/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  const idx = todos.findIndex(t => t.id === id);
  if (idx === -1) return res.status(404).json({ error: 'not_found' });
  todos.splice(idx, 1);
  saveTodos(todos);
  try { todosIndex.refresh(todos); } catch {}
  res.json({ ok: true });
});

// --- LLM proposal-and-verify (Ollama) ---
const OLLAMA_MODEL = 'granite3.3:8b';
const OLLAMA_TEMPERATURE = 0.1;
const GLOBAL_TIMEOUT_SECS = parseInt(process.env.OLLAMA_TIMEOUT_SECS || '300', 10);

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
  const kind = op.op;
  const allowedKinds = ['create', 'update', 'delete', 'complete', 'complete_occurrence', 'bulk_update', 'bulk_complete', 'bulk_delete'];
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
  }
  if ((kind === 'update' || kind === 'delete' || kind === 'complete' || kind === 'complete_occurrence')) {
    if (!(Number.isFinite(op.id))) errors.push('missing_or_invalid_id');
    else if (!findTodoById(op.id)) errors.push('id_not_found');
  }
  if (kind === 'complete_occurrence') {
    if (!isYmdString(op.occurrenceDate)) errors.push('invalid_occurrenceDate');
    if (op.completed !== undefined && typeof op.completed !== 'boolean') errors.push('invalid_completed');
  }
  // Strict: if op targets a repeating task, forbid master complete and require anchor when recurrence changes
  if (kind === 'complete') {
    const t = Number.isFinite(op.id) ? findTodoById(op.id) : null;
    if (t && t.recurrence && t.recurrence.type && t.recurrence.type !== 'none') {
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
  // Bulk ops validation
  if (kind === 'bulk_update') {
    const wErrors = validateWhere(op.where);
    if (wErrors.length) errors.push(...wErrors);
    if (!(op.set && typeof op.set === 'object')) errors.push('missing_set');
    // Validate provided set fields shape (but not values beyond basic types)
    const s = op.set || {};
    if (s.priority !== undefined && !['low','medium','high'].includes(String(s.priority))) errors.push('invalid_set_priority');
    if (s.scheduledFor !== undefined && !(s.scheduledFor === null || isYmdString(s.scheduledFor))) errors.push('invalid_set_scheduledFor');
    if (s.timeOfDay !== undefined && !isValidTimeOfDay(s.timeOfDay === '' ? null : s.timeOfDay)) errors.push('invalid_set_timeOfDay');
    if (s.recurrence !== undefined && !isValidRecurrence(s.recurrence)) errors.push('invalid_set_recurrence');
  } else if (kind === 'bulk_complete') {
    const wErrors = validateWhere(op.where);
    if (wErrors.length) errors.push(...wErrors);
    if (op.completed !== undefined && typeof op.completed !== 'boolean') errors.push('invalid_completed');
  } else if (kind === 'bulk_delete') {
    const wErrors = validateWhere(op.where);
    if (wErrors.length) errors.push(...wErrors);
  }
  return errors;
}

function validateProposal(body) {
  if (!body || typeof body !== 'object') return { errors: ['invalid_body'] };
  const operations = Array.isArray(body.operations) ? body.operations : [];
  if (!operations.length) return { errors: ['missing_operations'], operations: [] };
  const results = operations.map(o => ({ op: o, errors: validateOperation(o) }));
  const invalid = results.filter(r => r.errors.length > 0);
  return { operations, results, errors: invalid.length ? ['invalid_operations'] : [] };
}

function inferOperationShape(o) {
  if (!o || typeof o !== 'object') return null;
  const op = { ...o };
  if (!op.op) {
    const hasId = Number.isFinite(op.id);
    const hasCompleted = typeof op.completed === 'boolean';
    const hasTitleOrNotesOrSchedOrPrio = !!(op.title || op.notes || (op.scheduledFor !== undefined) || op.priority);
    if (!hasId && (op.title || op.scheduledFor !== undefined || op.priority)) {
      op.op = 'create';
      delete op.id; // ignore LLM-provided id on create
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

function buildSchemaV2Excerpt() {
  return [
    'Schema v2:',
    '- create/update/delete/complete/complete_occurrence (existing)',
    '- bulk_update: { op: "bulk_update", where: { ids?, title_contains?, overdue?, scheduled_range?{from?,to?}, priority?, completed?, repeating? }, set: { title?, notes?, scheduledFor?, timeOfDay?, priority?, completed?, recurrence? }, reason? }',
    '- bulk_complete: { op: "bulk_complete", where: { ... }, completed: true|false, reason? }',
    '- bulk_delete: { op: "bulk_delete", where: { ... }, reason? }',
    'Strict rules:',
    '- For create/update, include a recurrence object. Use {"type":"none"} if non-repeating.',
    '- For repeating tasks, an anchor scheduledFor is REQUIRED on create/update.',
    '- For repeating tasks, do not use complete. Use complete_occurrence with occurrenceDate.',
    '- Prefer bulk_* when many items match a simple filter; otherwise target by id.'
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
    `decision: one of [\"chat\", \"plan\", \"clarify\"],\n` +
    `category: one of [\"habit\", \"goal\", \"task\", \"event\"],\n` +
    `entities: object, missing: array, confidence: number 0..1, question: string (required when decision=clarify).\n` +
    `If the instruction is ambiguous about time/date or target, choose clarify and ask ONE short question. No prose.\n` +
    `If the user asks to change all items in a clear scope (e.g., \"all today\", \"all of them\", \"everything this week\"), prefer plan.\n` +
    `If a prior clarify question is present, interpret short answers like \"all of them\", \"yes\", \"all today\" as resolving that question and prefer plan.\n` +
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
    const raw = await runOllamaWithThinkingIfGranite({ userContent: prompt });
    const body = extractResponseBody(raw);
    const tryParse = (text) => { try { return JSON.parse(text); } catch { return null; } };
    let parsed = tryParse(body);
    if (!parsed && /```/.test(body)) {
      parsed = tryParse(body.replace(/```json|```/g, '').trim());
    }
    if (parsed && typeof parsed === 'object') {
      const result = {
        decision: String(parsed.decision || 'plan').toLowerCase(),
        category: parsed.category,
        entities: parsed.entities,
        missing: parsed.missing,
        confidence: Number(parsed.confidence || 0),
        question: parsed.question,
      };
      if (result.decision === 'clarify') {
        try {
          const snapshots = buildRouterSnapshots();
          const cands = topClarifyCandidates(instruction, snapshots, 5);
          if (cands.length) {
            const bullets = cands
              .map(c => `#${c.id} “${String(c.title).slice(0, 40)}”${c.scheduledFor ? ` @${c.scheduledFor}` : ''}`)
              .join('; ');
            const q = result.question && String(result.question).trim().length > 0
              ? result.question
              : 'Which item do you mean?';
            result.question = `${q} Options: ${bullets}.`;
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
    `Each operation MUST include field "op" which is one of: "create", "update", "delete", "complete", "complete_occurrence".\n` +
    `Allowed fields: op, id (int for update/delete/complete/complete_occurrence), title, notes, scheduledFor (YYYY-MM-DD or null), priority (low|medium|high), completed (bool), timeOfDay (HH:MM or null), recurrence (object with keys: type, intervalDays, until [YYYY-MM-DD or null]).\n` +
    `For EVERY create or update you MUST include a "recurrence" object. Use {"type":"none"} for non-repeating tasks.\n` +
    `For repeating tasks (recurrence.type != none), an anchor scheduledFor is REQUIRED.\n` +
    `For complete_occurrence, include: id (masterId), occurrenceDate (YYYY-MM-DD), and optional completed (bool).\n` +
    `Today's date is ${todayYmd}. Do NOT invent invalid IDs. Prefer fewer changes over hallucination.\n` +
    `You may reason internally, but the final output MUST be a single JSON object exactly as specified. Do not include your reasoning or any prose.`;
  const last3 = Array.isArray(transcript) ? transcript.slice(-3) : [];
  const convo = last3.map((t) => `- ${t.role}: ${t.text}`).join('\n');
  const context = JSON.stringify({ todos: todosSnapshot }, null, 2);
  const user = `Conversation (last 3 turns):\n${convo}\n\nTimezone: ${TIMEZONE}\nInstruction:\n${instruction}\n\nContext:\n${context}\n\nRespond with JSON ONLY that matches this exact example format:\n{\n  "operations": [\n    {"op": "create", "title": "Buy milk", "scheduledFor": "${todayYmd}", "priority": "high"}\n  ]\n}`;
  return `${system}\n\n${user}`;
}

// /api/llm/propose removed — superseded by /api/assistant/message two-call pipeline

const AUDIT_FILE = path.join(DATA_DIR, 'audit.jsonl');
function appendAudit(entry) {
  try { fs.appendFileSync(AUDIT_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n'); } catch {}
}

let applyMutex = Promise.resolve();
function withApplyLock(fn) { applyMutex = applyMutex.then(() => fn()).catch(() => {}).then(() => {}); return applyMutex; }

app.post('/api/llm/apply', async (req, res) => {
  const { operations } = req.body || {};
  const validation = validateProposal({ operations });
  if (validation.errors.length) {
    return res.status(400).json({ error: 'invalid_operations', detail: validation, message: 'Some operations were invalid. The assistant may be attempting unsupported or inconsistent changes.' });
  }
  const results = [];
  let created = 0, updated = 0, deleted = 0, completed = 0;
  await withApplyLock(async () => {
    for (const op of operations) {
      try {
        if (op.op === 'create') {
          const t = createTodo({ title: String(op.title || '').trim(), notes: op.notes || '', scheduledFor: op.scheduledFor ?? null, priority: op.priority || 'medium', timeOfDay: (op.timeOfDay === '' ? null : op.timeOfDay) ?? null, recurrence: op.recurrence });
          todos.push(t); saveTodos(todos); try { todosIndex.refresh(todos); todosIndex.setTimeZone(TIMEZONE); } catch {} ; results.push({ ok: true, op, todo: t }); created++;
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
          if (op.recurrence !== undefined) {
            const prevType = t.recurrence?.type || 'none';
            t.recurrence = { ...t.recurrence, ...op.recurrence };
            if (t.recurrence.until === undefined) t.recurrence.until = endOfCurrentYearYmd();
            if (prevType !== 'none' && t.recurrence.type === 'none') {
              t.completedDates = [];
            } else if (t.recurrence.type !== 'none') {
              if (!Array.isArray(t.completedDates)) t.completedDates = [];
            }
          }
          t.updatedAt = now; saveTodos(todos); try { todosIndex.refresh(todos); todosIndex.setTimeZone(TIMEZONE); } catch {} ; results.push({ ok: true, op, todo: t }); updated++;
          appendAudit({ action: 'update', op, result: 'ok', id: t.id });
        } else if (op.op === 'delete') {
          const idx = todos.findIndex(t => t.id === op.id); if (idx === -1) throw new Error('not_found');
          const removed = todos.splice(idx, 1)[0]; saveTodos(todos); try { todosIndex.refresh(todos); todosIndex.setTimeZone(TIMEZONE); } catch {} ; results.push({ ok: true, op }); deleted++;
          appendAudit({ action: 'delete', op, result: 'ok', id: removed?.id });
        } else if (op.op === 'complete') {
          const t = findTodoById(op.id); if (!t) throw new Error('not_found');
          t.completed = op.completed === undefined ? true : !!op.completed; t.updatedAt = new Date().toISOString();
          saveTodos(todos); try { todosIndex.refresh(todos); todosIndex.setTimeZone(TIMEZONE); } catch {} ; results.push({ ok: true, op, todo: t }); completed++;
          appendAudit({ action: 'complete', op, result: 'ok', id: t.id });
        } else if (op.op === 'complete_occurrence') {
          const t = findTodoById(op.id); if (!t) throw new Error('not_found');
          if (!(t.recurrence && t.recurrence.type && t.recurrence.type !== 'none')) throw new Error('not_repeating');
          if (!Array.isArray(t.completedDates)) t.completedDates = [];
          const idx = t.completedDates.indexOf(op.occurrenceDate);
          const shouldComplete = (op.completed === undefined) ? true : !!op.completed;
          if (shouldComplete) { if (idx === -1) t.completedDates.push(op.occurrenceDate); }
          else { if (idx !== -1) t.completedDates.splice(idx, 1); }
          t.updatedAt = new Date().toISOString(); saveTodos(todos); try { todosIndex.refresh(todos); todosIndex.setTimeZone(TIMEZONE); } catch {} ; results.push({ ok: true, op, todo: t }); completed++;
          appendAudit({ action: 'complete_occurrence', op, result: 'ok', id: t.id });
        } else if (op.op === 'bulk_update') {
          // Expand where to concrete ids, then apply updates item-wise
          const targets = todosIndex.filterByWhere(op.where || {});
          const set = op.set || {};
          for (const t of targets) {
            const tt = findTodoById(t.id); if (!tt) continue;
            const now2 = new Date().toISOString();
            if (set.title !== undefined) tt.title = set.title;
            if (set.notes !== undefined) tt.notes = set.notes;
            if (set.scheduledFor !== undefined) tt.scheduledFor = set.scheduledFor;
            if (set.priority !== undefined) tt.priority = set.priority;
            if (set.completed !== undefined) tt.completed = !!set.completed;
            if (set.timeOfDay !== undefined) tt.timeOfDay = (set.timeOfDay === '' ? null : set.timeOfDay);
            if (set.recurrence !== undefined) {
              const prevType = tt.recurrence?.type || 'none';
              tt.recurrence = { ...tt.recurrence, ...set.recurrence };
              if (tt.recurrence.until === undefined) tt.recurrence.until = endOfCurrentYearYmd();
              if (prevType !== 'none' && tt.recurrence.type === 'none') {
                tt.completedDates = [];
              } else if (tt.recurrence.type !== 'none') {
                if (!Array.isArray(tt.completedDates)) tt.completedDates = [];
              }
            }
            tt.updatedAt = now2;
          }
          saveTodos(todos); try { todosIndex.refresh(todos); todosIndex.setTimeZone(TIMEZONE); } catch {}
          results.push({ ok: true, op, count: targets.length, expandedIds: targets.map(t => t.id) });
          updated += targets.length;
          appendAudit({ action: 'bulk_update', op, result: 'ok', expandedIds: targets.map(t => t.id) });
        } else if (op.op === 'bulk_complete') {
          const targets = todosIndex.filterByWhere(op.where || {});
          const shouldComplete = (op.completed === undefined) ? true : !!op.completed;
          for (const t of targets) {
            const tt = findTodoById(t.id); if (!tt) continue;
            tt.completed = shouldComplete; tt.updatedAt = new Date().toISOString();
          }
          saveTodos(todos); try { todosIndex.refresh(todos); todosIndex.setTimeZone(TIMEZONE); } catch {}
          results.push({ ok: true, op, count: targets.length, expandedIds: targets.map(t => t.id) });
          completed += targets.length;
          appendAudit({ action: 'bulk_complete', op, result: 'ok', expandedIds: targets.map(t => t.id) });
        } else if (op.op === 'bulk_delete') {
          const targets = todosIndex.filterByWhere(op.where || {});
          const ids = new Set(targets.map(t => t.id));
          let removedCount = 0;
          for (let i = todos.length - 1; i >= 0; i--) {
            if (ids.has(todos[i].id)) { todos.splice(i, 1); removedCount++; }
          }
          saveTodos(todos); try { todosIndex.refresh(todos); todosIndex.setTimeZone(TIMEZONE); } catch {}
          results.push({ ok: true, op, count: removedCount, expandedIds: Array.from(ids) });
          deleted += removedCount;
          appendAudit({ action: 'bulk_delete', op, result: 'ok', expandedIds: Array.from(ids) });
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
  res.json({ results, summary: { created, updated, deleted, completed } });
});

// --- Assistant chat (two-call pipeline) ---
function buildConversationalSummaryPrompt({ instruction, operations, todosSnapshot, transcript }) {
  const today = new Date();
  const todayYmd = ymdInTimeZone(today, TIMEZONE);
  const compactOps = operations.map((op) => {
    const parts = [];
    parts.push(op.op);
    if (Number.isFinite(op.id)) parts.push(`#${op.id}`);
    if (op.title) parts.push(`“${String(op.title).slice(0, 60)}”`);
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
function buildChatPrompt({ instruction, transcript }) {
  const today = new Date();
  const todayYmd = ymdInTimeZone(today, TIMEZONE);
  const last3 = Array.isArray(transcript) ? transcript.slice(-3) : [];
  const convo = last3.map((t) => `- ${t.role}: ${t.text}`).join('\n');
  const system = `You are a helpful assistant for a todo app. Keep answers concise and clear. Prefer 1–3 short sentences; allow a short paragraph when needed. No markdown, no lists.`;
  const context = `Conversation (last 3 turns):\n${convo}\n\nToday: ${todayYmd} (${TIMEZONE})`;
  const user = `User message:\n${instruction}`;
  const task = `Respond helpfully and concretely. Do not output JSON.`;
  return `${system}\n\n${context}\n\n${user}\n\n${task}`;
}

app.post('/api/assistant/message', async (req, res) => {
  try {
    const { message, transcript = [], options = {} } = req.body || {};
    if (typeof message !== 'string' || message.trim() === '') {
      return res.status(400).json({ error: 'invalid_message' });
    }
    const mode = String((options && options.mode) || 'plan').toLowerCase();

    // Router branch for auto mode
    if (mode === 'auto' && AUTO_MODE_ENABLED) {
      const route = await runRouter({ instruction: message.trim(), transcript, clarify: options && options.clarify });
      try { appendAudit({ action: 'router_decision', mode: 'post', decision: route.decision, confidence: route.confidence, question: route.question || null }); } catch {}
      if (route.decision === 'clarify' && route.question) {
        return res.json({ requiresClarification: true, question: route.question });
      } else if (route.decision === 'chat') {
        try {
          const prompt = buildChatPrompt({ instruction: message.trim(), transcript });
          const raw = await runOllamaWithThinkingIfGranite({ userContent: prompt });
          let s = stripGraniteTags(String(raw || ''));
          s = s.replace(/```[\s\S]*?```/g, '').trim();
          s = s.replace(/[\r\n]+/g, ' ').trim();
          const text = s || 'Okay.';
          return res.json({ text, operations: [] });
        } catch (e) {
          return res.status(502).json({ error: 'assistant_failure', detail: String(e && e.message ? e.message : e) });
        }
      }
      // else fall through to plan path
    }

    // Chat-only mode: single LLM call, no operations
    if (mode === 'chat') {
      try {
        const prompt = buildChatPrompt({ instruction: message.trim(), transcript });
        const raw = await runOllamaWithThinkingIfGranite({ userContent: prompt });
        let s = stripGraniteTags(String(raw || ''));
        s = s.replace(/```[\s\S]*?```/g, '').trim();
        s = s.replace(/[\r\n]+/g, ' ').trim();
        const text = s || 'Okay.';
        return res.json({ text, operations: [] });
      } catch (e) {
        return res.status(502).json({ error: 'assistant_failure', detail: String(e && e.message ? e.message : e) });
      }
    }

    // Call 1 — generate operations (reuse robust proposal pipeline)
    const topK = todosIndex.searchByQuery('', { k: 40 });
    const aggregates = todosIndex.getAggregates();
    let prompt1 = buildProposalPrompt({ instruction: message.trim(), todosSnapshot: { topK, aggregates }, transcript });
    // Early SSE headers to keep connection alive during longer model calls
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    const send = (event, data) => { res.write(`event: ${event}\n`); res.write(`data: ${data}\n\n`); };
    send('summary', JSON.stringify({ text: 'Planning…' }));
    // Heartbeat every 10s
    const heartbeat = setInterval(() => {
      try { send('heartbeat', JSON.stringify({ ts: new Date().toISOString() })); } catch {}
    }, 10000);
    res.on('close', () => { try { clearInterval(heartbeat); } catch {} });
    const raw1 = await runOllamaWithThinkingIfGranite({ userContent: prompt1 });
    const raw1MaybeResponse = extractResponseBody(raw1);
    const tryParse = (text) => { try { return JSON.parse(text); } catch { return null; } };
    let parsed1 = tryParse(raw1MaybeResponse);
    if (!parsed1 && /```/.test(raw1MaybeResponse)) {
      const inner = raw1MaybeResponse.replace(/```json|```/g, '').trim();
      parsed1 = tryParse(inner);
    }
    if (!parsed1) {
      // Try extracting first JSON object
      const s = raw1MaybeResponse;
      const start = s.indexOf('{');
      if (start !== -1) {
        let depth = 0; let end = -1;
        for (let i = start; i < s.length; i++) {
          const ch = s[i];
          if (ch === '{') depth++;
          else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
        }
        if (end !== -1) parsed1 = tryParse(s.slice(start, end + 1));
      }
    }
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

    let validation = validateProposal({ operations: ops });
    let annotatedAll = validation.results.map(r => ({ op: r.op, errors: r.errors }));
    // Audit the model's understanding (internal-only)
    try {
      const summary = {
        valid: validation.results.filter(r => r.errors.length === 0).length,
        invalid: validation.results.filter(r => r.errors.length > 0).length,
      };
      appendAudit({ action: 'assistant_understanding', results: annotatedAll, summary });
    } catch {}
    if (validation.errors.length) {
      try { appendAudit({ action: 'repair_attempted', mode: 'post', invalid_ops: validation.results.filter(r => r.errors.length > 0).length }); } catch {}
      // Single repair attempt
      try {
        const repairPrompt = buildRepairPrompt({ instruction: message.trim(), originalOps: ops, errors: validation.results, transcript });
        const rawRepair = await runOllamaWithThinkingIfGranite({ userContent: repairPrompt });
        const body = extractResponseBody(rawRepair);
        const tryParse = (text) => { try { return JSON.parse(text); } catch { return null; } };
        let parsedR = tryParse(body);
        if (!parsedR && /```/.test(body)) parsedR = tryParse(body.replace(/```json|```/g, '').trim());
        const repairedOps = (parsedR && Array.isArray(parsedR.operations)) ? parsedR.operations : [];
        const shaped = repairedOps.filter(o => o && typeof o === 'object').map(o => inferOperationShape(o)).filter(Boolean);
        const reValidation = validateProposal({ operations: shaped });
        if (!reValidation.errors.length) {
          ops = shaped;
          validation = reValidation;
          annotatedAll = reValidation.results.map(r => ({ op: r.op, errors: r.errors }));
          try { appendAudit({ action: 'repair_success', mode: 'post', repaired_ops: shaped.length }); } catch {}
        } else {
          // fallback to valid-only from first pass
          try { appendAudit({ action: 'repair_failed', mode: 'post', remaining_invalid: reValidation.results.filter(r => r.errors.length > 0).length }); } catch {}
          ops = validation.results.filter(r => r.errors.length === 0).map(r => r.op);
        }
      } catch {
        ops = validation.results.filter(r => r.errors.length === 0).map(r => r.op);
        try { appendAudit({ action: 'repair_error', mode: 'post' }); } catch {}
      }
    }

    // Call 2 — conversational summary
    let text;
    let usedFallback = false;
    try {
      const prompt2 = buildConversationalSummaryPrompt({ instruction: message.trim(), operations: ops, todosSnapshot: todos, transcript });
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

    // POST endpoint always returns final JSON; streaming is served by GET /api/assistant/message/stream

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
    const mode = String(req.query.mode || 'plan').toLowerCase();

    if (mode === 'chat') {
      try {
        const prompt = buildChatPrompt({ instruction: message.trim(), transcript });
        const raw = await runOllamaWithThinkingIfGranite({ userContent: prompt });
        let s = stripGraniteTags(String(raw || ''));
        s = s.replace(/```[\s\S]*?```/g, '').trim();
        s = s.replace(/[\r\n]+/g, ' ').trim();
        const text = s || 'Okay.';

        // Stream SSE
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        if (typeof res.flushHeaders === 'function') res.flushHeaders();
        const send = (event, data) => { res.write(`event: ${event}\n`); res.write(`data: ${data}\n\n`); };
        send('summary', JSON.stringify({ text }));
        send('result', JSON.stringify({ text, operations: [] }));
        send('done', 'true');
        return res.end();
      } catch (e) {
        try { return res.status(502).json({ error: 'assistant_failure', detail: String(e && e.message ? e.message : e) }); } catch {}
      }
    }

    if (mode === 'auto' && AUTO_MODE_ENABLED) {
      const clarify = (() => { try { return JSON.parse(String(req.query.clarify || 'null')); } catch { return null; } })();
      const route = await runRouter({ instruction: message.trim(), transcript, clarify });
      try { appendAudit({ action: 'router_decision', mode: 'sse', decision: route.decision, confidence: route.confidence, question: route.question || null }); } catch {}
      if (route.decision === 'clarify' && route.question) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        if (typeof res.flushHeaders === 'function') res.flushHeaders();
        const send = (event, data) => { res.write(`event: ${event}\n`); res.write(`data: ${data}\n\n`); };
        send('clarify', JSON.stringify({ question: route.question }));
        send('done', 'true');
        return res.end();
      } else if (route.decision === 'chat') {
        try {
          const prompt = buildChatPrompt({ instruction: message.trim(), transcript });
          const raw = await runOllamaWithThinkingIfGranite({ userContent: prompt });
          let s = stripGraniteTags(String(raw || ''));
          s = s.replace(/```[\s\S]*?```/g, '').trim();
          s = s.replace(/[\r\n]+/g, ' ').trim();
          const text = s || 'Okay.';
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          if (typeof res.flushHeaders === 'function') res.flushHeaders();
          const send = (event, data) => { res.write(`event: ${event}\n`); res.write(`data: ${data}\n\n`); };
          send('summary', JSON.stringify({ text }));
          send('result', JSON.stringify({ text, operations: [] }));
          send('done', 'true');
          return res.end();
        } catch (e) {
          try { return res.status(502).json({ error: 'assistant_failure', detail: String(e && e.message ? e.message : e) }); } catch {}
        }
      }
      // else fall through to plan path; plan branch will set SSE headers below
    }

    // Establish SSE for plan path
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    const send = (event, data) => { res.write(`event: ${event}\n`); res.write(`data: ${data}\n\n`); };
    send('summary', JSON.stringify({ text: 'Planning…' }));
    const heartbeat = setInterval(() => {
      try { send('heartbeat', JSON.stringify({ ts: new Date().toISOString() })); } catch {}
    }, 10000);
    res.on('close', () => { try { clearInterval(heartbeat); } catch {} });

    // Call 1 — generate operations
    const topK = todosIndex.searchByQuery('', { k: 40 });
    const aggregates = todosIndex.getAggregates();
    const prompt1 = buildProposalPrompt({ instruction: message.trim(), todosSnapshot: { topK, aggregates }, transcript });
    const raw1 = await runOllamaWithThinkingIfGranite({ userContent: prompt1 });
    const raw1MaybeResponse = extractResponseBody(raw1);
    const tryParse = (text) => { try { return JSON.parse(text); } catch { return null; } };
    let parsed1 = tryParse(raw1MaybeResponse);
    if (!parsed1 && /```/.test(raw1MaybeResponse)) {
      const inner = raw1MaybeResponse.replace(/```json|```/g, '').trim();
      parsed1 = tryParse(inner);
    }
    if (!parsed1) {
      const s = raw1MaybeResponse;
      const start = s.indexOf('{');
      if (start !== -1) {
        let depth = 0; let end = -1;
        for (let i = start; i < s.length; i++) {
          const ch = s[i];
          if (ch === '{') depth++;
          else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
        }
        if (end !== -1) parsed1 = tryParse(s.slice(start, end + 1));
      }
    }
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

    let validation = validateProposal({ operations: ops });
    let annotatedAll = validation.results.map(r => ({ op: r.op, errors: r.errors }));
    try {
      const summary = {
        valid: validation.results.filter(r => r.errors.length === 0).length,
        invalid: validation.results.filter(r => r.errors.length > 0).length,
      };
      appendAudit({ action: 'assistant_understanding', results: annotatedAll, summary });
    } catch {}
    let validOps = validation.results.filter(r => r.errors.length === 0).map(r => r.op);
    if (validation.errors.length) {
      try { appendAudit({ action: 'repair_attempted', mode: 'sse', invalid_ops: validation.results.filter(r => r.errors.length > 0).length }); } catch {}
      try {
        const repairPrompt = buildRepairPrompt({ instruction: message.trim(), originalOps: ops, errors: validation.results, transcript });
        const rawRepair = await runOllamaWithThinkingIfGranite({ userContent: repairPrompt });
        const body = extractResponseBody(rawRepair);
        const tryParse = (text) => { try { return JSON.parse(text); } catch { return null; } };
        let parsedR = tryParse(body);
        if (!parsedR && /```/.test(body)) parsedR = tryParse(body.replace(/```json|```/g, '').trim());
        const repairedOps = (parsedR && Array.isArray(parsedR.operations)) ? parsedR.operations : [];
        const shaped = repairedOps.filter(o => o && typeof o === 'object').map(o => inferOperationShape(o)).filter(Boolean);
        const reValidation = validateProposal({ operations: shaped });
        if (!reValidation.errors.length) {
          validOps = shaped;
          validation = reValidation;
          annotatedAll = reValidation.results.map(r => ({ op: r.op, errors: r.errors }));
          try { appendAudit({ action: 'repair_success', mode: 'sse', repaired_ops: shaped.length }); } catch {}
        } else {
          try { appendAudit({ action: 'repair_failed', mode: 'sse', remaining_invalid: reValidation.results.filter(r => r.errors.length > 0).length }); } catch {}
        }
      } catch {
        try { appendAudit({ action: 'repair_error', mode: 'sse' }); } catch {}
      }
    }

    // Call 2 — conversational summary
    let text;
    try {
      const prompt2 = buildConversationalSummaryPrompt({ instruction: message.trim(), operations: validOps, todosSnapshot: todos, transcript });
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

// Mount static assets last so API routes are matched first
app.use(express.static(STATIC_DIR));

// Error handler
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'internal_error' });
});

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = '127.0.0.1';
app.listen(PORT, HOST, () => {
  console.log(`Server listening at http://${HOST}:${PORT}`);
});


