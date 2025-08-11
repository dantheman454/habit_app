#!/usr/bin/env python3
"""Executor: runs verified tool calls against the MCP server via Node client.

Reads a verification artifact and executes accepted calls using the
`scripts/mcp_client.js` wrapper, isolating state by passing `--cwd`.
Outputs an execution artifact with per-call results.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
from datetime import datetime, timezone
from typing import Any, Dict, List, Tuple

from ..core.scenarios import load_scenario


PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
NODE_CLIENT = os.path.join(PROJECT_ROOT, "scripts", "mcp_client.js")


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _call_tool(tool: str, args: Dict[str, Any], cwd: str) -> Dict[str, Any]:
    proc = subprocess.run(
        ["node", NODE_CLIENT, "--tool", tool, "--args", json.dumps(args), "--cwd", cwd],
        text=True,
        capture_output=True,
        check=False,
    )
    ok = (proc.returncode == 0)
    payload: Dict[str, Any] = {
        "ok": ok,
        "stdout": proc.stdout,
        "stderr": proc.stderr,
    }
    if ok:
        try:
            payload["parsed"] = json.loads(proc.stdout)
        except Exception:
            payload["parsed"] = None
    return payload


def execute_verified_calls(scenario_name: str, verification_artifact: Dict[str, Any], working_dir: str) -> Dict[str, Any]:
    executions: List[Dict[str, Any]] = []
    accepted = verification_artifact.get("accepted", [])

    os.makedirs(working_dir, exist_ok=True)

    # Optional per-run data reset for deterministic IDs/state
    reset_env = os.environ.get("EVX_RESET_DATA", "true").strip().lower()
    reset_enabled = reset_env in ("1", "true", "yes", "on", "y")
    if reset_enabled:
        data_dir = os.path.join(working_dir, "data")
        try:
            os.makedirs(data_dir, exist_ok=True)
            for fname in ("todos.json", "counter.json"):
                fpath = os.path.join(data_dir, fname)
                if os.path.exists(fpath):
                    try:
                        os.remove(fpath)
                    except Exception:
                        # Best-effort; continue execution even if removal fails
                        pass
        except Exception:
            # Best-effort; continue regardless
            pass
    # Placeholder substitution state: map create-call index (1-based) to created ID
    create_index_to_id: Dict[int, int] = {}
    executed_create_count: int = 0

    def _extract_created_id(tool_result: Dict[str, Any]) -> int | None:
        """Best-effort extraction of created todo id from MCP client JSON payload."""
        try:
            parsed = tool_result.get("parsed")
            if not parsed:
                return None
            # Expect structure: { tool, arguments, response }
            response = parsed.get("response") or {}
            contents = response.get("content") or []
            if not contents:
                return None
            text = contents[0].get("text") or ""
            # Find JSON object in the text (after first newline)
            brace_idx = text.find("{")
            if brace_idx == -1:
                return None
            json_str = text[brace_idx:]
            obj = json.loads(json_str)
            todo_id = obj.get("id")
            if isinstance(todo_id, int):
                return todo_id
            # Try numeric conversion if string
            try:
                return int(todo_id)
            except Exception:
                return None
        except Exception:
            return None

    def _substitute_placeholders(params: Dict[str, Any]) -> Tuple[Dict[str, Any], List[Dict[str, Any]], List[str]]:
        """
        Replace "$CALL_<n>.id" placeholders with concrete integers when available.
        Returns: (new_params, substitutions, unresolved_placeholders)
        """
        substitutions: List[Dict[str, Any]] = []
        unresolved: List[str] = []

        def replace_value(value: Any) -> Any:
            if isinstance(value, str) and value.startswith("$CALL_") and value.endswith(".id"):
                # parse n
                try:
                    middle = value[len("$CALL_") : -len(".id")]
                    n = int(middle)
                except Exception:
                    unresolved.append(value)
                    return value
                resolved_id = create_index_to_id.get(n)
                if resolved_id is None:
                    unresolved.append(value)
                    return value
                substitutions.append({"placeholder": value, "resolved": resolved_id})
                return resolved_id
            return value

        new_params: Dict[str, Any] = {}
        for k, v in (params or {}).items():
            new_params[k] = replace_value(v)
        return new_params, substitutions, unresolved

    # Duplicate detection: reject repeated create_todo with identical parameters in strict_mode
    strict_mode = bool(verification_artifact.get("scenario", {}).get("strict_mode", False)) if isinstance(verification_artifact.get("scenario"), dict) else bool(os.environ.get("EVX_STRICT_MODE", "false").lower() in ("1", "true", "yes", "on"))
    seen_creates: List[Dict[str, Any]] = []

    for call in accepted:
        tool = call.get("tool")
        raw_params = call.get("parameters", {}) or {}
        if strict_mode and tool == "create_todo":
            # Reject exact duplicates within the same run
            if any(p == raw_params for p in seen_creates):
                executions.append(
                    {
                        "tool": tool,
                        "arguments": raw_params,
                        "status": "rejected",
                        "success": False,
                        "error": {"code": "rejected_duplicate", "message": "Duplicate create_todo parameters in single run"},
                        "timings": {"started": _iso_now(), "ended": _iso_now()},
                    }
                )
                continue
            seen_creates.append(raw_params)
        substituted_params, subs_meta, unresolved = _substitute_placeholders(raw_params)

        if unresolved:
            executions.append(
                {
                    "tool": tool,
                    "arguments": raw_params,
                    "status": "skipped",
                    "success": False,
                    "error": {"code": "unresolved_placeholder", "message": f"Unresolved placeholders: {unresolved}"},
                    "metadata": {"substitutions": subs_meta} if subs_meta else {},
                    "timings": {"started": _iso_now(), "ended": _iso_now()},
                }
            )
            continue

        started = _iso_now()
        result = _call_tool(tool, substituted_params, cwd=working_dir)
        ended = _iso_now()

        entry: Dict[str, Any] = {
            "tool": tool,
            "arguments": substituted_params,
            "status": "executed",
            "success": bool(result.get("ok")),
            "response": result.get("parsed") or {"stdout": result.get("stdout"), "stderr": result.get("stderr")},
            "timings": {"started": started, "ended": ended},
        }
        if subs_meta:
            entry["metadata"] = {"substitutions": subs_meta}
        executions.append(entry)

        # Capture created ID mapping for subsequent placeholders
        if tool == "create_todo" and result.get("ok"):
            executed_create_count += 1
            created_id = _extract_created_id(result)
            if created_id is not None:
                create_index_to_id[executed_create_count] = created_id

    artifact: Dict[str, Any] = {
        "version": "1.0",
        "phase": "execution",
        "scenario": scenario_name,
        "inputs": {"verification_artifact": "../verification.json"},
        "executions": executions,
        "status": "pass",
        "timings": {"started": _iso_now(), "ended": _iso_now()},
    }
    return artifact


def main() -> None:
    parser = argparse.ArgumentParser(description="Execute verified calls via MCP client")
    parser.add_argument("--scenario", required=True, help="Scenario name (without .json)")
    parser.add_argument("--in-artifact", required=True, help="Path to verification.json")
    parser.add_argument("--out", required=True, help="Output directory for artifacts")
    parser.add_argument("--cwd", default="", help="Working directory to isolate data/ (defaults to results/tmp/<scenario>)")
    args = parser.parse_args()

    scenario = load_scenario(args.scenario)  # not used now but reserved for extensions
    with open(args.in_artifact, "r") as f:
        verification = json.load(f)

    scenario_dir = os.path.join(args.out, args.scenario)
    os.makedirs(scenario_dir, exist_ok=True)

    working_dir = args.cwd or os.path.join(args.out, "tmp", args.scenario)
    os.makedirs(working_dir, exist_ok=True)

    executed = execute_verified_calls(args.scenario, verification, working_dir)

    out_path = os.path.join(scenario_dir, "execution.json")
    with open(out_path, "w") as f:
        json.dump(executed, f, indent=2)
    print(out_path)


if __name__ == "__main__":
    main()


