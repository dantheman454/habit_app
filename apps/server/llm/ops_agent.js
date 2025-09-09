import { generateStructured, getModels } from './clients.js';
import { createToolPrompt } from './prompt.js';
import { buildFocusedContext } from './context.js';
import { extractFirstJson } from './json_extract.js';
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

// --- helpers for fallback inference ---
function normalizeTimeTo24h(token) {
  try {
    let s = String(token).trim().toLowerCase();
    const ampm = /(am|pm)$/i.test(s) ? s.slice(-2) : '';
    s = s.replace(/\s*(am|pm)$/i, '');
    let [h, m] = s.split(':').map(v => parseInt(v, 10));
    if (!Number.isFinite(h)) return null;
    if (!Number.isFinite(m)) m = 0;
    if (ampm === 'pm' && h < 12) h += 12;
    if (ampm === 'am' && h === 12) h = 0;
    if (h < 0 || h > 23 || m < 0 || m > 59) return null;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
  } catch { return null; }
}

function inferKeywordTime(lower) {
  if (/( at )?noon\b/.test(lower)) return '12:00';
  if (/( at )?midnight\b/.test(lower)) return '00:00';
  if (/\bmorning\b/.test(lower)) return '09:00';
  if (/\bafternoon\b/.test(lower)) return '13:00';
  if (/\bevening\b/.test(lower)) return '18:00';
  return null;
}

function addOneHour(hhmm) {
  try { const [h,m]=hhmm.split(':').map(n=>parseInt(n,10)); const d=new Date(2000,0,1,h,m); d.setHours(d.getHours()+1); return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; } catch { return null; }
}

function inferDateFromInstruction(lower, focusedContext, where, timezone) {
  try {
    const today = new Date();
    const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    if (/\btoday\b/.test(lower)) return ymd(today);
    if (/\btomorrow\b/.test(lower)) { const d=new Date(today); d.setDate(d.getDate()+1); return ymd(d); }
    // If where.view is day mode, bias to anchor day if instruction lacks explicit date
    try {
      const v = where?.view || {};
      if ((v.mode === 'day' || v.mode === 'week' || v.mode === 'month') && v.fromYmd && v.toYmd && !/\b\d{4}-\d{2}-\d{2}\b/.test(lower)) {
        // choose today if inside view; else use v.fromYmd as reasonable default
        const from = v.fromYmd; const to = v.toYmd;
        const ty = ymd(today);
        if (ty >= String(from) && ty <= String(to)) return ty;
        return from;
      }
    } catch {}
    // Explicit YYYY-MM-DD
    const m = lower.match(/\b(\d{4}-\d{2}-\d{2})\b/);
    if (m) return m[1];
  } catch {}
  return null;
}

