import { test } from 'node:test';
import assert from 'node:assert';
import { runRouter } from '../../apps/server/llm/router.js';

test('runRouter - returns clarify for empty input', async () => {
  const result = await runRouter({ instruction: '' });
  
  assert.strictEqual(result.decision, 'clarify');
  assert.strictEqual(result.confidence, 0);
  assert.strictEqual(result.question, 'What would you like to do?');
});

test('runRouter - creates Harmony prompt structure', async () => {
  const instruction = 'Create a new task called "Test task"';
  
  // Mock the harmonyConvoLLM function
  const originalHarmonyConvoLLM = global.harmonyConvoLLM;
  let capturedPrompt = null;
  
  global.harmonyConvoLLM = async (prompt) => {
    capturedPrompt = prompt;
    return {
      analysis: 'I need to analyze the user intent for creating a task',
      final: '{"decision":"plan","confidence":0.8,"where":{"title_contains":"Test task"}}',
      commentary: ''
    };
  };
  
  try {
    const result = await runRouter({ instruction });
    
    // Verify Harmony prompt structure
    assert(capturedPrompt.system.includes('intelligent intent router'));
    assert(capturedPrompt.developer.includes('OUTPUT FORMAT:'));
    assert(capturedPrompt.developer.includes('DECISION RULES:'));
    assert(capturedPrompt.developer.includes('CONFIDENCE SCORING:'));
    assert(capturedPrompt.user.includes('Today:'));
    assert(capturedPrompt.user.includes('Current Context:'));
    assert(capturedPrompt.user.includes('User Input:'));
    assert(capturedPrompt.user.includes('Create a new task called "Test task"'));
    
    // Verify response processing
    assert.strictEqual(result.decision, 'plan');
    assert.strictEqual(result.confidence, 0.8);
    assert.deepStrictEqual(result.where, { title_contains: 'Test task' });
  } finally {
    global.harmonyConvoLLM = originalHarmonyConvoLLM;
  }
});

test('runRouter - handles clarify decision', async () => {
  const instruction = 'Update the task';
  
  // Mock the harmonyConvoLLM function
  const originalHarmonyConvoLLM = global.harmonyConvoLLM;
  
  global.harmonyConvoLLM = async (prompt) => {
    return {
      analysis: 'The user wants to update a task but which one is ambiguous',
      final: '{"decision":"clarify","confidence":0.3,"question":"Which task would you like to update?"}',
      commentary: ''
    };
  };
  
  try {
    const result = await runRouter({ instruction });
    
    // Verify clarify decision
    assert.strictEqual(result.decision, 'clarify');
    assert.strictEqual(result.confidence, 0.3);
    assert.strictEqual(result.question, 'Which task would you like to update?');
  } finally {
    global.harmonyConvoLLM = originalHarmonyConvoLLM;
  }
});

test('runRouter - handles chat decision', async () => {
  const instruction = 'How many tasks do I have?';
  
  // Mock the harmonyConvoLLM function
  const originalHarmonyConvoLLM = global.harmonyConvoLLM;
  
  global.harmonyConvoLLM = async (prompt) => {
    return {
      analysis: 'This is a status inquiry, not an actionable request',
      final: '{"decision":"chat","confidence":0.9}',
      commentary: ''
    };
  };
  
  try {
    const result = await runRouter({ instruction });
    
    // Verify chat decision
    assert.strictEqual(result.decision, 'chat');
    assert.strictEqual(result.confidence, 0.9);
  } finally {
    global.harmonyConvoLLM = originalHarmonyConvoLLM;
  }
});

test('runRouter - handles low confidence threshold', async () => {
  const instruction = 'Do something';
  
  // Mock the harmonyConvoLLM function
  const originalHarmonyConvoLLM = global.harmonyConvoLLM;
  
  global.harmonyConvoLLM = async (prompt) => {
    return {
      analysis: 'This is very ambiguous',
      final: '{"decision":"plan","confidence":0.2}',
      commentary: ''
    };
  };
  
  try {
    const result = await runRouter({ instruction });
    
    // Verify low confidence forces clarify
    assert.strictEqual(result.decision, 'clarify');
    assert.strictEqual(result.confidence, 0.2);
  } finally {
    global.harmonyConvoLLM = originalHarmonyConvoLLM;
  }
});

test('runRouter - handles clarify selection', async () => {
  const instruction = 'Update task #123';
  const clarify = { selection: { ids: [123] } };
  
  // Mock the harmonyConvoLLM function
  const originalHarmonyConvoLLM = global.harmonyConvoLLM;
  
  global.harmonyConvoLLM = async (prompt) => {
    return {
      analysis: 'User has selected a specific task',
      final: '{"decision":"plan","confidence":0.8,"where":{"ids":[123]}}',
      commentary: ''
    };
  };
  
  try {
    const result = await runRouter({ instruction, clarify });
    
    // Verify clarify selection forces plan
    assert.strictEqual(result.decision, 'plan');
    assert.deepStrictEqual(result.where, { ids: [123] });
  } finally {
    global.harmonyConvoLLM = originalHarmonyConvoLLM;
  }
});
