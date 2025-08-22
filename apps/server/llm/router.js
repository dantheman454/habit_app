// Router orchestrator for the two‑LLM pipeline
// Decision: chat | act

import { qwenConvoLLM, getModels } from './clients.js';
import { createQwenPrompt, getQwenFinalResponse } from './qwen_utils.js';
import { buildRouterSnapshots } from './context.js';
import { mkCorrelationId, logIO } from './logging.js';
import { extractFirstJson } from './json_extract.js';
import { qualityMonitor } from './quality_monitor.js';

const CONFIDENCE_THRESHOLD = 0.5;
const TIMEZONE = process.env.TZ_NAME || 'America/New_York';

// Cache models locally for this module so logs and calls stay consistent.
const MODELS = (typeof getModels === 'function') ? getModels() : { convo: process.env.CONVO_MODEL || 'qwen3-coder:30b' };

export async function runRouter({ instruction, transcript = [] }) {
  const msg = String(instruction || '').trim();
  if (!msg) return { decision: 'chat', confidence: 0 };

  const correlationId = mkCorrelationId();
  const startTime = Date.now();
  qualityMonitor.recordRequest(correlationId, 'router', MODELS.convo);
  const today = new Date();
  const todayYmd = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(today).replace(/\//g, '-');
  const last3 = Array.isArray(transcript) ? transcript.slice(-3) : [];
  const convo = last3.map((t) => `- ${t.role}: ${t.text}`).join('\n');
  const snapshots = buildRouterSnapshots({ timezone: TIMEZONE });
  const qwenPrompt = createQwenPrompt({
    system: "You are an intelligent intent router for a todo assistant. Your job is to determine if the user wants to perform an action or just ask a question.",
    user: `Today: ${todayYmd} (${TIMEZONE})
Available Items: ${JSON.stringify(snapshots, null, 2)}
Recent Conversation: ${convo}
User Input: ${msg}

OUTPUT FORMAT: Single JSON object only with these fields:
- decision: "chat" | "act"
- confidence: number (0.0 to 1.0)
- where: object (only for act decisions, optional)

DECISION RULES:
- "act": Use when user wants to perform a concrete action (create, update, delete, complete, etc.)
- "chat": Use for questions, status inquiries, general conversation, or unclear requests

CONFIDENCE SCORING:
- 0.8-1.0: Very clear actionable intent
- 0.6-0.7: Clear actionable intent with some context
- 0.4-0.5: Somewhat clear but could be ambiguous
- 0.0-0.3: Unclear or definitely a question

Is this an actionable request or a question? Respond with JSON only:`
  });

  const raw = await qwenConvoLLM(qwenPrompt, { stream: false, model: MODELS.convo });
  logIO('router', { model: MODELS.convo, prompt: JSON.stringify(qwenPrompt), output: raw, meta: { correlationId, module: 'router' } });
  
  // Extract final response from Qwen response
  const finalResponse = getQwenFinalResponse(raw);
  const parsed = extractFirstJson(String(finalResponse || '')) || {};
  let decision = parsed.decision || 'chat';
  const confidence = Number(parsed.confidence || 0);
  
  // Simple threshold: below 0.5 = chat, above 0.5 = act
  if (confidence < CONFIDENCE_THRESHOLD) {
    decision = 'chat';
  }
  
  // Process where field for act decisions
  let where = parsed.where || null;
  if (decision === 'act' && typeof where === 'string' && where.trim()) {
    // Simple string-to-context conversion
    where = { title_contains: where };
  }

  const result = { 
    decision, 
    confidence, 
    where
  };
  
  // Record quality metrics
  const responseTime = Date.now() - startTime;
  const safeConfidence = typeof result.confidence === 'number' ? result.confidence : 0;
  const errors = [];
  qualityMonitor.recordResponse(correlationId, result, safeConfidence, errors, responseTime);
  
  return result;
}

