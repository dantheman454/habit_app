// Chat responder for conversational replies (no operations)

import { generateText, getModels } from './clients.js';
import { createPrompt, getFinalText } from './prompt.js';
import { buildQAContext } from './context.js';
import { mkCorrelationId, logIO } from './logging.js';

const TIMEZONE = process.env.TZ_NAME || 'America/New_York';

export async function runChat({ instruction, transcript = [], timezone } = {}) {
  const msg = String(instruction || '').trim();
  if (!msg) return 'How can I help?';

  const correlationId = mkCorrelationId();
  const today = new Date();
  const todayYmd = new Intl.DateTimeFormat('en-CA', { timeZone: timezone || TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(today).replace(/\//g, '-');
  const last3 = Array.isArray(transcript) ? transcript.slice(-3) : [];
  const convoPreview = last3.map((t) => `- ${t.role}: ${t.text}`).join('\n');

  const qa = buildQAContext({ timezone: timezone || TIMEZONE });
  const promptSpec = createPrompt({
    system: 'You are Mr. Assister, a helpful, concise assistant for a tasks/events app. Answer questions about tasks/events using the provided context. If the user asks to perform an action, do not modify data — only explain what you can do.',
    user: `Today: ${todayYmd} (${timezone || TIMEZONE})\nRecent conversation:\n${convoPreview || '(none)'}\n\nContext (QA):\n${JSON.stringify(qa, null, 2)}\n\nUser: ${msg}\n\nGuidelines:\n- Keep it short and actionable (1-3 sentences)\n- Plain text only (no markdown)\n- If needed info is missing, ask a short clarifying question.\n- Use the provided context; do not invent data or IDs.\n\nRespond:`
  });

  const { convo } = getModels();
  const raw = await generateText(promptSpec, { stream: false, model: convo });
  try {
    logIO('chat', { model: convo, prompt: JSON.stringify(promptSpec), output: JSON.stringify(raw), meta: { correlationId, module: 'chat', qa } });
  } catch {}

  const finalResponse = getFinalText(raw);
  const text = String(finalResponse || '').trim();
  return text || 'Okay.';
}
