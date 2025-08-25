#!/usr/bin/env node

// Single-server Express app that serves the UI and provides CRUD + search + backlog APIs.
// Persistence uses SQLite (better-sqlite3) at ./data/app.db with schema at apps/server/database/schema.sql.

import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import db from './database/DbService.js';
import app, { setOperationProcessor } from './app.js';
import { ymdInTimeZone, weekRangeFromToday } from './utils/date.js';
import { isYmdString, isValidTimeOfDay, isValidRecurrence } from './utils/recurrence.js';
import { filterTodosByWhere as filterTodosByWhereUtil, filterItemsByWhere as filterItemsByWhereUtil, getAggregatesFromDb as getAggregatesFromDbUtil } from './utils/filters.js';
import { logIO } from './llm/logging.js';

// Add response filtering middleware
function filterLLMResponse(data) {
  if (typeof data === 'string') {
    try {
      const parsed = JSON.parse(data);
      // Remove sensitive fields from client responses
      const filtered = { ...parsed };
      delete filtered.context;
      delete filtered.created_at;
      delete filtered.model;
      delete filtered.done_reason;
      return JSON.stringify(filtered);
    } catch {
      return data;
    }
  }
  return data;
}
import { HabitusMCPServer } from './mcp/mcp_server.js';
import { OperationProcessor } from './operations/operation_processor.js';
import { OperationRegistry } from './operations/operation_registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Cache configured LLM models once at startup to keep a single source of truth
// throughout the server process. This is intentionally read-once so runtime
// behaviour is consistent and so we can log configured models at startup.
const MODELS = {
  convo: 'qwen3:30b',
  code: 'qwen3:30b',
  host: process.env.OLLAMA_HOST || '127.0.0.1',
  port: process.env.OLLAMA_PORT || '11434',
};

// --- Paths ---
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(REPO_ROOT, 'data');
const STATIC_DIR = process.env.STATIC_DIR || path.join(REPO_ROOT, 'apps', 'web', 'flutter_app', 'build', 'web');
const SCHEMA_FILE = path.join(REPO_ROOT, 'apps', 'server', 'database', 'schema.sql');

// --- Timezone (fixed semantics) ---
const TIMEZONE = process.env.TZ_NAME || 'America/New_York';

// weekRangeFromToday is provided by utils/date.js

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

function filterTodosByWhere(where = {}) { return filterTodosByWhereUtil(where, { listAllTodosRaw }); }

function filterItemsByWhere(items, where = {}) { return filterItemsByWhereUtil(items, where); }

function getAggregatesFromDb() {
  return getAggregatesFromDbUtil({ listAllTodosRaw });
}

function buildRouterSnapshots() {
  const { fromYmd, toYmd } = weekRangeFromToday(TIMEZONE);
  const todosWeek = filterTodosByWhereUtil({ scheduled_range: { from: fromYmd, to: toYmd }, status: 'pending' }, { listAllTodosRaw });
  const eventsWeek = filterItemsByWhereUtil(listAllEventsRaw(), { scheduled_range: { from: fromYmd, to: toYmd }, completed: false });
  const habitsWeek = filterItemsByWhereUtil(listAllHabitsRaw(), { scheduled_range: { from: fromYmd, to: toYmd }, completed: false });
  const weekItems = [...todosWeek, ...eventsWeek, ...habitsWeek];
  const compact = (t) => ({ id: t.id, title: t.title, scheduledFor: t.scheduledFor });
  return { week: { from: fromYmd, to: toYmd, items: weekItems.map(compact) } };
}



// Ensure data dir exists and bootstrap DB schema
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
try {
  const schemaSql = fs.readFileSync(SCHEMA_FILE, 'utf8');
  db.bootstrapSchema(schemaSql);
} catch {}

// --- Normalization helpers (forward-compatible defaults) ---

function createTodoDb({ title, notes = '', scheduledFor = null, timeOfDay = null, recurrence = undefined, context = 'personal' }) {
  return db.createTodo({ title, notes, scheduledFor, timeOfDay, recurrence: recurrence || { type: 'none' }, completed: false, context });
}

function findTodoById(id) { return db.getTodoById(parseInt(id, 10)); }

// moved to utils/date.js

// moved to utils/recurrence.js

// moved to utils/recurrence.js

// moved to utils/recurrence.js

// moved to utils/date.js

// moved to utils/date.js

// Occurrence expansion helpers moved to utils/recurrence.js and route files

// --- Server ---
// app instance is created and configured in app.js

// Ajv schemas moved to individual route files; keep server.js lean

// Initialize MCP server and operation processor
const operationProcessor = new OperationProcessor();
operationProcessor.setDbService(db);
const operationRegistry = new OperationRegistry(db);
operationRegistry.registerAllOperations(operationProcessor);

