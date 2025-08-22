import { test } from 'node:test';
import assert from 'node:assert/strict';

// Import the router function
import { runRouter } from '../../apps/server/llm/router.js';

test('runRouter - empty input yields chat, confidence >= 0 and <= 1', async () => {
  const result = await runRouter({ instruction: '' });
  assert.equal(result.decision, 'chat');
  assert.equal(typeof result.confidence, 'number');
  assert(result.confidence >= 0 && result.confidence <= 1);
});

test('runRouter - actionable instruction may yield act', async () => {
  // Stub the LLM to return an act decision
  const mockLLM = async () => {
    return {
      final: JSON.stringify({
        decision: 'act',
        confidence: 0.8,
        where: { title_contains: 'test' }
      })
    };
  };

  const result = await runRouter({ 
    instruction: 'Create a task called "Test"',
    llmClient: mockLLM
  });
  assert(['chat','act'].includes(result.decision));
  assert.equal(typeof result.confidence, 'number');
  assert(result.confidence >= 0 && result.confidence <= 1);
});

test('runRouter - chat instruction yields chat', async () => {
  // Stub the LLM to return a chat decision
  const mockLLM = async () => {
    return {
      final: JSON.stringify({
        decision: 'chat',
        confidence: 0.3
      })
    };
  };

  const result = await runRouter({ 
    instruction: 'What is the weather today?',
    llmClient: mockLLM
  });
  assert.equal(result.decision, 'chat');
  assert.equal(typeof result.confidence, 'number');
  assert(result.confidence >= 0 && result.confidence <= 1);
});

test('runRouter - low confidence thresholds to chat', async () => {
  // Stub the LLM to return low confidence act
  const mockLLM = async () => {
    return {
      final: JSON.stringify({
        decision: 'act',
        confidence: 0.3  // Below 0.5 threshold
      })
    };
  };

  const result = await runRouter({ 
    instruction: 'Maybe create a task',
    llmClient: mockLLM
  });
  assert.equal(result.decision, 'chat'); // Should threshold to chat
  assert.equal(typeof result.confidence, 'number');
});

test('runRouter - string where field gets converted to title_contains', async () => {
  // Stub the LLM to return act with string where
  const mockLLM = async () => {
    return {
      final: JSON.stringify({
        decision: 'act',
        confidence: 0.8,
        where: 'important task'
      })
    };
  };

  const result = await runRouter({ 
    instruction: 'Update the important task',
    llmClient: mockLLM
  });
  assert.equal(result.decision, 'act');
  assert.deepEqual(result.where, { title_contains: 'important task' });
});

test('runRouter - handles malformed LLM response gracefully', async () => {
  // Stub the LLM to return invalid JSON
  const mockLLM = async () => {
    return {
      final: 'This is not valid JSON'
    };
  };

  const result = await runRouter({ 
    instruction: 'Do something',
    llmClient: mockLLM
  });
  assert.equal(result.decision, 'chat'); // Should default to chat
  assert.equal(typeof result.confidence, 'number');
});
