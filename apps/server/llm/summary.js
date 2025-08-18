// Summary generator for the two-agent system
// Produces concise plain-text summaries of operations and issues

import { convoLLM, getModels } from './clients.js';
import { mkCorrelationId, logIO } from './logging.js';

const TIMEZONE = process.env.TZ_NAME || 'America/New_York';
const MODELS = (typeof getModels === 'function') ? getModels() : { convo: process.env.CONVO_MODEL || 'llama3.2:3b' };

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

  const system = `You are a helpful assistant for a todo app. Produce a very concise plain-text summary of the plan. If some operations were invalid, mention what is ready vs what needs attention and why. No markdown, no lists, no JSON.`;

  const prompt = [
    system,
    `Today: ${todayYmd} (${timezone || TIMEZONE})`,
    'Ops (compact):',
    ...opSummaries,
    `Issues: ${issues.length > 0 ? issues.join('; ') : 'none'}`,
    'Summary:'
  ].join('\n');

  const raw = await convoLLM(prompt, { stream: false, model: MODELS.convo });
  logIO('summary', { model: MODELS.convo, prompt, output: raw, meta: { correlationId, module: 'summary' } });

  // Clean up the response - remove any markdown or extra formatting
  const summary = String(raw || '').trim()
    .replace(/^```.*\n?/g, '')  // Remove code blocks
    .replace(/```$/g, '')       // Remove trailing code blocks
    .replace(/^[-*]\s*/gm, '')  // Remove list markers
    .replace(/\n{3,}/g, '\n\n') // Normalize line breaks
    .trim();

  return summary || 'Plan ready.';
}
