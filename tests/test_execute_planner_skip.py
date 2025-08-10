import importlib.util


def test_execution_phase_skips_execute_planner(monkeypatch):
    # Load harness
    path = "/Users/dantheman/Desktop/habit_app/tests/test_models_tool_calling.py"
    spec = importlib.util.spec_from_file_location("harness_module", path)
    tm = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(tm)

    # Force execution-only phase
    tm.PHASE = "execution"

    # Sentinel for execute-planner invocation
    planner_called = {"flag": False}

    def fake_make_model_request_with_retries(model: str, enhanced_prompt: str, system_prompt: str):
        # Only flag when the execute-planner prompt is used
        if "ROLE: Execute vetted MCP tool calls" in enhanced_prompt:
            planner_called["flag"] = True
        return {"model_output": "", "retry_info": {"final_success": True, "retry_attempts": 0, "total_attempts": 1}, "error": None}

    monkeypatch.setattr(tm, "make_model_request_with_retries", fake_make_model_request_with_retries)

    # Scenario with gold-vetted tools and param hints
    scenario = {
        "prompt": "Create a todo for tomorrow.",
        "verification_gold": {"tools": ["create_todo"]},
        "execution_gold": {"tools": ["create_todo"]},
        "param_hints": {"create_todo": {"title": "Buy milk", "priority": "high", "scheduledFor": "2025-08-07"}},
        "complexity": 1,
    }

    class FakeAdapter:
        def __init__(self):
            self.working_dir = "."
        def reset_database(self):
            return None
        def get_context_summary(self):
            return ""
        def execute_tool_call(self, tool_call):
            return {"success": True}

    res = tm.run_single_model_scenario("m", scenario, FakeAdapter())

    # Assert planner was skipped
    assert planner_called["flag"] is False

    # Ensure we still executed the expected call and success rate is computed
    exec_metrics = res["pipeline"]["execute"]["metrics"]
    assert exec_metrics["success_rate"] >= 0.0
    assert res["pipeline"]["execute"]["final_calls"]


