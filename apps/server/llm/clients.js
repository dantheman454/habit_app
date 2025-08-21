// Minimal Ollama client wrappers. Non-breaking: not wired yet.
// Models are configurable via env. Conversation LLM may stream; code LLM is non-streaming by default.

import http from 'node:http';
import { formatHarmonyForGPTOSS, parseHarmonyResponse } from './harmony_utils.js';

const DEFAULT_CONVO_MODEL = process.env.CONVO_MODEL || 'qwen3-coder:30b';
const DEFAULT_CODE_MODEL = process.env.CODE_MODEL || 'qwen3-coder:30b';
const OLLAMA_HOST = process.env.OLLAMA_HOST || '127.0.0.1';
const OLLAMA_PORT = Number(process.env.OLLAMA_PORT || 11434);
const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 30000);

// Enhanced GPT-OSS configuration for better consistency
const GPT_OSS_CONFIG = {
  temperature: 0.1, // Lower temperature for more consistent outputs
  top_p: 0.9,
  max_tokens: 2048,
  stop: ['```', '---', '###'], // Stop generation at markdown boundaries
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

export async function convoLLM(prompt, { model = DEFAULT_CONVO_MODEL, stream = false, config = {} } = {}) {
  const finalConfig = { ...GPT_OSS_CONFIG, ...config };
  const payload = { 
    model, 
    prompt, 
    stream,
    ...finalConfig
  };
  const { status, body } = await postJson('/api/generate', payload);
  if (status !== 200) throw new Error(`convoLLM ${model} failed: ${status}`);
  return body; // caller parses/streams if needed
}

export async function codeLLM(prompt, { model = DEFAULT_CODE_MODEL, config = {} } = {}) {
  const finalConfig = { ...GPT_OSS_CONFIG, ...config };
  const payload = { 
    model, 
    prompt, 
    stream: false,
    ...finalConfig
  };
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

// Harmony-enabled LLM functions
export async function harmonyConvoLLM(harmonyPrompt, { model = DEFAULT_CONVO_MODEL, stream = false, config = {} } = {}) {
  const formattedPrompt = formatHarmonyForGPTOSS(harmonyPrompt);
  const finalConfig = { ...GPT_OSS_CONFIG, ...config };
  const payload = { 
    model, 
    prompt: formattedPrompt, 
    stream,
    ...finalConfig
  };
  const { status, body } = await postJson('/api/generate', payload);
  if (status !== 200) throw new Error(`harmonyConvoLLM ${model} failed: ${status}`);
  
  // Extract the actual response from Ollama metadata
  let responseText = String(body || '');
  if (responseText.includes('"response":')) {
    try {
      const parsed = JSON.parse(responseText);
      responseText = parsed.response || responseText;
    } catch (e) {
      // If parsing fails, use the original text
    }
  }
  
  // Parse response to extract channels
  const parsedResponse = parseHarmonyResponse(responseText);
  return parsedResponse;
}

export async function harmonyCodeLLM(harmonyPrompt, { model = DEFAULT_CODE_MODEL, config = {} } = {}) {
  const formattedPrompt = formatHarmonyForGPTOSS(harmonyPrompt);
  const finalConfig = { ...GPT_OSS_CONFIG, ...config };
  const payload = { 
    model, 
    prompt: formattedPrompt, 
    stream: false,
    ...finalConfig
  };
  const { status, body } = await postJson('/api/generate', payload);
  if (status !== 200) throw new Error(`harmonyCodeLLM ${model} failed: ${status}`);
  
  // Extract the actual response from Ollama metadata
  let responseText = String(body || '');
  if (responseText.includes('"response":')) {
    try {
      const parsed = JSON.parse(responseText);
      responseText = parsed.response || responseText;
    } catch (e) {
      // If parsing fails, use the original text
    }
  }
  
  // Parse response to extract channels
  const parsedResponse = parseHarmonyResponse(responseText);
  return parsedResponse;
}
