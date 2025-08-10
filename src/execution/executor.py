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
from typing import Any, Dict, List

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
    for call in accepted:
        tool = call.get("tool")
        args = call.get("parameters", {}) or {}
        started = _iso_now()
        result = _call_tool(tool, args, cwd=working_dir)
        ended = _iso_now()
        executions.append(
            {
                "tool": tool,
                "arguments": args,
                "success": bool(result.get("ok")),
                "response": result.get("parsed") or {"stdout": result.get("stdout"), "stderr": result.get("stderr")},
                "timings": {"started": started, "ended": ended},
            }
        )

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


