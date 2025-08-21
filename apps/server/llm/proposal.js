// OpsAgent proposal orchestrator
// Produces v3 operations with proper validation and repair

import { codeLLM, getModels } from './clients.js';
import { buildFocusedContext } from './context.js';
import { mkCorrelationId, logIO } from './logging.js';
import { extractFirstJson } from './json_extract.js';
import { qualityMonitor } from './quality_monitor.js';

const TIMEZONE = process.env.TZ_NAME || 'America/New_York';
const MODELS = (typeof getModels === 'function') ? getModels() : { code: process.env.CODE_MODEL || 'qwen3-coder:30b' };

// Add operation validation before returning
function validateProposalOutput(parsed) {
  const errors = [];
  
  if (!parsed.operations || !Array.isArray(parsed.operations)) {
    errors.push('Missing or invalid operations array');
  }
  
  if (parsed.operations.length > 20) {
    errors.push('Too many operations (max 20)');
  }
  
  // Validate each operation
  parsed.operations.forEach((op, index) => {
    if (!op.kind || !op.action) {
      errors.push(`Operation ${index}: missing kind or action`);
    }
    
    if (op.action === 'create' && !op.title) {
      errors.push(`Operation ${index}: create requires title`);
    }
    
    if (['update', 'delete', 'set_status'].includes(op.action) && !op.id) {
      errors.push(`Operation ${index}: ${op.action} requires id`);
    }
    
    if (op.recurrence && op.recurrence.type === 'none' && op.kind === 'habit') {
      errors.push(`Operation ${index}: habits cannot have recurrence type "none"`);
    }
  });
  
  return { valid: errors.length === 0, errors };
}

export async function runProposal({ instruction, transcript = [], focusedWhere = {} }) {
  const taskBrief = String(instruction || '').trim();
  if (!taskBrief) return { operations: [] };

  const correlationId = mkCorrelationId();
  const startTime = Date.now();
  qualityMonitor.recordRequest(correlationId, 'proposal', MODELS.code);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).replace(/\//g, '-');
  const last3 = Array.isArray(transcript) ? transcript.slice(-3) : [];
  const convo = last3.map((t) => `- ${t.role}: ${t.text}`).join('\n');
  const focusedContext = buildFocusedContext(focusedWhere, { timezone: TIMEZONE });
  const contextJson = JSON.stringify(focusedContext, null, 2);

  const prompt = `You are an expert operations planner for a todo application. Your task is to generate precise, valid operations based on user intent.

CRITICAL RULES:
1. Output ONLY valid JSON with keys: version, steps, operations, tools, notes
2. Use ONLY IDs from the provided context - NEVER invent IDs
3. Include recurrence for ALL create/update operations
4. For habits, recurrence.type cannot be "none"
5. For todos with recurrence, include scheduledFor as anchor
6. Maximum 20 operations per request
7. Validate all time formats (YYYY-MM-DD for dates, HH:MM for times)

OPERATION VALIDATION:
- todos: require title for create, id for update/delete
- events: require title, start, end for create
- habits: require title, recurrence for create
- timeOfDay: must be HH:MM format
- scheduledFor: must be YYYY-MM-DD format

CONTEXT ANALYSIS:
- Review all available items in the focused context
- Match user intent to specific items when possible
- Consider time constraints and scheduling conflicts
- Respect user's current view and filters

Timezone: ${TIMEZONE}; Today: ${today}
Task: ${taskBrief}
Where: ${JSON.stringify(focusedWhere)}
Available Context: ${contextJson}
Recent Conversation: ${convo}

Generate operations that precisely match the user's intent while following all validation rules.

OUTPUT FORMAT: Use version "3" and the exact operation structure shown below:
{
  "version": "3",
  "steps": [{"name": "Step description"}],
  "operations": [
    {"kind": "todo", "action": "create", "title": "Task title", "scheduledFor": "2025-08-20", "recurrence": {"type": "none"}}
  ],
  "tools": [],
  "notes": {}
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
      return { operations: [], notes: { errors: ['Failed to parse valid operations'] } };
    }
    
    // Validate the proposal
    const validation = validateProposalOutput(parsed);
    if (!validation.valid) {
      return { 
        operations: [], 
        notes: { errors: validation.errors }
      };
    }
    
    const result = {
      version: parsed.version || '3',
      steps: Array.isArray(parsed.steps) ? parsed.steps : [],
      operations: parsed.operations,
      tools: Array.isArray(parsed.tools) ? parsed.tools : [],
      notes: parsed.notes || {}
    };
    
    // Record quality metrics
    const responseTime = Date.now() - startTime;
    const errors = Array.isArray(result.notes?.errors) ? result.notes.errors : [];
    qualityMonitor.recordResponse(correlationId, result, 1.0, errors, responseTime);
    
    return result;
  } catch (error) {
    console.error('Proposal error:', error);
    
    // Record error in quality metrics
    const responseTime = Date.now() - startTime;
    qualityMonitor.recordResponse(correlationId, null, 0.0, Array.isArray(error.message) ? error.message : [error.message], responseTime);
    
    return { operations: [] };
  }
}
