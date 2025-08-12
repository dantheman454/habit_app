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
    # Minimal rules aligned with `apps/server/server.js` inputs
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
    strict_mode = bool(scenario.get("strict_mode", False))
    expected_parameters = scenario.get("expected_parameters") or {}

    accepted: List[Dict[str, Any]] = []
    rejected: List[Dict[str, Any]] = []

    for call in extraction_artifact.get("tool_calls", []):
        tool = call.get("tool")
        params = call.get("parameters", {}) or {}

        gates: List[Tuple[str, bool, str]] = []

        # Gate 1: allowlist
        if strict_mode:
            # Closed-set: empty allowlist means no tools allowed
            allow_ok = tool in allowlist
        else:
            allow_ok = (not allowlist) or (tool in allowlist)
        gates.append(("allowlist", allow_ok, "tool not in scenario allowlist" if not allow_ok else ""))

        # Gate 2: required parameters present
        required = _required_params_for_tool(tool)
        missing = [p for p in required if p not in params]
        req_ok = not missing
        gates.append(("required_params", req_ok, f"missing: {missing}" if not req_ok else ""))

        # Gate 3 (strict mode only): parameter exactness for specified keys
        if strict_mode and expected_parameters:
            # Support two shapes:
            #  - {"title": ..., "priority": ...} when a single tool of interest
            #  - {"create_todo": {...}, "get_todo": {...}} per-tool expectations
            per_tool_expected: Dict[str, Any] | None
            if any(k in expected_parameters for k in ("create_todo", "list_todos", "search_todos", "get_todo", "update_todo", "delete_todo")):
                per_tool_expected = expected_parameters.get(tool)
            else:
                # Only apply if the allowlist uniquely identifies this tool
                if isinstance(allowlist, list) and len(allowlist) == 1 and allowlist[0] == tool:
                    per_tool_expected = expected_parameters
                else:
                    per_tool_expected = None

            if per_tool_expected:
                exact_mismatches: List[str] = []
                for key, expected_value in per_tool_expected.items():
                    # Skip placeholder-valued expectations (e.g., "$CALL_1.id")
                    if isinstance(expected_value, str) and expected_value.startswith("$CALL_"):
                        continue
                    if key not in params:
                        exact_mismatches.append(f"missing key '{key}'")
                        continue
                    actual = params.get(key)
                    if key == "priority":
                        ev = str(expected_value).lower()
                        av = str(actual).lower()
                        if ev != av:
                            exact_mismatches.append(f"priority mismatch: expected '{expected_value}', got '{actual}'")
                    elif isinstance(expected_value, bool):
                        # Accept boolean or equivalent string literal
                        if actual is True or actual is False:
                            ok = (actual is expected_value)
                        else:
                            ok = str(actual).lower() in ("true", "false") and (str(actual).lower() == str(expected_value).lower())
                        if not ok:
                            exact_mismatches.append(f"boolean mismatch for '{key}': expected {expected_value}, got {actual}")
                    elif isinstance(expected_value, (int, float)):
                        try:
                            ok = float(actual) == float(expected_value)
                        except Exception:
                            ok = False
                        if not ok:
                            exact_mismatches.append(f"numeric mismatch for '{key}': expected {expected_value}, got {actual}")
                    else:
                        # Default to string equality
                        if str(actual) != str(expected_value):
                            exact_mismatches.append(f"mismatch for '{key}': expected '{expected_value}', got '{actual}'")

                exact_ok = not exact_mismatches
                gates.append(("parameter_exactness", exact_ok, "; ".join(exact_mismatches) if not exact_ok else ""))

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


