import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';

// Ensure an isolated DB file for these node tests to avoid interference
process.env.APP_DB_PATH = path.resolve(process.cwd(), 'tests', 'data', 'app.db');
import { nodeBuildContext, nodeBuildTools, nodeProposeLLM, nodeValidateOps, nodeDedupe, nodeSummarize, nodeClarify } from '../../apps/server/llm/ops_graph.js';

test('nodeBuildContext: builds focused context with counts', () => {
  const { context } = nodeBuildContext({ where: {}, timezone: 'America/New_York' });
  assert.ok(context);
  assert.ok('tasks' in context);
  assert.ok('events' in context);
  assert.ok('meta' in context);
});

test('nodeProposeLLM: adapts agent ops to tool_calls and message', async () => {
  const { proposal } = await nodeProposeLLM({ instruction: 'noop', where: {}, transcript: [], timezone: 'America/New_York' });
  // Should always return a proposal object with tool_calls array and optional message
  assert.ok(proposal && typeof proposal === 'object');
  assert.ok(Array.isArray(proposal.tool_calls));
  assert.ok('message' in proposal);
});

test('nodeValidateOps/nodeDedupe/summarize/clarify: shells produce consistent shapes', async () => {
  // Build a minimal proposal with an invalid and a valid-ish op shape
  const proposal = {
    tool_calls: [
      { function: { name: 'task.update', arguments: { id: 0, title: 'X' } } }, // invalid id
      { function: { name: 'task.create', arguments: { title: 'Y', scheduledFor: '2025-09-12' } } } // likely valid
    ]
  };
  // Use a very thin fake processor that flags id>0 as valid for update
  const fakeProcessor = {
    inferOperationType(op) { return `${op.kind}_${op.action}`; },
    validators: new Map([
      ['task_update', async (op) => ({ valid: (op.id && op.id > 0) || false, errors: (!op.id || op.id <= 0) ? ['Valid ID is required'] : [] })],
      ['task_create', async (_op) => ({ valid: true, errors: [] })]
    ])
  };
  const { validation } = await nodeValidateOps({ proposal, operationProcessor: fakeProcessor });
  const { deduped } = nodeDedupe({ validation });
  const { summary } = nodeSummarize({ deduped, validation, proposal: { message: 'fallback' } });
  const { clarify } = nodeClarify({ validation });
  // Shapes
  assert.ok(Array.isArray(validation.validOps));
  assert.ok(Array.isArray(validation.invalid));
  assert.ok(Array.isArray(deduped));
  assert.equal(typeof summary, 'string');
  assert.equal(typeof clarify.needed, 'boolean');
});

test('nodeBuildTools: builds tool list with expected names', async () => {
  const { tools } = await nodeBuildTools();
  const names = Array.isArray(tools) ? tools.map(t => t.function?.name) : [];
  for (const expected of [
    'task.create','task.update','task.delete','task.set_status',
    'event.create','event.update','event.delete']
  ) {
    assert.ok(names.includes(expected));
  }
});


