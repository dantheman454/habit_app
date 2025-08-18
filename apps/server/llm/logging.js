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
  
  // Clean console output - extract and pretty-print JSON response
  const bytesIn = entry.prompt.length;
  const bytesOut = (entry.output || '').length;
  console.log(`[LLM:${kind}] model=${model} bytesIn=${bytesIn} bytesOut=${bytesOut}`);
  
  // Extract and pretty-print the JSON response from Ollama output
  try {
    const ollamaResponse = JSON.parse(entry.output || '{}');
    if (ollamaResponse.response) {
      // Try to parse the inner JSON response
      try {
        const innerResponse = JSON.parse(ollamaResponse.response);
        console.log('📄 Response:', JSON.stringify(innerResponse, null, 2));
      } catch {
        // If inner parsing fails, try to extract JSON from the response
        const responseText = ollamaResponse.response;
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            const extractedJson = JSON.parse(jsonMatch[0]);
            console.log('📄 Response:', JSON.stringify(extractedJson, null, 2));
          } catch {
            console.log('📄 Response:', responseText);
          }
        } else {
          console.log('📄 Response:', responseText);
        }
      }
    } else {
      // Fallback: show the full output if no response field
      console.log('📄 Response:', entry.output);
    }
  } catch {
    // If JSON parsing fails, show the raw output
    console.log('📄 Response:', entry.output);
  }
}
