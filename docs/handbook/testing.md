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
- See `python/tests/test_llm_endpoints.py` for starting the server under test and exercising `/api/llm/apply` and `/api/todos`. A legacy propose test targeting `/api/llm/propose` remains but is skipped unless `OLLAMA_MODEL` is set.
- Verify health: `GET /health`
- Validate apply workflow assertions: creation, update, and complete counters in `summary`

```30:36:python/tests/test_llm_endpoints.py
@pytest.fixture(scope="module")
def web_server():
    cmd = ["node", "apps/server/server.js"]
    proc = subprocess.Popen(cmd, cwd=REPO_ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    # waits for 127.0.0.1:3000
```

```70:89:python/tests/test_llm_endpoints.py
def test_apply_endpoint_create_update_complete_delete(web_server):
    created = _post_json(f"{SERVER_URL}/api/todos", {"title": "Test A", "priority": "medium", "scheduledFor": None})
    tid = created["todo"]["id"]
    ops = [
        {"op": "update", "id": tid, "title": "Test A+", "priority": "high"},
        {"op": "complete", "id": tid, "completed": True},
        {"op": "create", "title": "LLM Created", "scheduledFor": None, "priority": "low"},
    ]
    result = _post_json(f"{SERVER_URL}/api/llm/apply", {"operations": ops})
```

```92:97:python/tests/test_llm_endpoints.py
@pytest.mark.skipif(not os.environ.get("OLLAMA_MODEL"), reason="OLLAMA_MODEL not set")
def test_propose_endpoint_roundtrip(web_server):
    payload = {"instruction": "create a new todo tomorrow titled Buy bread with priority high"}
    resp = _post_json(f"{SERVER_URL}/api/llm/propose", payload)
```

Note: `/api/llm/propose` was removed from the server in favor of `/api/assistant/message`. Keep `OLLAMA_MODEL` unset when running tests to skip this legacy test.

Python test deps
- Listed in `requirements.txt` (pytest, requests, jsonschema, jinja2, psutil)

Run tests
```bash
python3 -m pytest -q
```


