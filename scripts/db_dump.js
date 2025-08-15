#!/usr/bin/env node

import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const dbPath = path.join(repoRoot, 'data', 'app.db');

const MAX_COL_WIDTH = 100;

function ellipsize(s, max = MAX_COL_WIDTH) {
  if (s == null) return 'NULL';
  const str = String(s);
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + '…';
}

function tryParseJson(s) {
  try {
    const t = String(s || '').trim();
    if (!t) return null;
    if (!(t.startsWith('{') || t.startsWith('['))) return null;
    return JSON.parse(t);
  } catch { return null; }
}

function stringifyValue(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'string') {
    const parsed = tryParseJson(v);
    if (parsed !== null) {
      try { return JSON.stringify(parsed); } catch { return v; }
    }
    return v;
  }
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
}

function computeWidths(headers, rows) {
  const widths = headers.map(h => h.length);
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.min(MAX_COL_WIDTH, Math.max(widths[i], String(cell).length));
    });
  }
  return widths;
}

function hr(widths) {
  return '+' + widths.map(w => '-'.repeat(w + 2)).join('+') + '+';
}

function pad(s, w) {
  const str = String(s);
  if (str.length >= w) return str;
  return str + ' '.repeat(w - str.length);
}

function renderTable(headers, rows) {
  const widths = computeWidths(headers, rows);
  const lines = [];
  lines.push(hr(widths));
  lines.push('|' + headers.map((h, i) => ' ' + pad(h, widths[i]) + ' ').join('|') + '|');
  lines.push(hr(widths));
  for (const r of rows) {
    lines.push('|' + r.map((c, i) => ' ' + pad(c, widths[i]) + ' ').join('|') + '|');
  }
  lines.push(hr(widths));
  return lines.join('\n');
}

function main() {
  const db = new Database(dbPath, { readonly: true });
  const tables = db.prepare("SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name ASC").all();

  // Preferred order first, then remaining
  const preferred = [
    'todos', 'events', 'goals',
    'goal_todo_items', 'goal_event_items', 'goal_hierarchy',
    'audit_log', 'idempotency',
    'todos_fts', 'events_fts'
  ];
  const byName = new Map(tables.map(t => [t.name, t]));
  const ordered = [];
  for (const n of preferred) if (byName.has(n)) ordered.push(byName.get(n));
  for (const t of tables) if (!preferred.includes(t.name)) ordered.push(t);

  for (const t of ordered) {
    const name = t.name;
    const sql = String(t.sql || '');
    const isFts = /\bUSING\s+fts\d/i.test(sql);
    // Columns discovery
    const cols = db.prepare(`PRAGMA table_info(${name})`).all().map(r => r.name);
    let headers = cols;
    let rowsRaw;
    try {
      if (isFts && !cols.includes('rowid')) {
        rowsRaw = db.prepare(`SELECT rowid as rowid, * FROM ${name} ORDER BY rowid ASC`).all();
        headers = ['rowid', ...cols];
      } else if (cols.includes('id')) {
        rowsRaw = db.prepare(`SELECT * FROM ${name} ORDER BY id ASC`).all();
      } else {
        rowsRaw = db.prepare(`SELECT * FROM ${name}`).all();
      }
    } catch (e) {
      console.log(`\n=== ${name} (error reading) ===`);
      console.log(String(e && e.message ? e.message : e));
      continue;
    }
    console.log(`\n=== ${name} (${rowsRaw.length} rows) ===`);
    if (rowsRaw.length === 0) {
      console.log('(empty)');
      continue;
    }
    const rows = rowsRaw.map(r => headers.map(h => ellipsize(stringifyValue(r[h]))));
    console.log(renderTable(headers, rows));
  }
}

try { main(); } catch (e) { console.error('db:dump failed:', e); process.exit(1); }


