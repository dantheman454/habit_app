import { qwenToolLLM } from './clients.js';
import { createQwenToolPrompt } from './qwen_utils.js';
import { buildFocusedContext } from './context.js';
import { extractFirstJson } from './json_extract.js';
import { mkCorrelationId } from './logging.js';
import db from '../database/DbService.js';
import { OperationRegistry } from '../operations/operation_registry.js';

// Lightweight validation helpers (kept minimal to avoid cycles with server.js)
function isYmdString(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}
function isValidTimeOfDay(value) {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'string') return false;
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}
function isValidRecurrence(rec) {
  if (rec === null || rec === undefined) return true;
  if (typeof rec !== 'object') return false;
  const allowed = ['none','daily','weekdays','weekly','every_n_days'];
  const type = rec.type;
  if (!allowed.includes(String(type))) return false;
  if (type === 'every_n_days') {
    const n = rec.intervalDays;
    if (!Number.isInteger(n) || n < 1) return false;
  }
  if (!(rec.until === null || rec.until === undefined || isYmdString(rec.until))) return false;
  return true;
}

function inferOperationShape(o) {
  if (!o || typeof o !== 'object') return null;
  const op = { ...o };
  if (op.scheduledFor === '') op.scheduledFor = null;
  return op;
}

function validateOperation(op) {
  const errors = [];
  if (!op || typeof op !== 'object') return ['invalid_operation_object'];
  const kindV3 = op.kind && String(op.kind).toLowerCase();
  const actionV3 = op.action && String(op.action).toLowerCase();
  const inferred = inferOperationShape(op);
  const opType = inferred?.op || actionV3 || null;
  if (op.scheduledFor !== undefined && !(op.scheduledFor === null || isYmdString(op.scheduledFor))) errors.push('invalid_scheduledFor');
  if (op.timeOfDay !== undefined && !isValidTimeOfDay(op.timeOfDay === '' ? null : op.timeOfDay)) errors.push('invalid_timeOfDay');
  if (op.recurrence !== undefined && !isValidRecurrence(op.recurrence)) errors.push('invalid_recurrence');
  // Relaxed: do not require recurrence on create/update; registry schemas are authoritative
  if ((actionV3 === 'update' || actionV3 === 'delete' || actionV3 === 'complete' || actionV3 === 'complete_occurrence' || actionV3 === 'set_status') && !Number.isFinite(op.id)) errors.push('missing_or_invalid_id');
  if (actionV3 === 'complete_occurrence') {
    if (!isYmdString(op.occurrenceDate)) errors.push('invalid_occurrenceDate');
    if (op.completed !== undefined && typeof op.completed !== 'boolean') errors.push('invalid_completed');
  }
  // Relaxed: do not require date anchor when recurrence provided; processor/validators will enforce as needed
  
  // Additional validation for time-related updates
  if (actionV3 === 'update' && kindV3 === 'todo') {
    if (op.scheduledFor && op.timeOfDay === undefined) {
      // let repair handle
    }
  }
  
  return errors;
}

function validateProposal(ops) {
  const shaped = (Array.isArray(ops) ? ops.map(inferOperationShape).filter(Boolean) : []);
  const results = shaped.map((o, i) => ({ index: i, op: o, errors: validateOperation(o) }));
  const invalid = results.filter(r => r.errors.length > 0);
  return { operations: shaped, results, errors: invalid.length ? ['invalid_operations'] : [] };
}

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

