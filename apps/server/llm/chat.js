// Chat responder for conversational replies (no operations)

import { qwenConvoLLM, getModels } from './clients.js';
import { createQwenPrompt, getQwenFinalResponse } from './qwen_utils.js';
import { buildQAContext } from './context.js';
import { mkCorrelationId, logIO } from './logging.js';

const TIMEZONE = process.env.TZ_NAME || 'America/New_York';
const MODELS = { convo: 'qwen3:30b' };

export async function runChat({ instruction, transcript = [], timezone } = {}) {
  const msg = String(instruction || '').trim();
  if (!msg) return 'How can I help?';

  const correlationId = mkCorrelationId();
  const today = new Date();
  const todayYmd = new Intl.DateTimeFormat('en-CA', { timeZone: timezone || TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(today).replace(/\//g, '-');
  const last3 = Array.isArray(transcript) ? transcript.slice(-3) : [];
  const convo = last3.map((t) => `- ${t.role}: ${t.text}`).join('\n');

  const qa = buildQAContext({ timezone: timezone || TIMEZONE });
  const qwenPrompt = createQwenPrompt({
    system: 'You are Mr. Assister, a helpful, concise assistant for a habit/todo app. Answer questions about tasks/events using the provided context. If the user asks to perform an action, do not modify data — only explain what you can do.',
    user: `Today: ${todayYmd} (${timezone || TIMEZONE})\nRecent conversation:\n${convo || '(none)'}\n\nContext (QA):\n${JSON.stringify(qa, null, 2)}\n\nUser: ${msg}\n\nGuidelines:\n- Keep it short and actionable (1-3 sentences)\n- Plain text only (no markdown)\n- If needed info is missing, ask a short clarifying question.\n- Use the provided context; do not invent data or IDs.\n\nRespond:`
  });

  const raw = await qwenConvoLLM(qwenPrompt, { stream: false, model: MODELS.convo });
  logIO('chat', { model: MODELS.convo, prompt: JSON.stringify(qwenPrompt), output: JSON.stringify(raw), meta: { correlationId, module: 'chat' } });

  const finalResponse = getQwenFinalResponse(raw);
  const text = String(finalResponse || '').trim();
  return text || 'Okay.';
}
