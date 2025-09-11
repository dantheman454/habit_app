import { generateStructured, getModels } from './clients.js';
import { createToolPrompt } from './prompt.js';
import { buildFocusedContext } from './context.js';
import { extractFirstJson, validateToolCallsResponse } from './json_extract.js';
import { mkCorrelationId, logIO } from './logging.js';
import db from '../database/DbService.js';
import { OperationRegistry } from '../operations/operation_registry.js';

export async function runOpsAgent({ taskBrief, where = {}, transcript = [], timezone, operationProcessor } = {}) {
  // Pruned: delegate to tool-calling path for a single consistent execution flow
  return runOpsAgentToolCalling({ taskBrief, where, transcript, timezone, operationProcessor });
}

export async function runOpsAgentWithProcessor({ taskBrief, where = {}, transcript = [], timezone, operationProcessor } = {}) {
  // Pruned: delegate to tool-calling path; processor is passed through
  return runOpsAgentToolCalling({ taskBrief, where, transcript, timezone, operationProcessor });
}

function toolCallToOperation(name, args) {
  const [kind, action] = String(name || '').split('.')
    .map(s => String(s || '').trim().toLowerCase());
  return { kind, action, ...(args || {}) };
}

// (Removed) heuristic fallback helpers; strict tool-calling only

