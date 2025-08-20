// Structured logging helpers for LLM calls. Non-breaking, can be used incrementally.
import fs from 'node:fs';
import path from 'node:path';

const LOG_DIR = process.env.LLM_LOG_DIR || path.join(process.cwd(), 'logs', 'llm');
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}

function nowIso() { return new Date().toISOString(); }

export function mkCorrelationId() {
  const r = Math.random().toString(36).slice(2, 10);
  const t = Date.now().toString(36);
  return `${t}-${r}`;
}

export function trimStr(s, _max = 8192) {
  // Return unmodified to keep complete records (no trimming).
  return String(s ?? '');
}

// Add response sanitization function
function sanitizeLLMResponse(rawOutput) {
  try {
    // Parse the raw output
    const parsed = JSON.parse(rawOutput);
    
    // Extract only the response field, not metadata
    if (parsed.response) {
      return parsed.response;
    }
    
    // If no response field, return the whole object but remove sensitive fields
    const sanitized = { ...parsed };
    delete sanitized.context;
    delete sanitized.created_at;
    delete sanitized.model;
    delete sanitized.done_reason;
    
    return JSON.stringify(sanitized);
  } catch (e) {
    // If parsing fails, try to extract JSON from text
    const jsonMatch = rawOutput.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const extracted = JSON.parse(jsonMatch[0]);
        return extracted.response || jsonMatch[0];
      } catch {
        return rawOutput;
      }
    }
    return rawOutput;
  }
}

export function logIO(kind, { model, prompt, output, meta = {} }) {
  const entry = {
    ts: nowIso(),
    kind,
    model,
    meta,
    prompt: trimStr(prompt),
    output: trimStr(output),
  };
  const line = JSON.stringify(entry);
  try { fs.appendFileSync(path.join(LOG_DIR, `${kind}.log`), line + '\n'); } catch {}
  
  // Clean console output - extract and pretty-print JSON response
  const bytesIn = entry.prompt.length;
  const bytesOut = (entry.output || '').length;
  console.log(`[LLM:${kind}] model=${model} bytesIn=${bytesIn} bytesOut=${bytesOut}`);
  
  // Use sanitized response for console output
  const sanitized = sanitizeLLMResponse(entry.output || '');
  console.log('📄 Response:', sanitized);
}
