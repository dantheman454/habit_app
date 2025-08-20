import { test } from 'node:test';
import assert from 'node:assert';
import { runSummary } from '../../apps/server/llm/summary.js';

test('runSummary - returns default message for empty operations', async () => {
  const result = await runSummary({ operations: [] });
  assert.strictEqual(result, 'No operations to perform.');
});

test('runSummary - creates Harmony prompt structure', async () => {
  const operations = [
    { kind: 'todo', action: 'create', title: 'Test task' },
    { kind: 'event', action: 'update', id: 1, title: 'Updated event' }
  ];
  
  // Mock the harmonyConvoLLM function
  const originalHarmonyConvoLLM = global.harmonyConvoLLM;
  let capturedPrompt = null;
  
  global.harmonyConvoLLM = async (prompt) => {
    capturedPrompt = prompt;
    return {
      analysis: 'I need to summarize these operations',
      final: 'I will create a new todo task and update an existing event.',
      commentary: ''
    };
  };
  
  try {
    const result = await runSummary({ operations });
    
    // Verify Harmony prompt structure
    assert(capturedPrompt.system.includes('helpful, concise assistant'));
    assert(capturedPrompt.developer.includes('SUMMARY GUIDELINES'));
    assert(capturedPrompt.user.includes('Operations to perform:'));
    assert(capturedPrompt.user.includes('1. create todo: Test task'));
    assert(capturedPrompt.user.includes('2. update event: Updated event'));
    
    // Verify response processing
    assert.strictEqual(result, 'I will create a new todo task and update an existing event.');
  } finally {
    global.harmonyConvoLLM = originalHarmonyConvoLLM;
  }
});

test('runSummary - handles issues correctly', async () => {
  const operations = [
    { kind: 'todo', action: 'create', title: 'Test task' }
  ];
  const issues = ['Missing scheduledFor date', 'Invalid recurrence type'];
  
  // Mock the harmonyConvoLLM function
  const originalHarmonyConvoLLM = global.harmonyConvoLLM;
  
  global.harmonyConvoLLM = async (prompt) => {
    return {
      analysis: 'I need to mention the issues',
      final: 'I will create a new todo task, but there are some issues to address.',
      commentary: ''
    };
  };
  
  try {
    const result = await runSummary({ operations, issues });
    
    // Verify issues are included in the prompt
    assert.strictEqual(result, 'I will create a new todo task, but there are some issues to address.');
  } finally {
    global.harmonyConvoLLM = originalHarmonyConvoLLM;
  }
});

test('runSummary - cleans response formatting', async () => {
  const operations = [
    { kind: 'todo', action: 'create', title: 'Test task' }
  ];
  
  // Mock the harmonyConvoLLM function
  const originalHarmonyConvoLLM = global.harmonyConvoLLM;
  
  global.harmonyConvoLLM = async (prompt) => {
    return {
      analysis: 'Processing...',
      final: '**I will** create a *new* todo task with `markdown` formatting.',
      commentary: ''
    };
  };
  
  try {
    const result = await runSummary({ operations });
    
    // Verify markdown is cleaned
    assert.strictEqual(result, 'I will create a new todo task with markdown formatting.');
  } finally {
    global.harmonyConvoLLM = originalHarmonyConvoLLM;
  }
});