// Set the operation processor in the assistant routes
setOperationProcessor(operationProcessor);

const mcpServer = new HabitusMCPServer(app);
mcpServer.setOperationProcessor(operationProcessor);

// Static assets (Flutter Web build) are mounted AFTER API routes below

// Health route is mounted via app.js

// MCP Server endpoints
app.get('/api/mcp/tools', async (req, res) => {
  try {
    const tools = await mcpServer.listAvailableTools();
    res.json({ tools });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/mcp/resources', async (req, res) => {
  try {
    const resources = await mcpServer.listAvailableResources();
    res.json({ resources });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/mcp/resources/:type/:name', async (req, res) => {
  try {
    const { type, name } = req.params;
    const fullUri = `habitus://${type}/${name}`;
    const content = await mcpServer.readResource(fullUri);
    if (content === null) {
      return res.status(404).json({ error: 'Resource not found' });
    }
    res.json({ uri: fullUri, content });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/mcp/tools/call', async (req, res) => {
  try {
    const { name, arguments: args } = req.body || {};
    if (!name) {
      return res.status(400).json({ error: 'Tool name is required' });
    }
    const result = await mcpServer.handleToolCall(name, args || {});
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

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

// --- CRUD Endpoints --- (todos moved to routes/todos.js)

// Events (mirror Todos minimal wiring)
// Events routes moved to routes/events.js

// Habits routes moved to routes/habits.js
// Events routes moved to routes/events.js

// Unified search route moved to routes/search.js

// Unified schedule route moved to routes/schedule.js

// Goals routes moved to routes/goals.js

// Todos routes moved to routes/todos.js

// --- LLM proposal-and-verify (Ollama) ---
// Model selection now uses `getModels()` from `apps/server/llm/clients.js` (convo/code).
const OLLAMA_TEMPERATURE = 0.1;
const GLOBAL_TIMEOUT_SECS = parseInt('300', 10);


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

  if (w.completed !== undefined && typeof w.completed !== 'boolean') errors.push('invalid_where_completed');
  if (w.repeating !== undefined && typeof w.repeating !== 'boolean') errors.push('invalid_where_repeating');
  return errors;
}

function validateOperation(op) {
  const errors = [];
  if (!op || typeof op !== 'object') return ['invalid_operation_object'];
  const kindV3 = op.kind && String(op.kind).toLowerCase();
  const actionV3 = op.action && String(op.action).toLowerCase();
  const inferred = inferOperationShape(op);
  const kind = inferred?.op;
  const allowedKinds = ['create', 'update', 'delete', 'set_status', 'complete', 'complete_occurrence', 'goal_create', 'goal_update', 'goal_delete', 'goal_add_items', 'goal_remove_item', 'goal_add_child', 'goal_remove_child'];
  if (!allowedKinds.includes(kind)) errors.push('invalid_op');
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
  if ((kind === 'update' || kind === 'delete' || kind === 'complete' || kind === 'complete_occurrence' || kind === 'set_status')) {
    if (!(Number.isFinite(op.id))) {
      errors.push('missing_or_invalid_id');
    } else {
      const v3Kind = (op.kind && String(op.kind).toLowerCase()) || null;
      // For validation we do not hard-require current existence; apply stage will 404 appropriately.
      // This avoids false negatives for entities created earlier in the same batch.
    }
  }
  // For todos: prefer set_status
  if (op.kind && String(op.kind).toLowerCase() === 'todo') {
    if (kind === 'complete' || kind === 'complete_occurrence') {
      errors.push('use_set_status');
    }
    if (kind === 'set_status') {
      const s = (op.status === undefined || op.status === null) ? null : String(op.status);
      if (!s || !['pending','completed','skipped'].includes(s)) errors.push('invalid_status');
      if (op.occurrenceDate !== undefined && !(op.occurrenceDate === null || isYmdString(op.occurrenceDate))) errors.push('invalid_occurrenceDate');
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
  else if (action === 'set_status') op.op = 'set_status';
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
  // If only action provided in V3, try to infer op
  if (!op.op && !op.kind && op.action) {
    const action = String(op.action).toLowerCase();
  if (['create','update','delete','complete','complete_occurrence','set_status'].includes(action)) {
      op.op = action === 'complete_occurrence' ? 'complete_occurrence' : action;
    }
  }
  if (!op.op) {
    const hasId = Number.isFinite(op.id);
    const hasCompleted = typeof op.completed === 'boolean';
    const hasStatus = typeof op.status === 'string';
    const hasTitleOrNotesOrSched = !!(op.title || op.notes || (op.scheduledFor !== undefined));
    if (!hasId && (op.title || op.scheduledFor !== undefined)) {
      op.op = 'create';
      delete op.id;
    } else if (hasId && hasStatus && !hasTitleOrNotesOrSched) {
      op.op = 'set_status';
    } else if (hasId && hasCompleted && !hasTitleOrNotesOrSched) {
      // Back-compat: completed implies set_status
      op.op = 'set_status';
    } else if (hasId && hasTitleOrNotesOrSched) {
      op.op = 'update';
    }
  }
  // Normalize fields
  if (op.scheduledFor === '') op.scheduledFor = null;
  return op;
}

function runOllamaPrompt(prompt) {
  return new Promise((resolve, reject) => {
    const modelToRun = (MODELS && MODELS.code) ? MODELS.code : (process.env.OLLAMA_MODEL || null);
    if (!modelToRun) return reject(new Error('ollama_model_not_set'));
    const tryArgsList = [
      ['run', modelToRun, '--temperature', String(OLLAMA_TEMPERATURE)],
      ['run', modelToRun], // fallback for CLI versions without temperature flag
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

// Attempt HTTP JSON-biased generation via Ollama; falls back to CLI on error at call sites
async function tryRunOllamaJsonFormat({ userContent }) {
  const base = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
  const url = `${base}/api/generate`;
  const modelName = (MODELS && MODELS.code) ? MODELS.code : (process.env.OLLAMA_MODEL || null);
  const payload = { model: modelName, prompt: userContent, format: 'json', stream: false };
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
    return runOllamaPrompt(userContent);
  }
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
  '- todo actions: create|update|delete|set_status',
    '- event actions: create|update|delete|complete|complete_occurrence',
    '- goal actions: create|update|delete|add_items|remove_item|add_child|remove_child',
    'Rules:',
  '- For todo/event create/update, include a recurrence object (use {"type":"none"} for non-repeating).',
    '- For repeating tasks/events (recurrence.type != none), an anchor scheduledFor is REQUIRED.',
  '- For todos: use set_status with {id, status:"pending|completed|skipped"} (and optional occurrenceDate for repeating). Do NOT use complete/complete_occurrence for todos.',
  '- For repeating events/habits: do not use master complete; use complete_occurrence with occurrenceDate.',
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



function buildProposalPrompt({ instruction, todosSnapshot, transcript }) {
  const today = new Date();
  const todayYmd = ymdInTimeZone(today, TIMEZONE);
  const system = `You are an assistant for a todo app. Output ONLY a single JSON object with key "operations" as an array. No prose.\n` +
    `Each operation MUST include fields: kind (todo|event|goal) and action.\n` +
    `todo actions: create|update|delete|set_status.\n` +
    `event actions: create|update|delete|complete|complete_occurrence.\n` +
    `goal actions: create|update|delete|add_items|remove_item|add_child|remove_child.\n` +
    `For todo/event create/update include recurrence (use {"type":"none"} for non-repeating). If recurrence.type != none, scheduledFor is REQUIRED.\n` +
    `For todos: use set_status with {id, status:"pending|completed|skipped"} and optional occurrenceDate for repeating.\n` +
    `For events: use complete or complete_occurrence (with occurrenceDate).\n` +
    `No bulk operations. Emit independent operations; limit to ≤20 per apply.\n` +
    `Today's date is ${todayYmd}. Do NOT invent invalid IDs. Prefer fewer changes over hallucination.\n` +
    `You may reason internally, but the final output MUST be a single JSON object exactly as specified. Do not include your reasoning or any prose.`;
  const last3 = Array.isArray(transcript) ? transcript.slice(-3) : [];
  const convo = last3.map((t) => `- ${t.role}: ${t.text}`).join('\n');
  const context = JSON.stringify({ todos: todosSnapshot }, null, 2);
  const user = `Conversation (last 3 turns):\n${convo}\n\nTimezone: ${TIMEZONE}\nInstruction:\n${instruction}\n\nContext:\n${context}\n\nRespond with JSON ONLY that matches this exact example format:\n{\n  "operations": [\n    {"kind":"todo","action":"create","title":"<contextually relevant title>","scheduledFor":"${todayYmd}","recurrence":{"type":"none"}},\n    {"kind":"todo","action":"set_status","id":123,"status":"completed"}\n  ]\n}`;
  return `${system}\n\n${user}`;
}


function appendAudit(entry) {
  try { db.logAudit(entry); } catch {}
}

async function withDbTransaction(fn) { return db.runInTransaction(fn); }

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
  else if (op.op === 'complete' || op.op === 'set_status') { completed++; }
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

// Shared helper: propose → validate → (attempt repair) → return ops and annotations
async function runProposalAndRepair({ instruction, transcript, focusedWhere, mode = 'post', onValidating, onOps, onRepairing, correlationId }) {
  // Snapshot selection
  const aggregates = getAggregatesFromDb();
  const topK = focusedWhere ? filterTodosByWhereUtil(focusedWhere, { listAllTodosRaw }).slice(0, 50) : listAllTodosRaw().slice(0, 40);
  const snapshot = focusedWhere ? { focused: topK, aggregates } : { topK, aggregates };

  // Propose
  const prompt1 = buildProposalPrompt({ instruction: instruction.trim(), todosSnapshot: snapshot, transcript });
  const raw1 = await runOllamaForJsonPreferred({ userContent: prompt1 });
  try { const modelName = (MODELS && MODELS.code) ? MODELS.code : (process.env.OLLAMA_MODEL || null); logIO('proposal', { model: modelName, prompt: prompt1, output: raw1, meta: { correlationId, mode } }); } catch {}
  let parsed1 = parseJsonLenient(raw1);
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
    appendAudit({ action: 'assistant_understanding', results: annotatedAll, summary, meta: { correlationId } });
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
  try { appendAudit({ action: 'repair_attempted', mode, meta: { correlationId } }); } catch {}
    if (typeof onRepairing === 'function') {
      try { onRepairing(); } catch {}
    }
    try {
  const repairPrompt = buildRepairPrompt({ instruction: instruction.trim(), originalOps: ops, errors: validation.results, transcript });
  const rawRepair = await runOllamaForJsonPreferred({ userContent: repairPrompt });
  try { const modelName = (MODELS && MODELS.code) ? MODELS.code : (process.env.OLLAMA_MODEL || null); logIO('repair', { model: modelName, prompt: repairPrompt, output: rawRepair, meta: { correlationId, mode } }); } catch {}
      let parsedR = parseJsonLenient(rawRepair);
      const repairedOps = (parsedR && Array.isArray(parsedR.operations)) ? parsedR.operations : [];
      const shaped = repairedOps.filter(o => o && typeof o === 'object').map(o => inferOperationShape(o)).filter(Boolean);
      const reValidation = validateProposal({ operations: shaped });
      if (!reValidation.errors.length) {
        ops = shaped;
        validation = reValidation;
        annotatedAll = reValidation.results.map(r => ({ op: r.op, errors: r.errors }));
  try { appendAudit({ action: 'repair_success', mode, repaired_ops: shaped.length, meta: { correlationId } }); } catch {}
        if (typeof onOps === 'function') {
          try {
            onOps(2, annotatedAll, validation.results.filter(r => r.errors.length === 0).length, validation.results.filter(r => r.errors.length > 0).length);
          } catch {}
        }
      } else {
  try { appendAudit({ action: 'repair_failed', mode, remaining_invalid: reValidation.results.filter(r => r.errors.length > 0).length, meta: { correlationId } }); } catch {}
        // keep original valid subset
        ops = validation.results.filter(r => r.errors.length === 0).map(r => r.op);
      }
    } catch {
      ops = validation.results.filter(r => r.errors.length === 0).map(r => r.op);
      try { appendAudit({ action: 'repair_error', mode, meta: { correlationId } }); } catch {}
    }
  }

  return { ops, annotatedAll, validation };
}

 

// Assistant routes moved to routes/assistant.js

// Minimal POST endpoint to exercise conversation LLM and logging (non-invasive)
// LLM routes moved to routes/llm.js

// Mount static assets last so API routes are matched first
app.use(express.static(STATIC_DIR));

// Silence noisy 404s for Flutter source maps when running in prod-like mode
app.get('/flutter.js.map', (_req, res) => res.status(204).end());

// Error handler
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'internal_error' });
});

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '127.0.0.1';
app.listen(PORT, HOST, async () => {
  console.log(`Server listening at http://${HOST}:${PORT}`);
  try {
    // Best-effort: query Ollama for available models to report presence of configured names
    const { getAvailableModels } = await import('./llm/clients.js');
    try {
      const avail = await getAvailableModels();
      const present = Array.isArray(avail.models) ? avail.models.map(m => m.name) : [];
      const convoPresent = present.includes(MODELS.convo);
      const codePresent = present.includes(MODELS.code);
      console.log('Configured LLM models:', MODELS);
      console.log('Available Ollama models:', present.slice(0, 50));
      console.log(`Convo model present: ${convoPresent}, Code model present: ${codePresent}`);
    } catch (e) {
      console.log('Configured LLM models (availability unknown):', MODELS);
    }
  } catch (e) {
    console.log('Configured LLM models (getAvailableModels not available):', MODELS);
  }
});
