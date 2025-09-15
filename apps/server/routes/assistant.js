import { Router } from 'express';
import { mkCorrelationId, logIO } from '../llm/logging.js';
import db from '../database/DbService.js';
import { runOpsAgentToolCalling } from '../llm/ops_agent.js';
import { runOpsGraph, resumeRun } from '../llm/ops_graph.js';
import { runChat } from '../llm/chat.js';
import { routeAssistant, routeAssistantHybrid } from '../llm/orchestrator.js';

const router = Router();
const DEBUG = /^(1|true|yes|on)$/i.test(String(process.env.ASSISTANT_DEBUG || ''));
const TIMEZONE = process.env.TZ_NAME || 'America/New_York';

// Store the operation processor reference
let operationProcessor = null;

// Function to set the operation processor
export function setOperationProcessor(processor) {
  operationProcessor = processor;
}

function filterLLMResponse(data) {
  if (typeof data === 'string') {
    try {
      const parsed = JSON.parse(data);
      const filtered = { ...parsed };
      delete filtered.context;
      delete filtered.created_at;
      delete filtered.model;
      delete filtered.done_reason;
      return JSON.stringify(filtered);
    } catch {
      return data;
    }
  }
  return data;
}

function ensureSummaryText(text, operations = [], notes = {}) {
  const t = String(text || '').trim();
  if (t) return t;
  const valid = Array.isArray(operations) ? operations.length : 0;
  const invalid = Array.isArray(notes?.errors) ? notes.errors.length : 0;
  if (valid === 0 && invalid === 0) return 'No actionable changes detected.';
  const parts = [];
  if (valid > 0) parts.push(`${valid} proposed`);
  if (invalid > 0) parts.push(`${invalid} invalid`);
  return `Here are the proposed changes for your review (${parts.join(', ')}).`;
}

function buildOpKey(op) {
  try {
    return [
      op.kind || 'task',
      op.action || op.op || 'create',
      op.id || '',
      op.scheduledFor || '',
      op.startTime || '',
      op.title || '',
      op.status || '',
      op.occurrenceDate || ''
    ].join('|');
  } catch {
    return '';
  }
}

async function buildPreviews(ops) {
  const out = [];
  try {
    const arr = Array.isArray(ops) ? ops : [];
    for (const op of arr) {
      const action = String(op.action || op.op || '').toLowerCase();
      const kind = String(op.kind || 'task').toLowerCase();
      const needsBefore = ['update','delete','complete','set_status','complete_occurrence'].includes(action);
      let before = null;
      if (needsBefore && op.id != null) {
        try {
          const id = Number(op.id);
          if (Number.isFinite(id)) {
            if (kind === 'event') before = await db.getEventById(id);
            else before = await db.getTaskById(id);
          }
        } catch {}
      }
      out.push({ key: buildOpKey(op), op, before });
    }
  } catch {}
  return out;
}

