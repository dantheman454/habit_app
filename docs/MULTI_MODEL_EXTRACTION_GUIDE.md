# Multi‑Model Extraction Phase Run (PoC Extension)

This guide details how to extend the current pipeline to run ONLY the Extraction (E) phase across all available Ollama models, over all scenarios, serially, at a fixed temperature=0.1, and then generate a summary JSON plus the existing HTML report (with extraction data populated and other phases blank).

Scope: Implementation plan only. No production hardening (retries, parallelism, advanced metrics) beyond what is necessary to populate the report.

---
## 1. Requirements (as provided)

1. Model list source: output of `ollama list`.
2. Use recommended directory layout; ensure final HTML still renders meaningfully.
3. Perform real calls to each model using Ollama (not stubs).
4. Cover ALL scenarios in `tests/scenarios/` (excluding `schema.json`).
5. Serial execution (no concurrency).
6. Fixed temperature = 0.1 for all models; no per‑model overrides; no random seed customization required now.
7. Extend existing orchestrator (add flags) rather than create a new runner script.
8. Produce: (a) extraction artifacts per model+scenario, (b) a summary index, (c) updated HTML report.
9. Naming: choose most intuitive, sound structure.
10. No extra runtime constraints.

---
## 2. Proposed Output Layout (Confirmed)

```
results/
  artifacts/
    {model}/
      {scenario}/
        extraction.json
  summary_latest.json
  report_latest.html  # rendered automatically after batch
```

Rationale: Model-first folder prevents overwriting and mirrors intended future EVX layout.

---
## 3. New / Extended CLI Flags (Orchestrator)

Add to `src/pipeline/orchestrator.py`:

| Flag | Description | Default |
|------|-------------|---------|
| `--models` | Comma-separated list of models OR the keyword `all` to auto-discover via `ollama list`. | `all` |
| `--phase` | Already exists (`extraction` used here). | existing |
| `--scenarios` | Comma list or keyword `all` for auto-discovery in `tests/scenarios/`. | `all` |
| `--temperature` | Float forwarded to Ollama. | `0.1` |
| `--out` | Base output directory. | required |
| `--skip-existing` | If set, skip extraction when artifact already exists. | off |
|(removed)| HTML always rendered after batch | n/a |

Backward compatibility: If `--scenario` (singular) is used (legacy), behavior unchanged unless `--models` provided.

---
## 4. Model Discovery Logic

Shell command: `ollama list` (table format). We’ll parse lines after the header; first token per line = model name.

Pseudo‑parsing:
```
lines = subprocess.run(['ollama', 'list'], capture_output=True, text=True).stdout.splitlines()
models = [ln.split()[0] for ln in lines[1:] if ln.strip()]
```

Optional filter (future): exclude embedding / system / template models via pattern `(embed|system)` but for now keep all.

---
## 5. Scenario Discovery

Glob: `tests/scenarios/*.json` → exclude `schema.json`.
Scenario name = filename sans `.json`.

---
## 6. Extraction Invocation (Ollama)

For each (model, scenario):
1. Load scenario prompt (combine system + user if present).
2. Build a deterministic instruction telling model to output tool calls in a simple function-call format (or JSON object list). For now: keep existing stub format expectations.
3. Run: `ollama run <model> --temperature <temp>` with prompt via stdin or appended (depends on local Ollama invocation style). Capture stdout.
4. Parse output (strategy):
  * Regex each line: `^(\w+)\s*\((.*)\)` to capture function-style calls.
  * If zero matches, try to JSON-parse entire stdout; if it is a list of objects with `tool` keys, treat them as calls.
  * If still empty, record no calls (model retained for reporting).
5. Construct artifact: 
```
{
  "phase": "extraction",
  "model": model,
  "scenario": scenario_name,
  "tool_calls": [...],
  "metrics": {"total_calls": n, "invalid_calls": m},
  "temperature": 0.1
}
```

No advanced accuracy metrics at this stage.

---
## 7. Summary Aggregation (Extraction Only)

Create `summary_latest.json`:
```
{
  "timestamp": ISO,
  "models": [...],
  "scenarios": [...],
  "pipeline": {
    "extraction": {
      "<model>": {
  "tool_f1": <float 0..1 or null>,
        "order_adherence": null,
        "parameter_readiness": null
      }
    },
    "verification": {},
    "execution": {}
  },
  "scenarios": {
    "<scenario>": {
      "<model>": {
        "success_rate": null,
        "tool_accuracy": null,
        "avg_time_s": null
      }
    }
  },
  "model_stats": {
    "<model>": {
      "avg_success_rate": 0.0,
      "avg_tool_accuracy": 0.0,
      "avg_response_time_s": 0.0,
      "avg_tool_usage": {"f1": 0.0},
      "total_tests": <count of scenarios>
    }
  },
  "task_ranking": []
}
```

Computation of `tool_f1` (simple): expected tool multiset vs extracted list. precision = correct / extracted, recall = correct / expected. F1 standard formula; if no expected_tools defined or empty, set `tool_f1 = null` (unknown). If denominators zero with expectation present, F1 = 0.

---
## 8. HTML Report Generation (Always On)

Always render template after batch extraction. Provide `aggregates = summary_latest.json`. Unused sections remain empty/zero. No user flag required.

---
## 9. Orchestrator Flow (Extraction Multi-Model)

Pseudo:
```
if phase == 'extraction' and (models == 'all' or multiple models OR scenarios == 'all'):
  models = discover_models() if models == 'all' else parse_list(models)
  scenarios = discover_scenarios() if scenarios == 'all' else parse_list(scenarios)
  for model in models:              # serial
    for scenario in scenarios:
      out_file = results/artifacts/{model}/{scenario}/extraction.json
      if skip_existing and exists(out_file): continue
      artifact = run_extraction_with_ollama(model, scenario, temperature=0.1)
      write_json(out_file, artifact)
  summary = aggregate_extraction(models, scenarios, base_out)
  write_json(results/summary_latest.json, summary)
  render_html(summary, template, results/report_latest.html)
else:
  fallback existing single-scenario path
```

---
## 10. Minimal Code Changes List (Updated)

1. Modify `orchestrator.py` (flags + branching logic).
2. Add helpers: `discover_models()`, `discover_scenarios()`.
3. Add `ollama_runner.py` (wrap subprocess call).
4. Add simple parser (regex) if existing parser insufficient.
5. Add `aggregate_extraction.py` or inline function.
6. Orchestrator always renders HTML after batch.
7. Update README (optional) + this guide kept as dev reference.

---
## 11. Assumptions & Simplifications

* All models respond quickly enough; no timeout handling in first pass.
* If parsing yields zero tool calls, artifact still written (invalid_calls = 0, total_calls = 0) and F1 = 0.
* Duplicate tool names counted only once per call in simple list; multiset logic minimal.
* We do not attempt to sanitize or normalize parameter values yet.

---
## 12. Future Enhancements (Deferred)

* Parallel workers
* Retry/backoff
* Rich parameter accuracy metrics
* Verification + execution per model
* Caching raw LLM responses
* Configurable parsing modes (function vs JSON)

---
## 13. Finalized Decisions

1. Layout confirmed.
2. Parser regex + JSON fallback.
3. tool_f1 null when no expectations.
4. Keep zero-call models.
5. Keep all models (no filtering).
6. Always render HTML automatically.
7. Use summary_latest.json.
8. Continue on errors; include artifact with `error` field.

---
End of guide (ready for implementation).
