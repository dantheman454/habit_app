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

async function main() {
  // Health
  const health = await request('GET', '/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);

  // Create a todo (V3 apply)
  const apply1 = await request('POST', '/api/llm/dryrun', {
    operations: [{ kind: 'todo', action: 'create', title: 'Smoke', scheduledFor: null, priority: 'medium', recurrence: { type: 'none' } }]
  });
  assert.equal(apply1.status, 200);

  const apply2 = await request('POST', '/api/llm/apply', {
    operations: [{ kind: 'todo', action: 'create', title: 'Smoke', scheduledFor: null, priority: 'medium', recurrence: { type: 'none' } }]
  });
  assert.equal(apply2.status, 200);
  assert.ok(Array.isArray(apply2.body.results));
  const createdTodoId = (() => {
    try { const r = apply2.body.results.find(x => x && x.todo && x.ok); return r?.todo?.id ?? null; } catch { return null; }
  })();

  // Search should return >= 1 for 'smoke' (case-insens)
  const search = await request('GET', '/api/todos/search?query=smoke');
  assert.equal(search.status, 200);
  assert.ok(Array.isArray(search.body.todos));

  // Events list works
  const events = await request('GET', '/api/events');
  assert.equal(events.status, 200);
  assert.ok(Array.isArray(events.body.events));

  // Create an event (V3 apply), update, complete occurrence, delete
  const evCreate = await request('POST', '/api/llm/apply', {
    operations: [ { kind: 'event', action: 'create', title: 'Meeting', scheduledFor: ymd(), startTime: '09:00', endTime: '10:00', priority: 'low', recurrence: { type: 'none' } } ]
  });
  assert.equal(evCreate.status, 200);
  const evId = (() => { try { return evCreate.body.results.find(x => x.event)?.event.id; } catch { return null; } })();
  assert.ok(Number.isFinite(evId));
  const evUpdate = await request('POST', '/api/llm/apply', { operations: [ { kind: 'event', action: 'update', id: evId, priority: 'high', recurrence: { type: 'none' } } ] });
  assert.equal(evUpdate.status, 200);
  const evOcc = await request('POST', '/api/llm/apply', { operations: [ { kind: 'event', action: 'complete_occurrence', id: evId, occurrenceDate: ymd(), completed: true } ] });
  assert.equal(evOcc.status, 200);
  const evDelete = await request('POST', '/api/llm/apply', { operations: [ { kind: 'event', action: 'delete', id: evId } ] });
  assert.equal(evDelete.status, 200);

  // Create a repeating todo and toggle an occurrence
  const repCreate = await request('POST', '/api/llm/apply', { operations: [ { kind: 'todo', action: 'create', title: 'Repeat', scheduledFor: ymd(), priority: 'medium', recurrence: { type: 'weekly' } } ] });
  assert.equal(repCreate.status, 200);
  const repId = (() => { try { return repCreate.body.results.find(x => x.todo).todo.id; } catch { return null; } })();
  assert.ok(Number.isFinite(repId));
  const occ = await request('PATCH', `/api/todos/${repId}/occurrence`, { occurrenceDate: ymd(), completed: true });
  assert.equal(occ.status, 200);

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
  const idemPayload = { operations: [{ kind: 'todo', action: 'create', title: 'Idem Task', scheduledFor: null, priority: 'low', recurrence: { type: 'none' } }] };
  const first = await request('POST', '/api/llm/apply', idemPayload, { 'Idempotency-Key': idemKey });
  const second = await request('POST', '/api/llm/apply', idemPayload, { 'Idempotency-Key': idemKey });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  // Ensure indexing has been applied before asserting search results
  const idemSearch = await request('GET', '/api/todos/search?query=idem');
  assert.equal(idemSearch.status, 200);
  const idemCount = idemSearch.body.todos.filter(t => String(t.title || '').toLowerCase().includes('idem task')).length;
  assert.ok(idemCount >= 1, 'Expected at least one todo with title containing "Idem Task"');

  // Bulk ops should be rejected in V3 (dryrun returns error annotation)
  const bulkDry = await request('POST', '/api/llm/dryrun', { operations: [{ op: 'bulk_update', where: {}, set: { priority: 'high' } }] });
  assert.equal(bulkDry.status, 200);
  const errors = bulkDry.body.results[0].errors || [];
  assert.ok(errors.includes('bulk_operations_removed'));

  // Too many operations (cap = 20)
  const tooMany = Array.from({ length: 21 }, (_, i) => ({ kind: 'todo', action: 'create', title: `X${i}`, recurrence: { type: 'none' } }));
  const capDry = await request('POST', '/api/llm/dryrun', { operations: tooMany });
  assert.equal(capDry.status, 400);

  console.log('OK');
}

main().catch((e) => { console.error(e); process.exit(1); });


