// Router orchestrator for the two‑LLM pipeline
// Decision: chat | plan | clarify

import { harmonyConvoLLM, getModels } from './clients.js';
import { createHarmonyPrompt, getFinalResponse } from './harmony_utils.js';
import { buildRouterSnapshots, topClarifyCandidates } from './context.js';
import { mkCorrelationId, logIO } from './logging.js';
import { extractFirstJson } from './json_extract.js';
import { qualityMonitor } from './quality_monitor.js';

const CLARIFY_THRESHOLD = 0.45;
const CHAT_THRESHOLD = 0.70;
const TIMEZONE = process.env.TZ_NAME || 'America/New_York';

// Cache models locally for this module so logs and calls stay consistent.
const MODELS = (typeof getModels === 'function') ? getModels() : { convo: process.env.CONVO_MODEL || 'qwen3-coder:30b' };

export async function runRouter({ instruction, transcript = [], clarify }) {
  const msg = String(instruction || '').trim();
  if (!msg) return { decision: 'clarify', confidence: 0, question: 'What would you like to do?' };

  const correlationId = mkCorrelationId();
  const startTime = Date.now();
  qualityMonitor.recordRequest(correlationId, 'router', MODELS.convo);
  const today = new Date();
  const todayYmd = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(today).replace(/\//g, '-');
  const last3 = Array.isArray(transcript) ? transcript.slice(-3) : [];
  const convo = last3.map((t) => `- ${t.role}: ${t.text}`).join('\n');
  const snapshots = buildRouterSnapshots({ timezone: TIMEZONE });
  const harmonyPrompt = createHarmonyPrompt({
    system: "You are an intelligent intent router for a todo assistant.",
    developer: `Your job is to understand user intent and route to the appropriate handler.

OUTPUT FORMAT: Single JSON object only with these fields:
- decision: "chat" | "plan" | "clarify"
- confidence: number (0.0 to 1.0)
- question: string (only for clarify decisions)
- where: object (only for plan decisions)
- delegate: object (only for plan decisions)
- options: array (only for clarify decisions)

DECISION RULES:
- "clarify": Use when intent is ambiguous about time/date, target selection, or context
- "plan": Use when intent is clear and actionable
- "chat": Use for general questions, status inquiries, or non-actionable requests

CONFIDENCE SCORING:
- 0.9-1.0: Very clear intent with specific details
- 0.7-0.8: Clear intent with some ambiguity
- 0.5-0.6: Somewhat clear but needs context
- 0.3-0.4: Ambiguous, needs clarification
- 0.0-0.2: Very ambiguous, definitely needs clarification

CONTEXT AWARENESS:
- Consider the current date and timezone
- Use transcript history for context
- Respect user's current view and filters
- Be aware of the current tasks and their states
- Be aware of the current events and their states
- Be aware of the current habits and their states
- Be aware of the current goals and their states`,
    user: `Today: ${todayYmd} (${TIMEZONE})
Current Context: ${JSON.stringify(snapshots, null, 2)}

Recent Conversation (last 3 turns):
${convo}

User Input: ${msg}

Analyze the user's intent carefully. Consider:
1. What specific action do they want to perform?
2. Do they have all necessary information (time, target, context)?
3. Is there ambiguity that needs clarification?
4. What is their confidence level in their request?

Respond with JSON only:`
  });

  const raw = await harmonyConvoLLM(harmonyPrompt, { stream: false, model: MODELS.convo });
  logIO('router', { model: MODELS.convo, prompt: JSON.stringify(harmonyPrompt), output: raw, meta: { correlationId, module: 'router' } });
  
  // Extract final response from Harmony channels
  const finalResponse = getFinalResponse(raw);
  const parsed = extractFirstJson(String(finalResponse || '')) || {};
  let decision = parsed.decision || 'clarify';
  const confidence = Number(parsed.confidence || 0);
  
  if (!(confidence >= CLARIFY_THRESHOLD)) {
    decision = 'clarify';
  }
  
  // Process the LLM's where field - convert string to proper object
  let where = parsed.where || null;
  if (typeof where === 'string' && where.trim()) {
    // Try to find the task by title in all available contexts
    const allItems = [
      ...(snapshots.week?.items || []), 
      ...(snapshots.backlog || [])
    ];
    
    // First try exact match
    let matchingItem = allItems.find(item => 
      item.title && item.title.toLowerCase() === where.toLowerCase()
    );
    
    // If no exact match, try partial match
    if (!matchingItem) {
      matchingItem = allItems.find(item => 
        item.title && item.title.toLowerCase().includes(where.toLowerCase())
      );
    }
    
    if (matchingItem) {
      where = { ids: [matchingItem.id] };
    } else {
      // If no match found in current context, use title_contains to let context builder search broadly
      // This will search in ALL todos, not just the current week
      where = { title_contains: where };
    }
  }

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
      // NEW: Make Sunday the start of week
      const deltaToSun = day; // 0=Sun->0, 1=Mon->1, 2=Tue->2, etc.
      const sunday = addDays(d, -deltaToSun);
      const saturday = addDays(sunday, 6);
      return { from: ymd(sunday), to: ymd(saturday) };
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

    // If the LLM suggested clarify and there are multiple candidates, respect that decision
    if (parsed.decision === 'clarify' && Array.isArray(parsed.options) && parsed.options.length > 1) {
      decision = 'clarify';
    } else if (wantsAction || Object.keys(w).length > 0) {
      // Only force plan if the LLM didn't suggest clarify with multiple options
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
    
    // If the LLM suggested options but we're forcing plan, check if the where context makes sense
    if (decision === 'plan' && where && typeof where === 'object' && where.title_contains) {
      // Check if the title_contains actually matches any tasks in the context
      const allItems = [
        ...(snapshots.week?.items || []), 
        ...(snapshots.backlog || [])
      ];
      const matchingItems = allItems.filter(item => 
        item.title && item.title.toLowerCase().includes(where.title_contains.toLowerCase())
      );
      
      if (matchingItems.length === 0) {
        decision = 'clarify';
        where = null;
      } else if (matchingItems.length > 1) {
        decision = 'clarify';
        where = null;
      }
    }
  } catch {}
  if (clarify && typeof clarify === 'object' && clarify.selection && Array.isArray(clarify.selection.ids) && clarify.selection.ids.length) {
    decision = 'plan';
    where = { ...(where || {}), ids: clarify.selection.ids };
  }
  
  const result = { 
    decision, 
    confidence, 
    question: parsed.question || null, 
    where: where, // Use the processed where object, not parsed.where
    delegate: parsed.delegate || null,
    options: parsed.options || null
  };
  
  if (result.decision === 'clarify') {
    const cands = topClarifyCandidates(msg, snapshots, 5);
    result.question = result.question || 'Which item do you want to update?';
    result.options = cands.map(c => ({ id: c.id, title: c.title, scheduledFor: c.scheduledFor ?? null }));
  }
  
  // Record quality metrics
  const responseTime = Date.now() - startTime;
  const safeConfidence = typeof result.confidence === 'number' ? result.confidence : 0;
  const errors = result.decision === 'clarify' && safeConfidence < CLARIFY_THRESHOLD ? ['Low confidence routing'] : [];
  qualityMonitor.recordResponse(correlationId, result, safeConfidence, errors, responseTime);
  
  return result;
}

