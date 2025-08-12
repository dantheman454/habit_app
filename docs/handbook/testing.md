## Testing

Smoke tests (manual)
- Create/list/update/delete via API and confirm JSON files update
- LLM propose/apply with a simple instruction; verify summary and audit line

Automated tests
- Python EVX pipeline artifacts: run orchestrator to produce extraction/verification/execution JSON
  - Run `pytest -q` to execute the Python tests
  - HTTP endpoint tests spin up the Node server from `server.js`

Examples
```bash
python3 -m src.pipeline.orchestrator --scenario create_simple --out tests/_artifacts --phase all
```
Artifacts
- `tests/_artifacts/<scenario>/extraction.json`
- `tests/_artifacts/<scenario>/verification.json`
- `tests/_artifacts/<scenario>/execution.json`

Notes
- EVX integrates with Ollama optionally; when omitted, deterministic extractors are used
- Execution stage can sandbox data by using a temp working directory

HTTP endpoint tests
- See `tests/test_llm_endpoints.py` for starting the server under test and exercising `/api/llm/*` and `/api/todos`
- The propose test is skipped unless `OLLAMA_MODEL` is set
- Verify health: `GET /health`
- Validate apply workflow assertions: creation, update, and complete counters in `summary`

Python test deps
- Listed in `requirements.txt` (pytest, requests, jsonschema, jinja2, psutil)

Run tests
```bash
python3 -m pytest -q
```


