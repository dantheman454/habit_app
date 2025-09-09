// Minimal Ollama client wrappers. Non-breaking: not wired yet.
// Models are configurable via env. Conversation LLM may stream; code LLM is non-streaming by default.

import http from 'node:http';
import { createPrompt, parseResponse } from './prompt.js';

const DEFAULT_CONVO_MODEL = 'qwen3-coder:30b';
const DEFAULT_CODE_MODEL = 'qwen3-coder:30b';
const OLLAMA_HOST = process.env.OLLAMA_HOST || '127.0.0.1';
const OLLAMA_PORT = Number(process.env.OLLAMA_PORT || 11434);
const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 30000);



// Model-agnostic defaults; callers can override per request
const DEFAULT_CONFIG = {
  temperature: Number(process.env.LLM_TEMPERATURE || 0.2),
  top_p: Number(process.env.LLM_TOP_P || 0.9),
  max_tokens: Number(process.env.LLM_MAX_TOKENS || 2048)
};

function postJson(path, body, { timeout = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: OLLAMA_HOST,
      port: OLLAMA_PORT,
      path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
      timeout,
    }, (res) => {
      let s = '';
      res.on('data', (d) => { s += d.toString(); });
      res.on('end', () => resolve({ status: res.statusCode, body: s }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// convoLLM/codeLLM removed (unused)

export function getModels() {
  return { convo: DEFAULT_CONVO_MODEL, code: DEFAULT_CODE_MODEL, host: OLLAMA_HOST, port: OLLAMA_PORT };
}

export async function getAvailableModels() {
  // Ollama: GET /api/tags lists available models
  return new Promise((resolve) => {
    const req = http.request({ host: OLLAMA_HOST, port: OLLAMA_PORT, path: '/api/tags', method: 'GET', headers: { 'Accept': 'application/json' }, timeout: TIMEOUT_MS }, (res) => {
      let s = '';
      res.on('data', (d) => { s += d.toString(); });
      res.on('end', () => {
        try { const j = JSON.parse(s || '{}'); resolve({ ok: res.statusCode === 200, ...j }); }
        catch { resolve({ ok: false, models: [] }); }
      });
    });
    req.on('error', () => resolve({ ok: false, models: [] }));
    req.end();
  });
}



// Model-agnostic LLM functions
export async function generateText(prompt, { model = DEFAULT_CONVO_MODEL, stream = false, config = {} } = {}) {
  const formattedPrompt = typeof prompt === 'string' ? prompt : createPrompt(prompt);
  const finalConfig = { ...DEFAULT_CONFIG, ...config };
  const payload = { model, prompt: formattedPrompt, stream, ...finalConfig };
  const { status, body } = await postJson('/api/generate', payload);
  if (status !== 200) throw new Error(`generateText ${model} failed: ${status}`);
  let responseText = String(body || '');
  if (responseText.includes('"response":')) {
    try { const parsed = JSON.parse(responseText); responseText = parsed.response || responseText; } catch {}
  }
  return parseResponse(responseText);
}

export async function generateStructured(prompt, { model = DEFAULT_CODE_MODEL, config = {} } = {}) {
  return generateText(prompt, { model, stream: false, config });
}
