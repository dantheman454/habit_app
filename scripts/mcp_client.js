#!/usr/bin/env node

// Minimal MCP-like CLI client for todo tools used by tests.
// Implements tools directly (no server), persisting under --cwd/data.
// Output format matches tests: a JSON object with { tool, arguments, response: { content: [ { type: 'text', text } ] } }.

import fs from 'fs';
import path from 'path';

function parseArgs(argv) {
  const args = { tool: '', args: {}, cwd: process.cwd() };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tool') args.tool = String(argv[++i] || '');
    else if (a === '--args') {
      try { args.args = JSON.parse(String(argv[++i] || '{}')); } catch { args.args = {}; }
    } else if (a === '--cwd') {
      args.cwd = String(argv[++i] || args.cwd);
    }
  }
  return args;
}

function ensureDataDir(baseDir) {
  const dataDir = path.join(baseDir, 'data');
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch {}
  return dataDir;
}

function readJsonSafe(file, fallback) {
  try {
    if (fs.existsSync(file)) {
      const s = fs.readFileSync(file, 'utf8');
      return JSON.parse(s);
    }
  } catch {}
  return fallback;
}

function writeJsonSafe(file, obj) {
  try { fs.writeFileSync(file, JSON.stringify(obj, null, 2)); } catch {}
}

function parseYMD(s) {
  try {
    const [y, m, d] = String(s).split('-').map(v => parseInt(v, 10));
    if (!y || !m || !d) return null;
    return new Date(y, m - 1, d);
  } catch { return null; }
}

function isYmdString(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v); }

function coerceId(anyId) {
  const n = parseInt(String(anyId), 10);
  return Number.isFinite(n) ? n : NaN;
}

function findById(todos, anyId) {
  const id = coerceId(anyId);
  return todos.find(t => t.id === id);
}

function output(text, meta = {}) {
  const payload = {
    tool: meta.tool || '',
    arguments: meta.arguments || {},
    response: {
      content: [{ type: 'text', text: String(text) }],
    },
  };
  process.stdout.write(JSON.stringify(payload));
}

function main() {
  const { tool, args, cwd } = parseArgs(process.argv);
  if (!tool) {
    console.error('missing_tool');
    process.exit(2);
    return;
  }

  const dataDir = ensureDataDir(cwd || process.cwd());
  const todosFile = path.join(dataDir, 'todos.json');
  const counterFile = path.join(dataDir, 'counter.json');
  let todos = readJsonSafe(todosFile, []);
  let counter = readJsonSafe(counterFile, { nextId: 1 });

  const nowIso = new Date().toISOString();
  const meta = { tool, arguments: args };

  try {
    if (tool === 'create_todo') {
      const title = String(args.title || '').trim();
      if (!title) throw new Error('invalid_title');
      const notes = args.notes === undefined ? '' : String(args.notes);
      const scheduledFor = (args.scheduledFor === null || args.scheduledFor === undefined) ? null : String(args.scheduledFor);
      if (!(scheduledFor === null || isYmdString(scheduledFor))) throw new Error('invalid_scheduledFor');
      const priority = (args.priority || 'medium');
      const id = counter.nextId++;
      const todo = { id, title, notes, scheduledFor, priority, completed: false, createdAt: nowIso, updatedAt: nowIso };
      todos.push(todo);
      writeJsonSafe(todosFile, todos);
      writeJsonSafe(counterFile, counter);
      output(`Created todo:\n${JSON.stringify(todo)}`, meta);
      process.exit(0);
      return;
    }

    if (tool === 'list_todos') {
      const scheduledFrom = args.scheduledFrom ? parseYMD(args.scheduledFrom) : null;
      const scheduledTo = args.scheduledTo ? parseYMD(args.scheduledTo) : null;
      const priority = args.priority ? String(args.priority).toLowerCase() : undefined;
      const completed = (args.completed === undefined) ? undefined : Boolean(args.completed);
      let items = todos.slice();
      if (priority) items = items.filter(t => String(t.priority).toLowerCase() === priority);
      if (completed !== undefined) items = items.filter(t => t.completed === completed);
      if (scheduledFrom || scheduledTo) {
        items = items.filter(t => {
          if (t.scheduledFor === null) return false;
          const dt = parseYMD(t.scheduledFor);
          if (!dt) return false;
          if (scheduledFrom && dt < scheduledFrom) return false;
          if (scheduledTo) {
            const end = new Date(scheduledTo.getFullYear(), scheduledTo.getMonth(), scheduledTo.getDate() + 1);
            if (dt >= end) return false; // inclusive day
          }
          return true;
        });
      }
      output(`Found ${items.length} todos\n${JSON.stringify(items)}`, meta);
      process.exit(0);
      return;
    }

    if (tool === 'get_todo') {
      const t = findById(todos, args.id);
      if (!t) throw new Error('not_found');
      output(JSON.stringify(t), meta);
      process.exit(0);
      return;
    }

    if (tool === 'update_todo') {
      const t = findById(todos, args.id);
      if (!t) throw new Error('not_found');
      if (args.title !== undefined) t.title = String(args.title);
      if (args.notes !== undefined) t.notes = String(args.notes);
      if (args.scheduledFor !== undefined) {
        const v = (args.scheduledFor === null) ? null : String(args.scheduledFor);
        if (!(v === null || isYmdString(v))) throw new Error('invalid_scheduledFor');
        t.scheduledFor = v;
      }
      if (args.priority !== undefined) t.priority = String(args.priority);
      if (args.completed !== undefined) t.completed = Boolean(args.completed);
      t.updatedAt = nowIso;
      writeJsonSafe(todosFile, todos);
      output(`Updated todo:\n${JSON.stringify(t)}`, meta);
      process.exit(0);
      return;
    }

    if (tool === 'delete_todo') {
      const id = coerceId(args.id);
      const idx = todos.findIndex(t => t.id === id);
      if (idx === -1) throw new Error('not_found');
      todos.splice(idx, 1);
      writeJsonSafe(todosFile, todos);
      output(`Deleted todo id=${id}`, meta);
      process.exit(0);
      return;
    }

    if (tool === 'search_todos') {
      const q = String(args.query || '').toLowerCase().trim();
      if (!q) throw new Error('invalid_query');
      const items = todos.filter(t => String(t.title || '').toLowerCase().includes(q) || String(t.notes || '').toLowerCase().includes(q));
      output(`Found ${items.length} todos\n${JSON.stringify(items)}`, meta);
      process.exit(0);
      return;
    }

    console.error('unknown_tool');
    process.exit(2);
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    process.stderr.write(msg);
    process.exit(1);
  }
}

main();


