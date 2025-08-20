import { test } from 'node:test';
import assert from 'node:assert';
import { runRepair } from '../../apps/server/llm/repair.js';

test('runRepair - returns original operations when no errors', async () => {
  const original = [
    { kind: 'todo', action: 'create', title: 'Test task', recurrence: { type: 'none' } }
  ];
  
  const result = await runRepair({ errors: [], original, focusedContext: {} });
  
  assert.deepStrictEqual(result.operations, original);
});

test('runRepair - creates Harmony prompt structure', async () => {
  const original = [
    { kind: 'todo', action: 'update', id: 1, title: 'Test task' }
  ];
  const errors = [
    { op: { kind: 'todo', action: 'update', id: 1 }, errors: ['missing_recurrence'] }
  ];
  const focusedContext = {
    todos: [{ id: 1, title: 'Test task' }]
  };
  
  // Mock the harmonyCodeLLM function
  const originalHarmonyCodeLLM = global.harmonyCodeLLM;
  let capturedPrompt = null;
  
  global.harmonyCodeLLM = async (prompt) => {
    capturedPrompt = prompt;
    return {
      analysis: 'I need to add the missing recurrence field',
      final: '{"operations": [{"kind":"todo","action":"update","id":1,"title":"Test task","recurrence":{"type":"none"}}]}',
      commentary: ''
    };
  };
  
  try {
    const result = await runRepair({ errors, original, focusedContext });
    
    // Verify Harmony prompt structure
    assert(capturedPrompt.system.includes('repair agent'));
    assert(capturedPrompt.developer.includes('Common fixes:'));
    assert(capturedPrompt.developer.includes('missing_recurrence'));
    assert(capturedPrompt.user.includes('Errors to fix:'));
    assert(capturedPrompt.user.includes('Original operations:'));
    assert(capturedPrompt.user.includes('Focused context:'));
    
    // Verify response processing
    assert.deepStrictEqual(result.operations, [
      { kind: 'todo', action: 'update', id: 1, title: 'Test task', recurrence: { type: 'none' } }
    ]);
  } finally {
    global.harmonyCodeLLM = originalHarmonyCodeLLM;
  }
});

test('runRepair - handles missing timeOfDay error', async () => {
  const original = [
    { kind: 'todo', action: 'update', id: 1, timeOfDay: '21:00' }
  ];
  const errors = [
    { op: { kind: 'todo', action: 'update', id: 1 }, errors: ['missing_recurrence'] }
  ];
  const focusedContext = {
    todos: [{ id: 1, title: 'Test task' }]
  };
  
  // Mock the harmonyCodeLLM function
  const originalHarmonyCodeLLM = global.harmonyCodeLLM;
  
  global.harmonyCodeLLM = async (prompt) => {
    return {
      analysis: 'I need to add recurrence field for the update operation',
      final: '{"operations": [{"kind":"todo","action":"update","id":1,"timeOfDay":"21:00","recurrence":{"type":"none"}}]}',
      commentary: ''
    };
  };
  
  try {
    const result = await runRepair({ errors, original, focusedContext });
    
    // Verify the repair worked
    assert.deepStrictEqual(result.operations, [
      { kind: 'todo', action: 'update', id: 1, timeOfDay: '21:00', recurrence: { type: 'none' } }
    ]);
  } finally {
    global.harmonyCodeLLM = originalHarmonyCodeLLM;
  }
});

test('runRepair - handles multiple errors', async () => {
  const original = [
    { kind: 'todo', action: 'create', title: 'Test task' },
    { kind: 'todo', action: 'update', id: 1, title: 'Updated task' }
  ];
  const errors = [
    { op: { kind: 'todo', action: 'create', title: 'Test task' }, errors: ['missing_recurrence'] },
    { op: { kind: 'todo', action: 'update', id: 1, title: 'Updated task' }, errors: ['missing_recurrence'] }
  ];
  const focusedContext = {
    todos: [{ id: 1, title: 'Test task' }]
  };
  
  // Mock the harmonyCodeLLM function
  const originalHarmonyCodeLLM = global.harmonyCodeLLM;
  
  global.harmonyCodeLLM = async (prompt) => {
    return {
      analysis: 'I need to add recurrence fields to both operations',
      final: '{"operations": [{"kind":"todo","action":"create","title":"Test task","recurrence":{"type":"none"}},{"kind":"todo","action":"update","id":1,"title":"Updated task","recurrence":{"type":"none"}}]}',
      commentary: ''
    };
  };
  
  try {
    const result = await runRepair({ errors, original, focusedContext });
    
    // Verify both operations were repaired
    assert.strictEqual(result.operations.length, 2);
    assert.deepStrictEqual(result.operations[0].recurrence, { type: 'none' });
    assert.deepStrictEqual(result.operations[1].recurrence, { type: 'none' });
  } finally {
    global.harmonyCodeLLM = originalHarmonyCodeLLM;
  }
});

test('runRepair - fallback on error', async () => {
  const original = [
    { kind: 'todo', action: 'create', title: 'Test task' }
  ];
  const errors = [
    { op: { kind: 'todo', action: 'create', title: 'Test task' }, errors: ['missing_recurrence'] }
  ];
  const focusedContext = {};
  
  // Mock the harmonyCodeLLM function to throw an error
  const originalHarmonyCodeLLM = global.harmonyCodeLLM;
  
  global.harmonyCodeLLM = async () => {
    throw new Error('LLM error');
  };
  
  try {
    const result = await runRepair({ errors, original, focusedContext });
    
    // Verify fallback to original operations
    assert.deepStrictEqual(result.operations, original);
  } finally {
    global.harmonyCodeLLM = originalHarmonyCodeLLM;
  }
});
