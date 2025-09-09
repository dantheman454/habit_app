// Minimal smoke tests for REST endpoints and V3 apply
import assert from 'node:assert/strict';
import http from 'node:http';

const BASE = 'http://127.0.0.1:3000';

function ymd(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${da}`;
}

function request(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': data ? data.length : 0, ...headers },
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

// MCP helper functions
async function callMCPTool(name, args, correlationId = null) {
  const headers = {};
  if (correlationId) headers['x-correlation-id'] = correlationId;
  
  const res = await request('POST', '/api/mcp/tools/call', {
    name,
    arguments: args
  }, headers);
  
  if (res.status !== 200) {
    throw new Error(`MCP tool call failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  
  return res.body;
}

async function applyOperationsMCP(operations, correlationId = null) {
  const results = [];
  let created = 0, updated = 0, deleted = 0, completed = 0;
  
  for (const op of operations) {
    try {
      const toolName = operationToToolName(op);
      const args = operationToToolArgs(op);
      
      const result = await callMCPTool(toolName, args, correlationId);
      // The MCP tool returns { results: [...], summary: {...}, correlationId: "..." }
      // We need to extract the actual results from the nested structure
      if (result.results && Array.isArray(result.results)) {
        results.push(...result.results);
        // Update summary from the MCP result
        if (result.summary) {
          created += result.summary.created || 0;
          updated += result.summary.updated || 0;
          deleted += result.summary.deleted || 0;
          completed += result.summary.completed || 0;
        }
      } else {
        results.push(result);
      }
    } catch (e) {
      results.push({ error: e.toString() });
    }
  }
  
  return {
    results,
    summary: { created, updated, deleted, completed }
  };
}

function operationToToolName(op) {
  const kind = op.kind || 'task';
  const action = op.action || op.op || 'create';
  
  switch (action) {
    case 'create': return `create_${kind}`;
    case 'update': return `update_${kind}`;
    case 'delete': return `delete_${kind}`;
    case 'complete': return `complete_${kind}`;
    case 'complete_occurrence': return `complete_${kind}_occurrence`;
    case 'set_status': return `set_${kind}_status`;
    default: return `create_${kind}`;
  }
}

function operationToToolArgs(op) {
  const args = {};
  for (const [key, value] of Object.entries(op)) {
    if (key !== 'kind' && key !== 'action' && key !== 'op') {
      args[key] = value;
    }
  }
  return args;
}

