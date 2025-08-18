#!/usr/bin/env node

import { buildRouterSnapshots, topClarifyCandidates } from './apps/server/llm/context.js';
import { runRouter } from './apps/server/llm/router.js';
import { runConversationAgent } from './apps/server/llm/conversation_agent.js';
import { runProposal } from './apps/server/llm/proposal.js';
import { runOpsAgent } from './apps/server/llm/ops_agent.js';
import { extractFirstJson } from './apps/server/llm/json_extract.js';
import db from './apps/server/database/DbService.js';

async function debugAssistant() {
  console.log('=== DEBUGGING ASSISTANT ===');
  
  // Test the conversation agent with the exact message
  console.log('\n1. Testing conversation agent with "Update Buy report to have a time of 21:00":');
  const conversationResult = await runConversationAgent({ 
    instruction: 'Update Buy report to have a time of 21:00', 
    transcript: [] 
  });
  
  console.log('Conversation agent result:', JSON.stringify(conversationResult, null, 2));
  
  // Test the router directly
  console.log('\n2. Testing router directly:');
  const routerResult = await runRouter({ 
    instruction: 'Update Buy report to have a time of 21:00', 
    transcript: [] 
  });
  
  console.log('Router result:', JSON.stringify(routerResult, null, 2));
  
  console.log('\n=== END DEBUG ===');
}

debugAssistant().catch(console.error);
