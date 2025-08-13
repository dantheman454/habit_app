## Roadmap (near-term)

- UI polish
  - Keyboard-first quick entry; richer inline editing and validation
  - Group scheduled items with date headers and improve typography
  - Progress toward habit metrics (success rates over time)

- Data model (backward compatible)
  - Optional fields: `flagged`, `order`, `repeatRule`, `listId`, `parentId`

- Assistant workflow
  - Enhanced diffs in assistant review (field-by-field comparison)
  - Additional guardrails and dry-run diagnostics

- Testing
  - Scenario coverage for invalid schemas, conflicting ops, and edge cases

Assumptions remain: single user, all-local data and execution.

Stretch ideas
- Habit analytics: completion streaks, success rates by category/priority, weekly reviews
- Smart scheduling: suggest dates based on backlog size and anchor week load
- Structured lists: optional lists and subtasks while preserving backward compatibility

### Acceptance criteria (samples)
- Keyboard-first quick entry: can create, edit, and submit with Enter/Esc/Tab only; visible focus outlines
- Date headers: lists of scheduled items render in ascending `scheduledFor` groups with human-friendly headings
- Assistant diffs: UI shows before/after for updates; create/delete/complete are clearly labeled

### Compatibility notes
- Persist new optional fields in JSON without breaking existing readers; default missing fields at read time
- Avoid renaming/removing existing fields to preserve integrity of `audit.jsonl` and historical artifacts


