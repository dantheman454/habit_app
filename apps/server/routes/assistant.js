import { Router } from 'express';
import { mkCorrelationId, logIO } from '../llm/logging.js';
import db from '../database/DbService.js';
import { runOpsAgentToolCalling } from '../llm/ops_agent.js';
import { runChat } from '../llm/chat.js';

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
    const { message, transcript = [] } = req.body || {};
    const correlationId = mkCorrelationId();
    if (typeof message !== 'string' || message.trim() === '') {
      return res.status(400).json({ error: 'invalid_message' });
    }
    let oa;
    try {
      oa = await runOpsAgentToolCalling({ taskBrief: message.trim(), where: {}, transcript, timezone: TIMEZONE, operationProcessor });
      if (DEBUG) {
        try {
          const dbg = {
            text: oa.text,
            validOps: Array.isArray(oa.operations) ? oa.operations.length : 0,
            invalid: Array.isArray(oa.notes?.errors) ? oa.notes.errors.length : 0,
            kinds: Array.isArray(oa.operations) ? Array.from(new Set(oa.operations.map(o => o.kind))) : []
          };
          console.log('[Assistant] response', dbg);
          try { logIO('assistant_ops_summary', { model: 'ops_agent', prompt: JSON.stringify({ message, transcript }), output: JSON.stringify(dbg), meta: { correlationId } }); } catch {}
        } catch {}
      }
    } catch (err) {
      const fallbackText = await (async () => { try { return await runChat({ instruction: message.trim(), transcript, timezone: TIMEZONE }); } catch { return 'Sorry, I could not process that right now.'; } })();
      return res.json({ text: fallbackText, operations: [], correlationId });
    }
    const summaryText = ensureSummaryText(oa.text, oa.operations, oa.notes);
    const validCount = Array.isArray(oa.operations) ? oa.operations.length : 0;
    const invalidCount = Array.isArray(oa.notes?.errors) ? oa.notes.errors.length : 0;
    let previews = [];
    try { previews = await buildPreviews(oa.operations); } catch {}
    if (DEBUG) {
      try { logIO('assistant_response', { model: 'ops_agent', prompt: JSON.stringify({ message }), output: JSON.stringify({ text: summaryText, validCount, invalidCount }), meta: { correlationId } }); } catch {}
    }
    return res.json({ text: summaryText, steps: oa.steps, operations: oa.operations, tools: oa.tools, notes: oa.notes, correlationId, validCount, invalidCount, thinking: oa.thinking, previews });
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
      send('stage', JSON.stringify({ stage: 'act', correlationId }));
      let oa;
      try {
        oa = await runOpsAgentToolCalling({ taskBrief: message.trim(), where: {}, transcript, timezone: TIMEZONE, operationProcessor });
      } catch (err) {
        const fallbackText = await (async () => { try { return await runChat({ instruction: message.trim(), transcript, timezone: TIMEZONE }); } catch { return 'Sorry, I could not process that right now.'; } })();
        send('summary', JSON.stringify({ text: fallbackText, operations: [], correlationId }));
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
        previews
      }));
      send('summary', JSON.stringify({ text: summaryText, steps: oa.steps, operations: oa.operations, tools: oa.tools, notes: oa.notes, correlationId, thinking: oa.thinking }));
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


