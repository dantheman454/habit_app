#!/usr/bin/env python3
"""Verification stub: allowlist + required parameter gates.

Consumes an extraction artifact and the scenario to filter candidate
tool calls into accepted and rejected lists with simple metrics.
"""

from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
from typing import Any, Dict, List, Tuple

from ..core.scenarios import load_scenario


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _required_params_for_tool(tool_name: str) -> List[str]:
    # Minimal rules aligned with `src/server.js` inputs
    if tool_name == "create_todo":
        return ["title"]
    if tool_name in ("get_todo", "update_todo", "delete_todo"):
        return ["id"]
    # list_todos, search_todos require none strictly
    return []


def verify_extraction(scenario: Dict[str, Any], extraction_artifact: Dict[str, Any]) -> Dict[str, Any]:
    name = scenario.get("name") or "unknown"
    # allowlist from scenario
    allowlist = (
        (scenario.get("verification_gold") or {}).get("tools")
        or (scenario.get("extraction_gold") or {}).get("tools")
        or scenario.get("expected_tools")
        or []
    )

    accepted: List[Dict[str, Any]] = []
    rejected: List[Dict[str, Any]] = []

    for call in extraction_artifact.get("tool_calls", []):
        tool = call.get("tool")
        params = call.get("parameters", {}) or {}

        gates: List[Tuple[str, bool, str]] = []

        # Gate 1: allowlist
        allow_ok = (not allowlist) or (tool in allowlist)
        gates.append(("allowlist", allow_ok, "tool not in scenario allowlist" if not allow_ok else ""))

        # Gate 2: required parameters present
        required = _required_params_for_tool(tool)
        missing = [p for p in required if p not in params]
        req_ok = not missing
        gates.append(("required_params", req_ok, f"missing: {missing}" if not req_ok else ""))

        # Decision
        if all(ok for _, ok, _ in gates):
            accepted.append({"tool": tool, "parameters": params})
        else:
            rejected.append({
                "tool": tool,
                "parameters": params,
                "failed_gates": [{"gate": g, "reason": r} for g, ok, r in gates if not ok],
            })

    artifact: Dict[str, Any] = {
        "version": "1.0",
        "phase": "verification",
        "scenario": name,
        "inputs": {"extraction_artifact": "../extraction.json"},
        "accepted": accepted,
        "rejected": rejected,
        "metrics": {"accepted_count": len(accepted), "rejected_count": len(rejected)},
        "gates": {"allowlist": "applied", "required_params": "applied"},
        "status": "pass",
        "timings": {"started": _iso_now(), "ended": _iso_now(), "latency_ms": 1},
    }
    return artifact


def main() -> None:
    parser = argparse.ArgumentParser(description="Verification stub")
    parser.add_argument("--scenario", required=True, help="Scenario name (without .json)")
    parser.add_argument("--in-artifact", required=True, help="Path to extraction.json")
    parser.add_argument("--out", required=True, help="Output directory for artifacts")
    args = parser.parse_args()

    with open(args.in_artifact, "r") as f:
        extraction = json.load(f)
    scenario = load_scenario(args.scenario)

    verified = verify_extraction(scenario, extraction)

    scenario_dir = os.path.join(args.out, args.scenario)
    os.makedirs(scenario_dir, exist_ok=True)
    out_path = os.path.join(scenario_dir, "verification.json")
    with open(out_path, "w") as f:
        json.dump(verified, f, indent=2)
    print(out_path)


if __name__ == "__main__":
    main()


