#!/usr/bin/env python3
"""Deterministic extractor stub.

Reads a scenario and produces an extraction artifact with tool calls based
on `param_hints` or minimal heuristics. No external LLM calls.
"""

from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
from typing import Any, Dict, List

from ..core.scenarios import load_scenario


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def extract_tool_calls(scenario: Dict[str, Any]) -> Dict[str, Any]:
    name = scenario.get("name") or "unknown"
    prompt = scenario.get("prompt", "")
    param_hints = scenario.get("param_hints", {})
    extraction_gold = (
        (scenario.get("extraction_gold") or {}).get("tools")
        or scenario.get("expected_tools")  # legacy field support
        or []
    )

    tool_calls: List[Dict[str, Any]] = []
    # Prefer hints when available to keep it deterministic
    if isinstance(param_hints, dict) and param_hints:
        for tool_name, params in param_hints.items():
            tool_calls.append(
                {
                    "tool": tool_name,
                    "parameters": dict(params),
                    "parsing_errors": [],
                    "validation_errors": [],
                    "is_valid": True,
                }
            )
    else:
        # Fallback minimal heuristic: if extraction_gold lists a single tool
        # and prompt has a quoted title-like snippet, include a basic call.
        if isinstance(extraction_gold, list) and len(extraction_gold) == 1:
            tool_name = extraction_gold[0]
            tool_calls.append(
                {
                    "tool": tool_name,
                    "parameters": {},
                    "parsing_errors": [
                        "No param_hints; parameters left empty (heuristic mode)"
                    ],
                    "validation_errors": [],
                    "is_valid": False,
                }
            )

    artifact: Dict[str, Any] = {
        "version": "1.0",
        "phase": "extraction",
        "model": "stub-deterministic",
        "model_options": {"temperature": 0.0, "seed": 42},
        "scenario": name,
        "prompt": {"user": prompt},
        "format": "function",
        "tool_calls": tool_calls,
        "metrics": {
            "total_calls": len(tool_calls),
            "invalid_calls": sum(1 for c in tool_calls if not c.get("is_valid", False)),
            "parse_latency_ms": 1,
        },
        "status": "pass",
        "timings": {"started": _iso_now(), "ended": _iso_now(), "latency_ms": 1},
    }
    return artifact


def main() -> None:
    parser = argparse.ArgumentParser(description="Deterministic extractor stub")
    parser.add_argument("--scenario", required=True, help="Scenario name (without .json)")
    parser.add_argument("--out", required=True, help="Output directory for artifacts")
    args = parser.parse_args()

    os.makedirs(args.out, exist_ok=True)
    scenario = load_scenario(args.scenario)
    artifact = extract_tool_calls(scenario)

    scenario_dir = os.path.join(args.out, args.scenario)
    os.makedirs(scenario_dir, exist_ok=True)
    out_path = os.path.join(scenario_dir, "extraction.json")
    with open(out_path, "w") as f:
        json.dump(artifact, f, indent=2)
    print(out_path)


if __name__ == "__main__":
    main()


