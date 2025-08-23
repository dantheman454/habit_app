import { Router } from 'express';
import { mkCorrelationId } from '../llm/logging.js';
import { runConversationAgent } from '../llm/conversation_agent.js';
import { runOpsAgentToolCalling } from '../llm/ops_agent.js';
import { runChat } from '../llm/chat.js';

const router = Router();
const TIMEZONE = process.env.TZ_NAME || 'America/New_York';

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

router.post('/api/assistant/message', async (req, res) => {
  try {
    const { message, transcript = [] } = req.body || {};
    const correlationId = mkCorrelationId();
    if (typeof message !== 'string' || message.trim() === '') {
      return res.status(400).json({ error: 'invalid_message' });
    }
    const ca = await runConversationAgent({ instruction: message.trim(), transcript, timezone: TIMEZONE });
    if (ca.decision === 'chat') {
      const chatText = await runChat({ instruction: message.trim(), transcript, timezone: TIMEZONE });
      return res.json({ text: chatText, operations: [], correlationId });
    }
    let oa;
    try {
      oa = await runOpsAgentToolCalling({ taskBrief: message.trim(), where: ca.where, transcript, timezone: TIMEZONE });
    } catch (err) {
      const fallbackText = await (async () => { try { return await runChat({ instruction: message.trim(), transcript, timezone: TIMEZONE }); } catch { return 'Sorry, I could not process that right now.'; } })();
      return res.json({ text: fallbackText, operations: [], correlationId });
    }
    const summaryText = String(oa.text || '').trim();
    return res.json({ text: summaryText, steps: oa.steps, operations: oa.operations, tools: oa.tools, notes: oa.notes, correlationId });
  } catch (err) {
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
    send('stage', JSON.stringify({ stage: 'routing', correlationId }));
    const ca = await runConversationAgent({ instruction: message.trim(), transcript, timezone: TIMEZONE });
    if (ca.decision === 'chat') {
      const chatText = await runChat({ instruction: message.trim(), transcript, timezone: TIMEZONE });
      send('summary', JSON.stringify({ text: chatText, operations: [], correlationId }));
      send('done', JSON.stringify({ correlationId }));
      res.end();
      return;
    }
    send('stage', JSON.stringify({ stage: 'act', correlationId }));
    let oa;
    try {
      oa = await runOpsAgentToolCalling({ taskBrief: message.trim(), where: ca.where, transcript, timezone: TIMEZONE });
    } catch (err) {
      const fallbackText = await (async () => { try { return await runChat({ instruction: message.trim(), transcript, timezone: TIMEZONE }); } catch { return 'Sorry, I could not process that right now.'; } })();
      send('summary', JSON.stringify({ text: fallbackText, operations: [], correlationId }));
      send('done', JSON.stringify({ correlationId }));
      res.end();
      return;
    }
    const summaryText = String(oa.text || '').trim();
    send('summary', JSON.stringify({ text: summaryText, steps: oa.steps, operations: oa.operations, tools: oa.tools, notes: oa.notes, correlationId }));
    send('done', JSON.stringify({ correlationId }));
    res.end();
  } catch (err) {
    try { clearInterval(__heartbeat); } catch {}
    try { res.end(); } catch {}
  }
});

export default router;


