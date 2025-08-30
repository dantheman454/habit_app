# Tests

## Structure
- Unit tests under `tests/unit/*.test.js`
- Aggregated runner `tests/all.js` (boots server and executes suites)
- Integration flows in `tests/run.js`

## Focus areas
- Database service behaviors (tasks/events CRUD)
- Operation processor validation and execution
- MCP server tool listing, conversion, and resource reads
- Routes: `/api/schedule`, `/api/search`

## Running
```bash
npm test
```

## Notes
- Habits and goals are removed from the codebase
- Tasks and events are the only first-class entities
- MCP tools: `create|update|delete_(task|event)`, `set_task_status`
- Occurrence completion uses `set_task_status` with `occurrenceDate`
