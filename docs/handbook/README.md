## Habit App Handbook

Audience: you (single user). Scope: in-depth, single-machine, entirely local. This handbook is the living source for how Habit App works and how to extend it. It mirrors the implementation in `server.js` and the test suite under `tests/` so you can trust it for day-to-day operations and development.

### Table of contents
- `overview.md` — high-level purpose, capabilities, philosophy alignment, non-goals
- `architecture.md` — component + sequence diagrams, request lifecycle, concurrency, durability
- `api.md` — REST contract with parameters, validation rules, examples, and error codes
- `ui.md` — UX behaviors, views/filters, import workflow, accessibility/keyboard
- `llm.md` — proposal-and-verify design, prompt shape, normalization, validation, audit
- `development.md` — local setup, run/verify, environment, data management without external dependencies
- `testing.md` — manual smoke checks, automated tests, artifacts and how to interpret them
- `troubleshooting.md` — common failures, diagnostics, recovery procedures
- `roadmap.md` — prioritized improvements, acceptance criteria, compatibility notes
- `data_files.md` — on-disk schema for todos/counter/audit with concrete examples
- `usage_playbook.md` — workflows for capture, organize, execute, weekly review

### Naming and assumptions
- Name: “Habit App” throughout
- Assumptions: single user; single server; all data and services run locally; no cloud

### Conventions used in this handbook
- Dates are `YYYY-MM-DD` (e.g., `2025-08-12`)
- Timestamps are ISO strings (e.g., `2025-08-11T10:15:12.345Z`)
- All HTTP responses are JSON; successful create/update/delete return `200` with a body
- Unless stated, lists are returned in storage order (no guaranteed sorting)
- Base URL for examples: `http://127.0.0.1:3000`

### Glossary
- Todo: a task item with required `title` and optional `notes`, `scheduledFor`, `priority`, `completed`
- Backlog: todos with `scheduledFor: null`
- Anchor date: the date from which Day/Week/Month ranges are computed; defaults to today in most flows
- Proposal: LLM-produced array of operations; only applied after explicit approval
- Operation: one of `{ op: 'create'|'update'|'delete'|'complete', ... }`
- Audit entry: an append-only line in `data/audit.jsonl` describing an applied operation

### Quick start (pointer)
If you are here just to run the app, jump to `development.md`. For APIs, jump to `api.md`. For LLM behavior details, jump to `llm.md`.


