import json
import os
import importlib.util


def test_report_template_renders_pipeline_sections(tmp_path):
    # Prepare a minimal aggregates JSON with pipeline data
    aggregates = {
        "timestamp": "now",
        "models": ["m1"],
        "model_stats": {"m1": {"avg_success_rate": 1, "avg_tool_accuracy": 1, "avg_response_time_s": 1, "total_tests": 1, "avg_tool_usage": {"precision": 1, "recall": 1, "f1": 1}}},
        "retry_stats": {"total_tests": 1, "tests_with_retries": 0, "total_retry_attempts": 0, "retry_reasons": {}},
        "best_in_class": {},
        "pipeline": {
            "extraction": {"m1": {"tool_f1": 0.5, "order_adherence": 0.5, "parameter_readiness": 0.5}},
            "verification": {"m1": {"acceptance_f1": 0.6, "hallucination_f1": 0.7}},
            "execution": {"m1": {"success_rate": 0.8, "tool_accuracy": 0.9, "tool_usage_f1": 1.0}},
            "best_in_class": {"winner": "m1", "details": ""},
        },
        "parameter_extraction": {"model_averages": {}},
        "workflow_planning": {"model_averages": {}},
        "scenarios": {},
    }

    # Write to summary_latest.json where the template reads it
    out_dir = "/Users/dantheman/Desktop/habit_app/results"
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "summary_latest.json"), "w") as f:
        json.dump(aggregates, f)

    # Render the report using the CLI helper
    # Load CLI module directly by path to avoid import path issues in pytest
    spec = importlib.util.spec_from_file_location(
        "cli_module",
        "/Users/dantheman/Desktop/habit_app/scripts/compare_models.py",
    )
    cli = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(cli)
    render_html_report = cli.render_html_report
    html_path = os.path.join(out_dir, "report_test.html")
    render_html_report("# Summary\n", html_path)

    assert os.path.exists(html_path)
    with open(html_path, "r") as f:
        html = f.read()

    # Check that Pipeline sections are present
    assert "Pipeline Leaderboards" in html
    assert "Extraction" in html
    assert "Verification" in html
    assert "Execution (Vetted)" in html


