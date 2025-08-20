// Summary generator for the two-agent system
// Produces concise plain-text summaries of operations and issues

import { harmonyConvoLLM, getModels } from './clients.js';
import { createHarmonyPrompt, getFinalResponse } from './harmony_utils.js';
import { mkCorrelationId, logIO } from './logging.js';

const TIMEZONE = process.env.TZ_NAME || 'America/New_York';
const MODELS = (typeof getModels === 'function') ? getModels() : { convo: process.env.CONVO_MODEL || 'gpt-oss:20b' };

export async function runSummary({ operations = [], issues = [], timezone } = {}) {
  if (!operations.length) return 'No operations to perform.';

  const correlationId = mkCorrelationId();
  const today = new Date();
  const todayYmd = new Intl.DateTimeFormat('en-CA', { timeZone: timezone || TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(today).replace(/\//g, '-');

  // Build compact operation summaries
  const opSummaries = operations.map((op, index) => {
    const kind = op.kind || 'unknown';
    const action = op.action || 'unknown';
    const title = op.title || `item ${op.id || index + 1}`;
    return `${index + 1}. ${action} ${kind}: ${title}`;
  });

  const harmonyPrompt = createHarmonyPrompt({
    system: "You are a helpful, concise assistant for a todo application.",
    developer: `Your job is to explain what actions will be taken in clear, user-friendly language.

SUMMARY GUIDELINES:
- Be concise but informative (1-3 sentences)
- Use natural language, not technical terms
- Mention specific items being modified when relevant
- Explain any issues or limitations clearly
- Avoid jargon or technical details
- Focus on what the user will see change

FORMAT RULES:
- No markdown formatting
- No bullet points or lists
- No JSON or technical syntax
- Plain text only
- Use present tense for actions
- Be encouraging and helpful`,
    user: `Today: ${todayYmd} (${timezone || TIMEZONE})

Operations to perform:
${opSummaries.join('\n')}

Issues to address:
${issues.length > 0 ? issues.join('; ') : 'none'}

Generate a clear, user-friendly summary of what will happen:`
  });

  const raw = await harmonyConvoLLM(harmonyPrompt, { stream: false, model: MODELS.convo });
  logIO('summary', { model: MODELS.convo, prompt: JSON.stringify(harmonyPrompt), output: raw, meta: { correlationId, module: 'summary' } });

  // Enhanced response cleaning
  function cleanSummaryResponse(raw) {
    let summary = String(raw || '').trim();
    
    // Remove markdown and formatting
    summary = summary
      .replace(/^```.*\n?/g, '')  // Remove code blocks
      .replace(/```$/g, '')       // Remove trailing code blocks
      .replace(/^[-*]\s*/gm, '')  // Remove list markers
      .replace(/^#+\s*/gm, '')    // Remove headers
      .replace(/\*\*(.*?)\*\*/g, '$1') // Remove bold
      .replace(/\*(.*?)\*/g, '$1')     // Remove italic
      .replace(/\n{3,}/g, '\n\n') // Normalize line breaks
      .trim();
    
    // Ensure it's not too long
    if (summary.length > 500) {
      summary = summary.substring(0, 497) + '...';
    }
    
    return summary || 'Ready to apply your changes.';
  }

  // Extract final response from Harmony channels
  const finalResponse = getFinalResponse(raw);
  const summary = cleanSummaryResponse(finalResponse);
  return summary;
}
