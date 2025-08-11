#!/usr/bin/env node

// Minimal local HTTP bridge scaffold for the MCP todo server
// - Serves static UI from web/public
// - Exposes /health
// - Implements REST endpoints by shelling out to scripts/mcp_client.js per request

import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '256kb' }));

// Static assets
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

// Healthcheck
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// --- Helpers ---
const projectRoot = path.join(__dirname, '..');
const mcpClientPath = path.join(projectRoot, 'scripts', 'mcp_client.js');

function runMcpTool(toolName, args) {
  try {
    const stdout = execFileSync(
      'node',
      [mcpClientPath, '--tool', toolName, '--args', JSON.stringify(args || {}), '--cwd', projectRoot],
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
    );
    const parsed = JSON.parse(stdout);
    const text = parsed?.response?.content?.[0]?.text;
    if (typeof text !== 'string') {
      throw new Error('missing_content_text');
    }
    return text;
  } catch (err) {
    // Map MCP not-found errors to 404
    const stderr = err && err.stderr ? String(err.stderr) : '';
    const msg = String(err && err.message ? err.message : err || '');
    const combined = `${msg} ${stderr}`;
    if (/not found/i.test(combined)) {
      const notFound = new Error('not_found');
      notFound.code = 404;
      throw notFound;
    }
    const upstream = new Error('upstream_failure');
    upstream.code = 502;
    upstream.detail = combined.slice(0, 500);
    throw upstream;
  }
}

function isYmdString(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function parseObjFromCreatedOrUpdated(text) {
  const i = text.indexOf('{');
  if (i === -1) throw new Error('parse_error');
  return JSON.parse(text.slice(i));
}

function parseArrayFromFound(text) {
  const nl = text.indexOf('\n');
  const jsonPart = nl === -1 ? text : text.slice(nl + 1);
  const arr = JSON.parse(jsonPart);
  if (!Array.isArray(arr)) throw new Error('parse_error');
  return arr;
}

// --- Endpoints ---
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

  try {
    const text = runMcpTool('create_todo', { title, notes, scheduledFor: scheduledFor ?? null, priority });
    const todo = parseObjFromCreatedOrUpdated(text);
    res.json({ todo });
  } catch (err) {
    const code = err.code === 404 ? 404 : err.code === 502 ? 502 : 502;
    res.status(code).json({ error: code === 404 ? 'not_found' : 'upstream_failure' });
  }
});

// List
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

  const args = {};
  if (from) args.scheduledFrom = from;
  if (to) args.scheduledTo = to;
  if (priority) args.priority = String(priority);
  if (completedBool !== undefined) args.completed = completedBool;

  try {
    const text = runMcpTool('list_todos', args);
    const todos = parseArrayFromFound(text);
    res.json({ todos });
  } catch (err) {
    const code = err.code === 404 ? 404 : err.code === 502 ? 502 : 502;
    res.status(code).json({ error: code === 404 ? 'not_found' : 'upstream_failure' });
  }
});

// Search
app.get('/api/todos/search', (req, res) => {
  const q = req.query.query;
  if (typeof q !== 'string' || q.trim() === '') {
    return res.status(400).json({ error: 'invalid_query' });
  }
  try {
    const text = runMcpTool('search_todos', { query: q });
    const todos = parseArrayFromFound(text);
    res.json({ todos });
  } catch (err) {
    const code = err.code === 404 ? 404 : err.code === 502 ? 502 : 502;
    res.status(code).json({ error: code === 404 ? 'not_found' : 'upstream_failure' });
  }
});

// Backlog (unscheduled only)
app.get('/api/todos/backlog', (_req, res) => {
  try {
    const text = runMcpTool('list_todos', {});
    const todos = parseArrayFromFound(text).filter(t => t && t.scheduledFor === null);
    res.json({ todos });
  } catch (err) {
    const code = err.code === 404 ? 404 : err.code === 502 ? 502 : 502;
    res.status(code).json({ error: code === 404 ? 'not_found' : 'upstream_failure' });
  }
});

// Get by id
app.get('/api/todos/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  try {
    const text = runMcpTool('get_todo', { id });
    const todo = JSON.parse(text);
    res.json({ todo });
  } catch (err) {
    const code = err.code === 404 ? 404 : err.code === 502 ? 502 : 502;
    res.status(code).json({ error: code === 404 ? 'not_found' : 'upstream_failure' });
  }
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

  const args = { id };
  if (title !== undefined) args.title = title;
  if (notes !== undefined) args.notes = notes;
  if (scheduledFor !== undefined) args.scheduledFor = scheduledFor;
  if (priority !== undefined) args.priority = priority;
  if (completed !== undefined) args.completed = completed;

  try {
    const text = runMcpTool('update_todo', args);
    const todo = parseObjFromCreatedOrUpdated(text);
    res.json({ todo });
  } catch (err) {
    const code = err.code === 404 ? 404 : err.code === 502 ? 502 : 502;
    res.status(code).json({ error: code === 404 ? 'not_found' : 'upstream_failure' });
  }
});

// Delete by id
app.delete('/api/todos/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  try {
    runMcpTool('delete_todo', { id });
    res.json({ ok: true });
  } catch (err) {
    const code = err.code === 404 ? 404 : err.code === 502 ? 502 : 502;
    res.status(code).json({ error: code === 404 ? 'not_found' : 'upstream_failure' });
  }
});

// Error handler
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('Bridge error:', err);
  res.status(500).json({ error: 'internal_error' });
});

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = '127.0.0.1';

app.listen(PORT, HOST, () => {
  console.log(`Web bridge listening at http://${HOST}:${PORT}`);
});


