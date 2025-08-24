# LLM Testing Suite

This directory contains comprehensive testing tools for evaluating and optimizing the LLM components of the habit application.

## Overview

The testing suite consists of three main components:

1. **Unit Tests** (`unit/`) - Individual component tests
2. **Integration Tests** (`run.js`) - End-to-end API testing
3. **LLM Testing Suite** (`llm/`) - Standalone tools for LLM evaluation and optimization

## LLM Tasks in the Application

The habit application uses LLMs for four main tasks:

### 1. Router Decision (`router.js`)
**Purpose**: Determines whether to route user input to chat, plan, or clarify
**Model**: `CONVO_MODEL` (hardcoded: `qwen3:32b`)
**Input**: User instruction + transcript + week snapshot + backlog
**Output**: JSON with decision, confidence, and optional clarification details

**Key Prompts**:
```javascript
// Current prompt structure
You are an intent router for a todo assistant. Output a single JSON object only with fields: decision, confidence, question, where, delegate, options. If the user intent is ambiguous about time/date or target, choose "clarify" and ask ONE short question in "question". If user intent is concrete or a prior selection exists, choose "plan" and include a focused "where". Use only the last 3 turns from transcript. Do not include any prose or explanations outside JSON.

Today: {today}
Transcript (last 3): {transcript}
Context (week+backlog): {context}
User: {instruction}
```

### 2. Proposal Generation (`proposal.js`)
**Purpose**: Generates operations to fulfill user requests
**Model**: `CODE_MODEL` (hardcoded: `qwen3:32b`)
**Input**: Task brief + focused context + transcript
**Output**: JSON with operations, steps, and tools

**Key Prompts**:
```javascript
// Current prompt structure
You are the operations planner for a todo app. Output ONLY a single JSON object with keys: version, steps, operations, and optional tools, notes. Follow the rules strictly: include recurrence on create/update (use {"type":"none"} for non-repeating; habits must not be 'none'); if recurrence.type != 'none', include an anchor scheduledFor; for todos use set_status (with optional occurrenceDate for repeating); no bulk; ≤20 ops; do NOT invent invalid IDs. When updating time-related fields, always include timeOfDay if specified.

Timezone: {timezone}
Task: {task}
Where: {where}
Focused context: {context}
Transcript (last 3): {transcript}
```

### 3. Repair (`repair.js`)
**Purpose**: Fixes invalid operations based on validation errors
**Model**: `CODE_MODEL` (hardcoded: `qwen3:32b`)
**Input**: Original operations + validation errors + focused context
**Output**: JSON with repaired operations

**Key Prompts**:
```javascript
// Current prompt structure
You are a repair assistant for todo operations. Fix the invalid operations below by correcting the errors while preserving valid operations. Output ONLY a single JSON object with an "operations" array.

Errors to fix: {errors}
Original operations: {original}
Focused context: {context}

Rules:
- Keep valid operations unchanged
- Fix invalid operations by correcting the errors
- Ensure all required fields are present
- Use only IDs from the focused context
- Include timeOfDay when updating time-related fields
- Include recurrence for create/update operations
```

### 4. Summary (`summary.js`)
**Purpose**: Generates human-readable summaries of operations
**Model**: `CONVO_MODEL` (hardcoded: `qwen3:32b`)
**Input**: Compact operation summaries + issues
**Output**: Plain text summary

**Key Prompts**:
```javascript
// Current prompt structure
You are a helpful assistant for a todo app. Produce a very concise plain-text summary of the plan. If some operations were invalid, mention what is ready vs what needs attention and why. No markdown, no lists, no JSON.

Today: {today} ({timezone})
Ops (compact): {operations}
Issues: {issues}
Summary:
```

## Test Suite Overview

The testing suite consists of three main components:

1. **Unit Tests** (`unit/`) - Individual component tests with network-free defaults
2. **Integration Tests** (`all.js`, `run.js`) - End-to-end API testing with stubbed LLM
3. **LLM Testing Suite** (`llm/suite/`) - Opt-in manual tools for LLM evaluation

## Default Test Suite (Network-Free)

The default test suite runs without external LLM dependencies:

```bash
# Run all tests (unit + integration smoke)
npm test

# Run unit tests only
node --test tests/unit

# Run integration smoke tests
node tests/all.js

# Run MCP/SSE integration tests
node tests/run.js
```

## Opt-in LLM Suite

The LLM testing suite is **not run by default** and requires real model access:

```bash
# Router decision testing
node tests/llm/suite/improved_model_comparison.js --run-tests --task router --models qwen3:32b --iterations 1

# Model comparison across tasks
node tests/llm/suite/improved_model_comparison.js --compare-models --tasks router,proposal,repair --models qwen3:32b

# Validation review interface
node tests/llm/suite/improved_model_comparison.js --validate-scenarios
```

**Note**: The LLM suite is manual/opt-in and may require real model access. It is not included in `npm test` or CI by default.

## Configuration

For LLM-specific configuration and model recommendations, see the [LLM Testing Suite documentation](llm/suite/README.md).

## Router Tests (Chat/Act Only)

The router tests validate the chat/act decision behavior:

- **Unit tests**: `tests/unit/router_chat_act.test.js` - Tests router decisions without network calls
- **Integration**: Router behavior is exercised in `tests/all.js` with stubbed LLM
- **Scope**: Only validates `chat` and `act` decisions (no plan/clarify in default path)

## Assistant Endpoints

Assistant endpoints (`/api/assistant/message` and `/api/assistant/message/stream`) are aligned to chat/act behavior:

- **Chat path**: Returns `{ text, operations: [] }` 
- **Act path**: Returns `{ text, steps, operations, tools, notes }`
- **Fallback**: Graceful chat fallback on execution failures
- **Testing**: Exercised in integration smoke tests with stubbed LLM

## Interpreting Results

For information about interpreting LLM test results, see the [LLM Testing Suite documentation](llm/suite/README.md).

## Best Practices

For LLM-specific best practices, see the [LLM Testing Suite documentation](llm/suite/README.md).

## Troubleshooting

For LLM-specific troubleshooting, see the [LLM Testing Suite documentation](llm/suite/README.md).

## Integration with Development

For information about integrating LLM testing into your development workflow, see the [LLM Testing Suite documentation](llm/suite/README.md).

## Future Enhancements

For information about future LLM testing enhancements, see the [LLM Testing Suite documentation](llm/suite/README.md).

## Contributing

When adding new test scenarios or prompt variations:

1. Add to `TEST_SCENARIOS` or `PROMPT_VARIATIONS` in the appropriate LLM test file
2. Update quality assessment logic
3. Test with multiple models
4. Document expected behavior
5. Add to the [LLM Testing Suite documentation](llm/suite/README.md)

## Support

For issues or questions:
1. Check the troubleshooting section
2. Review the test output for specific errors
3. Ensure all prerequisites are met
4. For LLM-specific issues, see the [LLM Testing Suite documentation](llm/suite/README.md)
