// OpsAgent proposal orchestrator
// Produces v3 operations with proper validation and repair

import { codeLLM, getModels } from './clients.js';
import { buildFocusedContext } from './context.js';
import { mkCorrelationId, logIO } from './logging.js';
import { extractFirstJson } from './json_extract.js';

const TIMEZONE = process.env.TZ_NAME || 'America/New_York';
const MODELS = (typeof getModels === 'function') ? getModels() : { code: process.env.CODE_MODEL || 'granite-code:8b' };

export async function runProposal({ instruction, transcript = [], focusedWhere = {} }) {
  const taskBrief = String(instruction || '').trim();
  if (!taskBrief) return { operations: [] };

  const correlationId = mkCorrelationId();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).replace(/\//g, '-');
  const last3 = Array.isArray(transcript) ? transcript.slice(-3) : [];
  const convo = last3.map((t) => `- ${t.role}: ${t.text}`).join('\n');
  const focusedContext = buildFocusedContext(focusedWhere, { timezone: TIMEZONE });
  const contextJson = JSON.stringify(focusedContext, null, 2);

  const prompt = `You are the operations planner for a todo app. Output ONLY a single JSON object with keys: version, steps, operations, and optional tools, notes. Follow the rules strictly: include recurrence on create/update (use {"type":"none"} for non-repeating; habits must not be 'none'); if recurrence.type != 'none', include an anchor scheduledFor; for todos use set_status (with optional occurrenceDate for repeating); no bulk; ≤20 ops; do NOT invent invalid IDs. When updating time-related fields, always include timeOfDay if specified. You may internally reason, but the final output MUST be JSON only.

Timezone: ${TIMEZONE}; Today: ${today}
Task: ${taskBrief}
Where: ${JSON.stringify(focusedWhere)}
Focused context: ${contextJson}
Transcript (last 3):
${convo}

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
    const raw = await codeLLM(prompt, { model: MODELS.code });
    logIO('proposal', { model: MODELS.code, prompt, output: raw, meta: { correlationId } });
    
    // Extract the actual response from the LLM metadata
    let responseText = String(raw || '');
    if (responseText.includes('"response":')) {
      // The LLM returned a metadata object, extract just the response field
      try {
        const metadata = JSON.parse(responseText);
        responseText = metadata.response || responseText;
      } catch (e) {
        // If parsing fails, use the original text
      }
    }
    
    let parsed = extractFirstJson(responseText);
    
    if (!parsed || !Array.isArray(parsed.operations)) {
      return { operations: [] };
    }
    
    return {
      version: parsed.version || '3',
      steps: Array.isArray(parsed.steps) ? parsed.steps : [],
      operations: parsed.operations,
      tools: Array.isArray(parsed.tools) ? parsed.tools : [],
      notes: parsed.notes || {}
    };
  } catch (error) {
    console.error('Proposal error:', error);
    return { operations: [] };
  }
}
