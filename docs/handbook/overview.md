## Overview

Habit App helps you quickly capture, organize, and complete tasks while keeping a strong link to habits and success rates. It is designed to be fast to use (quick add/edit/delete), powerful at consolidating many todos, and safe when using AI: changes are proposed first, then applied only after your approval.

Core capabilities
- Capture: create todos with title, notes, date (or backlog), and priority
- Organize: Day/Week/Month views anchored to a date; Backlog; Flagged (by priority)
- Execute: mark complete, edit inline, delete, search
- Assistant: natural language instructions → proposed operations with a brief summary → apply

Philosophy alignment
- Virtual secretary: translate intent + calendar into concrete tasks
- Habits lens: tasks are scheduled intentionally; success rates (future) inform behavior
- Low friction: quick actions sheet; minimal clicks to edit/complete/delete

User behaviors the app optimizes for
- Quickly add/modify/delete todos
- Consolidate and organize many todos that build up
- Convert loosely structured lists (e.g., `.txt`) into clean scheduled items

Non-goals
- No multi-user or remote sync (single user only)
- No cloud dependency (all local); LLM runs locally via Ollama

### What “local-only” means
- All state is stored in plain JSON files under `data/`
- The server runs on `127.0.0.1:<PORT>` and serves the web UI and JSON APIs
- The LLM is optional and also runs locally (via `ollama`); without it, all non-LLM features work fully

### Data and safety guarantees (by design)
- Validation at API boundaries prevents malformed data from being persisted
- LLM outputs are normalized and validated; nothing is auto-applied
- Mutations are serialized and audit-logged

### Extensibility
- Add optional fields conservatively to preserve backward compatibility (see `roadmap.md`)
- UI and API are decoupled via JSON; other clients can be added without changing the server contract


