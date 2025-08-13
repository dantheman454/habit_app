import json
import os
import time
import subprocess
from contextlib import contextmanager

import requests


PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SERVER_ENTRY = os.path.join(PROJECT_ROOT, "apps", "server", "server.js")
BASE_URL = os.environ.get("HABIT_APP_BASE_URL", "http://127.0.0.1:3000")


def _health_ok(base: str) -> bool:
    try:
        r = requests.get(f"{base}/health", timeout=2)
        return r.ok and r.json().get("ok") is True
    except Exception:
        return False


@contextmanager
def _ensure_server_running():
    # If a server is already up, use it; otherwise start a local instance
    if _health_ok(BASE_URL):
        yield None
        return
    proc = subprocess.Popen(["node", SERVER_ENTRY], cwd=PROJECT_ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        # Wait for health
        deadline = time.time() + 15
        while time.time() < deadline:
            if _health_ok(BASE_URL):
                break
            time.sleep(0.25)
        assert _health_ok(BASE_URL), "Server did not become healthy in time"
        yield proc
    finally:
        try:
            if proc and proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    proc.kill()
        except Exception:
            pass


def _create(title: str, priority: str = "medium", scheduled_for=None):
    r = requests.post(f"{BASE_URL}/api/todos", json={"title": title, "priority": priority, "scheduledFor": scheduled_for})
    assert r.ok, r.text
    return r.json()["todo"]


def _list_scheduled(from_ymd: str | None = None, to_ymd: str | None = None, completed: bool | None = None):
    params = {}
    if from_ymd is not None:
        params["from"] = from_ymd
    if to_ymd is not None:
        params["to"] = to_ymd
    if completed is not None:
        params["completed"] = str(completed).lower()
    r = requests.get(f"{BASE_URL}/api/todos", params=params)
    assert r.ok, r.text
    return r.json()["todos"]


def _list_backlog():
    r = requests.get(f"{BASE_URL}/api/todos/backlog")
    assert r.ok, r.text
    return r.json()["todos"]


def _get(todo_id: int):
    r = requests.get(f"{BASE_URL}/api/todos/{todo_id}")
    assert r.ok, r.text
    return r.json()["todo"]


def _update(todo_id: int, patch: dict):
    r = requests.patch(f"{BASE_URL}/api/todos/{todo_id}", json=patch)
    assert r.ok, r.text
    return r.json()["todo"]


def _search(query: str):
    r = requests.get(f"{BASE_URL}/api/todos/search", params={"query": query})
    assert r.ok, r.text
    return r.json()["todos"]


def _delete(todo_id: int):
    r = requests.delete(f"{BASE_URL}/api/todos/{todo_id}")
    assert r.ok, r.text
    return r.json()


def test_crud_and_search_behavior(tmp_path):
    with _ensure_server_running():
        # Create (unscheduled goes to backlog)
        todo = _create("Buy milk", priority="high", scheduled_for=None)
        assert todo["title"] == "Buy milk"

        # List backlog and ensure presence
        backlog = _list_backlog()
        assert any(t["id"] == todo["id"] for t in backlog)

        tid = todo["id"]

        # Get by id
        t1 = _get(tid)
        assert t1["id"] == tid

        # Update completed
        t2 = _update(tid, {"completed": True})
        assert t2["completed"] is True

        # Search
        found = _search("milk")
        assert any(t["id"] == tid for t in found)

        # Delete
        res = _delete(tid)
        assert res["ok"] is True


def test_date_filters_in_list(tmp_path):
    with _ensure_server_running():
        # Create two dated todos
        _create("Task A", scheduled_for="2025-08-06")
        _create("Task B", scheduled_for="2025-08-07")

        # Filter from 6th to 6th inclusive
        today = _list_scheduled(from_ymd="2025-08-06", to_ymd="2025-08-06")
        titles_today = {t["title"] for t in today}
        assert "Task A" in titles_today and "Task B" not in titles_today

        # Filter range covering both
        both = _list_scheduled(from_ymd="2025-08-06", to_ymd="2025-08-07")
        titles_range = {t["title"] for t in both}
        assert {"Task A", "Task B"}.issubset(titles_range)


