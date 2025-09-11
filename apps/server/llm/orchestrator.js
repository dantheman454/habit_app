// Lightweight router/orchestrator for assistant requests (feature-flagged)
// Decides whether to invoke the ops agent (tool-calling) or the chat responder.

import { mkCorrelationId, logIO } from './logging.js';
import { generateStructured, getModels } from './clients.js';
import crypto from 'node:crypto';

function isQuestionLike(text) {
  const t = (text || '').trim().toLowerCase();
  if (!t) return false;
  if (t.includes('?')) return true;
  return /^(what|how|why|where|who|which|when|can|could|should|do|does|did|is|are|am|will|would|may|might)\b/.test(t);
}

function isActionLike(text) {
  const t = (text || '').trim().toLowerCase();
  if (!t) return false;
  // Common verbs for data-changing intents
  return /(add|create|schedule|update|change|modify|move|reschedule|set|complete|mark|finish|delete|remove|cancel)\b/.test(t);
}

export function routeAssistant({ message, where, transcript, correlationId = mkCorrelationId() }) {
  const hints = {};
  const lower = String(message || '').toLowerCase();
  let decision = 'ops';
  let reason = 'default_ops';

  if (isQuestionLike(lower) && !isActionLike(lower)) {
    decision = 'chat';
    reason = 'question_like';
  } else if (isActionLike(lower)) {
    decision = 'ops';
    reason = 'action_like';
  }

  try {
    logIO('assistant_orchestrator_decision', {
      model: 'orchestrator',
      prompt: JSON.stringify({ message, where, transcriptPreview: Array.isArray(transcript) ? transcript.slice(-2) : [] }),
      output: JSON.stringify({ decision, reason, hints }),
      meta: { correlationId }
    });
  } catch {}

  return { decision, reason, hints };
}

// Compute a stable fingerprint for a routing request
function computeFingerprint({ message, where, transcript }) {
  const payload = {
    m: String(message || '').trim(),
    // Only include minimal context that affects intent
    w: where && typeof where === 'object' ? { view: where.view || null, kind: where.kind || null } : null,
    t: Array.isArray(transcript) ? transcript.slice(-2).map(x => ({ role: x.role, text: x.text })) : []
  };
  const s = JSON.stringify(payload);
  return crypto.createHash('sha256').update(s).digest('hex');
}

// LLM-based classifier; returns { decision, reason, confidence, hints?, clarifyQuestion? }
async function classifyWithLLM({ message, where, transcript, correlationId }) {
  const { code } = getModels();
  const model = process.env.ORCHESTRATOR_MODEL || code;
  const system = 'You are an intent router for a tasks/events assistant. Output ONLY JSON with: { decision: "ops"|"chat"|"clarify", reason: string, confidence?: number, hints?: { kind?: "task"|"event", title?: string, date?: string, time?: string }, clarifyQuestion?: string }';
  const user = `Message: ${String(message || '').trim()}\nWhere: ${JSON.stringify(where ? { view: where.view || null, kind: where.kind || null } : null)}\nTranscript preview: ${JSON.stringify(Array.isArray(transcript) ? transcript.slice(-2).map(x=>({role:x.role,text:x.text})) : [])}\n\nRules:\n- chat: informational questions or non-actionable asks.\n- ops: explicit create/update/delete/set/complete requests.\n- clarify: ambiguous intent; include ONE short question in clarifyQuestion.\nRespond with a single JSON object.`;
  const prompt = { system, user };
  const timeoutMs = Number(process.env.ORCHESTRATOR_TIMEOUT_MS || 15000);
  let raw;
  try {
    raw = await generateStructured(prompt, { model, timeoutMs });
  } catch (e) {
    try { logIO('assistant_orchestrator_classifier_error', { model, error: String(e?.message || e), meta: { correlationId } }); } catch {}
    return { decision: 'chat', reason: 'router_timeout', confidence: null };
  }
  let parsed = {};
  try { parsed = JSON.parse(typeof raw === 'string' ? raw : raw.final || '{}'); } catch {}
  // Normalize
  const d = String(parsed.decision || '').toLowerCase();
  let decision = (d === 'chat' || d === 'clarify') ? d : 'ops';
  const hints = (parsed && typeof parsed.hints === 'object') ? parsed.hints : undefined;
  const clarifyQuestion = decision === 'clarify' && typeof parsed.clarifyQuestion === 'string' ? parsed.clarifyQuestion : undefined;
  let reason = typeof parsed.reason === 'string' && parsed.reason ? parsed.reason : 'llm_classifier';
  let confidence = Number(parsed.confidence);
  if (!Number.isFinite(confidence)) confidence = null;
  try { logIO('assistant_orchestrator_classifier', { model, prompt: JSON.stringify(prompt), output: JSON.stringify({ decision, reason, confidence, hints, clarify: !!clarifyQuestion }), meta: { correlationId } }); } catch {}
  return { decision, reason, confidence, hints, clarifyQuestion };
}

// Internal classifier reference for DI in tests
let _classifier = classifyWithLLM;
export function __setClassifier(fn) { if (typeof fn === 'function') _classifier = fn; }

// Hybrid router: cache → heuristics → LLM (if enabled)
export async function routeAssistantHybrid({ message, where, transcript, correlationId = mkCorrelationId() }) {
  const fp = computeFingerprint({ message, where, transcript });
  // Start with heuristic
  const base = routeAssistant({ message, where, transcript, correlationId });
  let result = { ...base, fingerprint: fp };
  const ENABLE_CLASSIFIER = /^(1|true|yes|on)$/i.test(String(process.env.ORCHESTRATOR_CLASSIFIER_ENABLED || ''));
  if (ENABLE_CLASSIFIER) {
    try {
      const llm = await _classifier({ message, where, transcript, correlationId });
      // If LLM strongly prefers chat (confidence >= 0.6) or differs from heuristic, or requests clarify, adopt it
      if (llm && (llm.confidence == null || llm.confidence >= 0.6 || llm.decision !== base.decision || llm.decision === 'clarify')) {
        result = { decision: llm.decision, reason: llm.reason, confidence: llm.confidence, hints: llm.hints, clarifyQuestion: llm.clarifyQuestion, fingerprint: fp };
      }
    } catch (e) {
      // fall back to heuristic
    }
  }
  return result;
}
