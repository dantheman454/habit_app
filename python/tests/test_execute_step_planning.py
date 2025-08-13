import importlib.util
import os


def test_execute_step_uses_final_calls(monkeypatch):
    # Import harness
    spec = importlib.util.spec_from_file_location(
        "harness_module",
        os.path.join(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")), "tests", "test_models_tool_calling.py"),
    )
    tm = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(tm)

    # Configure step-specific models
    tm.MODELS_EXTRACT[:] = ["extract-llm"]
    tm.MODELS_VERIFY[:] = ["verify-llm"]
    tm.MODELS_EXECUTE[:] = ["execute-llm"]

    # Fake adapter to avoid invoking the real MCP client
    class FakeAdapter:
        def __init__(self):
            self.working_dir = "."

        def reset_database(self):
            return None

        def get_context_summary(self):
            return "(Note: Database is currently empty - no existing todos.)"

        def execute_tool_call(self, tool_call):
            # Always succeed
            return {"success": True}

    # Patch model request to simulate different step outputs based on model used
    def fake_make_model_request_with_retries(model: str, enhanced_prompt: str, system_prompt: str):
        # Extract step output: includes a duplicate and an extra unsupported call which Verify should allow (vetted set drives constraints)
        if model == "extract-llm":
            output = (
                "create_todo(title=\"Buy milk\", priority=\"high\", scheduledFor=\"2025-08-07\")\n"
                "list_todos(completed=False)\n"
                "list_todos(completed=False)\n"
            )
            return {"model_output": output, "retry_info": {"final_success": True, "retry_attempts": 0, "total_attempts": 1}, "error": None}
        # Verify step output: keeps the duplicate to simulate need for deduplication in Execute
        if model == "verify-llm":
            output = (
                "create_todo(title=\"Buy milk\", priority=\"high\", scheduledFor=\"2025-08-07\")\n"
                "list_todos(completed=False)\n"
                "list_todos(completed=False)\n"
            )
            return {"model_output": output, "retry_info": {"final_success": True, "retry_attempts": 0, "total_attempts": 1}, "error": None}
        # Execute step output: deduplicated, final minimal plan
        if model == "execute-llm":
            output = (
                "create_todo(title=\"Buy milk\", priority=\"high\", scheduledFor=\"2025-08-07\")\n"
                "list_todos(completed=False)\n"
            )
            return {"model_output": output, "retry_info": {"final_success": True, "retry_attempts": 0, "total_attempts": 1}, "error": None}
        # Default
        return {"model_output": "", "retry_info": {"final_success": False, "retry_attempts": 0, "total_attempts": 0}, "error": "unexpected model"}

    monkeypatch.setattr(tm, "make_model_request_with_retries", fake_make_model_request_with_retries)

    # Define a minimal scenario where expected tools are create + list
    scenario = {
        "prompt": "Create a high priority todo for tomorrow, then list pending.",
        "expected_tools": ["create_todo", "list_todos"],
        "complexity": 2,
    }

    # Run the single-scenario flow with fakes
    fake_client = FakeAdapter()
    result = tm.run_single_model_scenario("any-model", scenario, fake_client)

    # Assertions: step models attributed correctly
    assert result["pipeline"]["extract"]["model"] == "extract-llm"
    assert result["pipeline"]["verify"]["model"] == "verify-llm"
    assert result["pipeline"]["execute"]["model"] == "execute-llm"

    # Verify/vetted calls kept duplicates (3), execute final calls deduped (2)
    assert len(result["pipeline"]["verify"]["vetted_calls"]) == 3
    assert len(result["pipeline"]["execute"]["final_calls"]) == 2

    # Metrics should use the final execution calls
    assert result["metrics"]["actual_tools"] == 2
    assert result["metrics"]["success_rate"] == 1.0


