// Repair orchestrator for fixing common operation issues

import { codeLLM, getModels } from './clients.js';
import { mkCorrelationId, logIO } from './logging.js';
import { extractFirstJson } from './json_extract.js';

const TIMEZONE = process.env.TZ_NAME || 'America/New_York';
const MODELS = (typeof getModels === 'function') ? getModels() : { code: process.env.CODE_MODEL || 'granite-code:8b' };

export async function runRepair({ errors, original, focusedContext }) {
  if (!Array.isArray(errors) || !errors.length) {
    return { operations: Array.isArray(original) ? original : [] };
  }

  const correlationId = mkCorrelationId();
  
  // Build repair prompt with specific error details
  const errorDetails = errors.map((err, index) => {
    const op = err.op || {};
    return `Operation ${index + 1}: ${JSON.stringify(op)}\nErrors: ${Array.isArray(err.errors) ? err.errors.join(', ') : 'unknown'}`;
  }).join('\n\n');

  const system = `You are a repair agent for todo app operations. Fix the invalid operations by addressing the specific errors. Common fixes:
- Add missing timeOfDay when updating time-related fields
- Add missing recurrence field for create/update operations
- Ensure scheduledFor is present when recurrence.type != 'none'
- Fix invalid date/time formats
- Add missing IDs for update/delete operations

Output ONLY a JSON object with an "operations" array containing the repaired operations.`;

  const prompt = `You are a repair assistant for todo operations. Fix the invalid operations below by correcting the errors while preserving valid operations. Output ONLY a single JSON object with an "operations" array.

Errors to fix:
${errorDetails}

Original operations:
${JSON.stringify(original, null, 2)}

Focused context:
${JSON.stringify(focusedContext, null, 2)}

Rules:
- Keep valid operations unchanged
- Fix invalid operations by correcting the errors
- Ensure all required fields are present
- Use only IDs from the focused context
- Include timeOfDay when updating time-related fields
- Include recurrence for create/update operations

Example outputs:

For missing timeOfDay:
{
  "operations": [
    {"kind":"todo","action":"update","id":8,"timeOfDay":"21:00","recurrence":{"type":"every_n_days","intervalDays":2,"until":"2025-12-31"}}
  ]
}

For missing recurrence:
{
  "operations": [
    {"kind":"todo","action":"update","id":8,"scheduledFor":"2025-08-17","recurrence":{"type":"none"}}
  ]
}

For invalid ID:
{
  "operations": [
    {"kind":"todo","action":"update","id":8,"scheduledFor":"2025-08-17","recurrence":{"type":"none"}}
  ]
}`;

  try {
    const raw = await codeLLM(prompt, { stream: false, model: MODELS.code });
    logIO('repair', { model: MODELS.code, prompt, output: raw, meta: { correlationId, module: 'repair' } });
    
    const parsed = extractFirstJson(String(raw || '')) || {};
    const repairedOps = Array.isArray(parsed.operations) ? parsed.operations : [];
    
    return { operations: repairedOps };
  } catch (e) {
    // Fallback to original operations if repair fails
    return { operations: Array.isArray(original) ? original : [] };
  }
}
