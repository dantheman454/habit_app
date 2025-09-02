import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import app from '../../apps/server/app.js';
import db from '../../apps/server/database/DbService.js';

let server;
let base;

function request(method, url, body = null) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': data ? data.length : 0 },
    }, (res) => {
      let s = '';
      res.on('data', d => s += d.toString());
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: s ? JSON.parse(s) : {} }); } catch { resolve({ status: res.statusCode, body: {} }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

describe('routes: /api/tasks/:id/occurrence errors', () => {
  before(async () => {
    const testDataDir = path.join(process.cwd(), 'data', 'test');
    try { fs.mkdirSync(testDataDir, { recursive: true }); } catch {}
    const testDbPath = path.join(testDataDir, 'app_occurrence.db');
    process.env.APP_DB_PATH = testDbPath;
    for (const f of ['app_occurrence.db', 'app_occurrence.db-shm', 'app_occurrence.db-wal']) {
      try { fs.unlinkSync(path.join(testDataDir, f)); } catch {}
    }
    const schemaSql = fs.readFileSync(path.join(process.cwd(), 'apps', 'server', 'database', 'schema.sql'), 'utf8');
    db.bootstrapSchema(schemaSql);
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        base = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    try { await new Promise((r) => server.close(() => r())); } catch {}
  });

  test('invalid_occurrenceDate returns 400', async () => {
    const t = db.createTask({ title: 'One-off', recurrence: { type: 'none' } });
    const res = await request('PATCH', `/api/tasks/${t.id}/occurrence`, { occurrenceDate: 'invalid', status: 'completed' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_occurrenceDate');
  });

  test('not_repeating returns 400 for one-off task', async () => {
    const t = db.createTask({ title: 'One-off', recurrence: { type: 'none' }, scheduledFor: '2025-09-01' });
    const res = await request('PATCH', `/api/tasks/${t.id}/occurrence`, { occurrenceDate: '2025-09-02', status: 'completed' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'not_repeating');
  });
});


