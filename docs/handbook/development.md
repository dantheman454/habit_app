## Development (Local-only)

Prereqs
- Node 18+
- Python 3 (for some test tooling)
- Ollama installed if using LLM features

Install and run
```bash
npm install
npm run web         # starts single Express server at http://127.0.0.1:3000
# or
npm run web:dev     # nodemon apps/server/server.js
```

Directory structure (selected)
```
habit_app/
  apps/server/server.js                 # Express API (single server)
  apps/web/flutter_app/                 # Flutter Web app source
  data/                                 # todos.json, counter.json, audit.jsonl
  docs/handbook/                        # this handbook
  python/src/                           # EVX pipeline (Python)
  python/tests/                         # tests (start server and hit HTTP)
```

Data management (no external scripts)
- Clear all data: stop the server, then remove files in `data/` (or replace contents):
  - `rm -f data/todos.json data/counter.json data/audit.jsonl`
  - or set `todos.json` to `[]` and `counter.json` to `{ "nextId": 1 }`
- Seed sample data via API (examples):
```bash
curl -s -X POST http://127.0.0.1:3000/api/todos -H 'Content-Type: application/json' -d '{"title":"Sample A","priority":"medium","scheduledFor":null}'
curl -s -X POST http://127.0.0.1:3000/api/todos -H 'Content-Type: application/json' -d '{"title":"Sample B","priority":"high","scheduledFor":"2025-08-12"}'
```

Environment
- `PORT` (default: 3000)
- `OLLAMA_MODEL` (default: `granite3.3:8b`)
- `OLLAMA_TEMPERATURE` (default: `0.1`)
- `GLOBAL_TIMEOUT_SECS` (default: `120`)
- `STATIC_DIR` (optional: override static web root; default is `apps/web/flutter_app/build/web`)

Notes
- Single user. All data under `data/` in repo root. No external services required.

Verify the server
```bash
curl -s http://127.0.0.1:3000/health
# → {"ok":true}
curl -s -X POST http://127.0.0.1:3000/api/todos -H 'Content-Type: application/json' -d '{"title":"Hello"}'
curl -s http://127.0.0.1:3000/api/todos
```

Using the Flutter web app
- Default static dir is `apps/web/flutter_app/build/web` (override with `STATIC_DIR`).
- Build the Flutter Web project in `apps/web/flutter_app`:
```bash
cd apps/web/flutter_app
flutter build web
```
- Start the server; it will serve from that build directory by default.
- See `docs/handbook/ui.md` for behaviors.

```557:559:apps/server/server.js
// Mount static assets last so API routes are matched first
app.use(express.static(STATIC_DIR));
```


