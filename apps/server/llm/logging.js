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
  // Full console output (always on)
  const bytesIn = entry.prompt.length;
  const bytesOut = (entry.output || '').length;
  console.log(`[LLM:${kind}] model=${model} bytesIn=${bytesIn} bytesOut=${bytesOut}`);
  // Print the full output unmodified to stdout
  try {
    // Separate line to keep headers readable
    console.log(String(entry.output ?? ''));
  } catch {}
}
