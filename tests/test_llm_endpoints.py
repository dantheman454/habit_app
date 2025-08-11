import os
import time
import json
import signal
import socket
import subprocess

import pytest
import requests


SERVER_URL = "http://127.0.0.1:3000"


def _port_open(host: str, port: int, timeout_s: float = 0.25) -> bool:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(timeout_s)
    try:
        s.connect((host, port))
        return True
    except Exception:
        return False
    finally:
        try:
            s.close()
        except Exception:
            pass


@pytest.fixture(scope="module")
def web_server():
    env = os.environ.copy()
    # Keep OLLAMA_MODEL if set by user; tests will skip propose if not set
    cmd = ["node", "server.js"]
    proc = subprocess.Popen(cmd, cwd=os.path.abspath(os.path.join(os.path.dirname(__file__), "..")), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    # Wait for port to open
    for _ in range(120):
        if _port_open("127.0.0.1", 3000):
            break
        time.sleep(0.25)
    else:
        try:
            proc.kill()
        except Exception:
            pass
        raise RuntimeError("server failed to start on 127.0.0.1:3000")
    yield proc
    try:
        proc.send_signal(signal.SIGTERM)
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill()
    except Exception:
        pass


def _post_json(url: str, payload: dict):
    r = requests.post(url, json=payload, timeout=15)
    r.raise_for_status()
    return r.json()


def _get_json(url: str):
    r = requests.get(url, timeout=15)
    r.raise_for_status()
    return r.json()


def test_apply_endpoint_create_update_complete_delete(web_server):
    # Create via normal API to acquire an id
    created = _post_json(f"{SERVER_URL}/api/todos", {"title": "Test A", "priority": "medium", "scheduledFor": None})
    tid = created["todo"]["id"]

    # Apply a batch: update title, mark completed, then delete a new created item too
    ops = [
        {"op": "update", "id": tid, "title": "Test A+", "priority": "high"},
        {"op": "complete", "id": tid, "completed": True},
        {"op": "create", "title": "LLM Created", "scheduledFor": None, "priority": "low"},
    ]
    result = _post_json(f"{SERVER_URL}/api/llm/apply", {"operations": ops})
    assert result["summary"]["updated"] >= 1
    assert result["summary"]["completed"] >= 1
    assert result["summary"]["created"] >= 1

    # Fetch the updated todo and verify title and completed
    updated = _get_json(f"{SERVER_URL}/api/todos/{tid}")
    assert updated["todo"]["title"] == "Test A+"
    assert updated["todo"]["completed"] is True


@pytest.mark.skipif(not os.environ.get("OLLAMA_MODEL"), reason="OLLAMA_MODEL not set")
def test_propose_endpoint_roundtrip(web_server):
    payload = {"instruction": "create a new todo tomorrow titled Buy bread with priority high"}
    resp = _post_json(f"{SERVER_URL}/api/llm/propose", payload)
    assert isinstance(resp.get("operations"), list)
    assert all(isinstance(o, dict) for o in resp["operations"])  # schema-lite check


