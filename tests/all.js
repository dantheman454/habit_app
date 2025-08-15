// Orchestrate unit tests and existing integration smoke tests
import { spawn } from 'node:child_process';
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
  // 1) Unit tests (Node test runner will discover our unit tests)
  await run(process.execPath, ['--test', path.join(__dirname, 'unit')]);
  // 2) Integration smoke tests (server must already be running)
  await run(process.execPath, [path.join(__dirname, 'run.js')]);
}

main().catch((e) => { console.error(e); process.exit(1); });


