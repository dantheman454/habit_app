# LLM Testing Suite

This directory contains standalone tools for testing and optimizing the LLM components of the habit application.

## Overview

These tools are **standalone** and are **not integrated** with the main test suite. They are designed for:
- Model performance evaluation
- Prompt optimization
- LLM-specific testing and benchmarking

## Tools

### 1. Model Comparison (`model_comparison.js`)

Tests different models on each LLM task in the application.

**Usage:**
```bash
# Test all tasks with default models
node tests/llm/model_comparison.js

# Test specific task
node tests/llm/model_comparison.js --task router --models llama3.2:3b,granite-code:8b

# Test with more iterations for better accuracy
node tests/llm/model_comparison.js --task proposal --models granite-code:8b,llama3.2:8b --iterations 5
```

**What it tests:**
- Router Decision (intent classification)
- Proposal Generation (operation planning)
- Repair (error correction)
- Summary (text generation)

**Output:**
- Clean, formatted JSON responses (no verbose metadata)
- Console output with real-time progress
- Detailed JSON reports in `tests/llm/reports/`
- Summary statistics for each model/task combination

### 2. Prompt Optimization (`prompt_optimizer.js`)

Tests different prompt variations to find the most effective ones.

**Usage:**
```bash
# Optimize router prompts
node tests/llm/prompt_optimizer.js --task router --model llama3.2:3b

# Test more prompt variations
node tests/llm/prompt_optimizer.js --task proposal --model granite-code:8b --variations 5

# Test with more iterations
node tests/llm/prompt_optimizer.js --task repair --model granite-code:8b --iterations 3
```

**What it tests:**
- Different prompt strategies (JSON-only, chain-of-thought, few-shot, etc.)
- Quality assessment of responses
- Performance metrics (speed, accuracy)

**Output:**
- Clean, formatted JSON responses (no verbose metadata)
- Console output with rankings
- Detailed JSON reports in `tests/llm/reports/`
- Recommendations for best prompts

## Prerequisites

1. **Ollama installed and running**
   ```bash
   # Install Ollama
   curl -fsSL https://ollama.ai/install.sh | sh
   
   # Pull required models
   ollama pull llama3.2:3b
   ollama pull granite-code:8b
   ollama pull llama3.2:8b
   ```

2. **Node.js environment**
   ```bash
   # Install dependencies
   npm install
   ```

## Quick Start

```bash
# 1. Test model performance
node tests/llm/model_comparison.js --task router --models llama3.2:3b,granite-code:8b

# 2. Optimize prompts for best model
node tests/llm/prompt_optimizer.js --task router --model llama3.2:3b

# 3. Run comprehensive test
node tests/llm/model_comparison.js --task all --models llama3.2:3b,granite-code:8b,llama3.2:8b --iterations 5
```

## Reports

All reports are saved to `tests/llm/reports/` with timestamps:

- `llm_comparison_report_YYYY-MM-DDTHH-MM-SS.json` - Model comparison results
- `prompt_optimization_TASK_YYYY-MM-DDTHH-MM-SS.json` - Prompt optimization results

## Configuration

### Environment Variables

```bash
# Model configuration
CONVO_MODEL=llama3.2:3b          # Conversation model
CODE_MODEL=granite-code:8b       # Code/operations model
OLLAMA_HOST=127.0.0.1           # Ollama host
OLLAMA_PORT=11434               # Ollama port
LLM_TIMEOUT_MS=30000            # Timeout for LLM calls

# Timezone
TZ_NAME=America/New_York        # Timezone for date handling
```

### Model Recommendations

**For Router/Summary (Conversation Tasks):**
- `llama3.2:3b` - Good balance of speed and quality
- `llama3.2:8b` - Higher quality, slower
- `granite3.3:8b` - High quality, good reasoning

**For Proposal/Repair (Code Tasks):**
- `granite-code:8b` - Excellent for structured operations
- `llama3.2:8b` - Good fallback option
- `codellama:7b` - Alternative code model

