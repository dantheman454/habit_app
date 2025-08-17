// Minimal Ollama client wrappers. Non-breaking: not wired yet.
// Models are configurable via env. Conversation LLM may stream; code LLM is non-streaming by default.

import http from 'node:http';

const DEFAULT_CONVO_MODEL = process.env.CONVO_MODEL || 'llama3.2:3b';
const DEFAULT_CODE_MODEL = process.env.CODE_MODEL || 'granite-code:8b';
const OLLAMA_HOST = process.env.OLLAMA_HOST || '127.0.0.1';
const OLLAMA_PORT = Number(process.env.OLLAMA_PORT || 11434);
const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 30000);

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

export async function convoLLM(prompt, { model = DEFAULT_CONVO_MODEL, stream = false } = {}) {
  // Using /api/generate for simplicity (ollama); adjust as needed.
  const payload = { model, prompt, stream };
  const { status, body } = await postJson('/api/generate', payload);
  if (status !== 200) throw new Error(`convoLLM ${model} failed: ${status}`);
  return body; // caller parses/streams if needed
}

export async function codeLLM(prompt, { model = DEFAULT_CODE_MODEL } = {}) {
  const payload = { model, prompt, stream: false };
  const { status, body } = await postJson('/api/generate', payload);
  if (status !== 200) throw new Error(`codeLLM ${model} failed: ${status}`);
  return body;
}

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
