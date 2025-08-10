#!/usr/bin/env python3
"""Scenario loader utilities.

Loads JSON scenario fixtures from `tests/scenarios/` and provides
simple helpers to list and load scenarios by name.

This module does not enforce a strict schema at import time; callers
may optionally validate against `tests/scenarios/schema.json` using
`jsonschema` if needed.
"""

from __future__ import annotations

import json
import os
from typing import Dict, Any, List


def _project_root() -> str:
    # `src/core/scenarios.py` → project root is parent of `src`
    return os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def scenarios_dir() -> str:
    return os.path.join(_project_root(), "tests", "scenarios")


def list_scenario_files() -> List[str]:
    """List scenario JSON filenames (absolute paths)."""
    directory = scenarios_dir()
    if not os.path.isdir(directory):
        return []
    return [
        os.path.join(directory, f)
        for f in sorted(os.listdir(directory))
        if f.endswith(".json")
    ]


def list_scenarios() -> List[str]:
    """List scenario names derived from filenames (without `.json`)."""
    names: List[str] = []
    for path in list_scenario_files():
        base = os.path.basename(path)
        name, _ = os.path.splitext(base)
        names.append(name)
    return names


def load_scenario_by_file(path: str) -> Dict[str, Any]:
    with open(path, "r") as f:
        return json.load(f)


def load_scenario(name: str) -> Dict[str, Any]:
    """Load a scenario by base name (without `.json`).

    Example: load_scenario("create_simple") → loads tests/scenarios/create_simple.json
    """
    candidate = os.path.join(scenarios_dir(), f"{name}.json")
    if not os.path.exists(candidate):
        raise FileNotFoundError(f"Scenario not found: {candidate}")
    return load_scenario_by_file(candidate)


def load_all_scenarios() -> Dict[str, Dict[str, Any]]:
    """Load all scenarios keyed by filename base (without `.json`)."""
    out: Dict[str, Dict[str, Any]] = {}
    for path in list_scenario_files():
        base = os.path.basename(path)
        name, _ = os.path.splitext(base)
        try:
            out[name] = load_scenario_by_file(path)
        except Exception:
            # Leave partially invalid scenarios out of the map
            continue
    return out


if __name__ == "__main__":
    # Simple CLI for manual inspection
    import argparse

    parser = argparse.ArgumentParser(description="List or load scenarios")
    parser.add_argument("--list", action="store_true", help="List scenario names")
    parser.add_argument("--name", default="", help="Load a specific scenario by name")
    args = parser.parse_args()

    if args.list:
        for n in list_scenarios():
            print(n)
    elif args.name:
        data = load_scenario(args.name)
        print(json.dumps(data, indent=2))
    else:
        parser.print_help()