export async function runOpsAgent({ taskBrief, where = {}, transcript = [], timezone } = {}) {
  const focusedContext = buildFocusedContext(where, { timezone });
  const correlationId = mkCorrelationId();
  try { 
    db.logAudit({ 
      action: 'ops_agent.input', 
      payload: { 
        taskBrief: String(taskBrief || '').slice(0, 1000), 
        where, 
        transcript: transcript.slice(-3),
        contextSize: Object.keys(focusedContext).length
      },
      meta: { correlationId }
    }); 
  } catch {}

  const proposalRaw = await runProposal({ instruction: taskBrief, transcript, focusedWhere: where });
  let proposedOps = Array.isArray(proposalRaw && proposalRaw.operations) ? proposedOps : [];
  let proposedSteps = Array.isArray(proposalRaw && proposalRaw.steps) ? proposedSteps : [];
  let proposedTools = Array.isArray(proposalRaw && proposalRaw.tools) ? proposedTools : [];

  if (!proposedOps.length && typeof proposalRaw === 'string') {
    const parsed = extractFirstJson(proposalRaw);
    if (parsed && Array.isArray(parsed.operations)) proposedOps = parsed.operations;
    if (parsed && Array.isArray(parsed.steps)) proposedSteps = parsed.steps;
    if (parsed && Array.isArray(parsed.tools)) proposedTools = parsed.tools;
  }

  proposedOps = proposedOps.map(inferOperationShape).filter(Boolean).slice(0, 20);

  let validation = validateProposal(proposedOps);

  let repairedCount = 0;
  if (validation.errors.length) {
    try {
      const repairRaw = await runRepair({ errors: validation.results.filter(r => r.errors.length), original: proposedOps, focusedContext });
      let repaired = Array.isArray(repairRaw && repairRaw.operations) ? repairRaw.operations : [];
      if (!repaired.length && typeof repairRaw === 'string') {
        const parsed = extractFirstJson(repairRaw);
        if (parsed && Array.isArray(parsed.operations)) repaired = parsed.operations;
      }
      repaired = repaired.map(inferOperationShape).filter(Boolean);
      const reval = validateProposal(repaired);
      const validRepaired = reval.results.filter(r => r.errors.length === 0).map(r => r.op);
      repairedCount = validRepaired.length;
      const originallyValid = validation.results.filter(r => r.errors.length === 0).map(r => r.op);
      proposedOps = [...originallyValid, ...validRepaired].slice(0, 20);
      validation = validateProposal(proposedOps);
    } catch (e) {
      console.error('Repair failed:', e);
    }
  }

  const tools = proposedTools.length > 0 ? proposedTools : proposedOps.map((op) => {
    const name = `${String(op.kind || 'unknown')}.${String(op.action || 'unknown')}`;
    const args = { ...op };
    return { name, args };
  });

  const out = {
    version: '3',
    steps: proposedSteps.length > 0 ? proposedSteps : [ { name: 'Identify targets' }, { name: 'Plan operations' } ],
    operations: proposedOps,
    tools,
    notes: { 
      repairedCount, 
      invalidCount: validation.results.filter(r => r.errors.length > 0).length,
      errors: validation.results.filter(r => r.errors.length > 0).map(r => r.errors.join(', '))
    }
  };

  try { 
    db.logAudit({ 
      action: 'ops_agent.output', 
      payload: { 
        stepsCount: out.steps.length, 
        operationsCount: out.operations.length, 
        invalidCount: out.notes.invalidCount,
        repairedCount: out.notes.repairedCount
      },
      meta: { correlationId }
    }); 
  } catch {}
  return out;
}

