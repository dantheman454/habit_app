import { Router } from 'express';
import { getAvailableModels, getModels } from '../llm/clients.js';

const router = Router();

router.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// LLM health: report configured model names and availability from Ollama
router.get('/api/llm/health', async (_req, res) => {
  try {
    const configured = getModels();
    const avail = await getAvailableModels();
    const names = Array.isArray(avail.models) ? avail.models.map(m => m.name) : [];
    const present = {
      convo: names.includes(configured.convo),
      code: names.includes(configured.code),
    };
    res.json({ ok: true, configured, available: names, present });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e) });
  }
});

export default router;


