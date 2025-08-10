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
from typing import Dict, Any

from ..core.scenarios import load_scenario
from ..evaluation.extractor import extract_tool_calls
from ..evaluation.verifier import verify_extraction
from ..execution.executor import execute_verified_calls


def ensure_dir(path: str) -> None:
    os.makedirs(path, exist_ok=True)


def orchestrate(scenario_name: str, out_dir: str, phase: str = "all") -> Dict[str, Any]:
    ensure_dir(out_dir)
    scenario = load_scenario(scenario_name)
    scenario_dir = os.path.join(out_dir, scenario_name)
    ensure_dir(scenario_dir)

    results: Dict[str, Any] = {}

    extraction_path = os.path.join(scenario_dir, "extraction.json")
    verification_path = os.path.join(scenario_dir, "verification.json")
    execution_path = os.path.join(scenario_dir, "execution.json")

    # Extraction
    if phase in ("all", "extraction", "verification", "execution"):
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
    args = parser.parse_args()

    results = orchestrate(args.scenario, args.out, phase=args.phase)
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()