router.post('/api/assistant/message', async (req, res) => {
  try {
    const { message, transcript = [], options } = req.body || {};
    // Accept optional client-provided focus hints
    const client = options?.client || {};
    const where = client?.where || req.body?.where || {};
    const correlationId = mkCorrelationId();
    if (typeof message !== 'string' || message.trim() === '') {
      return res.status(400).json({ error: 'invalid_message' });
    }
    // Orchestrator telemetry placeholder: log router disabled → default to ops
  const ORCHESTRATOR_ENABLED = /^(1|true|yes|on)$/i.test(String(process.env.ORCHESTRATOR_ENABLED || '1'));
    const GRAPH_ENABLED = /^(1|true|yes|on)$/i.test(String(process.env.ASSISTANT_GRAPH_ENABLED || '1'));
    let route = { decision: 'ops', reason: 'router_disabled', hints: null };
    if (ORCHESTRATOR_ENABLED) {
  const HYBRID = /^(1|true|yes|on)$/i.test(String(process.env.ORCHESTRATOR_HYBRID || '1'));
      if (HYBRID) {
        route = await routeAssistantHybrid({ message, where, transcript, correlationId });
      } else {
        route = routeAssistant({ message, where, transcript, correlationId });
      }
    } else {
      try { logIO('assistant_orchestrator_decision', { model: 'orchestrator', prompt: JSON.stringify({ message, where }), output: JSON.stringify(route), meta: { correlationId } }); } catch {}
    }

    let oa;
    try {
      if (route.decision === 'chat') {
  const text = await runChat({ instruction: message.trim(), transcript, timezone: TIMEZONE });
  const summaryText = ensureSummaryText(text, [], {});
  return res.json({ text: summaryText, operations: [], correlationId, validCount: 0, invalidCount: 0, previews: [], fingerprint: route.fingerprint || null });
      }
      if (route.decision === 'clarify') {
        const q = String(route.clarifyQuestion || '').trim() || 'Could you clarify your request?';
        return res.json({ text: q, operations: [], correlationId, validCount: 0, invalidCount: 0, previews: [], fingerprint: route.fingerprint || null });
      }
      const whereMerged = { ...(where || {}), ...(route?.hints ? { hints: route.hints } : {}) };
      if (GRAPH_ENABLED) {
        oa = await runOpsGraph({ instruction: message.trim(), where: whereMerged, transcript, timezone: TIMEZONE }, { operationProcessor });
      } else {
        oa = await runOpsAgentToolCalling({ taskBrief: message.trim(), where: whereMerged, transcript, timezone: TIMEZONE, operationProcessor });
      }
      if (DEBUG) {
        try {
          const dbg = {
            text: oa.text,
            validOps: Array.isArray(oa.operations) ? oa.operations.length : 0,
            invalid: Array.isArray(oa.notes?.errors) ? oa.notes.errors.length : 0,
            kinds: Array.isArray(oa.operations) ? Array.from(new Set(oa.operations.map(o => o.kind))) : []
          };
          console.log('[Assistant] response', dbg);
          try { logIO('assistant_ops_summary', { model: 'ops_agent', prompt: JSON.stringify({ message, transcript, where }), output: JSON.stringify(dbg), meta: { correlationId } }); } catch {}
        } catch {}
      }
    } catch (err) {
      const lower = message.toLowerCase();
      let guidance = 'I could not propose any changes.';
      if (/(add|create|schedule)\b/.test(lower)) {
        guidance += ' Try: "add an event called Meeting at 14:00 tomorrow" or "create a task titled Groceries for 2025-09-10".';
      } else if (/(update|change|modify|move|reschedule|set)\b/.test(lower)) {
        guidance += ' Try: "update Lunch with Dad to 13:00 today" or "set task \"Groceries\" status to completed".';
      } else if (/(delete|remove|cancel)\b/.test(lower)) {
        guidance += ' Try: "delete the event \"Lunch with Dad\" today" or "delete task \"Groceries\"".';
      } else {
        guidance += ' Use explicit actions like add/create, update/set, or delete, with specific titles and dates.';
      }
      return res.json({ text: guidance, operations: [], correlationId, fingerprint: route.fingerprint || null, error: true });
    }
  const summaryText = ensureSummaryText(oa.text, oa.operations, oa.notes);
    const validCount = Array.isArray(oa.operations) ? oa.operations.length : 0;
    const invalidCount = Array.isArray(oa.notes?.errors) ? oa.notes.errors.length : 0;
    let previews = [];
    try { previews = await buildPreviews(oa.operations); } catch {}
    if (DEBUG) {
      try { logIO('assistant_response', { model: 'ops_agent', prompt: JSON.stringify({ message }), output: JSON.stringify({ text: summaryText, validCount, invalidCount }), meta: { correlationId } }); } catch {}
    }
  return res.json({ text: summaryText, steps: oa.steps, operations: oa.operations, tools: oa.tools, notes: oa.notes, correlationId, validCount, invalidCount, thinking: oa.thinking, previews, fingerprint: route.fingerprint || null });
  } catch (err) {
    console.error('Assistant route error:', err);
    res.status(502).json({ error: 'assistant_failure', detail: String(err && err.message ? err.message : err) });
  }
});

