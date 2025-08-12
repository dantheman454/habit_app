import importlib.util


def test_verification_phase_skips_verifier_call(monkeypatch):
    # Load harness module directly by path
    path = "/Users/dantheman/Desktop/habit_app/tests/test_models_tool_calling.py"
    spec = importlib.util.spec_from_file_location("harness_module", path)
    tm = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(tm)

    # Force verification-only phase
    tm.PHASE = "verification"

    # Sentinel to detect unexpected verifier call
    verifier_called = {"flag": False}

    def fake_make_model_request_with_retries(model: str, enhanced_prompt: str, system_prompt: str):
        # Mark only if this is the verifier path (identify by prompt text)
        if "return ONLY the vetted subset" in enhanced_prompt:
            verifier_called["flag"] = True
        return {"model_output": "", "retry_info": {"final_success": True, "retry_attempts": 0, "total_attempts": 1}, "error": None}

    monkeypatch.setattr(tm, "make_model_request_with_retries", fake_make_model_request_with_retries)

    # Minimal scenario with verification gold
    scenario = {
        "prompt": "Create a todo.",
        "verification_gold": {"tools": ["create_todo"]},
        "complexity": 1,
    }

    # Fake adapter to satisfy function signature
    class FakeAdapter:
        def __init__(self):
            self.working_dir = "."
        def reset_database(self):
            return None
        def get_context_summary(self):
            return ""
        def execute_tool_call(self, tool_call):
            return {"success": True}

    result = tm.run_single_model_scenario("model", scenario, FakeAdapter())

    # Ensure we returned early with verification metrics present
    assert "verify" in result["pipeline"]
    assert "metrics" in result["pipeline"]["verify"]

    # And ensure the verifier model was not invoked
    assert verifier_called["flag"] is False


