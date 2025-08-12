import json
import os
import subprocess


PROJECT_ROOT = "/Users/dantheman/Desktop/habit_app"
CLIENT = os.path.join(PROJECT_ROOT, "scripts", "mcp_client.js")


def _call(tool: str, args: dict, cwd: str) -> dict:
    proc = subprocess.run(
        ["node", CLIENT, "--tool", tool, "--args", json.dumps(args), "--cwd", cwd],
        text=True,
        capture_output=True,
        check=False,
    )
    assert proc.returncode == 0, f"Client failed: {proc.stderr}"
    return json.loads(proc.stdout)


def test_crud_and_search_behavior(tmp_path):
    workdir = str(tmp_path)

    # Create
    created = _call("create_todo", {"title": "Buy milk", "priority": "high", "scheduledFor": None}, workdir)
    created_text = created["response"]["content"][0]["text"]
    assert "Created todo" in created_text

    # List all
    listed = _call("list_todos", {}, workdir)
    text = listed["response"]["content"][0]["text"]
    assert "Found" in text and "todos" in text

    # Extract first ID
    data_str = text.split("\n", 1)[1]
    todos = json.loads(data_str)
    assert isinstance(todos, list) and len(todos) >= 1
    tid = todos[0]["id"]

    # Get by int and str IDs
    got_int = _call("get_todo", {"id": tid}, workdir)
    got_str = _call("get_todo", {"id": str(tid)}, workdir)
    assert json.loads(got_int["response"]["content"][0]["text"]) == json.loads(got_str["response"]["content"][0]["text"])  # ID coercion

    # Update
    updated = _call("update_todo", {"id": tid, "completed": True}, workdir)
    assert "Updated todo" in updated["response"]["content"][0]["text"]

    # Search
    searched = _call("search_todos", {"query": "milk"}, workdir)
    assert "Found" in searched["response"]["content"][0]["text"]

    # Delete
    deleted = _call("delete_todo", {"id": tid}, workdir)
    assert "Deleted todo" in deleted["response"]["content"][0]["text"]


def test_date_filters_in_list(tmp_path):
    workdir = str(tmp_path)

    # Create two dated todos
    _call("create_todo", {"title": "Task A", "scheduledFor": "2025-08-06"}, workdir)
    _call("create_todo", {"title": "Task B", "scheduledFor": "2025-08-07"}, workdir)

    # Filter from today to today inclusive
    res_today = _call("list_todos", {"scheduledFrom": "2025-08-06", "scheduledTo": "2025-08-06"}, workdir)
    data_today = json.loads(res_today["response"]["content"][0]["text"].split("\n", 1)[1])
    titles_today = {t["title"] for t in data_today}
    assert "Task A" in titles_today and "Task B" not in titles_today

    # Filter range covering both
    res_range = _call("list_todos", {"scheduledFrom": "2025-08-06", "scheduledTo": "2025-08-07"}, workdir)
    data_range = json.loads(res_range["response"]["content"][0]["text"].split("\n", 1)[1])
    titles_range = {t["title"] for t in data_range}
    assert {"Task A", "Task B"}.issubset(titles_range)