export async function runOpsAgentToolCalling({ taskBrief, where = {}, transcript = [], timezone, operationProcessor } = {}) {
  const instruction = String(taskBrief || '').trim();
  if (!instruction) return { version: '3', steps: [], operations: [], tools: [], notes: { errors: ['empty_instruction'] }, text: 'Please share what you would like to do.' };

  const correlationId = mkCorrelationId();
  const DEBUG = /^(1|true|yes|on)$/i.test(String(process.env.ASSISTANT_DEBUG || ''));
  const focusedContext = buildFocusedContext(where, { timezone });
  const contextJson = JSON.stringify(focusedContext, null, 2);
  const last3 = Array.isArray(transcript) ? transcript.slice(-3) : [];
  const convo = last3.map((t) => `- ${t.role}: ${t.text}`).join('\n');

  // Build tool surface with JSON Schemas from OperationRegistry
  const registry = new OperationRegistry(db);
  // Limit tool surface to tasks and events only
  const toolNames = [
    'task.create','task.update','task.delete','task.set_status',
    'event.create','event.update','event.delete'
  ];
  const operationTools = toolNames.map((name) => {
    const [k, a] = name.split('.');
    const opType = `${k}_${a}`;
    const schema = registry.getOperationSchema(opType) || { type: 'object', additionalProperties: true };
    return ({
      type: 'function',
      function: {
        name,
        description: `Execute operation ${name}`,
        parameters: schema
      }
    });
  });

  const system = 'You are an assistant for a tasks and events app. Use the provided tools to create, update, or delete tasks and events.\n\nIMPORTANT:\n- Tasks are all-day items (no time fields)\n- Events have start and end times\n- Use tool_calls to perform actions\n- The system will validate and present changes to the user for approval\n\nAvailable tools are listed below. Use them when the user wants to modify data.';
  const user = `Task: ${instruction}\nWhere: ${JSON.stringify(where)}\nFocused Context:\n${contextJson}\nRecent Conversation:\n${convo}`;

  const prompt = createToolPrompt({ system, user, tools: operationTools });
  if (DEBUG) {
    try {
      const { code } = getModels();
      logIO('ops_agent_init', {
        model: code,
        prompt: JSON.stringify({ system, user, tools: operationTools.map(t => t.function?.name) }),
        output: JSON.stringify({ note: 'initialized tool-calling run', focusedContext }),
        meta: { correlationId }
      });
    } catch {}
  }

  const proposedOps = [];
  const executedKeys = new Set();
  const toolCallsLog = [];
  const notes = { errors: [] };
  const annotations = [];
  const steps = [ { name: 'Identify targets' }, { name: 'Propose operations' } ];

  // Stateless prompting: createToolPrompt returns a string; no message threading
  let rounds = 0;
  const MAX_ROUNDS = 5;
  const MAX_OPS = 20;
  let finalText = '';
  let thinkingText = null;
  let lastResponseText = '';
  let lastHadThinking = false;

  while (rounds < MAX_ROUNDS && proposedOps.length < MAX_OPS) {
    const { code } = getModels();
    let text = '';
    let jsonCandidate = {};
    let toolCallsArr = [];
    // Test knob: allow disabling LLM to force guidance path in unit tests
    const DISABLE_LLM = /^(1|true|yes|on)$/i.test(String(process.env.ASSISTANT_DISABLE_LLM || ''));
    if (DISABLE_LLM) {
      toolCallsArr = [];
    } else {
    try {
      const resp = await generateStructured(prompt, { model: code });
      text = typeof resp === 'string' ? resp : (resp.final || resp.message || resp.content || '');
      const parsed = extractFirstJson(String(text || ''));
      jsonCandidate = parsed && typeof parsed === 'object' ? parsed : {};
      const v = validateToolCallsResponse(jsonCandidate);
      if (v.valid) {
        toolCallsArr = jsonCandidate.tool_calls;
      } else {
        toolCallsArr = [];
        if (DEBUG) {
          try { logIO('ops_agent_round', { output: JSON.stringify({ warning: 'invalid_response_format', detail: v.error }) }); } catch {}
        }
      }
    } catch (e) {
      // Model might be unavailable; skip tool-calls and allow fallback inference below
      text = '';
      jsonCandidate = {};
      toolCallsArr = [];
      if (DEBUG) {
        try { logIO('ops_agent_round', { model: code, prompt: JSON.stringify({ round: rounds + 1 }), output: JSON.stringify({ error: 'generateStructured_failed', message: String(e && e.message ? e.message : e) }), meta: { correlationId, round: rounds + 1 } }); } catch {}
      }
    }
    }

    if (DEBUG) {
      try {
        const { code } = getModels();
        logIO('ops_agent_round', {
          model: code,
          prompt: JSON.stringify({ round: rounds + 1 }),
          output: JSON.stringify({
            responseText: text?.slice(0, 2000) || '',
            toolCalls: toolCallsArr.map(c => ({ name: c?.function?.name || c?.name, arguments: c?.function?.arguments || c?.arguments }))
          }),
          meta: { correlationId, round: rounds + 1 }
        });
      } catch {}
    }

    // Extract thinking and final text from all responses
    const responseText = String(jsonCandidate.message || text || '').trim();
    const thinkingMatch = responseText.match(/<think>([\s\S]*?)<\/think>/);
    lastResponseText = responseText;
    lastHadThinking = !!thinkingMatch;
    if (thinkingMatch) {
      thinkingText = thinkingMatch[1].trim();
      if (thinkingText && thinkingText.length > 2000) thinkingText = thinkingText.slice(0, 2000) + '…';
    }

  if (!toolCallsArr.length) {
      // No tool calls - extract clean final response
      let respText = responseText;
      
      // Remove thinking from final response
      if (thinkingMatch) {
        respText = respText.replace(/<think>[\s\S]*?<\/think>/, '').trim();
      }
      
      // If no clean response after removing thinking, use a default
      if (!respText) {
    respText = 'I could not propose any changes. Use explicit actions like add/create, update/set, or delete, with specific titles and dates.';
      }
      
      finalText = respText;
      break;
    }

    for (const call of toolCallsArr) {
      if (proposedOps.length >= MAX_OPS) break;
      const name = call?.function?.name || call?.name;
      const argsRaw = call?.function?.arguments || call?.arguments || {};
      let parsedArgs = argsRaw;
      if (typeof argsRaw === 'string') {
        try { parsedArgs = JSON.parse(argsRaw); } catch { parsedArgs = {}; }
      }

      // Normalize common arg variants
      if (name === 'task.update' && parsedArgs) {
        if (parsedArgs.where && parsedArgs.where.id && parsedArgs.id === undefined) parsedArgs.id = parsedArgs.where.id;
        if (parsedArgs.data && typeof parsedArgs.data === 'object') {
          for (const [k,v] of Object.entries(parsedArgs.data)) { if (parsedArgs[k] === undefined) parsedArgs[k] = v; }
          delete parsedArgs.data;
        }
        // tasks are all-day: ignore any time aliases for task.update
      }

      const op = toolCallToOperation(name, parsedArgs);
      toolCallsLog.push({ name, args: parsedArgs });
      
      // Validate operation using processor validators
      const type = operationProcessor.inferOperationType(op);
      const validator = operationProcessor.validators.get(type);
      const validation = validator ? await validator(op) : { valid: false, errors: ['unknown_operation_type'] };
      
      annotations.push({ op, errors: validation.errors || [] });
      
      if (validation.valid) {
        const key = [op.kind, op.action, op.id, op.scheduledFor || '', op.startTime || '', op.title || '', op.status || '', op.occurrenceDate || ''].join('|');
        if (!executedKeys.has(key)) {
          executedKeys.add(key);
          proposedOps.push(op);
        }
      }
      
      // No message threading; we only log validation outcome
    }

    rounds += 1;
    // Stateless; continue to next round if needed
  }

  // Ensure we always have a reasonable summary text
  if (!finalText) {
    let respText = lastResponseText || '';
    if (lastHadThinking) respText = respText.replace(/<think>[\s\S]*?<\/think>/, '').trim();
    const defaultText = `Here are the proposed changes for your review. (${proposedOps.length} valid, ${annotations.filter(a => a.errors?.length).length} invalid)`;
    finalText = respText || defaultText;
  }

  // Guidance path: if no operations were proposed, provide concise suggestions
  if (proposedOps.length === 0) {
    const lower = instruction.toLowerCase();
    let guidance = 'I could not propose any changes. ';
    if (/(add|create|schedule)\b/.test(lower)) {
      guidance += 'Try: "add an event called Meeting at 14:00 tomorrow" or "create a task titled Groceries for 2025-09-10".';
    } else if (/(update|change|modify|move|reschedule|set)\b/.test(lower)) {
      guidance += 'Try: "update Lunch with Dad to 13:00 today" or "set task \"Groceries\" status to completed".';
    } else if (/(delete|remove)\b/.test(lower)) {
      guidance += 'Try: "delete the event \"Lunch with Dad\" today" or "delete task \"Groceries\"".';
    } else {
      guidance += 'Use explicit actions like add/create, update/set, or delete, with specific titles and dates.';
    }
    return {
      version: '3',
      steps,
      operations: [],
      tools: toolCallsLog,
      notes: {
        errors: [{ error: 'no_operations_proposed' }],
        contextTruncated: !!(focusedContext && focusedContext.meta && focusedContext.meta.contextTruncated)
      },
      text: guidance,
      thinking: thinkingText
    };
  }

  return {
    version: '3',
    steps,
    operations: proposedOps,
    tools: toolCallsLog,
    notes: {
  errors: annotations.filter(a => a.errors?.length).map(a => ({ op: a.op, errors: a.errors })),
      contextTruncated: !!(focusedContext && focusedContext.meta && focusedContext.meta.contextTruncated)
    },
    text: finalText,
    thinking: thinkingText
  };
}

// Emit a final result log outside the function return to aid debugging when enabled
// Note: We cannot log here post-return; callers receive structured results. The above
// per-round and init logs, plus assistant route summary logs, should be sufficient.
