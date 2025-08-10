import json
import os

import src.pipeline.orchestrator as orch


def test_orchestrator_creates_artifacts(tmp_path):
    out_dir = os.path.join(str(tmp_path), "artifacts")

    # Choose a simple scenario from tests
    scenario = "create_simple"

    results = orch.orchestrate(scenario, out_dir, phase="all")

    # Paths returned and files exist
    extraction_path = os.path.join(out_dir, scenario, "extraction.json")
    verification_path = os.path.join(out_dir, scenario, "verification.json")
    execution_path = os.path.join(out_dir, scenario, "execution.json")

    assert results.get("extraction_path") == extraction_path
    assert results.get("verification_path") == verification_path
    assert results.get("execution_path") == execution_path

    for p in (extraction_path, verification_path, execution_path):
        assert os.path.exists(p)
        with open(p, "r") as f:
            data = json.load(f)
            assert isinstance(data, dict)
            assert data.get("phase") in ("extraction", "verification", "execution")


