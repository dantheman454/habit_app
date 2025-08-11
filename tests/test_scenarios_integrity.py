import re
from typing import Dict, Any

from src.core.scenarios import load_all_scenarios


ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def test_scenarios_loadable_and_required_fields_present():
    scenarios: Dict[str, Dict[str, Any]] = load_all_scenarios()
    assert isinstance(scenarios, dict)
    # There should be at least one scenario file present
    assert len(scenarios) >= 1

    for name, data in scenarios.items():
        if isinstance(data, dict):
            assert "prompt" in data and isinstance(data["prompt"], str) and data["prompt"].strip()
        elif isinstance(data, list):
            # Catalog file: validate each item shape minimally
            for item in data:
                if isinstance(item, dict) and "prompt" in item:
                    assert isinstance(item["prompt"], str) and item["prompt"].strip()


def test_unique_names_if_present_and_expected_tools_shape():
    scenarios = load_all_scenarios()
    seen_names_single_files = set()
    for fname, data in scenarios.items():
        # If a human-friendly name is provided, ensure no duplicates
        if isinstance(data, dict):
            name_val = data.get("name")
            if isinstance(name_val, str):
                assert name_val not in seen_names_single_files, f"Duplicate scenario name: {name_val}"
                seen_names_single_files.add(name_val)

            # If expected_tools is present, ensure it has the right shape
            if "expected_tools" in data:
                et = data["expected_tools"]
                assert isinstance(et, list)
                assert all(isinstance(t, str) for t in et)
        elif isinstance(data, list):
            # Enforce uniqueness within catalog lists only (do not cross-check with single-file names)
            catalog_seen = set()
            for item in data:
                if isinstance(item, dict):
                    name_val = item.get("name")
                    if isinstance(name_val, str):
                        assert name_val not in catalog_seen, f"Duplicate scenario name in catalog: {name_val}"
                        catalog_seen.add(name_val)
                    if "expected_tools" in item:
                        et = item["expected_tools"]
                        assert isinstance(et, list)
                        assert all(isinstance(t, str) for t in et)


def test_param_hints_align_when_expected_tools_present():
    scenarios = load_all_scenarios()
    for fname, data in scenarios.items():
        if isinstance(data, dict) and "param_hints" in data and "expected_tools" in data:
            hints = data["param_hints"]
            expected_tools = set(data["expected_tools"]) if isinstance(data["expected_tools"], list) else set()
            if isinstance(hints, dict) and expected_tools:
                # Require that hint keys are a subset of expected tool names
                assert set(hints.keys()).issubset(expected_tools), (
                    f"param_hints keys must be in expected_tools for {fname}"
                )


def test_strict_mode_requires_expected_tools_if_enabled():
    scenarios = load_all_scenarios()
    for fname, data in scenarios.items():
        if isinstance(data, dict) and data.get("strict_mode") is True:
            # At minimum, presence of expected_tools is required when strict_mode is enabled
            assert "expected_tools" in data, f"strict_mode enabled but expected_tools missing in {fname}"


def test_iso_dates_when_specified_in_expected_parameters():
    scenarios = load_all_scenarios()
    for fname, data in scenarios.items():
        if isinstance(data, dict):
            ep = data.get("expected_parameters")
            if isinstance(ep, dict):
                # Support both flat dict and per-tool dicts
                candidate_dicts = []
                if any(k in ep for k in ("create_todo", "list_todos", "search_todos", "get_todo", "update_todo", "delete_todo")):
                    for v in ep.values():
                        if isinstance(v, dict):
                            candidate_dicts.append(v)
                else:
                    candidate_dicts.append(ep)

                for d in candidate_dicts:
                    for key in ("scheduledFor", "scheduledFrom", "scheduledTo"):
                        if key in d and d[key] is not None:
                            val = d[key]
                            if isinstance(val, str):
                                # Allow anchor placeholders during transition
                                if val in ("${TODAY}", "${TOMORROW}"):
                                    continue
                                assert ISO_DATE_RE.match(val), (
                                    f"Expected ISO date (YYYY-MM-DD) for {key} in {fname}: got {val}"
                                )
                            # If not a string, allow other values for now (e.g., null); stricter typing left for future


