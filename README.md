# Habit App (Server + Flutter Web)

## Requirements
- Node.js 20 (pinned for better-sqlite3 compatibility)
- Ollama running locally (default host `127.0.0.1:11434`)
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
- The assistant always uses a two‑LLM pipeline (router → propose → validate/repair → summarize). Streaming SSE is available at `/api/assistant/message/stream`; non‑streaming at `POST /api/assistant/message`.

### Environment defaults
- CONVO_MODEL=qwen3:30b (hardcoded)
- CODE_MODEL=qwen3:30b (hardcoded)
- OLLAMA_HOST=127.0.0.1
- OLLAMA_PORT=11434
- LLM_TIMEOUT_MS=30000
- TZ_NAME=America/New_York
- ENABLE_ASSISTANT_DEBUG=1 (prints one-line breadcrumbs per request)

Verify models with: GET `/api/llm/health`.

## Testing

The application features a comprehensive testing suite designed for reliability and maintainability:

### Test Coverage
- **159 tests** across **44 test suites** with **100% pass rate**
- **71.97% line coverage** overall with critical modules at 90%+ coverage
- Comprehensive unit tests for all utility modules
- Integration tests with mocked LLM services
- Error handling and edge case validation

### Running Tests
- **Full test suite**: `npm test` (unit + integration tests)
- **Unit tests only**: `npm run test:unit`
- **Integration tests only**: `npm run test:integration` (requires running server)
- **Test coverage report**: `npm run test:coverage`
- **Watch mode for development**: `npm run test:watch`
- **Server auto-start + tests**: `npm run test:with-server`

### Test Organization
- **Unit tests** (`tests/unit/`): Fast, isolated tests for individual modules
- **Integration tests** (`tests/run.js`): End-to-end API testing with live server
- **Test utilities**: Isolated test database at `data/test/app.db` (never touches `data/app.db`)

### CI/CD
- Tests run automatically on push/PR via GitHub Actions
- Unit tests execute in under 2 minutes
- Integration tests validate full system functionality
- Coverage reports help maintain code quality

## Assistant (local Ollama)

The assistant is backed by the local Ollama models configured at startup. 

- Environment (optional overrides):
```bash
export OLLAMA_HOST=127.0.0.1
export OLLAMA_PORT=11434
```

- In browser console (dev, once):
```js
localStorage.setItem('MCP_SHARED_SECRET', 'dev-secret')
```

- Stream SSE:
```bash
curl -N "http://127.0.0.1:3000/api/assistant/message/stream?message=add%20task&transcript=[]" | sed -u 's/^/SSE: /'
```

- MCP direct test (requires shared secret):
```bash
curl -s -X POST http://127.0.0.1:3000/api/mcp/tools/call \
  -H 'Content-Type: application/json' \
  -H 'x-mcp-token: dev-secret' \
  -d '{"name":"create_task","arguments":{"title":"Hello","scheduledFor":null,"recurrence":{"type":"none"}}}' | jq .
```


