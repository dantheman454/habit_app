#!/usr/bin/env node

// Single-server Express app that serves the UI and provides CRUD + search + backlog APIs.
// Persistence uses JSON files in ./data. Designed to replace web/server.js + src/server.js bridge.

import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Paths ---
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(REPO_ROOT, 'data');
const TODOS_FILE = path.join(DATA_DIR, 'todos.json');
const COUNTER_FILE = path.join(DATA_DIR, 'counter.json');
const STATIC_DIR = process.env.STATIC_DIR || path.join(REPO_ROOT, 'apps', 'web', 'flutter_app', 'build', 'web');

// Ensure data dir exists
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

// --- Persistence helpers (sync for simplicity) ---
function loadTodos() {
  try {
    if (fs.existsSync(TODOS_FILE)) {
      const s = fs.readFileSync(TODOS_FILE, 'utf8');
      return JSON.parse(s);
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

let todos = loadTodos();
let nextId = loadNextId();

function createTodo({ title, notes = '', scheduledFor = null, priority = 'medium' }) {
  const now = new Date().toISOString();
  const todo = {
    id: nextId++,
    title,
    notes,
    scheduledFor,
    priority,
    completed: false,
    createdAt: now,
    updatedAt: now,
  };
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
  const { title, notes, scheduledFor, priority } = req.body || {};
  if (typeof title !== 'string' || title.trim() === '') {
    return res.status(400).json({ error: 'invalid_title' });
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

  const todo = createTodo({ title: title.trim(), notes: notes || '', scheduledFor: scheduledFor ?? null, priority: priority || 'medium' });
  todos.push(todo);
  saveTodos(todos);
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

  let items = todos.filter(t => t.scheduledFor !== null);
  if (priority) items = items.filter(t => String(t.priority).toLowerCase() === String(priority).toLowerCase());
  if (completedBool !== undefined) items = items.filter(t => t.completed === completedBool);

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
  res.json({ todos: items });
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
  const items = todos.filter(t => String(t.title || '').toLowerCase().includes(q) || String(t.notes || '').toLowerCase().includes(q));
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
  const { title, notes, scheduledFor, priority, completed } = req.body || {};
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

  const t = findTodoById(id);
  if (!t) return res.status(404).json({ error: 'not_found' });
  const now = new Date().toISOString();
  if (title !== undefined) t.title = title;
  if (notes !== undefined) t.notes = notes;
  if (scheduledFor !== undefined) t.scheduledFor = scheduledFor;
  if (priority !== undefined) t.priority = priority;
  if (completed !== undefined) t.completed = completed;
  t.updatedAt = now;
  saveTodos(todos);
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
  res.json({ ok: true });
});

// --- LLM proposal-and-verify (Ollama) ---
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'granite3.3:8b';
const OLLAMA_TEMPERATURE = parseFloat(process.env.OLLAMA_TEMPERATURE || '0.1');
const GLOBAL_TIMEOUT_SECS = parseInt(process.env.GLOBAL_TIMEOUT_SECS || '90', 10);

function validateOperation(op) {
  const errors = [];
  if (!op || typeof op !== 'object') return ['invalid_operation_object'];
  const kind = op.op;
  if (!['create', 'update', 'delete', 'complete'].includes(kind)) errors.push('invalid_op');
  if (op.priority !== undefined && !['low','medium','high'].includes(String(op.priority))) errors.push('invalid_priority');
  if (op.scheduledFor !== undefined && !(op.scheduledFor === null || isYmdString(op.scheduledFor))) errors.push('invalid_scheduledFor');
  if ((kind === 'update' || kind === 'delete' || kind === 'complete')) {
    if (!(Number.isFinite(op.id))) errors.push('missing_or_invalid_id');
    else if (!findTodoById(op.id)) errors.push('id_not_found');
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

function buildProposalPrompt({ instruction, todosSnapshot }) {
  const today = new Date();
  const todayYmd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const system = `You are an assistant for a todo app. Output ONLY a single JSON object with key "operations" as an array. No prose.\n` +
    `Each operation MUST include field "op" which is one of: "create", "update", "delete", "complete".\n` +
    `Allowed fields: op, id (int for update/delete/complete), title, notes, scheduledFor (YYYY-MM-DD or null), priority (low|medium|high), completed (bool).\n` +
    `If the user's instruction does not specify a date for a create operation, DEFAULT scheduledFor to TODAY (${todayYmd}).\n` +
    `Today's date is ${todayYmd}. Do NOT invent invalid IDs. Prefer fewer changes over hallucination.`;
  const context = JSON.stringify({ todos: todosSnapshot }, null, 2);
  const user = `Instruction:\n${instruction}\n\nContext:\n${context}\n\nRespond with JSON ONLY that matches this exact example format:\n{\n  "operations": [\n    {"op": "create", "title": "Buy milk", "scheduledFor": "${todayYmd}", "priority": "high"}\n  ]\n}`;
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
    return res.status(400).json({ error: 'invalid_operations', detail: validation });
  }
  const results = [];
  let created = 0, updated = 0, deleted = 0, completed = 0;
  await withApplyLock(async () => {
    for (const op of operations) {
      try {
        if (op.op === 'create') {
          const t = createTodo({ title: String(op.title || '').trim(), notes: op.notes || '', scheduledFor: op.scheduledFor ?? null, priority: op.priority || 'medium' });
          todos.push(t); saveTodos(todos); results.push({ ok: true, op, todo: t }); created++;
          appendAudit({ action: 'create', op, result: 'ok', id: t.id });
        } else if (op.op === 'update') {
          const t = findTodoById(op.id); if (!t) throw new Error('not_found');
          const now = new Date().toISOString();
          if (op.title !== undefined) t.title = op.title;
          if (op.notes !== undefined) t.notes = op.notes;
          if (op.scheduledFor !== undefined) t.scheduledFor = op.scheduledFor;
          if (op.priority !== undefined) t.priority = op.priority;
          if (op.completed !== undefined) t.completed = !!op.completed;
          t.updatedAt = now; saveTodos(todos); results.push({ ok: true, op, todo: t }); updated++;
          appendAudit({ action: 'update', op, result: 'ok', id: t.id });
        } else if (op.op === 'delete') {
          const idx = todos.findIndex(t => t.id === op.id); if (idx === -1) throw new Error('not_found');
          const removed = todos.splice(idx, 1)[0]; saveTodos(todos); results.push({ ok: true, op }); deleted++;
          appendAudit({ action: 'delete', op, result: 'ok', id: removed?.id });
        } else if (op.op === 'complete') {
          const t = findTodoById(op.id); if (!t) throw new Error('not_found');
          t.completed = op.completed === undefined ? true : !!op.completed; t.updatedAt = new Date().toISOString();
          saveTodos(todos); results.push({ ok: true, op, todo: t }); completed++;
          appendAudit({ action: 'complete', op, result: 'ok', id: t.id });
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
function buildConversationalSummaryPrompt({ instruction, operations, todosSnapshot }) {
  const today = new Date();
  const todayYmd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
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
  const system = `You are a helpful assistant for a todo app. Reply ultra-briefly (prefer 1 sentence; max 2). No markdown, no lists, no JSON.`;
  const context = `Today: ${todayYmd}\nProposed operations (count: ${operations.length}):\n${compactOps}`;
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

app.post('/api/assistant/message', async (req, res) => {
  try {
    const { message } = req.body || {};
    if (typeof message !== 'string' || message.trim() === '') {
      return res.status(400).json({ error: 'invalid_message' });
    }

    // Call 1 — generate operations (reuse robust proposal pipeline)
    const prompt1 = buildProposalPrompt({ instruction: message.trim(), todosSnapshot: todos });
    const raw1 = await runOllamaPrompt(prompt1);
    const tryParse = (text) => { try { return JSON.parse(text); } catch { return null; } };
    let parsed1 = tryParse(raw1);
    if (!parsed1 && /```/.test(raw1)) {
      const inner = raw1.replace(/```json|```/g, '').trim();
      parsed1 = tryParse(inner);
    }
    if (!parsed1) {
      // Try extracting first JSON object
      const s = raw1;
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

    const validation = validateProposal({ operations: ops });
    if (validation.errors.length) {
      // Keep only valid operations for UX; include detail for debugging
      ops = validation.results.filter(r => r.errors.length === 0).map(r => r.op);
    }

    // Call 2 — conversational summary
    let text;
    let usedFallback = false;
    try {
      const prompt2 = buildConversationalSummaryPrompt({ instruction: message.trim(), operations: ops, todosSnapshot: todos });
      const raw2 = await runOllamaPrompt(prompt2);
      // Extract a clean one- or two-sentence plain text
      text = String(raw2 || '').replace(/```[\s\S]*?```/g, '').trim();
      text = text.replace(/[\r\n]+/g, ' ').trim();
      if (!text) throw new Error('empty_text');
    } catch (e) {
      usedFallback = true;
      text = buildDeterministicSummaryText(ops);
      appendAudit({ action: 'assistant_message', conversational_fallback: true, error: String(e && e.message ? e.message : e) });
    }

    const body = { text };
    if (ops.length) body.operations = ops;
    res.json(body);
  } catch (err) {
    res.status(502).json({ error: 'assistant_failure', detail: String(err && err.message ? err.message : err) });
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


