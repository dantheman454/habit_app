# Habit App - Model Tool Calling Test Suite

A comprehensive testing framework for evaluating LLM models' ability to use MCP (Model Context Protocol) tools for todo management operations.

## 📁 Project Structure

```
habit_app/
├── src/                    # Source code
│   └── server.js          # MCP Todo Server (with persistent storage)
├── data/                  # Persistent storage (auto-created)
│   ├── todos.json         # Todo items storage
│   └── counter.json       # ID counter storage
├── tests/                 # Test files
│   └── test_models_tool_calling.py  # Main test framework
├── scripts/               # Utility scripts (planned)
├── docs/                  # Documentation (planned)
├── results/               # Test results
│   ├── TEST_RESULTS_SUMMARY.md  # Latest test summary
│   └── detailed_test_logs_*.json  # Detailed conversation logs
├── node_modules/          # Node.js dependencies
├── package.json           # Node.js project configuration
├── package-lock.json      # Dependency lock file
└── README.md              # This file
```

## 🚀 Quick Start

### 1. Install Dependencies
```bash
npm install
pip3 install -r requirements.txt
```

### 2. Run the Evaluation Suite
All tool execution is routed strictly via the MCP server over stdio using a Node client.

```bash
# Discover models and run selected scenarios, with model-level parallelism
python3 scripts/compare_models.py \
  --discover \
  --scenarios create_simple,workflow_multiple \
  --max-parallel-models 2 \
  --out results/
```

### 3. HTML Report
Open the generated report:

```bash
open results/report_*.html
```

### 4. Direct Test Runner (advanced)
You can invoke the test runner directly:

```bash
python3 tests/test_models_tool_calling.py
```

## 🧰 CLI Runner

The `scripts/compare_models.py` runner executes tests, writes structured JSON aggregates, and renders an HTML report.

### Key Flags
- `--discover`: populate models from `ollama list`
- `--models`: explicit models to test (overrides discover)
- `--scenarios`: comma-separated scenario names
- `--max-parallel-models`: parallelize across models
- `--out`: output directory

### Storage Information
- Each test spawns a fresh MCP server in an isolated temp working directory (sandboxed `data/`).
- The root `data/` directory is used for manual dev runs only.

## 📊 What This Tests

The framework evaluates different LLM models on their ability to:

- **Tool Discovery**: Identify which MCP tools to use for given tasks
- **Parameter Extraction**: Extract correct parameters from natural language
- **Tool Calling**: Generate properly formatted tool calls using Function Calling format
- **Workflow Understanding**: Chain multiple operations together
- **Error Handling**: Deal with invalid requests gracefully

### Test Scenarios

1. **Simple Operations** (Complexity 1-2)
   - Create todo with specific parameters
   - List todos with filters
   - Update existing todos

2. **Complex Workflows** (Complexity 3-4)
   - Multi-step operations (create → list → update)
   - Complex planning scenarios
   - Error recovery situations

## 🏆 Latest Results Summary

| Model | Success Rate | Tool Accuracy | Avg Response Time |
|-------|-------------|---------------|-------------------|
| llama3.2:3b | 77.3% ⭐ | 100.0% | 5.16s ⚡ |
| phi4:14b | 73.3% | 100.0% 🎯 | 20.76s |
| llama3.1:8b | 62.7% | 96.0% | 7.80s |
| phi4-mini:3.8b | 62.7% | 82.7% | 3.79s ⚡ |

See `results/TEST_RESULTS_SUMMARY.md` for detailed analysis.

## 🛠 MCP Server Features

The todo server provides:

### Tools
- `create_todo` - Create new todo items
- `list_todos` - List todos with optional filters
- `get_todo` - Get specific todo by ID
- `update_todo` - Update existing todos
- `delete_todo` - Delete todos

### Resources
- `todo://all` - All todo items
- `todo://pending` - Incomplete todos only
- `todo://completed` - Completed todos only

### Prompts
- `daily_review` - Daily planning assistance
- `priority_analysis` - Priority optimization
- `schedule_conflicts` - Conflict detection

## 🧪 Tool Call Format

Function Calling syntax (Python-like):

```text
create_todo(title="Buy groceries", priority="high", scheduledFor="2025-08-07")
list_todos(completed=False)
update_todo(id=1, completed=True)
```

## 📚 Documentation

- API documentation in source code comments

## 🔧 Development

### Adding New Test Scenarios

Edit `tests/test_models_tool_calling.py` and add to the `TEST_SCENARIOS` dictionary:

```python
"your_test": {
    "prompt": "Your test prompt here",
    "expected_tools": ["tool1", "tool2"],
    "complexity": 2
}
```

### Extending the MCP Server

Add new tools, resources, or prompts in `src/server.js` following the existing patterns.

## 📈 Contributing

1. Add new test scenarios for edge cases
2. Improve the tool call parser for better accuracy
3. Add more sophisticated metrics
4. Extend the MCP server with additional capabilities

## 🎯 Goals

This project helps answer:
- Which LLM models are best at tool calling?
- How do models handle complex multi-step workflows?
- What are the common failure patterns in tool usage?
- How can we improve tool calling prompts and formats?
