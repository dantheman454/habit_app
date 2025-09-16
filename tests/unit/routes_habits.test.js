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

describe('routes: /api/habits', () => {
  before(async () => {
    // Isolate DB
    const testDataDir = path.join(process.cwd(), 'data', 'test');
    try { fs.mkdirSync(testDataDir, { recursive: true }); } catch {}
    const testDbPath = path.join(testDataDir, 'app.db');
    process.env.APP_DB_PATH = testDbPath;
    // Clean previous
    for (const f of ['app.db', 'app.db-shm', 'app.db-wal']) {
      try { fs.unlinkSync(path.join(testDataDir, f)); } catch {}
    }
    // Bootstrap schema
    const schemaSql = fs.readFileSync(path.join(process.cwd(), 'apps', 'server', 'database', 'schema.sql'), 'utf8');
    db.bootstrapSchema(schemaSql);
    // Start app on ephemeral port
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

  test('create → get → list → search → update → logs → delete', async () => {
    // create
    const createRes = await request('POST', '/api/habits', {
      title: 'Drink water',
      notes: '8 glasses',
      startedOn: '2025-09-15',
      recurrence: { type: 'daily' },
      weeklyTargetCount: 5,
      context: 'personal'
    });
    assert.equal(createRes.status, 200);
    assert.equal(typeof createRes.body?.habit?.id, 'number');
    const id = createRes.body.habit.id;

    // get
    const getRes = await request('GET', `/api/habits/${id}`);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.body?.habit?.title, 'Drink water');

    // list
    const listRes = await request('GET', '/api/habits?context=personal');
    assert.equal(listRes.status, 200);
    assert.ok(Array.isArray(listRes.body.habits));
    assert.ok(listRes.body.habits.some(h => h.id === id));

    // search
    const searchRes = await request('GET', '/api/habits/search?query=water&context=personal');
    assert.equal(searchRes.status, 200);
    assert.ok(Array.isArray(searchRes.body.habits));
    assert.ok(searchRes.body.habits.some(h => h.id === id));

    // update
    const updRes = await request('PATCH', `/api/habits/${id}`, { notes: '10 glasses' });
    assert.equal(updRes.status, 200);
    assert.equal(updRes.body?.habit?.notes, '10 glasses');

    // logs: set done true on a date
    const logDate = '2025-09-16';
    const logPut = await request('PUT', `/api/habits/${id}/logs/${logDate}`, { done: true });
    assert.equal(logPut.status, 200);
    assert.equal(logPut.body?.log?.date, logDate);
    assert.equal(logPut.body?.log?.done, true);
    // list logs
    const listLogs = await request('GET', `/api/habits/${id}/logs?from=2025-09-15&to=2025-09-17`);
    assert.equal(listLogs.status, 200);
    assert.ok(Array.isArray(listLogs.body?.logs));
    assert.ok(listLogs.body.logs.some(l => l.date === logDate));
    // delete log
    const delLog = await request('DELETE', `/api/habits/${id}/logs/${logDate}`);
    assert.equal(delLog.status, 200);
    assert.equal(delLog.body?.ok, true);

    // delete habit
    const delRes = await request('DELETE', `/api/habits/${id}`);
    assert.equal(delRes.status, 200);
    assert.equal(delRes.body?.ok, true);
  });

  test('validation errors', async () => {
    // invalid context on list
    const listBad = await request('GET', '/api/habits?context=home');
    assert.equal(listBad.status, 400);

    // create missing title
    const c1 = await request('POST', '/api/habits', { notes: '' });
    assert.equal(c1.status, 400);
    // create invalid startedOn
    const c2 = await request('POST', '/api/habits', { title: 'x', startedOn: 'bad', recurrence: { type: 'none' } });
    assert.equal(c2.status, 400);
    // create repeating without anchor
    const c3 = await request('POST', '/api/habits', { title: 'x', recurrence: { type: 'daily' } });
    assert.equal(c3.status, 400);

    // search invalid query
    const s1 = await request('GET', '/api/habits/search?query=');
    assert.equal(s1.status, 400);

    // get invalid id
    const g1 = await request('GET', '/api/habits/abc');
    assert.equal(g1.status, 400);

    // logs invalid date
    const createRes = await request('POST', '/api/habits', { title: 'h', startedOn: '2025-09-15', recurrence: { type: 'none' } });
    const id = createRes.body?.habit?.id;
    const badLog = await request('PUT', `/api/habits/${id}/logs/not-a-date`, { done: true });
    assert.equal(badLog.status, 400);
  });
});


