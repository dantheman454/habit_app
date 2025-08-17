// Router orchestrator for the two‑LLM pipeline
// Decision: chat | plan | clarify

import { convoLLM, getModels } from './clients.js';
import { buildRouterSnapshots, topClarifyCandidates } from './context.js';
import { mkCorrelationId, logIO } from './logging.js';
import { extractFirstJson } from './json_extract.js';

const CLARIFY_THRESHOLD = 0.45;
const CHAT_THRESHOLD = 0.70;
const TIMEZONE = process.env.TZ_NAME || 'America/New_York';

// Cache models locally for this module so logs and calls stay consistent.
const MODELS = (typeof getModels === 'function') ? getModels() : { convo: process.env.CONVO_MODEL || 'llama3.2:3b' };

export async function runRouter({ instruction, transcript = [], clarify }) {
  const msg = String(instruction || '').trim();
  if (!msg) return { decision: 'clarify', confidence: 0, question: 'What would you like to do?' };

  const correlationId = mkCorrelationId();
  const today = new Date();
  const todayYmd = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(today).replace(/\//g, '-');
  const last3 = Array.isArray(transcript) ? transcript.slice(-3) : [];
  const convo = last3.map((t) => `- ${t.role}: ${t.text}`).join('\n');
  const snapshots = buildRouterSnapshots({ timezone: TIMEZONE });
  const system = `You are an intent router for a todo assistant. Output JSON only with fields: decision, category, entities, missing, confidence, question.`;
  const prompt = [
    system,
    'If ambiguous about time/date or target, choose clarify and ask ONE short question.',
    'If scope is clearly bulk, prefer plan. If prior clarify selection exists, prefer plan and focus.',
    `Today: ${todayYmd} (${TIMEZONE})`,
    'Confidence thresholds: clarify if confidence < 0.45; chat when ≥ 0.70.',
    'Transcript (last 3):',
    convo,
    'Context (this week + small backlog, completed=false):',
    JSON.stringify(snapshots),
    'User:',
    msg,
  ].join('\n');

  const raw = await convoLLM(prompt, { stream: false, model: MODELS.convo });
  logIO('router', { model: MODELS.convo, prompt, output: raw, meta: { correlationId, module: 'router' } });
  const parsed = extractFirstJson(String(raw || '')) || {};
  let decision = parsed.decision || 'clarify';
  const confidence = Number(parsed.confidence || 0);
  if (!(confidence >= CLARIFY_THRESHOLD)) decision = 'clarify';
  // Inject clarify selection bias
  let where = parsed.where || null;

  // Heuristic bias: if the user's message looks like a concrete action, prefer plan
  // and seed a focused `where`. This helps ensure tools are actually called.
  try {
    const lower = msg.toLowerCase();
    const wantsAction = /\b(update|change|set|reschedul|move|delete|remove|complete|finish|create|add)\b/.test(lower);

    // Extract simple scope hints
  const idMatch = msg.match(/#(\d+)/);

    // Helpers for date ranges
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
    const ymd = (d) => fmt.format(d).replace(/\//g, '-');
    const addDays = (d, n) => { const t = new Date(d.getTime()); t.setDate(t.getDate() + n); return t; };
    const getWeekRange = (d) => {
      const day = d.getDay(); // 0=Sun..6=Sat
      // Make Monday the start of week
      const deltaToMon = (day === 0 ? -6 : 1 - day);
      const monday = addDays(d, deltaToMon);
      const sunday = addDays(monday, 6);
      return { from: ymd(monday), to: ymd(sunday) };
    };

    let forcedPlan = false;
    const w = { ...(where || {}) };

    if (idMatch) {
      forcedPlan = true;
      const id = parseInt(idMatch[1], 10);
      if (Number.isFinite(id)) w.ids = [id];
    }

    // Natural scopes
    if (/(\btoday\b)/.test(lower)) {
      forcedPlan = true;
      const t = ymd(today);
      w.scheduled_range = { from: t, to: t };
    } else if (/(\btomorrow\b)/.test(lower)) {
      forcedPlan = true;
      const tmr = ymd(addDays(today, 1));
      w.scheduled_range = { from: tmr, to: tmr };
    } else if (/\bthis\s+week\b/.test(lower)) {
      forcedPlan = true;
      w.scheduled_range = getWeekRange(today);
    }

    if (/\b(all|everything)\b/.test(lower)) {
      // Keep as a hint; proposal/validation will constrain
      forcedPlan = true;
    }

  // priority removed

    // If message strongly suggests an action or we have a focused where, force plan
    if (wantsAction || Object.keys(w).length > 0) {
      decision = 'plan';
      where = Object.keys(w).length ? w : where;
    } else {
      // If the fuzzy match finds one clear candidate, treat that as focused context
      try {
        const cands = topClarifyCandidates(msg, snapshots, 1);
        if (Array.isArray(cands) && cands.length === 1) {
          decision = 'plan';
          where = { ...(where || {}), ids: [cands[0].id] };
        }
      } catch {}
    }
  } catch {}
  if (clarify && typeof clarify === 'object' && clarify.selection && Array.isArray(clarify.selection.ids) && clarify.selection.ids.length) {
    decision = 'plan';
    where = { ...(where || {}), ids: clarify.selection.ids };
  }
  const result = { decision, confidence, question: parsed.question || null, where };
  if (result.decision === 'clarify') {
    const cands = topClarifyCandidates(msg, snapshots, 5);
    result.question = result.question || 'Which item do you want to update?';
    result.options = cands.map(c => ({ id: c.id, title: c.title, scheduledFor: c.scheduledFor ?? null }));
  }
  return result;
}

