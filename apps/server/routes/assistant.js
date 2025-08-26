import { Router } from 'express';
import { mkCorrelationId } from '../llm/logging.js';
import { runOpsAgentToolCalling } from '../llm/ops_agent.js';
import { runChat } from '../llm/chat.js';

const router = Router();
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
    } catch (err) {
      const fallbackText = await (async () => { try { return await runChat({ instruction: message.trim(), transcript, timezone: TIMEZONE }); } catch { return 'Sorry, I could not process that right now.'; } })();
      return res.json({ text: fallbackText, operations: [], correlationId });
    }
    const summaryText = ensureSummaryText(oa.text, oa.operations, oa.notes);
    const validCount = Array.isArray(oa.operations) ? oa.operations.length : 0;
    const invalidCount = Array.isArray(oa.notes?.errors) ? oa.notes.errors.length : 0;
    return res.json({ text: summaryText, steps: oa.steps, operations: oa.operations, tools: oa.tools, notes: oa.notes, correlationId, validCount, invalidCount, thinking: oa.thinking });
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

    // Single-call path (hard-enabled)
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
    
    // Send ops event before summary
    send('ops', JSON.stringify({
      operations: oa.operations,
      version: 3,
      validCount,
      invalidCount,
      correlationId
    }));
    
    send('summary', JSON.stringify({ text: summaryText, steps: oa.steps, operations: oa.operations, tools: oa.tools, notes: oa.notes, correlationId, thinking: oa.thinking }));
    send('done', JSON.stringify({ correlationId }));
    res.end();
  } catch (err) {
    try { clearInterval(__heartbeat); } catch {}
    try { res.end(); } catch {}
  } finally {
    try { clearInterval(__heartbeat); } catch {}
  }
});

export default router;


