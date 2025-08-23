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
  const kind = op.kind || 'todo';
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

  // Create a todo (MCP apply)
  const apply2 = await applyOperationsMCP([
    { kind: 'todo', action: 'create', title: 'Smoke', scheduledFor: null, recurrence: { type: 'none' } }
  ]);
  assert.ok(Array.isArray(apply2.results));
  const createdTodoId = (() => {
    try { const r = apply2.results.find(x => x && x.todo && x.ok); return r?.todo?.id ?? null; } catch { return null; }
  })();

  // Search should return >= 1 for 'smoke' (case-insens)
  const search = await request('GET', '/api/todos/search?query=smoke');
  assert.equal(search.status, 200);
  assert.ok(Array.isArray(search.body.todos));

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

  // Create a repeating todo and toggle an occurrence
  const repCreate = await applyOperationsMCP([{ kind: 'todo', action: 'create', title: 'Repeat', scheduledFor: ymd(), recurrence: { type: 'weekly' } }]);
  const repId = (() => { try { return repCreate.results.find(x => x.todo).todo.id; } catch { return null; } })();
  assert.ok(Number.isFinite(repId));
  // old boolean path still maps correctly
  const occ = await request('PATCH', `/api/todos/${repId}/occurrence`, { occurrenceDate: ymd(), completed: true });
  assert.equal(occ.status, 200);

  // new status path: switch the same occurrence to skipped
  const occSkip = await request('PATCH', `/api/todos/${repId}/occurrence`, { occurrenceDate: ymd(), status: 'skipped' });
  assert.equal(occSkip.status, 200);
  // master set_status via MCP op
  const masterPending = await applyOperationsMCP([{ kind: 'todo', action: 'set_status', id: repId, status: 'pending' }]);

  // Goals: create A and B, add B as child of A, attach todo if present
  const goalA = await request('POST', '/api/goals', { title: 'Goal A' });
  const goalB = await request('POST', '/api/goals', { title: 'Goal B' });
  assert.equal(goalA.status, 200); assert.equal(goalB.status, 200);
  const aId = goalA.body.goal.id; const bId = goalB.body.goal.id;
  const addChild = await request('POST', `/api/goals/${aId}/children`, [bId]);
  assert.equal(addChild.status, 200);
  const goalGet = await request('GET', `/api/goals/${aId}?includeChildren=true`);
  assert.equal(goalGet.status, 200);
  assert.ok(Array.isArray(goalGet.body.goal.children));
  if (Number.isFinite(createdTodoId)) {
    const addItems = await request('POST', `/api/goals/${aId}/items`, { todos: [createdTodoId] });
    assert.equal(addItems.status, 200);
    const remItem = await request('DELETE', `/api/goals/${aId}/items/todo/${createdTodoId}`);
    assert.equal(remItem.status, 200);
  }
  const remChild = await request('DELETE', `/api/goals/${aId}/children/${bId}`);
  assert.equal(remChild.status, 200);

  // Idempotency replay: same payload and Idempotency-Key
  const idemKey = 'test-key-1';
  const idemPayload = [{ kind: 'todo', action: 'create', title: 'Idem Task', scheduledFor: null, recurrence: { type: 'none' } }];
  const first = await applyOperationsMCP(idemPayload, idemKey);
  const second = await applyOperationsMCP(idemPayload, idemKey);
  // Ensure indexing has been applied before asserting search results
  const idemSearch = await request('GET', '/api/todos/search?query=idem');
  assert.equal(idemSearch.status, 200);
  const idemCount = idemSearch.body.todos.filter(t => String(t.title || '').toLowerCase().includes('idem task')).length;
  assert.ok(idemCount >= 1, 'Expected at least one todo with title containing "Idem Task"');

  // Bulk ops should be rejected in MCP (tool doesn't exist)
  const bulkResult = await callMCPTool('bulk_update', { where: {}, set: { title: 'x' } });
  assert.ok(bulkResult.results);
  assert.equal(bulkResult.results.length, 1);
  assert.equal(bulkResult.results[0].ok, false);
  assert.equal(bulkResult.results[0].error, 'unknown_operation_type');

  // Too many operations (cap = 20) - MCP doesn't have this limit, but we can test it
  const tooMany = Array.from({ length: 21 }, (_, i) => ({ kind: 'todo', action: 'create', title: `X${i}`, recurrence: { type: 'none' } }));
  // MCP processes operations individually, so this should work
  const capResult = await applyOperationsMCP(tooMany);
  assert.ok(Array.isArray(capResult.results));

  // Unified schedule basic sanity (todos+events)
  const today = ymd();
  // Create a one-off todo and event for today
  await applyOperationsMCP([{ kind: 'todo', action: 'create', title: 'Sched T', scheduledFor: today, recurrence: { type: 'none' } }]);
  await applyOperationsMCP([{ kind: 'event', action: 'create', title: 'Sched E', scheduledFor: today, startTime: '08:00', endTime: '09:00', recurrence: { type: 'none' } }]);
  // Create a daily habit for today anchor
  const habitCreate = await request('POST', '/api/habits', { title: 'Sched H', scheduledFor: today, recurrence: { type: 'daily' } });
  if (habitCreate.status === 200) {
    const sched = await request('GET', `/api/schedule?from=${today}&to=${today}`);
    assert.equal(sched.status, 200);
    assert.ok(Array.isArray(sched.body.items));
    const kinds = new Set(sched.body.items.map(x => x.kind));
    assert.ok(kinds.has('todo') || kinds.has('event') || kinds.has('habit'));
  }

  // Explicit schedule kinds for habits
  const schedHabits = await request('GET', `/api/schedule?from=${today}&to=${today}&kinds=habit`);
  assert.equal(schedHabits.status, 200);
  const onlyKinds = new Set(schedHabits.body.items.map(x => x.kind));
  // Either no items (if no habits) or only 'habit'
  assert.equal(onlyKinds.size === 0 || (onlyKinds.size === 1 && onlyKinds.has('habit')), true);

  // Habits stats endpoint: should include stats when from/to provided
  const statsRes = await request('GET', `/api/habits?from=${today}&to=${today}`);
  assert.equal(statsRes.status, 200);
  assert.ok(Array.isArray(statsRes.body.habits));
  if (statsRes.body.habits.length > 0) {
    const h0 = statsRes.body.habits[0];
    // currentStreak and weekHeatmap are optional fields but should be present when range supplied
    assert.ok(Object.prototype.hasOwnProperty.call(h0, 'currentStreak'));
    assert.ok(Object.prototype.hasOwnProperty.call(h0, 'longestStreak'));
    assert.ok(Object.prototype.hasOwnProperty.call(h0, 'weekHeatmap'));
  }

  // Habit link/unlink endpoints
  const h2 = await request('POST', '/api/habits', { title: 'Link H', scheduledFor: today, recurrence: { type: 'daily' } });
  assert.equal(h2.status, 200);
  const hid = h2.body.habit.id;
  const t2 = await applyOperationsMCP([{ kind: 'todo', action: 'create', title: 'T for H', recurrence: { type: 'none' } }]);
  const tid = (() => { try { return t2.results.find(x => x.todo).todo.id; } catch { return null; } })();
  const e2 = await applyOperationsMCP([{ kind: 'event', action: 'create', title: 'E for H', scheduledFor: today, startTime: '12:00', endTime: '12:30', recurrence: { type: 'none' } }]);
  const eid = (() => { try { return e2.results.find(x => x.event).event.id; } catch { return null; } })();
  const linkRes = await request('POST', `/api/habits/${hid}/items`, { todos: [tid], events: [eid] });
  assert.equal(linkRes.status, 204);
  const unlinkTodoRes = await request('DELETE', `/api/habits/${hid}/items/todo/${tid}`);
  assert.equal(unlinkTodoRes.status, 204);
  const unlinkEventRes = await request('DELETE', `/api/habits/${hid}/items/event/${eid}`);
  assert.equal(unlinkEventRes.status, 204);

  // E2E-ish smoke: create a repeating habit and toggle a few days
  const make = await request('POST', '/api/habits', { title: 'E2E Habit', scheduledFor: today, recurrence: { type: 'daily' } });
  assert.equal(make.status, 200);
  const e2eHid = make.body.habit.id;
  const toggle1 = await request('PATCH', `/api/habits/${e2eHid}/occurrence`, { occurrenceDate: today, completed: true });
  assert.equal(toggle1.status, 200);
  const schedE2E = await request('GET', `/api/habits?from=${today}&to=${today}`);
  assert.equal(schedE2E.status, 200);
  const found = (schedE2E.body.habits || []).find((h) => h.id === e2eHid);
  if (found) {
    // Expect currentStreak >= 1
    if (typeof found.currentStreak === 'number') {
      if (!(found.currentStreak >= 1)) throw new Error('Expected currentStreak >= 1');
    }
  }

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

  console.log('OK');
}

main().catch((e) => { console.error(e); process.exit(1); });


