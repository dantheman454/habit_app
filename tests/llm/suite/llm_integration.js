// LLM Integration for Test Suite
// Integrates with existing LLM infrastructure for real model testing

import { convoLLM, codeLLM, getModels } from '../../../apps/server/llm/clients.js';
import { buildRouterSnapshots, buildFocusedContext } from '../../../apps/server/llm/context.js';
import { extractFirstJson } from '../../../apps/server/llm/json_extract.js';

const TIMEZONE = process.env.TZ_NAME || 'America/New_York';
const MODELS = getModels();

// Scenario-aware context building functions
function buildScenarioRouterContext(scenario, timezone) {
  const today = new Date();
  const todayYmd = new Intl.DateTimeFormat('en-CA', { 
    timeZone: timezone, 
    year: 'numeric', 
    month: '2-digit', 
    day: '2-digit' 
  }).format(today).replace(/\//g, '-');
  
  // Use scenario context instead of database
  const context = scenario.context || {};
  
  // Build week items from scenario context
  const weekItems = [
    ...(context.todos || []).map(t => ({ 
      id: t.id, 
      title: t.title, 
      scheduledFor: t.scheduledFor 
    })),
    ...(context.events || []).map(e => ({ 
      id: e.id, 
      title: e.title, 
      scheduledFor: e.scheduledFor 
    }))
  ];
  
  // Build backlog from unscheduled items
  const backlogItems = (context.todos || [])
    .filter(t => !t.scheduledFor)
    .map(t => ({ id: t.id, title: t.title, scheduledFor: null }));
  
  return {
    week: { 
      from: todayYmd, 
      to: todayYmd, 
      items: weekItems 
    },
    backlog: backlogItems
  };
}

function buildScenarioFocusedContext(scenario, timezone) {
  const context = scenario.context || {};
  const focusedWhere = scenario.focusedWhere || {};
  
  // Filter context based on focusedWhere
  let todos = context.todos || [];
  let events = context.events || [];
  
  // Apply focusedWhere filters
  if (focusedWhere.ids) {
    const idSet = new Set(focusedWhere.ids);
    todos = todos.filter(t => idSet.has(t.id));
    events = events.filter(e => idSet.has(e.id));
  }
  
  if (focusedWhere.scheduled_range) {
    const { from, to } = focusedWhere.scheduled_range;
    todos = todos.filter(t => {
      if (!t.scheduledFor) return false;
      return t.scheduledFor >= from && t.scheduledFor <= to;
    });
    events = events.filter(e => {
      if (!e.scheduledFor) return false;
      return e.scheduledFor >= from && e.scheduledFor <= to;
    });
  }
  
  return {
    where: focusedWhere,
    todos: todos.map(t => ({
      id: t.id,
      title: t.title,
      scheduledFor: t.scheduledFor || null,
      recurrence: t.recurrence || { type: 'none' },
      completed: t.status === 'completed' || t.completed || false
    })),
    events: events.map(e => ({
      id: e.id,
      title: e.title,
      scheduledFor: e.scheduledFor || null,
      startTime: e.startTime || null,
      endTime: e.endTime || null,
      location: e.location || null,
      recurrence: e.recurrence || { type: 'none' },
      completed: e.completed || false
    })),
    habits: (context.habits || []).map(h => ({
      id: h.id,
      title: h.title,
      scheduledFor: h.scheduledFor || null,
      timeOfDay: h.timeOfDay || null,
      recurrence: h.recurrence || { type: 'daily' },
      completed: h.completed || false
    })),
    aggregates: {}
  };
}

export class LLMIntegration {
  constructor() {
    this.models = MODELS;
  }

  async callRouterLLM(scenario) {
    const today = new Date();
    const todayYmd = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(today).replace(/\//g, '-');
    
    // Use scenario-specific context instead of database
    const snapshots = buildScenarioRouterContext(scenario, TIMEZONE);
    
    // Debug: Log context being sent to LLM
    if (scenario.name === "Complete specific task" || scenario.name === "Create new task") {
      console.log(`🔍 LLM Context for ${scenario.name}:`);
      console.log(`  Scenario context: ${JSON.stringify(scenario.context, null, 2)}`);
      console.log(`  Built snapshots: ${JSON.stringify(snapshots, null, 2)}`);
    }
    
    const prompt = `You are an intent router for a todo assistant. You MUST respond with ONLY a single JSON object. No explanations, no code, no prose.

CRITICAL: Output ONLY valid JSON with these fields: decision, confidence, question, where, delegate, options

DECISION RULES:
- Choose "plan" when the user intent is clear and specific:
  * "complete my project proposal review" (specific task)
  * "create a task to buy groceries tomorrow" (new task with time)
  * "what do I have to do today?" (view tasks for specific time)
  * "show my tasks" (view tasks)
- Choose "clarify" when the user intent is ambiguous:
  * "update my task" when multiple tasks exist
  * "do something" without specifics
  * "handle my project" when multiple project items exist
  * "complete something" when multiple tasks exist
  * "show me my tasks for next week" (ambiguous time reference)
  * "do something with my meeting" (unclear action)
- Choose "chat" for general conversation without actionable intent

WHERE FIELD RULES:
- For specific existing tasks: use {"ids": [task_id]}
- For new tasks with time: use "tomorrow", "today", "next week", etc.
- For general actions: use "today" or appropriate time context

SEMANTIC MATCHING RULES:
- Match user intent to existing tasks using semantic similarity
- "project review" can match "Review project proposal"
- "meeting" can match "Team meeting"
- "call" can match "Call client"
- Be flexible with word variations and synonyms

CONTEXT ANALYSIS RULES:
- If user mentions a specific task that exists in context, use {"ids": [task_id]}
- If user wants to create a NEW task, use time reference like "tomorrow", "today"
- If context is empty and user wants to create something, use time reference
- If user wants to view/show tasks, use time reference like "today"

Today: ${todayYmd} (${TIMEZONE})

Context (week+backlog):
${JSON.stringify(snapshots)}

User:
${scenario.instruction}

RESPOND WITH ONLY THIS JSON FORMAT:

For completing a specific task (when task exists in context):
{"decision":"plan","confidence":0.9,"where":{"ids":[1]}}

For creating a new task (when no matching task exists):
{"decision":"plan","confidence":0.8,"where":"tomorrow"}

For viewing/showing tasks:
{"decision":"plan","confidence":0.9,"where":"today"}

For ambiguous target:
{"decision":"clarify","confidence":0.3,"question":"Which task do you want to update?","options":[{"id":1,"title":"Review project"},{"id":2,"title":"Call client"}]}

For vague completion:
{"decision":"clarify","confidence":0.2,"question":"Which task would you like to complete?","options":[{"id":1,"title":"Review project"},{"id":2,"title":"Call client"}]}

For unclear action:
{"decision":"clarify","confidence":0.3,"question":"What would you like to do with your meeting? (reschedule, cancel, add details)"}

For ambiguous time:
{"decision":"clarify","confidence":0.4,"question":"Which week do you mean? This week or next week?"}

For general chat:
{"decision":"chat","confidence":0.8}

JSON RESPONSE:`;

    // Debug: Log prompt for specific scenarios
    if (scenario.name === "Complete specific task" || scenario.name === "Create new task") {
      console.log(`🔍 Full prompt for ${scenario.name}:`);
      console.log(`  ${prompt}`);
    }

    try {
      const raw = await convoLLM(prompt, { stream: false, model: this.models.convo });
      
      // Debug: Log raw LLM response
      if (scenario.name === "Complete specific task" || scenario.name === "Create new task") {
        console.log(`🔍 Raw LLM response for ${scenario.name}:`);
        console.log(`  Raw: ${String(raw || '')}`);
      }
      
      // Extract the actual response from the LLM output
      let responseText = String(raw || '');
      if (responseText.includes('"response":')) {
        try {
          const parsed = JSON.parse(responseText);
          responseText = parsed.response || responseText;
        } catch (e) {
          // If parsing fails, use the original text
        }
      }
      
      // Try to extract JSON from the response
      let parsed = extractFirstJson(responseText) || {};
      
      // If extraction failed, try to find JSON-like content
      if (!parsed || Object.keys(parsed).length === 0) {
        // Look for JSON-like patterns in the response
        const jsonMatch = responseText.match(/\{[^{}]*"decision"[^{}]*\}/);
        if (jsonMatch) {
          try {
            parsed = JSON.parse(jsonMatch[0]);
          } catch (e) {
            // If still fails, create a fallback response
            console.warn(`Failed to parse JSON from response: ${responseText.substring(0, 200)}...`);
          }
        }
      }
      
      // Debug: Log parsed response
      if (scenario.name === "Complete specific task" || scenario.name === "Create new task") {
        console.log(`🔍 Parsed response for ${scenario.name}:`);
        console.log(`  Parsed: ${JSON.stringify(parsed, null, 2)}`);
      }
      
      return {
        decision: parsed.decision || 'clarify',
        confidence: Number(parsed.confidence || 0),
        question: parsed.question,
        where: parsed.where,
        options: parsed.options,
        requiresClarification: parsed.decision === 'clarify'
      };
    } catch (error) {
      console.error('Router LLM error:', error);
      return {
        decision: 'clarify',
        confidence: 0,
        question: 'Error processing request',
        requiresClarification: true
      };
    }
  }

  async callProposalLLM(scenario) {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).replace(/\//g, '-');
    
    // Use scenario-specific focused context instead of database
    const focusedContext = buildScenarioFocusedContext(scenario, TIMEZONE);
    const contextJson = JSON.stringify(focusedContext, null, 2);

    const prompt = `You are the operations planner for a todo app. Output ONLY a single JSON object with keys: version, steps, operations, and optional tools, notes. Follow the rules strictly: include recurrence on create/update (use {"type":"none"} for non-repeating; habits must not be 'none'); if recurrence.type != 'none', include an anchor scheduledFor; for todos use set_status (with optional occurrenceDate for repeating); no bulk; ≤20 ops; do NOT invent invalid IDs. When updating time-related fields, always include timeOfDay if specified. You may internally reason, but the final output MUST be JSON only.

Timezone: ${TIMEZONE}; Today: ${today}
Task: ${scenario.instruction}
Where: ${JSON.stringify(scenario.focusedWhere || {})}
Focused context: ${contextJson}

IMPORTANT: Use ONLY the IDs from the focused context. Do NOT invent IDs. If updating a task, use its exact ID from the context.

Respond with JSON exactly as:
{
  "version":"3",
  "steps":[{"name":"Identify targets"},{"name":"Apply changes","expectedOps":2}],
  "operations":[{"kind":"todo","action":"update","id":123,"scheduledFor":"${today}","timeOfDay":"21:00","recurrence":{"type":"none"}}]
}

Example outputs:

For updating a task's time:
{
  "version":"3",
  "steps":[{"name":"Update time"}],
  "operations":[{"kind":"todo","action":"update","id":8,"timeOfDay":"21:00","recurrence":{"type":"every_n_days","intervalDays":2,"until":"2025-12-31"}}]
}

For creating a new task:
{
  "version":"3",
  "steps":[{"name":"Create task"}],
  "operations":[{"kind":"todo","action":"create","title":"New task","scheduledFor":"${today}","timeOfDay":"14:30","recurrence":{"type":"none"}}]
}

For completing a task:
{
  "version":"3",
  "steps":[{"name":"Mark complete"}],
  "operations":[{"kind":"todo","action":"set_status","id":8,"status":"completed"}]
}`;

    try {
      const raw = await codeLLM(prompt, { model: this.models.code });
      
      // Extract the actual response from the LLM metadata
      let responseText = String(raw || '');
      if (responseText.includes('"response":')) {
        try {
          const metadata = JSON.parse(responseText);
          responseText = metadata.response || responseText;
        } catch (e) {
          // If parsing fails, use the original text
        }
      }
      
      let parsed = extractFirstJson(responseText);
      
      if (!parsed || !Array.isArray(parsed.operations)) {
        return { operations: [], shouldExecute: false };
      }
      
      return {
        operations: parsed.operations,
        shouldExecute: true,
        version: parsed.version || '3',
        steps: Array.isArray(parsed.steps) ? parsed.steps : []
      };
    } catch (error) {
      console.error('Proposal LLM error:', error);
      return { operations: [], shouldExecute: false };
    }
  }

  async callRepairLLM(scenario) {
    // Use scenario-specific focused context instead of database
    const focusedContext = buildScenarioFocusedContext(scenario, TIMEZONE);
    
    // Build repair prompt with specific error details
    const errorDetails = scenario.errors.map((err, index) => {
      const op = err.op || {};
      return `Operation ${index + 1}: ${JSON.stringify(op)}\nErrors: ${Array.isArray(err.errors) ? err.errors.join(', ') : 'unknown'}`;
    }).join('\n\n');

    const prompt = `You are a repair assistant for todo operations. Fix the invalid operations below by correcting the errors while preserving valid operations. Output ONLY a single JSON object with an "operations" array.

Errors to fix:
${errorDetails}

Original operations:
${JSON.stringify(scenario.original, null, 2)}

Focused context:
${JSON.stringify(focusedContext, null, 2)}

Rules:
- Keep valid operations unchanged
- Fix invalid operations by correcting the errors
- Ensure all required fields are present
- Use only IDs from the focused context
- Include timeOfDay when updating time-related fields
- Include recurrence for create/update operations

Example outputs:

For missing timeOfDay:
{
  "operations": [
    {"kind":"todo","action":"update","id":8,"timeOfDay":"21:00","recurrence":{"type":"every_n_days","intervalDays":2,"until":"2025-12-31"}}
  ]
}

For missing recurrence:
{
  "operations": [
    {"kind":"todo","action":"update","id":8,"scheduledFor":"2025-08-17","recurrence":{"type":"none"}}
  ]
}

For invalid ID:
{
  "operations": [
    {"kind":"todo","action":"update","id":8,"scheduledFor":"2025-08-17","recurrence":{"type":"none"}}
  ]
}`;

    try {
      const raw = await codeLLM(prompt, { stream: false, model: this.models.code });
      
      const parsed = extractFirstJson(String(raw || '')) || {};
      const repairedOps = Array.isArray(parsed.operations) ? parsed.operations : [];
      
      return { operations: repairedOps };
    } catch (error) {
      console.error('Repair LLM error:', error);
      return { operations: Array.isArray(scenario.original) ? scenario.original : [] };
    }
  }

  getAvailableModels() {
    return this.models;
  }
}
