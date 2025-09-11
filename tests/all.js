// Orchestrate unit tests and existing integration smoke tests
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit', ...opts });
    p.on('close', (code) => {
      if (code === 0) resolve(); else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`));
    });
  });
}

async function main() {
  // Isolate tests to a dedicated SQLite file under data/test to avoid touching local data
  try {
    const testDataDir = path.join(__dirname, '..', 'data', 'test');
    try { fs.mkdirSync(testDataDir, { recursive: true }); } catch {}
    const testDbPath = path.join(testDataDir, 'app.db');
    process.env.APP_DB_PATH = process.env.APP_DB_PATH || testDbPath;
    for (const f of ['app.db', 'app.db-shm', 'app.db-wal']) {
      try { fs.unlinkSync(path.join(testDataDir, f)); } catch {}
    }
  } catch {}
  // 1) Unit tests (disable LLM to keep deterministic guidance expectations)
  await run(process.execPath, ['--test', path.join(__dirname, 'unit')], { env: { ...process.env, ASSISTANT_DISABLE_LLM: '1' } });

  // 2) Start a stub LLM (fakes Ollama) so assistant endpoints can run without a real model
  const llmStub = await new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ models: [] }));
      }
      if (req.method === 'POST' && req.url === '/api/generate') {
        let body = '';
        req.on('data', (d) => body += d.toString());
        req.on('end', () => {
          try {
            const j = JSON.parse(body || '{}');
            const prompt = String(j.prompt || '');
            // Router prompts should produce JSON; return clarify to avoid code path
            if (/intent router/i.test(prompt) || /Output JSON only with fields: decision/i.test(prompt)) {
              res.writeHead(200, { 'Content-Type': 'text/plain' });
              return res.end('{"decision":"clarify","confidence":0.4,"question":"Which item do you want to update?"}');
            }
            // Other prompts (proposal/summary): return a short plain response
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            return res.end('Okay.');
          } catch {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            return res.end('Okay.');
          }
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      resolve({ server: srv, port: addr.port });
    });
  });

  // 3) Start server for integration tests, wait for /health, then run smoke tests
  const serverEnv = { 
    ...process.env,
    APP_DB_PATH: process.env.APP_DB_PATH,
    OLLAMA_HOST: '127.0.0.1',
    OLLAMA_PORT: String(llmStub.port),
    ORCHESTRATOR_ENABLED: '1',
    ORCHESTRATOR_HYBRID: '1',
    ORCHESTRATOR_CLASSIFIER_ENABLED: '0'
  };
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'apps', 'server', 'server.js')], {
    env: serverEnv,
    stdio: ['ignore', 'inherit', 'inherit']
  });

  const waitForHealth = async (tries = 30) => new Promise((resolve, reject) => {
    let attempt = 0;
    const tick = () => {
      attempt++;
      const req = http.request('http://127.0.0.1:3000/health', { method: 'GET', timeout: 1000 }, (res) => {
        if (res.statusCode === 200) { resolve(); } else { attempt < tries ? setTimeout(tick, 250) : reject(new Error('server_not_ready')); }
        res.resume();
      });
      req.on('error', () => { attempt < tries ? setTimeout(tick, 250) : reject(new Error('server_not_ready')); });
      req.end();
    };
    tick();
  });

  try {
    await waitForHealth();
    await run(process.execPath, [path.join(__dirname, 'run.js')]);
  } finally {
    try { server.kill('SIGTERM'); } catch {}
  try { llmStub.server.close(); } catch {}
  }
}

main().catch((e) => { console.error(e); process.exit(1); });