export async function runOpsAgentWithProcessor({ taskBrief, where = {}, transcript = [], timezone, operationProcessor } = {}) {
  const focusedContext = buildFocusedContext(where, { timezone });
  const correlationId = mkCorrelationId();
  
  try { 
    db.logAudit({ 
      action: 'ops_agent_with_processor.input', 
      payload: { 
        taskBrief: String(taskBrief || '').slice(0, 1000), 
        where, 
        transcript: transcript.slice(-3),
        contextSize: Object.keys(focusedContext).length
      },
      meta: { correlationId }
    }); 
  } catch {}

  const ambiguityCheck = detectAmbiguity(taskBrief, focusedContext);
  
  if (ambiguityCheck.needsClarification) {
    return {
      needsClarification: true,
      question: ambiguityCheck.question,
      options: ambiguityCheck.options,
      correlationId
    };
  }

  const proposalRaw = await runProposal({ instruction: taskBrief, transcript, focusedWhere: where });
  let proposedOps = Array.isArray(proposalRaw && proposalRaw.operations) ? proposedOps : [];
  let proposedSteps = Array.isArray(proposalRaw && proposalRaw.steps) ? proposedSteps : [];
  let proposedTools = Array.isArray(proposalRaw && proposalRaw.tools) ? proposedTools : [];

  if (!proposedOps.length && typeof proposalRaw === 'string') {
    const parsed = extractFirstJson(proposalRaw);
    if (parsed && Array.isArray(parsed.operations)) proposedOps = parsed.operations;
    if (parsed && Array.isArray(parsed.steps)) proposedSteps = parsed.steps;
    if (parsed && Array.isArray(parsed.tools)) proposedTools = parsed.tools;
  }

  proposedOps = proposedOps.map(inferOperationShape).filter(Boolean).slice(0, 20);

  let processorResults = null;
  let repairedCount = 0;
  
  if (proposedOps.length > 0 && operationProcessor) {
    try {
      processorResults = await operationProcessor.processOperations(proposedOps, correlationId);
      const failedOps = processorResults.results.filter(r => !r.ok);
      if (failedOps.length > 0) {
        try {
          const repairRaw = await runRepair({ 
            errors: failedOps.map(r => ({ index: r.op ? proposedOps.indexOf(r.op) : 0, errors: [r.error] })), 
            original: proposedOps, 
            focusedContext 
          });
          let repaired = Array.isArray(repairRaw && repairRaw.operations) ? repairRaw.operations : [];
          if (!repaired.length && typeof repairRaw === 'string') {
            const parsed = extractFirstJson(repairRaw);
            if (parsed && Array.isArray(parsed.operations)) repaired = parsed.operations;
          }
          repaired = repaired.map(inferOperationShape).filter(Boolean);
          
          if (repaired.length > 0) {
            const repairedResults = await operationProcessor.processOperations(repaired, correlationId);
            const validRepaired = repairedResults.results.filter(r => r.ok).map(r => r.op);
            repairedCount = validRepaired.length;
            const originallyValid = processorResults.results.filter(r => r.ok).map(r => r.op);
            const allValidOps = [...originallyValid, ...validRepaired].slice(0, 20);
            processorResults = await operationProcessor.processOperations(allValidOps, correlationId);
          }
        } catch (e) {
          console.error('Repair failed:', e);
        }
      }
    } catch (e) {
      console.error('Operation processor failed:', e);
      const validation = validateProposal(proposedOps);
      processorResults = {
        results: validation.results.map(r => ({ 
          ok: r.errors.length === 0, 
          op: r.op, 
          error: r.errors.length > 0 ? r.errors.join(', ') : undefined 
        })),
        summary: { created: 0, updated: 0, deleted: 0, completed: 0 },
        correlationId
      };
    }
  } else {
    const validation = validateProposal(proposedOps);
    processorResults = {
      results: validation.results.map(r => ({ 
        ok: r.errors.length === 0, 
        op: r.op, 
        error: r.errors.length > 0 ? r.errors.join(', ') : undefined 
      })),
      summary: { created: 0, updated: 0, deleted: 0, completed: 0 },
      correlationId
    };
  }

  const validOps = processorResults.results.filter(r => r.ok).map(r => r.op);
  const tools = proposedTools.length > 0 ? proposedTools : validOps.map((op) => {
    const name = `${String(op.kind || 'unknown')}.${String(op.action || 'unknown')}`;
    const args = { ...op };
    return { name, args };
  });

  const out = {
    version: '3',
    steps: proposedSteps.length > 0 ? proposedSteps : [ { name: 'Identify targets' }, { name: 'Plan operations' } ],
    operations: validOps,
    tools,
    notes: { 
      repairedCount, 
      invalidCount: processorResults.results.filter(r => !r.ok).length,
      errors: processorResults.results.filter(r => !r.ok).map(r => r.error).filter(Boolean)
    }
  };

  try { 
    db.logAudit({ 
      action: 'ops_agent_with_processor.output', 
      payload: { 
        stepsCount: out.steps.length, 
        operationsCount: out.operations.length, 
        invalidCount: out.notes.invalidCount,
        repairedCount: out.notes.repairedCount
      },
      meta: { correlationId }
    }); 
  } catch {}
  
  return out;
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
  const focusedContext = buildFocusedContext(where, { timezone });
  const contextJson = JSON.stringify(focusedContext, null, 2);
  const last3 = Array.isArray(transcript) ? transcript.slice(-3) : [];
  const convo = last3.map((t) => `- ${t.role}: ${t.text}`).join('\n');

  // Build tool surface with JSON Schemas from OperationRegistry
  const registry = new OperationRegistry(db);
  const toolNames = [
    'todo.create','todo.update','todo.delete','todo.set_status',
    'event.create','event.update','event.delete',
    'habit.create','habit.update','habit.delete','habit.set_occurrence_status'
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

  const system = 'You are an operations executor for a todo application. Use tools to perform user actions precisely. Never invent IDs. Validate dates (YYYY-MM-DD) and times (HH:MM). Keep operations under 20 total. Output MUST be a single JSON object, no code fences, no extra text.';
  const user = `Task: ${instruction}\nWhere: ${JSON.stringify(where)}\nFocused Context:\n${contextJson}\nRecent Conversation:\n${convo}`;

  const prompt = createQwenToolPrompt({ system, user, tools: operationTools });

  const executedOps = [];
  const executedKeys = new Set();
  const toolCallsLog = [];
  const notes = { errors: [] };
  const steps = [ { name: 'Identify targets' }, { name: 'Execute operations' } ];

  let messages = [...prompt.messages];
  let rounds = 0;
  const MAX_ROUNDS = 5;
  const MAX_OPS = 20;
  let finalText = '';

  while (rounds < MAX_ROUNDS && executedOps.length < MAX_OPS) {
    const resp = await qwenToolLLM({ messages, tools: operationTools, tool_choice: 'auto' });

    const text = typeof resp === 'string' ? resp : (resp.final || resp.message || resp.content || '');

    const jsonCandidate = extractFirstJson(String(text || '')) || {};

    const toolCallsArr = Array.isArray(jsonCandidate.tool_calls) ? jsonCandidate.tool_calls
      : (jsonCandidate.tool_call ? [jsonCandidate.tool_call] : []);

    if (!toolCallsArr.length) {
      // Fallback: attempt to synthesize an operation from router 'where' and instruction
      const idFromWhere = (where && Number(where.id)) || null;
      const timeRegex = /\b([01]?\d|2[0-3]):([0-5]\d)\b/;
      const timeFromWhere = (where && (where.timeOfDay || where.time || where.startTime || where.scheduledTime || where.scheduledForTime)) || null;
      const timeFromInstruction = (typeof instruction === 'string' && (instruction.match(timeRegex) || [])[0]) || null;
      const timeCandidate = timeFromWhere || timeFromInstruction || jsonCandidate?.time || null;

      if (idFromWhere && timeCandidate) {
        const normalizedTime = (() => {
          const m = String(timeCandidate).match(timeRegex);
          if (!m) return null;
          const hh = m[1].padStart(2, '0');
          const mm = m[2];
          return `${hh}:${mm}`;
        })();
        if (normalizedTime) {
          const op = { kind: 'todo', action: 'update', id: idFromWhere, timeOfDay: normalizedTime };
          try {
            const result = await operationProcessor.processOperations([op], correlationId);
            const ok = result?.results?.[0]?.ok;
            if (ok) {
              executedOps.push(op);
              toolCallsLog.push({ name: 'todo.update', args: op });
              finalText = `Updated time to ${normalizedTime}.`;
              break;
            }
          } catch {}
        }
      }

      finalText = String(jsonCandidate.message || text || '').trim();
      break;
    }

    for (const call of toolCallsArr) {
      if (executedOps.length >= MAX_OPS) break;
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
      try {
        const result = await operationProcessor.processOperations([op], correlationId);
        const ok = result?.results?.[0]?.ok;
        if (ok) {
          const key = [op.kind, op.action, op.id, op.scheduledFor || '', op.timeOfDay || '', op.title || '', op.status || '', op.occurrenceDate || ''].join('|');
          if (!executedKeys.has(key)) {
            executedKeys.add(key);
            executedOps.push(op);
          }
        }
        messages.push({ role: 'tool', tool_call_id: call.id || name, content: JSON.stringify(result) });
      } catch (e) {
        notes.errors.push(String(e?.message || e));
        messages.push({ role: 'tool', tool_call_id: call.id || name, content: JSON.stringify({ ok: false, error: String(e?.message || e) }) });
      }
    }

    rounds += 1;
    messages = [ ...prompt.messages, ...messages.filter(m => m.role === 'tool') ];
  }

  return {
    version: '3',
    steps,
    operations: executedOps,
    tools: toolCallsLog,
    notes,
    text: finalText || 'All set.'
  };
}
