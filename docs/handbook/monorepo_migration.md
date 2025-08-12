## Monorepo-style Migration Guide (surgical)

Objectives
- Move to `apps/server` (Express API) and `apps/web` (Flutter app)
- Serve static directly from Flutter build (no `web/public` copy step)
- Add `STATIC_DIR` support to the server
- Keep Python EVX under `python/` with tests runnable via `npm test`

### Target layout
```
habit_app/
  apps/
    server/
      server.js
    web/
      flutter_app/            # moved from root `flutter_app/`
      build/web/              # Flutter build output (served directly)
  data/
  docs/
    handbook/
      monorepo_migration.md
  python/
    src/
    tests/
    requirements.txt
  package.json
  README.md
```

Notes
- `server.js` will reference `data/` and the Flutter build via absolute paths from repo root.
- `npm test` will run Python tests via `pytest` from root.

---

### 0) Preflight
```bash
cd /Users/dantheman/Desktop/habit_app
git status
# Ensure clean working tree or commit/stash first
npm run web | cat & sleep 1; kill %1 2>/dev/null || true
python3 -m pytest -q || true
```

### 1) Move directories
```bash
mkdir -p apps/server apps/web
git mv server.js apps/server/server.js
git mv flutter_app apps/web/
mkdir -p python
git mv src python/src
git mv tests python/tests
git mv requirements.txt python/requirements.txt
```

Optional cleanup (static dir no longer needed after code change below):
```bash
rm -rf web/public
git rm -r web 2>/dev/null || true
```

### 2) Update server paths and add `STATIC_DIR` support
Edit `apps/server/server.js`:

Replace the path section with (adjusting root/data/static resolution):
```js
// --- Paths ---
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(REPO_ROOT, 'data');
const TODOS_FILE = path.join(DATA_DIR, 'todos.json');
const COUNTER_FILE = path.join(DATA_DIR, 'counter.json');
const STATIC_DIR = process.env.STATIC_DIR || path.join(REPO_ROOT, 'apps', 'web', 'build', 'web');
```

Replace the static assets section with:
```js
// Static assets (Flutter Web build)
app.use(express.static(STATIC_DIR));
```

Rationale
- After moving the server under `apps/server`, `__dirname` is no longer the repo root. We use `REPO_ROOT = ../../` to resolve `data/` and static assets reliably.
- `STATIC_DIR` env var allows one-off overrides if you keep builds elsewhere.

### 3) Update `package.json` scripts and test wiring
Edit `package.json` at repo root:

- Replace server scripts to point to the new path:
```json
{
  "scripts": {
    "web": "node apps/server/server.js",
    "web:dev": "nodemon apps/server/server.js",
    "start:web": "node apps/server/server.js",
    "dev:web": "nodemon apps/server/server.js",
    "test": "python3 -m pytest -q"
  }
}
```

Notes
- Remove or update old entries referencing `src/server.js`.
- Keep `type: module` as-is; no change required.

### 4) Update Python tests and paths
Edit `python/tests/test_llm_endpoints.py` (if path differs, search for it):

Change server startup command:
```python
cmd = ["node", "apps/server/server.js"]
proc = subprocess.Popen(cmd, cwd=REPO_ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
```

If you have references to the old server path (e.g., `src/server.js`) in any Python files (like `tests/test_models_tool_calling.py`), update to the new location or make the path configurable.

Run tests via npm after the script change:
```bash
npm test
```

### 5) Build Flutter and serve directly
```bash
cd /Users/dantheman/Desktop/habit_app/apps/web/flutter_app
flutter clean
flutter pub get
flutter build web --release

# Start the server (from repo root)
cd /Users/dantheman/Desktop/habit_app
npm run web
# Open http://127.0.0.1:3000
```

If you maintain multiple builds, you can point the server to another build directory:
```bash
STATIC_DIR=/path/to/another/build/web npm run web
```

### 6) Documentation touch-ups
- Replace references to `server.js` at repo root with `apps/server/server.js` as needed.
- Mention that the static UI is now served from `apps/web/build/web` by default.

### 7) Commit changes
```bash
git add -A
git commit -m "Monorepo layout: move server to apps/server, Flutter to apps/web; add STATIC_DIR; move Python to python/; npm test -> pytest"
```

### Rollback plan
If anything breaks, reverse moves:
```bash
git reset --hard HEAD~1
```
Or manually move files back and restore prior `package.json` scripts.

---

Checklist
- apps/server/server.js resolves `REPO_ROOT`, `DATA_DIR`, and `STATIC_DIR`
- `npm run web` starts server; `/health` responds `{ ok: true }`
- Flutter build copied to `apps/web/build/web` and served at `/`
- `npm test` runs Python tests under `python/tests`