function inferTitleFromInstruction(instr) {
  // Heuristic: extract after keywords like 'called', 'titled', or fallback to quoted text
  try {
    const s = String(instr);
    const q = s.match(/"([^"]{2,80})"|'([^']{2,80})'/);
    if (q) return (q[1] || q[2]).trim();
    const called = s.match(/\b(called|titled)\s+([^,.;]+?)(\s+at\b|\s+on\b|$)/i);
    if (called) return String(called[2]).trim();
    // Fallback: take a short phrase after 'add an event' or 'create an event'
    const add = s.match(/\b(add|create|schedule)\s+(an?\s+)?event\s+(for\s+|on\s+)?([^,.;]+?)(\s+at\b|$)/i);
    if (add) return String(add[4]).replace(/\b(today|tomorrow)\b/ig,'').trim();
  } catch {}
  return null;
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

  const system = 'You are an operations executor for a tasks/events app. Use provided tools precisely.\n\nFields map (strict):\n- Tasks: date -> scheduledFor; status -> status.\n- Events: date -> scheduledFor; start -> startTime; end -> endTime.\n\nHard rules:\n- Do NOT propose event completion operations (events are never completed via tools). Tasks use set_status (optionally with occurrenceDate).\n- Never reply that you cannot modify data. You must propose tool calls. The server will only apply them after the user confirms.\n- Output requirements: You MUST output exactly ONE plain JSON object with a `tool_calls` array (no code fences, no prose). Any other content is discarded.\n\nDisambiguation (deterministic):\n- Prefer IDs from focused.candidates when exactly one candidate is present; treat as the target.\n- When multiple title matches exist, compare titles case-insensitively with normalized matching (ignore punctuation/extra whitespace) via indexes.task_by_title_ci and indexes.event_by_title_ci.\n- If multiple event matches remain: prefer those whose scheduledFor lies within the current view window (focused.where.view). Otherwise prefer the closest future date within the next-month set.\n- Cross-check the chosen ID with indexes.id_to_kind and indexes.id_to_title to verify type/title before emitting a tool call.\n- Never invent IDs. If still ambiguous after these rules, choose the best deterministic candidate and still emit the tool call. Do not ask the user to clarify.\n\nValidation: Validate dates (YYYY-MM-DD) and times (HH:MM). Keep operations under 20 total.';
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
    try {
      const resp = await generateStructured(prompt, { model: code });
      text = typeof resp === 'string' ? resp : (resp.final || resp.message || resp.content || '');
      jsonCandidate = extractFirstJson(String(text || '')) || {};
      toolCallsArr = Array.isArray(jsonCandidate.tool_calls) ? jsonCandidate.tool_calls
        : (jsonCandidate.tool_call ? [jsonCandidate.tool_call] : []);
    } catch (e) {
      // Model might be unavailable; skip tool-calls and allow fallback inference below
      text = '';
      jsonCandidate = {};
      toolCallsArr = [];
      if (DEBUG) {
        try { logIO('ops_agent_round', { model: code, prompt: JSON.stringify({ round: rounds + 1 }), output: JSON.stringify({ error: 'generateStructured_failed', message: String(e && e.message ? e.message : e) }), meta: { correlationId, round: rounds + 1 } }); } catch {}
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

  // Fallback: if no operations were proposed but intent is likely actionable, infer a minimal op
  if (proposedOps.length === 0) {
    try {
      const lower = instruction.toLowerCase();
      const isUpdateLike = ['update','change','modify','set','reschedule','move','shift','retime','delay'].some(w => lower.includes(w));
      const isCreateLike = ['add','create','schedule','make','put'].some(w => lower.includes(w));

      if (isUpdateLike) {
        // Try to extract a time like HH:MM (for events only)
        const m = instruction.match(/\b([01]?\d|2[0-3]):[0-5]\d\s*(am|pm)?\b/i);
        const inferredTime = m ? normalizeTimeTo24h(m[0]) : inferKeywordTime(lower);
        // Choose target: prefer focused candidates, then explicit where.id, then title matching
        let targetId = null;
        let targetKind = 'task';
        const norm = (s) => {
          try {
            return String(s || '')
              .toLowerCase()
              .replace(/[^\p{L}\p{N}]+/gu, ' ')
              .replace(/\s+/g, ' ')
              .trim();
          } catch {
            return String(s || '').toLowerCase().replace(/[^a-z0-9]+/gi, ' ').replace(/\s+/g, ' ').trim();
          }
        };
        const normalizedInstruction = norm(instruction);
        
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
            } else {
              // Prefer event in current view over others when ambiguous
              const byView = candidates.find(c => {
                if (c.kind !== 'event') return false;
                try {
                  const ev = focusedContext.events.find(e => e.id === c.id);
                  return ev && ev.source === 'view';
                } catch { return false; }
              });
              if (byView) { targetId = byView.id; targetKind = byView.kind; }
            }
          }
        }
        
        // Fallback to explicit where.id
        if (!targetId && where && Number.isFinite(where.id)) {
          targetId = where.id;
          // Try to determine kind by checking both tasks and events
          const tasksInContext = (focusedContext && Array.isArray(focusedContext.tasks)) ? focusedContext.tasks : [];
          const eventsInContext = (focusedContext && Array.isArray(focusedContext.events)) ? focusedContext.events : [];
          if (tasksInContext.find(t => t.id === targetId)) {
            targetKind = 'task';
          } else if (eventsInContext.find(e => e.id === targetId)) {
            targetKind = 'event';
          }
        }
        
        // Last resort: title matching using events/tasks in focused context (prefer events in view)
        if (!targetId) {
          try {
            // Look for event title matches first, to support time changes like "move lunch to 1 pm"
            const matchEvents = Array.isArray(focusedContext.events) ? focusedContext.events.filter(e => {
              const t = norm(e.title);
              return t && normalizedInstruction.includes(t);
            }) : [];
            if (matchEvents.length) {
              // Prefer those in the current view window, else the earliest in next_month
              const inView = matchEvents.filter(e => e.source === 'view');
              const pick = (arr) => arr.slice().sort((a,b) => String(a.scheduledFor||'').localeCompare(String(b.scheduledFor||'')) || (a.id - b.id))[0];
              const chosen = inView.length ? pick(inView) : pick(matchEvents);
              if (chosen) { targetId = chosen.id; targetKind = 'event'; }
            }
            // If no event match, try tasks
            if (!targetId && Array.isArray(focusedContext.tasks)) {
              const matchTasks = focusedContext.tasks.filter(t => {
                const tt = norm(t.title);
                return tt && normalizedInstruction.includes(tt);
              });
              if (matchTasks.length) {
                const chosen = matchTasks.slice().sort((a,b)=> (a.id - b.id))[0];
                if (chosen) { targetId = chosen.id; targetKind = 'task'; }
              }
            }
          } catch {}
        }
        
        if (targetId && (inferredTime || lower.includes('time') || /\b(\d{1,2})(am|pm)\b/.test(lower))) {
          const inferred = { kind: targetKind, action: 'update', id: targetId };
          if (inferredTime && targetKind === 'event') {
            inferred.startTime = inferredTime;
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
              try { const { code } = getModels(); logIO('ops_agent_fallback', { model: code, prompt: JSON.stringify({ instruction }), output: JSON.stringify({ inferred }), meta: { correlationId } }); } catch {}
            }
          }
        }
      } else if (isCreateLike) {
        // Infer a simple event.create from natural language like: "add an event for today called Lunch with Dad at noon"
        const date = inferDateFromInstruction(lower, focusedContext, where, timezone);
        const title = inferTitleFromInstruction(instruction);
        const start = (() => {
          const m = instruction.match(/\b([01]?\d|2[0-3]):[0-5]\d\s*(am|pm)?\b/i);
          const t = m ? normalizeTimeTo24h(m[0]) : inferKeywordTime(lower);
          return t || null;
        })();
        const end = start ? addOneHour(start) : null;
        if (date && title && start && end) {
          const op = { kind: 'event', action: 'create', title, scheduledFor: date, startTime: start, endTime: end, recurrence: { type: 'none' } };
          const type = operationProcessor.inferOperationType(op);
          const validator = operationProcessor.validators.get(type);
          const validation = validator ? await validator(op) : { valid: false, errors: ['unknown_operation_type'] };
          annotations.push({ op, errors: validation.errors || [] });
          if (validation.valid) {
            proposedOps.push(op);
            finalText = finalText || `Here are the proposed changes for your review. (1 valid, 0 invalid)`;
            if (DEBUG) {
              try { const { code } = getModels(); logIO('ops_agent_fallback', { model: code, prompt: JSON.stringify({ instruction }), output: JSON.stringify({ inferredCreate: op }), meta: { correlationId } }); } catch {}
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
