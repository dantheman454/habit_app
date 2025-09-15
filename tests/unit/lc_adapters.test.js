import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildOperationTools, parseToolResponseStrict } from '../../apps/server/llm/lc_adapters.js';

const fakeRegistry = {
  getOperationSchema(type) {
    return { type: 'object', properties: { id: { type: 'number' } } };
  }
};

test('buildOperationTools: returns expected tool names and schemas', () => {
  const tools = buildOperationTools(fakeRegistry);
  const names = tools.map(t => t.function.name);
  assert.deepEqual(names, [
    'task.create','task.update','task.delete','task.set_status',
    'event.create','event.update','event.delete'
  ]);
  for (const t of tools) {
    assert.equal(t.type, 'function');
    assert.ok(t.function.parameters && t.function.parameters.type === 'object');
  }
});

test('parseToolResponseStrict: parses valid tool_calls with object args', () => {
  const input = {
    tool_calls: [
      { function: { name: 'task.update', arguments: { id: 1, title: 'X' } } }
    ],
    message: 'ok'
  };
  const out = parseToolResponseStrict(input);
  assert.equal(out.message, 'ok');
  assert.equal(out.tool_calls.length, 1);
  assert.equal(out.tool_calls[0].function.name, 'task.update');
  assert.deepEqual(out.tool_calls[0].function.arguments, { id: 1, title: 'X' });
});

test('parseToolResponseStrict: parses stringified arguments', () => {
  const input = {
    tool_calls: [
      { function: { name: 'event.create', arguments: '{"title":"Meet","scheduledFor":"2025-09-12","startTime":"10:00","endTime":"11:00"}' } }
    ]
  };
  const out = parseToolResponseStrict(input);
  assert.equal(out.tool_calls.length, 1);
  assert.equal(out.tool_calls[0].function.name, 'event.create');
  assert.equal(out.tool_calls[0].function.arguments.title, 'Meet');
});

test('parseToolResponseStrict: tolerant on parse error', () => {
  const out = parseToolResponseStrict('not-json');
  assert.equal(out.tool_calls.length, 0);
  assert.ok(out.errors.includes('parse_error'));
});

test('parseToolResponseStrict: missing fields yield errors but remain tolerant', () => {
  const input = { tool_calls: [ { function: { arguments: {} } }, { function: { name: 'task.update' } } ] };
  const out = parseToolResponseStrict(input);
  assert.equal(out.tool_calls.length, 0);
  assert.ok(out.errors.includes('invalid_tool_call'));
});


