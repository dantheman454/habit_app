// Test the two-agent system implementation

import assert from 'node:assert/strict';
import { test } from 'node:test';

// Simple integration test to verify the two-agent system structure
test('Two-Agent System: ConversationAgent structure', async () => {
  // This test verifies that the ConversationAgent module can be imported
  // and has the expected interface
  const { runConversationAgent } = await import('../../apps/server/llm/conversation_agent.js');
  
  assert.equal(typeof runConversationAgent, 'function');
  
  // Test that it returns a promise
  const result = runConversationAgent({ instruction: 'test', transcript: [] });
  assert.equal(result instanceof Promise, true);
});

test('Two-Agent System: OpsAgent structure', async () => {
  // This test verifies that the OpsAgent module can be imported
  // and has the expected interface
  const { runOpsAgent } = await import('../../apps/server/llm/ops_agent.js');
  
  assert.equal(typeof runOpsAgent, 'function');
  
  // Test that it returns a promise
  const result = runOpsAgent({ taskBrief: 'test', transcript: [] });
  assert.equal(result instanceof Promise, true);
});

test('Two-Agent System: Summary structure', async () => {
  // This test verifies that the Summary module can be imported
  // and has the expected interface
  const { runSummary } = await import('../../apps/server/llm/summary.js');
  
  assert.equal(typeof runSummary, 'function');
  
  // Test that it returns a promise
  const result = runSummary({ operations: [], issues: [] });
  assert.equal(result instanceof Promise, true);
});

test('Two-Agent System: Proposal structure', async () => {
  // This test verifies that the Proposal module can be imported
  // and has the expected interface
  const { runProposal } = await import('../../apps/server/llm/proposal.js');
  
  assert.equal(typeof runProposal, 'function');
  
  // Test that it returns a promise
  const result = runProposal({ instruction: 'test', transcript: [] });
  assert.equal(result instanceof Promise, true);
});
