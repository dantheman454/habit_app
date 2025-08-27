import { qwenToolLLM } from './clients.js';
import { createQwenToolPrompt } from './qwen_utils.js';
import { buildFocusedContext } from './context.js';
import { extractFirstJson } from './json_extract.js';
import { mkCorrelationId, logIO } from './logging.js';
import db from '../database/DbService.js';
import { OperationRegistry } from '../operations/operation_registry.js';

function detectAmbiguity(taskBrief, context) {
  const lowerBrief = taskBrief.toLowerCase();
  const actionWords = ['update', 'change', 'modify', 'complete', 'delete', 'remove', 'set', 'create', 'add'];
  const hasAction = actionWords.some(word => lowerBrief.includes(word));
  
  if (!hasAction) {
    return { needsClarification: false };
  }
  
  const items = context.focused || [];
  if (items.length > 1 && !lowerBrief.match(/#\d+/)) {
    return {
      needsClarification: true,
      question: "Which item do you want to work with?",
      options: items.slice(0, 5).map(item => ({
        id: item.id,
        title: item.title,
        scheduledFor: item.scheduledFor
      }))
    };
  }
  const titleMatches = items.filter(item => 
    item.title && lowerBrief.includes(item.title.toLowerCase())
  );
  if (titleMatches.length > 1) {
    return {
      needsClarification: true,
      question: "Which item do you mean?",
      options: titleMatches.map(item => ({
        id: item.id,
        title: item.title,
        scheduledFor: item.scheduledFor
      }))
    };
  }
  return { needsClarification: false };
}

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
  // Limit tool surface to todos and events only (habits excluded per user preference)
  const toolNames = [
    'todo.create','todo.update','todo.delete','todo.set_status',
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

  const system = 'You are an operations executor for a tasks/events app. Use provided tools precisely.\n\nFields map (strict):\n- Todos: date -> scheduledFor; time -> timeOfDay; status -> status; DO NOT use startTime/endTime.\n- Events: date -> scheduledFor; start -> startTime; end -> endTime; DO NOT use timeOfDay.\n\nDisambiguation rules:\n- Prefer IDs from focused.candidates when present.\n- When matching by title, compare case-insensitively (ignore punctuation/extra whitespace) using indexes.todo_by_title_ci and indexes.event_by_title_ci.\n- Cross-check matches with indexes.id_to_kind and indexes.id_to_title to avoid mixing todo vs event.\n- For instructions like "update X to HH:MM", set timeOfDay for todos or startTime for events accordingly.\n- Never invent IDs; if still ambiguous after candidates/indexes, return a concise clarify question.\n\nValidation: Validate dates (YYYY-MM-DD) and times (HH:MM). Keep operations under 20 total. Output MUST be a single JSON object, no code fences, no extra text.';
  const user = `Task: ${instruction}\nWhere: ${JSON.stringify(where)}\nFocused Context:\n${contextJson}\nRecent Conversation:\n${convo}`;

  const prompt = createQwenToolPrompt({ system, user, tools: operationTools });
  if (DEBUG) {
    try {
      logIO('ops_agent_init', {
        model: 'qwen3-coder:30b',
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

  let messages = [...prompt.messages];
  let rounds = 0;
  const MAX_ROUNDS = 5;
  const MAX_OPS = 20;
  let finalText = '';
  let thinkingText = null;
  let lastResponseText = '';
  let lastHadThinking = false;

  while (rounds < MAX_ROUNDS && proposedOps.length < MAX_OPS) {
    const resp = await qwenToolLLM({ messages, tools: operationTools, tool_choice: 'auto' });

    const text = typeof resp === 'string' ? resp : (resp.final || resp.message || resp.content || '');

    const jsonCandidate = extractFirstJson(String(text || '')) || {};

    const toolCallsArr = Array.isArray(jsonCandidate.tool_calls) ? jsonCandidate.tool_calls
      : (jsonCandidate.tool_call ? [jsonCandidate.tool_call] : []);

    if (DEBUG) {
      try {
        logIO('ops_agent_round', {
          model: 'qwen3-coder:30b',
          prompt: JSON.stringify({ round: rounds + 1, messagesLength: messages.length }),
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
        respText = 'Here are the suggested changes for your review.';
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
      if (name === 'todo.update' && parsedArgs) {
        if (parsedArgs.where && parsedArgs.where.id && parsedArgs.id === undefined) parsedArgs.id = parsedArgs.where.id;
        if (parsedArgs.data && typeof parsedArgs.data === 'object') {
          for (const [k,v] of Object.entries(parsedArgs.data)) { if (parsedArgs[k] === undefined) parsedArgs[k] = v; }
          delete parsedArgs.data;
        }
        const timeAliases = ['time','scheduledTime','scheduledForTime','startTime'];
        for (const alias of timeAliases) {
          if (parsedArgs[alias] && !parsedArgs.timeOfDay) { parsedArgs.timeOfDay = parsedArgs[alias]; delete parsedArgs[alias]; }
        }
      }

      const op = toolCallToOperation(name, parsedArgs);
      toolCallsLog.push({ name, args: parsedArgs });
      
      // Validate operation using processor validators
      const type = operationProcessor.inferOperationType(op);
      const validator = operationProcessor.validators.get(type);
      const validation = validator ? await validator(op) : { valid: false, errors: ['unknown_operation_type'] };
      
      annotations.push({ op, errors: validation.errors || [] });
      
      if (validation.valid) {
        const key = [op.kind, op.action, op.id, op.scheduledFor || '', op.timeOfDay || op.startTime || '', op.title || '', op.status || '', op.occurrenceDate || ''].join('|');
        if (!executedKeys.has(key)) {
          executedKeys.add(key);
          proposedOps.push(op);
        }
      }
      
      // Simulate tool response for LLM
      const simulatedResult = validation.valid ? 
        { ok: true, message: 'Operation validated successfully' } : 
        { ok: false, error: validation.errors.join(', ') };
      messages.push({ role: 'tool', tool_call_id: call.id || name, content: JSON.stringify(simulatedResult) });
    }

    rounds += 1;
    messages = [ ...prompt.messages, ...messages.filter(m => m.role === 'tool') ];
  }

  // Ensure we always have a reasonable summary text
  if (!finalText) {
    let respText = lastResponseText || '';
    if (lastHadThinking) respText = respText.replace(/<think>[\s\S]*?<\/think>/, '').trim();
    const defaultText = `Here are the proposed changes for your review. (${proposedOps.length} valid, ${annotations.filter(a => a.errors?.length).length} invalid)`;
    finalText = respText || defaultText;
  }

  // Fallback: if no operations were proposed but intent is likely actionable, infer a minimal op
  if (proposedOps.length === 0) {
    try {
      const lower = instruction.toLowerCase();
      const isActionable = ['update','change','modify','set','reschedule'].some(w => lower.includes(w));
      if (isActionable) {
        // Try to extract a time like HH:MM
        const m = instruction.match(/\b([01]\d|2[0-3]):[0-5]\d\b/);
        const timeOfDay = m ? m[0] : null;
        // Choose target: prefer focused candidates, then explicit where.id, then title matching
        let targetId = null;
        let targetKind = 'todo';
        
        // First, check focused candidates
        if (focusedContext.focused && Array.isArray(focusedContext.focused.candidates)) {
          const candidates = focusedContext.focused.candidates;
          if (candidates.length === 1) {
            targetId = candidates[0].id;
            targetKind = candidates[0].kind;
          } else if (candidates.length > 1) {
            // Multiple candidates - try to find best match by title
            const titleMatch = candidates.find(c => {
              const t = String(c.title || '').toLowerCase();
              return !!t && lower.includes(t);
            });
            if (titleMatch) {
              targetId = titleMatch.id;
              targetKind = titleMatch.kind;
            }
          }
        }
        
        // Fallback to explicit where.id
        if (!targetId && where && Number.isFinite(where.id)) {
          targetId = where.id;
          // Try to determine kind by checking both todos and events
          const todosInContext = (focusedContext && Array.isArray(focusedContext.todos)) ? focusedContext.todos : [];
          const eventsInContext = (focusedContext && Array.isArray(focusedContext.events)) ? focusedContext.events : [];
          if (todosInContext.find(t => t.id === targetId)) {
            targetKind = 'todo';
          } else if (eventsInContext.find(e => e.id === targetId)) {
            targetKind = 'event';
          }
        }
        
        // Last resort: title matching using indexes
        if (!targetId) {
          try {
            // Try todo index first
            if (focusedContext.indexes && focusedContext.indexes.todo_by_title_ci) {
              for (const [title, id] of Object.entries(focusedContext.indexes.todo_by_title_ci)) {
                if (lower.includes(title)) {
                  targetId = id;
                  targetKind = 'todo';
                  break;
                }
              }
            }
            
            // Try event index if no todo match
            if (!targetId && focusedContext.indexes && focusedContext.indexes.event_by_title_ci) {
              for (const [title, id] of Object.entries(focusedContext.indexes.event_by_title_ci)) {
                if (lower.includes(title)) {
                  targetId = id;
                  targetKind = 'event';
                  break;
                }
              }
            }
          } catch {}
        }
        
        if (targetId && (timeOfDay || lower.includes('time'))) {
          const inferred = { kind: targetKind, action: 'update', id: targetId };
          if (timeOfDay) {
            if (targetKind === 'todo') {
              inferred.timeOfDay = timeOfDay;
            } else if (targetKind === 'event') {
              inferred.startTime = timeOfDay;
            }
          }
          // Validate and include if valid
          const type = operationProcessor.inferOperationType(inferred);
          const validator = operationProcessor.validators.get(type);
          const validation = validator ? await validator(inferred) : { valid: false, errors: ['unknown_operation_type'] };
          annotations.push({ op: inferred, errors: validation.errors || [] });
          if (validation.valid) {
            proposedOps.push(inferred);
            finalText = finalText || `Here are the proposed changes for your review. (1 valid, 0 invalid)`;
            if (DEBUG) {
              try { logIO('ops_agent_fallback', { model: 'qwen3-coder:30b', prompt: JSON.stringify({ instruction }), output: JSON.stringify({ inferred }), meta: { correlationId } }); } catch {}
            }
          }
        }
      }
    } catch {}
  }

  return {
    version: '3',
    steps,
    operations: proposedOps,
    tools: toolCallsLog,
    notes: { 
      errors: annotations.filter(a => a.errors?.length).map(a => ({ op: a.op, errors: a.errors }))
    },
    text: finalText,
    thinking: thinkingText
  };
}

// Emit a final result log outside the function return to aid debugging when enabled
// Note: We cannot log here post-return; callers receive structured results. The above
// per-round and init logs, plus assistant route summary logs, should be sufficient.
