import { Router } from 'express';
import { mkCorrelationId, logIO } from '../llm/logging.js';
import { ymdInTimeZone } from '../utils/date.js';
import { convoLLM } from '../llm/clients.js';

const router = Router();
const TIMEZONE = process.env.TZ_NAME || 'America/New_York';

router.post('/api/llm/message', async (req, res) => {
  const correlationId = mkCorrelationId();
  try {
    const { message = '', transcript = [] } = req.body || {};
    const msg = String(message || '').trim();
    if (!msg) return res.status(400).json({ error: 'invalid_message' });
    const todayYmd = ymdInTimeZone(new Date(), TIMEZONE);
    const last3 = Array.isArray(transcript) ? transcript.slice(-3) : [];
    const convo = last3.map((t) => `- ${t.role}: ${t.text}`).join('\n');
    const system = 'You are a helpful assistant for a todo app. Keep answers concise and clear. Prefer 1–3 short sentences; no lists or JSON.';
    const prompt = `${system}\n\nToday: ${todayYmd} (${TIMEZONE})\nConversation (last 3):\n${convo}\nUser: ${msg}`;
    const raw = await convoLLM(prompt, { stream: false });
    logIO('router', { model: 'convo', prompt, output: raw, meta: { correlationId, path: '/api/llm/message' } });
    let text = String(raw || '').replace(/```[\s\S]*?```/g, '').replace(/[\r\n]+/g, ' ').trim();
    if (!text) text = 'Okay.';
    return res.json({ ok: true, text, correlationId });
  } catch (e) {
    logIO('router', { model: 'convo', prompt: '(error)', output: String(e && e.message ? e.message : e), meta: { correlationId, path: '/api/llm/message', error: true } });
    return res.status(502).json({ error: 'llm_failed', correlationId });
  }
});

router.get('/api/llm/health', async (_req, res) => {
  try {
    const { getAvailableModels } = await import('../llm/clients.js');
    const avail = await getAvailableModels();
    const present = Array.isArray(avail.models) ? avail.models.map(m => m.name) : [];
    return res.json({ ok: !!avail.ok, models: present });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e && e.message ? e.message : e) });
  }
});

router.get('/api/llm/quality', (_req, res) => {
  try {
    const { qualityMonitor } = require('../llm/quality_monitor.js');
    const report = qualityMonitor.getQualityReport();
    return res.json({ ok: true, report });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e) });
  }
});

export default router;


