import { runRouter } from './router.js';
import { buildRouterContext } from './context.js';
import { mkCorrelationId } from './logging.js';
import db from '../database/DbService.js';

// ConversationAgent: enforces JSON-only outputs and records audit traces.
export async function runConversationAgent({ instruction, transcript = [], timezone } = {}) {
  const ctx = buildRouterContext({ timezone });
  const correlationId = mkCorrelationId();
  
  // Persist compact input to audit log
  try { 
    db.logAudit({ 
      action: 'conversation_agent.input', 
      payload: { 
        instruction: String(instruction || '').slice(0, 1000), 
        transcript: transcript.slice(-3),
        contextSize: Object.keys(ctx).length
      },
      meta: { correlationId }
    }); 
  } catch {}

  const result = await runRouter({ instruction, transcript });

  // Normalize result to expected envelope
  const out = {
    decision: result.decision || 'chat',
    confidence: Number(result.confidence || 0),
    where: result.where || null,
  };

  console.log('Conversation agent router result:', result);
  console.log('Conversation agent normalized output:', out);

  try { 
    db.logAudit({ 
      action: 'conversation_agent.output', 
      payload: out,
      meta: { correlationId }
    }); 
  } catch {}
  return out;
}
