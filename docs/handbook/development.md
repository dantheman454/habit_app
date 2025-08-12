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
npm run web:dev     # nodemon server.js
```

Directory structure (selected)
```
habit_app/
  server.js              # Express API (single server)
  data/                  # todos.json, counter.json, audit.jsonl
  web/public/            # served static assets (when not using Flutter build)
  flutter_app/           # Flutter Web app source
  src/                   # EVX pipeline (Python)
  docs/handbook/         # this handbook
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
- `GLOBAL_TIMEOUT_SECS` (default: `90`)

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
- The server serves static files from `web/public/`. To use the Flutter app, build the Flutter Web project and copy its build output (e.g., `flutter_app/build/web/*`) into `web/public/`.
- See `docs/handbook/ui.md` for behaviors and URL state recommendations.


