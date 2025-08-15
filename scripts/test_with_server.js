#!/usr/bin/env node

import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function request(method, url) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => {
      let s = '';
      res.on('data', d => s += d.toString());
      res.on('end', () => resolve({ status: res.statusCode, body: s }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitForHealth({ url, timeoutMs = 30000, intervalMs = 300 } = {}) {
  const start = Date.now();
  // quick fast-path probe once
  try {
    const r = await request('GET', url);
    if (r.status === 200) return true;
  } catch {}
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await request('GET', url);
      if (r.status === 200) return true;
    } catch {}
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

async function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit', ...opts });
    p.on('close', (code) => {
      if (code === 0) resolve(); else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`));
    });
  });
}

async function main() {
  const healthUrl = process.env.TEST_HEALTH_URL || 'http://127.0.0.1:3000/health';
  const serverEntry = path.join(__dirname, '..', 'apps', 'server', 'server.js');

  let serverProc = null;
  let startedOwnServer = false;

  // If health is already OK, reuse existing server
  const alreadyHealthy = await waitForHealth({ url: healthUrl, timeoutMs: 1000, intervalMs: 200 });
  if (!alreadyHealthy) {
    serverProc = spawn(process.execPath, [serverEntry], { stdio: 'inherit', env: process.env });
    startedOwnServer = true;
    const ok = await waitForHealth({ url: healthUrl, timeoutMs: 30000, intervalMs: 300 });
    if (!ok) {
      try { serverProc.kill('SIGINT'); } catch {}
      throw new Error('Server failed to become healthy in time');
    }
  }

  let exitCode = 0;
  try {
    // Run full test orchestrator (cleans DB and runs unit+integration)
    await run(process.execPath, [path.join(__dirname, '..', 'tests', 'all.js')]);
  } catch (e) {
    exitCode = 1;
    console.error(e);
  } finally {
    if (startedOwnServer && serverProc) {
      try { serverProc.kill('SIGINT'); } catch {}
    }
  }

  process.exit(exitCode);
}

main().catch((e) => { console.error(e); process.exit(1); });


