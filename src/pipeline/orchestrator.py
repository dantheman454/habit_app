#!/usr/bin/env python3
"""EVX Orchestrator: chains Extraction → Verification → Execution.

Intuitive CLI:
  python -m src.pipeline.orchestrator --scenario create_simple --out results/artifacts --phase all

Phases: all | extraction | verification | execution
Writes artifacts under results/artifacts/{scenario}/
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import textwrap
from typing import Dict, Any, List, Optional

from ..core.scenarios import load_scenario
from ..evaluation.extractor import extract_tool_calls
from ..evaluation.verifier import verify_extraction
from ..execution.executor import execute_verified_calls


def ensure_dir(path: str) -> None:
    os.makedirs(path, exist_ok=True)


def _extract_with_ollama(scenario: Dict[str, Any], model: str, temperature: float) -> Dict[str, Any]:
    """Perform a single LLM-backed extraction using an Ollama model.

    Minimal implementation:
    - Sends a concise system + user prompt to `ollama run <model>`.
    - Parses Python-like function call lines into tool call objects.
    - Falls back to empty list on errors (keeps pipeline moving).
    """
    prompt = scenario.get("prompt", "")
    expected = scenario.get("expected_tools") or []
    system_instructions = textwrap.dedent(
        """
        You convert natural language todo intents into tool calls.
        Output ONLY Python-style function calls, one per line. No prose.
        Available tools: create_todo, list_todos, get_todo, update_todo, delete_todo, search_todos
        Example:
        create_todo(title="Buy groceries", priority="high", scheduledFor="2025-08-07")
        list_todos(completed=False)
        """
    ).strip()

    full_prompt = f"{system_instructions}\n\nTASK:\n{prompt}\n"

    try:
        # Honor unified timeout via EVX_GLOBAL_TIMEOUT_SECS (default 90s)
        timeout_secs = int(os.environ.get("EVX_GLOBAL_TIMEOUT_SECS", "90"))
        proc = subprocess.run(
            ["ollama", "run", model, "--temperature", str(temperature)],
            input=full_prompt,
            text=True,
            capture_output=True,
            check=False,
            timeout=max(1, timeout_secs),
        )
        raw_output = proc.stdout.strip()
    except Exception as e:  # pragma: no cover (best effort)
        raw_output = ""
        error = str(e)
    else:
        error = None if proc.returncode == 0 else f"non-zero exit ({proc.returncode})"

    def _coerce_and_validate(tool: str, params: Dict[str, Any]) -> Dict[str, Any]:
        validation_errors: List[str] = []
        coerced: Dict[str, Any] = {}

        def to_bool(x: Any) -> Any:
            if isinstance(x, bool):
                return x
            if isinstance(x, str) and x.lower() in ("true", "false"):
                return x.lower() == "true"
            return x

        def to_int(x: Any) -> Any:
            if isinstance(x, int):
                return x
            try:
                if isinstance(x, str) and x.strip().isdigit():
                    return int(x.strip())
            except Exception:
                pass
            return x

        for k, v in (params or {}).items():
            cv = v
            if k in ("completed",):
                cv = to_bool(v)
                if not isinstance(cv, bool):
                    validation_errors.append(f"'{k}' must be boolean")
            elif k == "id" and (tool in ("get_todo", "update_todo", "delete_todo")):
                cv = to_int(v)
                if not isinstance(cv, int):
                    validation_errors.append("'id' must be integer")
            elif k == "priority":
                if isinstance(v, str):
                    lv = v.lower()
                    cv = lv
                    if lv not in ("low", "medium", "high"):
                        validation_errors.append("'priority' must be one of low|medium|high")
                else:
                    validation_errors.append("'priority' must be string")
            elif k in ("scheduledFor", "scheduledFrom", "scheduledTo"):
                if v is not None and not isinstance(v, str):
                    validation_errors.append(f"'{k}' must be string or null")
            coerced[k] = cv

        return {"parameters": coerced, "validation_errors": validation_errors}

    # Parse tool calls: prefer JSON array, fallback to function-call lines
    tool_calls: List[Dict[str, Any]] = []
    parsed_as_json = False
    if raw_output.startswith("["):
        try:
            arr = json.loads(raw_output)
            if isinstance(arr, list):
                for i, item in enumerate(arr, start=1):
                    if not isinstance(item, dict):
                        continue
                    name = item.get("tool") or item.get("name")
                    params = item.get("parameters") or {}
                    if not isinstance(name, str) or not isinstance(params, dict):
                        continue
                    res = _coerce_and_validate(name, params)
                    tool_calls.append(
                        {
                            "tool": name,
                            "parameters": res["parameters"],
                            "parsing_errors": [],
                            "validation_errors": res["validation_errors"],
                            "is_valid": len(res["validation_errors"]) == 0,
                        }
                    )
                parsed_as_json = True
        except Exception:
            parsed_as_json = False

    if not parsed_as_json:
        for line in raw_output.splitlines():
            line = line.strip()
            if not line or "(" not in line or not line.endswith(")"):
                continue
            name = line.split("(", 1)[0].strip()
            args_part = line[len(name) + 1 : -1].strip()
            params: Dict[str, Any] = {}
            parsing_errors: List[str] = []
            if args_part:
                for frag in args_part.split(","):
                    frag = frag.strip()
                    if not frag:
                        continue
                    if "=" not in frag:
                        parsing_errors.append(f"Malformed arg '{frag}'")
                        continue
                    k, v = frag.split("=", 1)
                    k = k.strip()
                    v = v.strip()
                    # Strip wrapping quotes for strings
                    if len(v) >= 2 and ((v[0] == '"' and v[-1] == '"') or (v[0] == "'" and v[-1] == "'")):
                        v_inner = v[1:-1]
                    else:
                        v_inner = v
                    # Best-effort type coercion
                    if v_inner.lower() in ("true", "false"):
                        val: Any = (v_inner.lower() == "true")
                    elif k == "id" and v_inner.strip().isdigit():
                        val = int(v_inner.strip())
                    elif k == "priority":
                        val = v_inner.lower()
                    else:
                        val = v_inner
                    params[k] = val
            res = _coerce_and_validate(name, params)
            tool_calls.append(
                {
                    "tool": name,
                    "parameters": res["parameters"],
                    "parsing_errors": parsing_errors,
                    "validation_errors": res["validation_errors"],
                    "is_valid": (not parsing_errors) and (len(res["validation_errors"]) == 0),
                }
            )

    artifact = {
        "version": "1.0",
        "phase": "extraction",
        "model": model,
        "model_options": {"temperature": temperature},
        "scenario": scenario.get("name") or "unknown",
        "prompt": {"user": prompt},
        "format": "function",
        "raw_output": raw_output,
        "tool_calls": tool_calls,
        "metrics": {
            "total_calls": len(tool_calls),
            "invalid_calls": sum(1 for c in tool_calls if not c.get("is_valid")),
            "expected_tools": len(expected),
        },
        "status": "pass",
        "error": error,
    }
    return artifact


def orchestrate(
    scenario_name: str,
    out_dir: str,
    phase: str = "all",
    model: Optional[str] = None,
    temperature: float = 0.1,
) -> Dict[str, Any]:
    ensure_dir(out_dir)
    scenario = load_scenario(scenario_name)
    scenario_dir = os.path.join(out_dir, scenario_name)
    ensure_dir(scenario_dir)

    results: Dict[str, Any] = {}

    extraction_path = os.path.join(scenario_dir, "extraction.json")
    verification_path = os.path.join(scenario_dir, "verification.json")
    execution_path = os.path.join(scenario_dir, "execution.json")

    # Extraction (stub or Ollama-backed if model provided)
    if phase in ("all", "extraction", "verification", "execution"):
        if model:
            extraction = _extract_with_ollama(scenario, model=model, temperature=temperature)
        else:
            extraction = extract_tool_calls(scenario)
        with open(extraction_path, "w") as f:
            json.dump(extraction, f, indent=2)
        results["extraction_path"] = extraction_path
        if phase not in ("all", "verification", "execution"):
            return results
    else:
        extraction = None

    # Verification
    if phase in ("all", "verification", "execution"):
        if extraction is None:
            with open(extraction_path, "r") as f:
                extraction = json.load(f)
        verification = verify_extraction(scenario, extraction)
        with open(verification_path, "w") as f:
            json.dump(verification, f, indent=2)
        results["verification_path"] = verification_path
        if phase not in ("all", "execution"):
            return results
    else:
        verification = None

    # Execution
    if phase in ("all", "execution"):
        if verification is None:
            with open(verification_path, "r") as f:
                verification = json.load(f)
        working_dir = os.path.join(out_dir, "tmp", scenario_name)
        ensure_dir(working_dir)
        execution = execute_verified_calls(scenario_name, verification, working_dir)
        with open(execution_path, "w") as f:
            json.dump(execution, f, indent=2)
        results["execution_path"] = execution_path

    return results


def main() -> None:
    parser = argparse.ArgumentParser(description="EVX Orchestrator")
    parser.add_argument("--scenario", required=True, help="Scenario name (without .json)")
    parser.add_argument("--out", required=True, help="Output directory (e.g., results/artifacts)")
    parser.add_argument("--phase", choices=["all", "extraction", "verification", "execution"], default="all")
    parser.add_argument("--model", default=None, help="(Optional) Ollama model name for LLM-backed extraction")
    parser.add_argument("--temperature", type=float, default=0.1, help="Temperature for LLM extraction (only if --model provided)")
    args = parser.parse_args()

    results = orchestrate(
        args.scenario,
        args.out,
        phase=args.phase,
        model=args.model,
        temperature=args.temperature,
    )
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()


