## Troubleshooting

UI cannot load or is blank
- Ensure the server is running at http://127.0.0.1:3000
- Check the browser console and server logs for errors

Data not saving
- Verify write permissions to the data/ directory and that it exists
- Check for JSON parse errors in data/todos.json

Assistant failures
- Confirm `ollama list` works and the model is pulled
- Example: `ollama pull granite3.3:8b` (or `ollama pull granite-code:8b`)
- Increase GLOBAL_TIMEOUT_SECS if generations are slow
- If you see errors mentioning an unknown CLI flag for temperature, upgrade Ollama; the server auto-retries without `--temperature`, but it's better to update

Validation errors
- Ensure scheduledFor is YYYY-MM-DD or null
- Ensure priority is one of low, medium, high
- Ensure title is non-empty on create

File corruption recovery
- If `todos.json` is corrupted, back it up then repair structure or start fresh (keep `counter.json` if IDs matter)
- `audit.jsonl` can be inspected to reconstruct recent changes

Port conflicts
- If port 3000 is busy, set `PORT=3001` (and use that base URL in the UI)

Server logs and diagnostics
- Start server in dev mode for live logs: `npm run web:dev`
- Look for `Server listening at http://127.0.0.1:<PORT>`
- HTTP 400 errors include specific `error` codes in JSON; HTTP 502 on assistant includes `detail`

Resetting state quickly
- Stop the server, then delete `data/todos.json`, `data/counter.json`, and `data/audit.jsonl`; restart the server


