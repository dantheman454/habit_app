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

describe('routes: /api/schedule', () => {
  before(async () => {
    // Isolate DB
    const testDataDir = path.join(process.cwd(), 'data', 'test');
    try { fs.mkdirSync(testDataDir, { recursive: true }); } catch {}
    const testDbPath = path.join(testDataDir, 'app.db');
    process.env.APP_DB_PATH = testDbPath;
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

  test('happy path: returns 200 with items array', async () => {
    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, '0');
    const d = String(today.getDate()).padStart(2, '0');
    const ymd = `${y}-${m}-${d}`;
    const res = await request('GET', `/api/schedule?from=${ymd}&to=${ymd}`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.items));
  });

  test('invalid from returns 400', async () => {
    const res = await request('GET', '/api/schedule?from=2025/01/01&to=2025-01-01');
    assert.equal(res.status, 400);
  });

  test('invalid to returns 400', async () => {
    const res = await request('GET', '/api/schedule?from=2025-01-01&to=2025/01/01');
    assert.equal(res.status, 400);
  });

  test('invalid completed flag returns 400', async () => {
    const res = await request('GET', '/api/schedule?from=2025-01-01&to=2025-01-01&completed=maybe');
    assert.equal(res.status, 400);
  });

  test('invalid status_task returns 400', async () => {
    const res = await request('GET', '/api/schedule?from=2025-01-01&to=2025-01-01&status_task=done');
    assert.equal(res.status, 400);
  });

  test('invalid context returns 400', async () => {
    const res = await request('GET', '/api/schedule?from=2025-01-01&to=2025-01-01&context=home');
    assert.equal(res.status, 400);
  });
});


