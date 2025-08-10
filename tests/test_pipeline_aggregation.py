import json
import os
import importlib.util


def _load_harness_module():
    path = "/Users/dantheman/Desktop/habit_app/tests/test_models_tool_calling.py"
    spec = importlib.util.spec_from_file_location("harness_module", path)
    mod = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(mod)
    return mod


def _make_result(model: str, ex_tool_f1: float, ver_accept_f1: float, exe_success: float):
    return {
        "model": model,
        "format_type": "function",
        "format_name": "Function Calling",
        "retry_info": {"retry_attempts": 0, "retry_reasons": []},
        "metrics": {  # single-shot overall metrics (not used directly by pipeline agg)
            "success_rate": exe_success,
            "tool_accuracy": 1.0,
            "response_time": 0.01,
            "tool_usage": {"precision": 1.0, "recall": 1.0, "f1": 1.0},
            "parsing_errors": 0,
            "validation_errors": 0,
        },
        "scenario": {"evaluation_focus": "pipeline"},
        "pipeline": {
            "extract": {
                "raw_output": "",
                "tool_calls": [],
                "metrics": {
                    "tool_f1": ex_tool_f1,
                    "order_adherence": 1.0,
                    "parameter_readiness": 1.0,
                },
            },
            "verify": {
                "vetted_calls": [],
                "issues": {},
                "metrics": {
                    "acceptance_f1": ver_accept_f1,
                    "hallucination_f1": 1.0,
                    "order_adherence": 1.0,
                },
            },
            "execute": {
                "results": [],
                "metrics": {
                    "success_rate": exe_success,
                    "tool_accuracy": 1.0,
                    "tool_usage_f1": 1.0,
                },
            },
        },
    }


def test_pipeline_aggregates_and_best_in_class(tmp_path):
    # Import lazily to avoid import cycles during collection
    tm = _load_harness_module()

    # Two models, two results each to exercise averaging and rankings
    results = [
        _make_result("modelA", ex_tool_f1=0.9, ver_accept_f1=0.9, exe_success=0.8),
        _make_result("modelA", ex_tool_f1=0.5, ver_accept_f1=0.8, exe_success=0.7),
        _make_result("modelB", ex_tool_f1=0.8, ver_accept_f1=0.8, exe_success=0.7),
        _make_result("modelB", ex_tool_f1=0.8, ver_accept_f1=0.8, exe_success=0.7),
    ]

    # Generate summary files
    tm.generate_results(results)

    # Load latest summary
    summary_path = "/Users/dantheman/Desktop/habit_app/results/summary_latest.json"
    assert os.path.exists(summary_path), "summary_latest.json not found"
    with open(summary_path, "r") as f:
        aggregates = json.load(f)

    # Check pipeline per-model averages
    ex = aggregates["pipeline"]["extraction"]
    ver = aggregates["pipeline"]["verification"]
    exe = aggregates["pipeline"]["execution"]

    # Averages: modelA ex=0.7, ver=0.85, exe=0.75; modelB ex=0.8, ver=0.8, exe=0.7
    assert abs(ex["modelA"]["tool_f1"] - 0.7) < 1e-6
    assert abs(ver["modelA"]["acceptance_f1"] - 0.85) < 1e-6
    assert abs(exe["modelA"]["success_rate"] - 0.75) < 1e-6

    assert abs(ex["modelB"]["tool_f1"] - 0.8) < 1e-6
    assert abs(ver["modelB"]["acceptance_f1"] - 0.8) < 1e-6
    assert abs(exe["modelB"]["success_rate"] - 0.7) < 1e-6

    # Best-in-Class: modelA should win 2/3 steps (Verification, Execution)
    bic = aggregates["pipeline"]["best_in_class"]
    assert bic["winner"] == "modelA"


