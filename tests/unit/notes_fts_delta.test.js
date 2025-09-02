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

describe('FTS delta: notes changes propagate to search', () => {
  before(async () => {
    const testDataDir = path.join(process.cwd(), 'data', 'test');
    try { fs.mkdirSync(testDataDir, { recursive: true }); } catch {}
    const testDbPath = path.join(testDataDir, 'app_fts_delta.db');
    process.env.APP_DB_PATH = testDbPath;
    for (const f of ['app_fts_delta.db', 'app_fts_delta.db-shm', 'app_fts_delta.db-wal']) {
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

  test('task notes: create -> update -> clear reflected in /api/tasks/search', async () => {
    const create = await request('POST', '/api/tasks', { title: 'FTS Task', notes: 'alpha', recurrence: { type: 'none' }, scheduledFor: '2025-09-01' });
    assert.equal(create.status, 200);
    const id = create.body.task.id;
    let res = await request('GET', `/api/tasks/search?query=alpha`);
    assert.equal(res.status, 200);
    assert.ok(res.body.tasks.some(t => t.id === id));
    // update notes
    const upd = await request('PATCH', `/api/tasks/${id}`, { notes: 'beta' });
    assert.equal(upd.status, 200);
    res = await request('GET', `/api/tasks/search?query=beta`);
    assert.equal(res.status, 200);
    assert.ok(res.body.tasks.some(t => t.id === id));
    // previous term should no longer match after update
    res = await request('GET', `/api/tasks/search?query=alpha`);
    assert.equal(res.status, 200);
    assert.equal(res.body.tasks.some(t => t.id === id), false);
    // clear notes
    const clr = await request('PATCH', `/api/tasks/${id}`, { notes: '' });
    assert.equal(clr.status, 200);
    res = await request('GET', `/api/tasks/search?query=beta`);
    assert.equal(res.status, 200);
    assert.equal(res.body.tasks.some(t => t.id === id), false);
  });

  test('event notes: create -> update -> clear reflected in /api/events/search', async () => {
    const create = await request('POST', '/api/events', { title: 'FTS Event', notes: 'gamma', scheduledFor: '2025-09-01', startTime: '09:00', endTime: '10:00', recurrence: { type: 'none' } });
    assert.equal(create.status, 200);
    const id = create.body.event.id;
    let res = await request('GET', `/api/events/search?query=gamma`);
    assert.equal(res.status, 200);
    assert.ok(res.body.events.some(e => e.id === id));
    // update notes
    const upd = await request('PATCH', `/api/events/${id}`, { notes: 'delta' });
    assert.equal(upd.status, 200);
    res = await request('GET', `/api/events/search?query=delta`);
    assert.equal(res.status, 200);
    assert.ok(res.body.events.some(e => e.id === id));
    // previous term should no longer match after update
    res = await request('GET', `/api/events/search?query=gamma`);
    assert.equal(res.status, 200);
    assert.equal(res.body.events.some(e => e.id === id), false);
    // clear notes
    const clr = await request('PATCH', `/api/events/${id}`, { notes: '' });
    assert.equal(clr.status, 200);
    res = await request('GET', `/api/events/search?query=delta`);
    assert.equal(res.status, 200);
    assert.equal(res.body.events.some(e => e.id === id), false);
  });
});