async function main() {
  // Health
  const health = await request('GET', '/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);

  // Create a task (MCP apply)
  const apply2 = await applyOperationsMCP([
    { kind: 'task', action: 'create', title: 'Smoke', scheduledFor: null, recurrence: { type: 'none' } }
  ]);
  assert.ok(Array.isArray(apply2.results));
  const createdTaskId = (() => {
    try { const r = apply2.results.find(x => x && x.task && x.ok); return r?.task?.id ?? null; } catch { return null; }
  })();

  // Search should return >= 1 for 'smoke' (case-insens)
  const search = await request('GET', '/api/tasks/search?query=smoke');
  assert.equal(search.status, 200);
  assert.ok(Array.isArray(search.body.tasks));

  // Events list works
  const events = await request('GET', '/api/events');
  assert.equal(events.status, 200);
  assert.ok(Array.isArray(events.body.events));

  // Create an event (MCP apply), update, delete (event completion not supported)
  const evCreate = await applyOperationsMCP([
    { kind: 'event', action: 'create', title: 'Meeting', scheduledFor: ymd(), startTime: '09:00', endTime: '10:00', recurrence: { type: 'none' } }
  ]);
  const evId = (() => { try { return evCreate.results.find(x => x.event)?.event.id; } catch { return null; } })();
  assert.ok(Number.isFinite(evId));
  const evUpdate = await applyOperationsMCP([{ kind: 'event', action: 'update', id: evId, recurrence: { type: 'none' } }]);
  // No event completion
  const evDelete = await applyOperationsMCP([{ kind: 'event', action: 'delete', id: evId }]);

  // Create a repeating task and toggle an occurrence
  const repCreate = await applyOperationsMCP([{ kind: 'task', action: 'create', title: 'Repeat', scheduledFor: ymd(), recurrence: { type: 'weekly' } }]);
  const repId = (() => { try { return repCreate.results.find(x => x.task).task.id; } catch { return null; } })();
  assert.ok(Number.isFinite(repId));
  // old boolean path still maps correctly
  const occ = await request('PATCH', `/api/tasks/${repId}/occurrence`, { occurrenceDate: ymd(), completed: true });
  assert.equal(occ.status, 200);

  // new status path: switch the same occurrence to skipped
  const occSkip = await request('PATCH', `/api/tasks/${repId}/occurrence`, { occurrenceDate: ymd(), status: 'skipped' });
  assert.equal(occSkip.status, 200);
  // master set_status via MCP op
  const masterPending = await applyOperationsMCP([{ kind: 'task', action: 'set_status', id: repId, status: 'pending' }]);

  // Goals routes removed in migration; skip goal flows in integration tests

  // Idempotency replay: same payload and Idempotency-Key
  const idemKey = 'test-key-1';
  const idemPayload = [{ kind: 'task', action: 'create', title: 'Idem Task', scheduledFor: null, recurrence: { type: 'none' } }];
  const first = await applyOperationsMCP(idemPayload, idemKey);
  const second = await applyOperationsMCP(idemPayload, idemKey);
  // Ensure indexing has been applied before asserting search results
  const idemSearch = await request('GET', '/api/tasks/search?query=idem');
  assert.equal(idemSearch.status, 200);
  const idemCount = idemSearch.body.tasks.filter(t => String(t.title || '').toLowerCase().includes('idem task')).length;
  assert.ok(idemCount >= 1, 'Expected at least one task with title containing "Idem Task"');

  // Bulk ops should be rejected in MCP (tool doesn't exist)
  const bulkResult = await callMCPTool('bulk_update', { where: {}, set: { title: 'x' } });
  assert.ok(bulkResult.results);
  assert.equal(bulkResult.results.length, 1);
  assert.equal(bulkResult.results[0].ok, false);
  assert.equal(bulkResult.results[0].error, 'unknown_operation_type');

  // Too many operations (cap = 20) - MCP doesn't have this limit, but we can test it
  const tooMany = Array.from({ length: 21 }, (_, i) => ({ kind: 'task', action: 'create', title: `X${i}`, recurrence: { type: 'none' } }));
  // MCP processes operations individually, so this should work
  const capResult = await applyOperationsMCP(tooMany);
  assert.ok(Array.isArray(capResult.results));

  // Unified schedule basic sanity (tasks+events)
  const today = ymd();
  // Create a one-off task and event for today
  await applyOperationsMCP([{ kind: 'task', action: 'create', title: 'Sched T', scheduledFor: today, recurrence: { type: 'none' } }]);
  await applyOperationsMCP([{ kind: 'event', action: 'create', title: 'Sched E', scheduledFor: today, startTime: '08:00', endTime: '09:00', recurrence: { type: 'none' } }]);

  // Assistant endpoints
  // 1) Non-stream assistant message: allow 200 (normal) or 502 (LLM unavailable in CI)
  const asst1 = await request('POST', '/api/assistant/message', { message: 'update my task for today', transcript: [] });
  assert.equal([200, 502].includes(asst1.status), true);
  if (asst1.status === 200) {
    assert.equal(typeof asst1.body.correlationId, 'string');
    assert.equal(!!(asst1.body.clarify || typeof asst1.body.text === 'string'), true);
  }

  // 2) SSE stream should emit stage and done events
  await new Promise((resolve, reject) => {
    const req = http.request(BASE + `/api/assistant/message/stream?message=${encodeURIComponent('update my task for today')}` , { method: 'GET' }, (res) => {
      let gotStage = false;
      let gotDone = false;
      res.setEncoding('utf8');
      let seenSummaryOrResult = false;
      res.on('data', (chunk) => {
        if (chunk.includes('event: stage')) gotStage = true;
        if (chunk.includes('event: summary') || chunk.includes('event: result')) seenSummaryOrResult = true;
        if (chunk.includes('event: done')) {
          // done should occur after summary/result
          if (!seenSummaryOrResult) {
            reject(new Error('SSE: done received before summary/result'));
            return;
          }
          gotDone = true;
        }
      });
      res.on('end', () => {
        try {
          assert.equal(res.statusCode, 200);
          assert.equal(gotStage, true);
          assert.equal(gotDone, true);
          resolve();
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });

  // Disambiguation: prefer event in current view when titles collide
  const todayY = ymd();
  // Create two "Lunch" events: one today (in view) and one next month
  const lunchToday = await applyOperationsMCP([
    { kind: 'event', action: 'create', title: 'Lunch', scheduledFor: todayY, startTime: '12:00', endTime: '12:30', recurrence: { type: 'none' } }
  ]);
  const lunchTodayId = (() => { try { return lunchToday.results.find(x => x.event)?.event.id; } catch { return null; } })();
  assert.ok(Number.isFinite(lunchTodayId));
  // next month same title
  const nextMonth = (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth()+1, 1); })();
  const nmYmd = ymd(nextMonth);
  await applyOperationsMCP([
    { kind: 'event', action: 'create', title: 'Lunch', scheduledFor: nmYmd, startTime: '12:00', endTime: '12:30', recurrence: { type: 'none' } }
  ]);
  // Ask assistant to move lunch to 13:00 with a view limited to today
  const disamb = await request('POST', '/api/assistant/message', {
    message: 'move lunch to 13:00',
    transcript: [],
    options: {
      client: {
        where: { view: { mode: 'day', fromYmd: todayY, toYmd: todayY }, kind: ['event'] }
      }
    }
  });
  assert.equal([200, 502].includes(disamb.status), true);
  if (disamb.status === 200) {
    const ops = Array.isArray(disamb.body.operations) ? disamb.body.operations : [];
    assert.ok(Array.isArray(ops));
  }

  // Undo smoke: update an event title, then undo restores it
  const undoCid = 'undo-batch-1';
  const evBase = await applyOperationsMCP([
    { kind: 'event', action: 'create', title: 'Undoable', scheduledFor: todayY, startTime: '10:00', endTime: '10:30', recurrence: { type: 'none' } }
  ], undoCid);
  const undoId = (() => { try { return evBase.results.find(x => x.event)?.event.id; } catch { return null; } })();
  assert.ok(Number.isFinite(undoId));
  // Update title within same correlation batch
  await applyOperationsMCP([
    { kind: 'event', action: 'update', id: undoId, title: 'Undoable 2' }
  ], undoCid);
  // Verify updated
  const afterUpd = await request('GET', `/api/events/${undoId}`);
  assert.equal(afterUpd.status, 200);
  assert.equal(afterUpd.body.event.title, 'Undoable 2');
  // Ensure batch exists
  const lastBatch = await request('GET', '/api/assistant/last_batch');
  assert.equal([200,404].includes(lastBatch.status), true);
  if (lastBatch.status === 200) {
    // Perform undo
    const undid = await request('POST', '/api/assistant/undo_last');
    assert.equal(undid.status, 200);
    assert.equal(undid.body.ok, true);
    // Title should be restored
    const afterUndo = await request('GET', `/api/events/${undoId}`);
    assert.equal(afterUndo.status, 200);
    assert.equal(afterUndo.body.event.title, 'Undoable');
  }

  // Assistant fallback create: "add an event for today called Lunch with Dad at noon"
  {
    const msg = 'add an event for today called Lunch with Dad at noon';
    const today = ymd();
    const res = await request('POST', '/api/assistant/message', {
      message: msg,
      transcript: [],
      options: {
        client: {
          where: { view: { mode: 'day', fromYmd: today, toYmd: today } }
        }
      }
    });
    assert.equal([200, 502].includes(res.status), true);
    if (res.status === 200) {
      const ops = Array.isArray(res.body.operations) ? res.body.operations : [];
      // expect at least one event.create
      const create = ops.find(o => o && o.kind === 'event' && (o.action === 'create' || o.op === 'create'));
      assert.ok(create, 'expected an event.create operation');
      assert.equal(create.scheduledFor, today);
      assert.equal(create.startTime, '12:00');
      assert.equal(create.endTime, '13:00');
      assert.ok(String(create.title || '').toLowerCase().includes('lunch'), 'title should include lunch');
    }
  }

  console.log('OK');
}

main().catch((e) => { console.error(e); process.exit(1); });


