# Habit App (Server + Flutter Web)

## Requirements
- Node.js 20 (pinned for better-sqlite3 compatibility)
- Ollama running locally with model `granite3.3:8b` (set `OLLAMA_BASE_URL` if not default `http://127.0.0.1:11434`)
- Optional: `TZ_NAME` to control server timezone (default `America/New_York`)
- Flutter (web) toolchain for building the client

## Quick start
1. Build the Flutter web client:
   - `cd apps/web/flutter_app`
   - `flutter clean && flutter build web`
2. Start the server from repo root:
   - `npm run start`
   - If using nvm: `nvm install 20 && nvm use 20 && npm install`
   - If using Homebrew on macOS: `brew install node@20` and add `/opt/homebrew/opt/node@20/bin` to PATH
3. Verify health:
   - `curl http://127.0.0.1:3000/health` → `{ "ok": true }`

## Notes
- The server hosts the built Flutter web assets from `apps/web/flutter_app/build/web`.
- The assistant uses a two-call pipeline (router → propose → validate/repair → summarize), with SSE streaming at `/api/assistant/message/stream`.

## Testing
- Tests run against an isolated test database at `data/test/app.db` and will not touch your local data in `data/app.db`.
- The full test runner cleans the isolated test DB and then runs unit + integration tests. Ensure the server is running, or use the helper that starts/stops it automatically:
  - Server already running: `npm test`
  - Start server automatically then run tests: `npm run test:with-server`
  - Unit only: `npm run test:unit`
  - Integration only (server must be running): `npm run test:integration`


