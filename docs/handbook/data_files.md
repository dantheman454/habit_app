## Data Files (on disk)

Location: `data/` at repo root

### todos.json
Array of Todo objects. Stored in insertion/update order; no guaranteed sort. Example:
```json
[
  {
    "id": 1,
    "title": "Buy milk",
    "notes": "2%",
    "scheduledFor": "2025-08-12",
    "priority": "high",
    "completed": false,
    "createdAt": "2025-08-11T10:15:12.345Z",
    "updatedAt": "2025-08-11T10:15:12.345Z"
  },
  {
    "id": 2,
    "title": "Inbox cleanup",
    "notes": "",
    "scheduledFor": null,
    "priority": "medium",
    "completed": true,
    "createdAt": "2025-08-11T10:20:00.000Z",
    "updatedAt": "2025-08-11T12:00:00.000Z"
  }
]
```

Constraints enforced by API
- `title` non-empty string
- `scheduledFor` is `YYYY-MM-DD` or `null`
- `priority` ∈ `low|medium|high`
- `completed` boolean
- Timestamps are ISO strings
- `id` is unique per todo; sequentially assigned from `counter.json`

### counter.json
Autoincrement cursor for IDs. Updated synchronously on create.
```json
{ "nextId": 3 }
```

### audit.jsonl
Append-only JSON Lines, one object per line recording applied operations.
Example lines:
```json
{ "ts": "2025-08-11T12:34:56.789Z", "action": "create", "op": {"op":"create","title":"Buy milk"}, "result": "ok", "id": 7 }
{ "ts": "2025-08-11T12:36:00.001Z", "action": "update", "op": {"op":"update","id":7,"priority":"high"}, "result": "ok", "id": 7 }
{ "ts": "2025-08-11T12:36:30.500Z", "action": "complete", "op": {"op":"complete","id":7,"completed":true}, "result": "ok", "id": 7 }
```

Recovery notes
- If `todos.json` is corrupted, back it up, repair JSON or start from an empty array `[]`; `audit.jsonl` can help reconstruct recent changes
- `counter.json` can be reset to `max(id)+1` derived from `todos.json` if needed
- If `audit.jsonl` grows large, you may rotate it manually; the server only appends and does not require historical contents

Creation bootstrap
- If `data/` is missing, the server creates it on startup
- If `todos.json` or `counter.json` are missing, server assumes `[]` and `1` respectively and will create them on first write


