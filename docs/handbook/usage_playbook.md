## Usage Playbook

Day-to-day workflows optimized for speed and clarity.

### Capture (fast entry)
- Type a short title into Quick Entry
- Choose entry mode:
  - Direct: creates a todo scheduled for the current anchor date
  - LLM: enter a natural instruction (e.g., “Schedule haircut Friday and set priority high”), review proposed ops, select, apply

Tips
- Use short, imperative titles (verb-first)
- Default to anchor date for timeboxing; move later if needed

### Organize (daily/weekly planning)
- Pick view: Day/Week/Month; adjust anchor date
- Use Flagged for priority-high items needing attention
- Search to find and regroup scattered items
- Backlog: triage unscheduled items into specific days

### Execute (focus)
- Mark done via checkbox; keep completed hidden for a cleaner board
- Edit inline to refine notes, date, or priority
- Delete aggressively when irrelevant

### Consolidate (bulk import)
- Prepare a `.txt` list (one task per line)
- Import → select lines → choose schedule (anchor or backlog) and default priority → apply

### Propose-and-Verify (structured changes via LLM)
- Enter a concise instruction; example: “Move all high-priority backlog to next week and rename ‘Test’ to ‘Buy milk’”
- Review operations; uncheck anything surprising; apply
- Check summary and spot-check a few todos

### Weekly review (habit lens)
- Scan completed tasks in the past week; note patterns
- Lift 2–3 recurring wins into flagged items for the coming week
- Push low-value backlog items forward or delete

### Quick API cheatsheet (optional)
```bash
# Create and immediately mark complete
id=$(curl -s -X POST http://127.0.0.1:3000/api/todos -H 'Content-Type: application/json' -d '{"title":"Water plants","priority":"low"}' | jq .todo.id)
curl -s -X PATCH http://127.0.0.1:3000/api/todos/$id -H 'Content-Type: application/json' -d '{"completed":true}'

# Search and schedule all matches for tomorrow (client-side loop)
tomorrow=$(date -v+1d +%F)
for id in $(curl -s 'http://127.0.0.1:3000/api/todos/search?query=plants' | jq -r '.todos[].id'); do
  curl -s -X PATCH http://127.0.0.1:3000/api/todos/$id -H 'Content-Type: application/json' -d '{"scheduledFor":"'"$tomorrow"'"}' >/dev/null
done
```


