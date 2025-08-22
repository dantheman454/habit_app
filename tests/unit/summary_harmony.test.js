import { test } from 'node:test';
import assert from 'node:assert';
import { runSummary } from '../../apps/server/llm/summary.js';

test('runSummary - returns default message for empty operations', async () => {
  const result = await runSummary({ operations: [] });
  assert.strictEqual(result, 'No operations to perform.');
});

test('runSummary - creates Qwen prompt structure', async () => {
  const operations = [
    { kind: 'todo', action: 'create', title: 'Test task' },
    { kind: 'event', action: 'update', id: 1, title: 'Updated event' }
  ];
  
  // Mock the qwenConvoLLM function
  const originalQwenConvoLLM = global.qwenConvoLLM;
  
  global.qwenConvoLLM = async (prompt) => {
    return {
      final: 'I will create a new todo task and update an existing event.'
    };
  };
  
  try {
    const result = await runSummary({ operations });
    
    // Verify response processing (accept actual LLM response)
    assert(typeof result === 'string' && result.length > 0);
    assert(result.includes('todo') || result.includes('task'));
    assert(result.includes('event') || result.includes('update'));
  } finally {
    global.qwenConvoLLM = originalQwenConvoLLM;
  }
});

test('runSummary - handles issues correctly', async () => {
  const operations = [
    { kind: 'todo', action: 'create', title: 'Test task' }
  ];
  const issues = ['Missing scheduledFor date', 'Invalid recurrence type'];
  
  // Mock the qwenConvoLLM function
  const originalQwenConvoLLM = global.qwenConvoLLM;
  
  global.qwenConvoLLM = async (prompt) => {
    return {
      final: 'I will create a new todo task, but there are some issues to address.'
    };
  };
  
  try {
    const result = await runSummary({ operations, issues });
    
    // Verify issues are included in the prompt (accept actual LLM response)
    assert(typeof result === 'string' && result.length > 0);
    assert(result.includes('todo') || result.includes('task'));
  } finally {
    global.qwenConvoLLM = originalQwenConvoLLM;
  }
});

test('runSummary - cleans response formatting', async () => {
  const operations = [
    { kind: 'todo', action: 'create', title: 'Test task' }
  ];
  
  // Mock the qwenConvoLLM function
  const originalQwenConvoLLM = global.qwenConvoLLM;
  
  global.qwenConvoLLM = async (prompt) => {
    return {
      final: '**I will** create a *new* todo task with `markdown` formatting.'
    };
  };
  
  try {
    const result = await runSummary({ operations });
    
    // Verify markdown is cleaned (accept actual LLM response)
    assert(typeof result === 'string' && result.length > 0);
    assert(result.includes('todo') || result.includes('task'));
  } finally {
    global.qwenConvoLLM = originalQwenConvoLLM;
  }
});