router.get('/api/assistant/message/stream', async (req, res) => {
  let __heartbeat;
  try {
    const message = String(req.query.message || '');
    const transcriptParam = req.query.transcript;
    const transcript = (() => { try { return Array.isArray(transcriptParam) ? transcriptParam : JSON.parse(String(transcriptParam || '[]')); } catch { return []; } })();
    // Accept optional client-provided focus hints from query `context` JSON
    const where = (() => { 
      try { 
        const ctx = JSON.parse(String(req.query.context || '{}'));
        return ctx?.where || {}; 
      } catch { 
        return {}; 
      } 
    })();
    if (message.trim() === '') return res.status(400).json({ error: 'invalid_message' });
    const correlationId = mkCorrelationId();
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    const send = (event, data) => { const filteredData = filterLLMResponse(data); res.write(`event: ${event}\n`); res.write(`data: ${filteredData}\n\n`); };

    // Heartbeat every 10 seconds
    try { clearInterval(__heartbeat); } catch {}
    __heartbeat = setInterval(() => { try { send('heartbeat', JSON.stringify({ t: Date.now(), correlationId })); } catch {} }, 10000);

    // Local ops agent (Ollama-backed) streaming
    try {
      // Emit route stage first (backward compatible)
      send('stage', JSON.stringify({ stage: 'route', correlationId }));
      // Optional resume: if resume_correlation_id is provided and graph is enabled, replay prior stages
      const GRAPH_ENABLED = /^(1|true|yes|on)$/i.test(String(process.env.ASSISTANT_GRAPH_ENABLED || '1'));
      const resumeCid = String(req.query.resume_correlation_id || '').trim();
      if (GRAPH_ENABLED && resumeCid) {
        try {
          const resume = resumeRun({ correlationId: resumeCid, onStage: (stage, meta) => { try { send('stage', JSON.stringify({ stage, correlationId: meta?.correlationId || resumeCid })); } catch {} } });
          if (DEBUG) { try { console.log('[Assistant][SSE] resume stages', resume); } catch {} }
        } catch {}
      }
      // Orchestrator: decide chat vs ops
  const ORCHESTRATOR_ENABLED = /^(1|true|yes|on)$/i.test(String(process.env.ORCHESTRATOR_ENABLED || '1'));
      let route = { decision: 'ops', reason: 'router_disabled', hints: null };
      if (ORCHESTRATOR_ENABLED) {
  const HYBRID = /^(1|true|yes|on)$/i.test(String(process.env.ORCHESTRATOR_HYBRID || '1'));
        if (HYBRID) {
          route = await routeAssistantHybrid({ message, where, transcript, correlationId });
        } else {
          route = routeAssistant({ message, where, transcript, correlationId });
        }
      } else {
        try { logIO('assistant_orchestrator_decision', { model: 'orchestrator', prompt: JSON.stringify({ message, where }), output: JSON.stringify(route), meta: { correlationId } }); } catch {}
      }
      send('stage', JSON.stringify({ stage: 'act', correlationId, fingerprint: route.fingerprint || null }));
      let oa;
      try {
        if (route.decision === 'chat') {
          const text = await runChat({ instruction: message.trim(), transcript, timezone: TIMEZONE });
          send('summary', JSON.stringify({ text: ensureSummaryText(text, [], {}), correlationId, fingerprint: route.fingerprint || null }));
          send('done', JSON.stringify({ correlationId }));
          res.end();
          return;
        }
        if (route.decision === 'clarify') {
          const q = String(route.clarifyQuestion || '').trim() || 'Could you clarify your request?';
          send('summary', JSON.stringify({ text: q, correlationId, fingerprint: route.fingerprint || null }));
          send('done', JSON.stringify({ correlationId }));
          res.end();
          return;
        }
        const whereMerged = { ...(where || {}), ...(route?.hints ? { hints: route.hints } : {}) };
        if (GRAPH_ENABLED) {
          oa = await runOpsGraph(
            { instruction: message.trim(), where: whereMerged, transcript, timezone: TIMEZONE, correlationId },
            {
              operationProcessor,
              onStage: (stage, meta) => {
                try { send('stage', JSON.stringify({ stage, correlationId: meta?.correlationId })); } catch {}
              }
            }
          );
        } else {
          oa = await runOpsAgentToolCalling({ taskBrief: message.trim(), where: whereMerged, transcript, timezone: TIMEZONE, operationProcessor });
        }
      } catch (err) {
        const lower = message.toLowerCase();
        let guidance = 'I could not propose any changes.';
        if (/(add|create|schedule)\b/.test(lower)) {
          guidance += ' Try: "add an event called Meeting at 14:00 tomorrow" or "create a task titled Groceries for 2025-09-10".';
        } else if (/(update|change|modify|move|reschedule|set)\b/.test(lower)) {
          guidance += ' Try: "update Lunch with Dad to 13:00 today" or "set task \"Groceries\" status to completed".';
        } else if (/(delete|remove|cancel)\b/.test(lower)) {
          guidance += ' Try: "delete the event \"Lunch with Dad\" today" or "delete task \"Groceries\"".';
        } else {
          guidance += ' Use explicit actions like add/create, update/set, or delete, with specific titles and dates.';
        }
        send('summary', JSON.stringify({ text: ensureSummaryText(guidance, [], {}), correlationId, fingerprint: route.fingerprint || null }));
        send('done', JSON.stringify({ correlationId }));
        res.end();
        return;
      }
  const summaryText = ensureSummaryText(oa.text, oa.operations, oa.notes);
      const validCount = Array.isArray(oa.operations) ? oa.operations.length : 0;
      const invalidCount = Array.isArray(oa.notes?.errors) ? oa.notes.errors.length : 0;
      let previews = [];
      try { previews = await buildPreviews(oa.operations); } catch {}
  send('ops', JSON.stringify({
        operations: oa.operations,
        version: 3,
        validCount,
        invalidCount,
    correlationId,
    fingerprint: route.fingerprint || null,
        previews
      }));
  send('summary', JSON.stringify({ text: summaryText, correlationId, fingerprint: route.fingerprint || null }));
      send('done', JSON.stringify({ correlationId }));
      res.end();
    } catch (err) {
      try { clearInterval(__heartbeat); } catch {}
      try { res.end(); } catch {}
    }
  } catch (err) {
    try { clearInterval(__heartbeat); } catch {}
    try { res.end(); } catch {}
  } finally {
    try { clearInterval(__heartbeat); } catch {}
  }
});

export default router;