## Troubleshooting

### Common Issues

1. **Ollama not running**
   ```bash
   # Start Ollama
   ollama serve
   ```

2. **Model not found**
   ```bash
   # Pull missing model
   ollama pull llama3.2:3b
   ```

3. **Timeout errors**
   ```bash
   # Increase timeout
   export LLM_TIMEOUT_MS=60000
   ```

4. **Memory issues**
   ```bash
   # Use smaller models or reduce batch size
   node tests/llm/model_comparison.js --iterations 1
   ```

## Integration Notes

These tools are **standalone** and will **not** be run by:
- `npm test`
- `node tests/all.js`
- `node tests/run.js`

They are designed for manual LLM evaluation and optimization only.

## Output Format

The testing tools now provide clean, readable output:

### Console Output
- **📄 Response**: Pretty-printed JSON responses (no verbose metadata)
- **📊 Progress**: Real-time test progress with scenarios
- **📋 Summary**: Final statistics and rankings

### Example Output
```
🧪 Testing ROUTER task...
📊 Testing model: llama3.2:3b
  🔄 Running scenario: Clear action request
[LLM:router] model=llama3.2:3b bytesIn=4957 bytesOut=8215
📄 Response: {
  "decision": "clarify",
  "confidence": 0.3,
  "question": "Which task do you want to update?",
  "options": [
    {
      "id": 8,
      "title": "Plan inbox",
      "scheduledFor": "2025-08-17"
    }
  ]
}
```

## Examples

### Model Comparison Example

```bash
# Compare two models on router task
node tests/llm/model_comparison.js --task router --models llama3.2:3b,granite-code:8b --iterations 3

# Output:
# 🚀 Starting LLM Model Comparison Tests
# 📋 Models: llama3.2:3b, granite-code:8b
# 🔄 Iterations per test: 3
# 
# 🧪 Testing ROUTER task...
# 📊 Testing model: llama3.2:3b
#   🔄 Running scenario: Clear action request
#   🔄 Running scenario: Ambiguous target
#   ...
# 
# 📊 TEST SUMMARY
# ============================================================
# 
# ROUTER:
# ----------------------------------------
# llama3.2:3b:
#   Success Rate: 85.0%
#   Avg Duration: 1200ms
#   Error Rate: 15.0%
# 
# granite-code:8b:
#   Success Rate: 92.0%
#   Avg Duration: 2100ms
#   Error Rate: 8.0%
```

### Prompt Optimization Example

```bash
# Test different prompt strategies
node tests/llm/prompt_optimizer.js --task router --model llama3.2:3b --variations 4

# Output:
# 🔧 Optimizing prompts for router task with model llama3.2:3b
# 
# 📝 Testing variation: Current (JSON-only)
# 📝 Testing variation: Chain-of-thought
# 📝 Testing variation: Few-shot examples
# 📝 Testing variation: Structured reasoning
# 
# 🏆 Ranking by Quality Score:
# ----------------------------------------
# 1. Chain-of-thought
#    Quality: 95.0%
#    Success: 92.0%
#    Duration: 1800ms
#    Tests: 12
# 
# 2. Current (JSON-only)
#    Quality: 90.0%
#    Success: 85.0%
#    Duration: 1200ms
#    Tests: 12
```

## Best Practices

1. **Start small**: Test one task with few models first
2. **Iterate**: Run multiple iterations for accuracy
3. **Optimize**: Use prompt optimizer for best results
4. **Monitor**: Track performance over time
5. **Document**: Keep notes on which models/prompts work best

## Future Enhancements

1. **Automated model selection**: Choose best model per task
2. **Dynamic prompt optimization**: Real-time prompt adjustment
3. **Performance regression testing**: Detect performance degradation
4. **Cost optimization**: Balance quality vs cost
5. **Multi-modal testing**: Test with different input types
