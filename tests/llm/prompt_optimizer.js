#!/usr/bin/env node

/**
 * Prompt Optimization Testing Suite
 * 
 * This utility helps optimize prompts by testing different variations and measuring
 * their effectiveness across different models and scenarios.
 * 
 * Usage:
 *   node tests/prompt_optimizer.js --task router --model llama3.2:3b
 *   node tests/prompt_optimizer.js --task proposal --model granite-code:8b --variations 5
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Prompt variations for each task
const PROMPT_VARIATIONS = {
  router: [
    {
      name: "Current (JSON-only)",
      prompt: `You are an intent router for a todo assistant. Output a single JSON object only with fields: decision, confidence, question, where, delegate, options. If the user intent is ambiguous about time/date or target, choose "clarify" and ask ONE short question in "question". If user intent is concrete or a prior selection exists, choose "plan" and include a focused "where". Use only the last 3 turns from transcript. Do not include any prose or explanations outside JSON.

Today: {today}
Transcript (last 3):
{transcript}

Context (week+backlog):
{context}

User: {instruction}

Example outputs:
For a clear action: {"decision": "plan", "confidence": 0.9, "where": "Plan inbox"}
For ambiguous target: {"decision": "clarify", "confidence": 0.3, "question": "Which task do you want to update?", "options": [...]}
For general chat: {"decision": "chat", "confidence": 0.8}`
    },
    {
      name: "Chain-of-thought",
      prompt: `You are an intent router for a todo assistant. Think through the user's intent step by step, then output a single JSON object with fields: decision, confidence, question, where, delegate, options.

Steps:
1. Analyze the user's request for clarity and specificity
2. Determine if they need clarification (ambiguous target, time, or date)
3. Check if they have a concrete action in mind
4. Assess if this is general conversation
5. Output the appropriate decision with confidence

Today: {today}
Transcript (last 3):
{transcript}

Context (week+backlog):
{context}

User: {instruction}

Output JSON only:
{"decision": "plan|clarify|chat", "confidence": 0.0-1.0, "question": "if clarify", "where": "if plan", "options": "if clarify"}`
    },
    {
      name: "Few-shot examples",
      prompt: `You are an intent router for a todo assistant. Output JSON only.

Today: {today}
Transcript (last 3):
{transcript}

Context (week+backlog):
{context}

Examples:
User: "Complete my task for today"
Output: {"decision": "plan", "confidence": 0.9, "where": "today"}

User: "Update my task"
Output: {"decision": "clarify", "confidence": 0.3, "question": "Which task do you want to update?", "options": [...]}

User: "How are you doing?"
Output: {"decision": "chat", "confidence": 0.8}

User: {instruction}
Output:`
    },
    {
      name: "Structured reasoning",
      prompt: `You are an intent router for a todo assistant. Follow this structure:

REASONING:
- Intent clarity: [high/medium/low]
- Action specificity: [specific/ambiguous]
- Context dependency: [needed/not needed]
- Time reference: [present/absent]

DECISION:
Output JSON: {"decision": "plan|clarify|chat", "confidence": 0.0-1.0, "question": "if clarify", "where": "if plan", "options": "if clarify"}

Today: {today}
Transcript (last 3):
{transcript}

Context (week+backlog):
{context}

User: {instruction}`
    }
  ],
  
  proposal: [
    {
      name: "Current (Strict rules)",
      prompt: `You are the operations planner for a todo app. Output ONLY a single JSON object with keys: version, steps, operations, and optional tools, notes. Follow the rules strictly: include recurrence on create/update (use {"type":"none"} for non-repeating; habits must not be 'none'); if recurrence.type != 'none', include an anchor scheduledFor; for todos use set_status (with optional occurrenceDate for repeating); no bulk; ≤20 ops; do NOT invent invalid IDs. When updating time-related fields, always include timeOfDay if specified. You may internally reason, but the final output MUST be JSON only.

Timezone: {timezone}
Task: {task}
Where: {where}
Focused context: {context}
Transcript (last 3):
{transcript}

IMPORTANT: Use ONLY the IDs from the focused context. Do NOT invent IDs. If updating a task, use its exact ID from the context.

Respond with JSON exactly as:
{
  "version":"3",
  "steps":[{"name":"Identify targets"},{"name":"Apply changes","expectedOps":2}],
  "operations":[{"kind":"todo","action":"update","id":123,"scheduledFor":"{today}","timeOfDay":"21:00","recurrence":{"type":"none"}}]
}`
    },
    {
      name: "Step-by-step planning",
      prompt: `You are the operations planner for a todo app. Plan step by step:

1. ANALYZE: Understand the user's request and identify what needs to be done
2. IDENTIFY: Find relevant items from the context that match the request
3. PLAN: Determine the specific operations needed (create, update, delete, complete)
4. VALIDATE: Ensure all operations follow the schema rules
5. OUTPUT: JSON with version, steps, operations

Rules:
- Include recurrence for create/update operations
- Use valid IDs from context only
- Include timeOfDay when updating time fields
- Limit to 20 operations maximum

Timezone: {timezone}
Task: {task}
Where: {where}
Focused context: {context}
Transcript (last 3):
{transcript}

Output JSON:`
    },
    {
      name: "Schema-first approach",
      prompt: `You are the operations planner for a todo app. Focus on the schema first:

REQUIRED SCHEMA:
- version: "3"
- steps: [{"name": "string"}]
- operations: [{"kind": "todo|event|habit", "action": "create|update|delete|set_status", ...}]

OPERATION RULES:
- create/update: must include recurrence object
- update/delete: must include valid id
- todos: use set_status for completion
- habits: must be repeating (not "none")
- time updates: include timeOfDay field

Timezone: {timezone}
Task: {task}
Where: {where}
Focused context: {context}
Transcript (last 3):
{transcript}

Output JSON following the schema:`
    }
  ],
  
  repair: [
    {
      name: "Current (Error-focused)",
      prompt: `You are a repair assistant for todo operations. Fix the invalid operations below by correcting the errors while preserving valid operations. Output ONLY a single JSON object with an "operations" array.

Errors to fix:
{errors}

Original operations:
{original}

Focused context:
{context}

Rules:
- Keep valid operations unchanged
- Fix invalid operations by correcting the errors
- Ensure all required fields are present
- Use only IDs from the focused context
- Include timeOfDay when updating time-related fields
- Include recurrence for create/update operations`
    },
    {
      name: "Validation-driven repair",
      prompt: `You are a repair assistant for todo operations. For each error, apply the appropriate fix:

VALIDATION RULES:
- missing_recurrence: Add {"type": "none"} for todos, {"type": "daily"} for habits
- missing_timeOfDay: Add timeOfDay field when updating time-related fields
- id_not_found: Use only valid IDs from context
- missing_anchor_for_recurrence: Add scheduledFor when recurrence.type != "none"

Errors to fix:
{errors}

Original operations:
{original}

Focused context:
{context}

Apply fixes and output JSON:`
    },
    {
      name: "Context-aware repair",
      prompt: `You are a repair assistant for todo operations. Use the context to fix errors:

CONTEXT ANALYSIS:
- Available todos: {context.todos?.length || 0}
- Available events: {context.events?.length || 0}
- Available habits: {context.habits?.length || 0}

ERROR FIXING:
- For missing IDs: Use only IDs present in context
- For missing fields: Add required fields based on operation type
- For invalid values: Replace with valid values from context

Errors to fix:
{errors}

Original operations:
{original}

Focused context:
{context}

Output repaired operations as JSON:`
    }
  ],
  
  summary: [
    {
      name: "Current (Concise)",
      prompt: `You are a helpful assistant for a todo app. Produce a very concise plain-text summary of the plan. If some operations were invalid, mention what is ready vs what needs attention and why. No markdown, no lists, no JSON.

Today: {today} ({timezone})
Ops (compact):
{operations}

Issues: {issues}

Summary:`
    },
    {
      name: "Action-oriented",
      prompt: `You are a helpful assistant for a todo app. Summarize what actions will be taken:

ACTIONS TO PERFORM:
{operations}

ISSUES TO ADDRESS:
{issues}

Provide a clear, action-oriented summary in 1-2 sentences. Focus on what the user can expect to happen.`
    },
    {
      name: "User-friendly",
      prompt: `You are a helpful assistant for a todo app. Explain what will happen in user-friendly terms:

Today: {today}

What I'll do:
{operations}

Any problems:
{issues}

Tell the user what to expect in simple, friendly language.`
    }
  ]
};

// Test scenarios for prompt optimization
const OPTIMIZATION_SCENARIOS = {
  router: [
    {
      name: "Clear action",
      instruction: "Complete my task for today",
      transcript: [],
      expected: { decision: "plan", confidence: "high" }
    },
    {
      name: "Ambiguous target",
      instruction: "Update my task",
      transcript: [],
      expected: { decision: "clarify", confidence: "low" }
    },
    {
      name: "General chat",
      instruction: "How are you doing?",
      transcript: [],
      expected: { decision: "chat", confidence: "high" }
    },
    {
      name: "With context",
      instruction: "the first one",
      transcript: [
        { role: "user", text: "Update my task" },
        { role: "assistant", text: "Which task? Options: #1 \"Review project\" @2024-01-15; #2 \"Call client\" @2024-01-15." }
      ],
      expected: { decision: "plan", confidence: "high" }
    }
  ],
  
  proposal: [
    {
      name: "Create todo",
      instruction: "Create a task called 'Test task' for today",
      transcript: [],
      focusedWhere: {},
      expected: { hasRecurrence: true, validOperation: true }
    },
    {
      name: "Update time",
      instruction: "Change the time of my task to 3pm",
      transcript: [],
      focusedWhere: { ids: [1] },
      expected: { hasTimeOfDay: true, hasRecurrence: true }
    },
    {
      name: "Complete task",
      instruction: "Mark my task as done",
      transcript: [],
      focusedWhere: { ids: [1] },
      expected: { validOperation: true }
    }
  ],
  
  repair: [
    {
      name: "Missing recurrence",
      original: [{ kind: "todo", action: "create", title: "Test" }],
      errors: [{ op: { kind: "todo", action: "create", title: "Test" }, errors: ["missing_recurrence"] }],
      expected: { hasRecurrence: true }
    },
    {
      name: "Missing timeOfDay",
      original: [{ kind: "todo", action: "update", id: 1, scheduledFor: "2024-01-15" }],
      errors: [{ op: { kind: "todo", action: "update", id: 1 }, errors: ["missing_timeOfDay"] }],
      expected: { hasTimeOfDay: true }
    }
  ],
  
  summary: [
    {
      name: "Simple operations",
      operations: [
        { kind: "todo", action: "create", title: "New task" },
        { kind: "todo", action: "update", id: 1, status: "completed" }
      ],
      issues: [],
      expected: { hasText: true, mentionsActions: true }
    },
    {
      name: "With errors",
      operations: [{ kind: "todo", action: "create", title: "Valid task" }],
      issues: ["missing_recurrence for operation 2"],
      expected: { hasText: true, mentionsIssues: true }
    }
  ]
};

class PromptOptimizer {
  constructor(options = {}) {
    this.model = options.model || 'llama3.2:3b';
    this.task = options.task || 'router';
    this.variations = options.variations || 3;
    this.iterations = options.iterations || 2;
    this.results = {};
  }

  async testPromptVariation(variation, scenario) {
    const startTime = Date.now();
    
    try {
      // Mock the LLM call for now - in real implementation, this would call the actual LLM
      const mockResult = await this.mockLLMCall(variation, scenario);
      const duration = Date.now() - startTime;
      
      return {
        success: true,
        result: mockResult,
        duration,
        quality: this.assessQuality(mockResult, scenario.expected)
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        duration: Date.now() - startTime
      };
    }
  }

  async mockLLMCall(variation, scenario) {
    // This is a mock implementation - replace with actual LLM calls
    await new Promise(resolve => setTimeout(resolve, 100 + Math.random() * 200));
    
    // Simulate different response qualities based on prompt variation
    const qualityFactors = {
      "Current (JSON-only)": 0.9,
      "Chain-of-thought": 0.95,
      "Few-shot examples": 0.85,
      "Structured reasoning": 0.92,
      "Step-by-step planning": 0.88,
      "Schema-first approach": 0.93,
      "Error-focused": 0.87,
      "Validation-driven repair": 0.91,
      "Context-aware repair": 0.89,
      "Concise": 0.86,
      "Action-oriented": 0.94,
      "User-friendly": 0.90
    };
    
    const quality = qualityFactors[variation.name] || 0.8;
    
    // Generate appropriate mock response based on task
    switch (this.task) {
      case 'router':
        return this.mockRouterResponse(scenario, quality);
      case 'proposal':
        return this.mockProposalResponse(scenario, quality);
      case 'repair':
        return this.mockRepairResponse(scenario, quality);
      case 'summary':
        return this.mockSummaryResponse(scenario, quality);
      default:
        return { error: "Unknown task" };
    }
  }

  mockRouterResponse(scenario, quality) {
    const baseResponse = {
      decision: scenario.expected.decision,
      confidence: quality * 0.8 + 0.2
    };
    
    if (scenario.expected.decision === 'clarify') {
      baseResponse.question = "Which task do you want to update?";
      baseResponse.options = [
        { id: 1, title: "Review project", scheduledFor: "2024-01-15" },
        { id: 2, title: "Call client", scheduledFor: "2024-01-15" }
      ];
    } else if (scenario.expected.decision === 'plan') {
      baseResponse.where = "today";
    }
    
    return baseResponse;
  }

  mockProposalResponse(scenario, quality) {
    const operations = [];
    
    if (scenario.name === "Create todo") {
      operations.push({
        kind: "todo",
        action: "create",
        title: "Test task",
        scheduledFor: "2024-01-15",
        recurrence: { type: "none" }
      });
    } else if (scenario.name === "Update time") {
      operations.push({
        kind: "todo",
        action: "update",
        id: 1,
        timeOfDay: "15:00",
        recurrence: { type: "none" }
      });
    } else if (scenario.name === "Complete task") {
      operations.push({
        kind: "todo",
        action: "set_status",
        id: 1,
        status: "completed"
      });
    }
    
    return {
      version: "3",
      steps: [{ name: "Identify targets" }, { name: "Apply changes" }],
      operations
    };
  }

  mockRepairResponse(scenario, quality) {
    const operations = [...scenario.original];
    
    if (scenario.name === "Missing recurrence") {
      operations[0].recurrence = { type: "none" };
    } else if (scenario.name === "Missing timeOfDay") {
      operations[0].timeOfDay = "09:00";
    }
    
    return { operations };
  }

  mockSummaryResponse(scenario, quality) {
    if (scenario.name === "Simple operations") {
      return "I'll create a new task and mark the existing one as completed.";
    } else if (scenario.name === "With errors") {
      return "I'll create the valid task, but there's an issue with the second operation that needs attention.";
    }
    
    return "Operations completed successfully.";
  }

  assessQuality(result, expected) {
    let score = 0;
    let checks = 0;
    
    // Task-specific quality checks
    switch (this.task) {
      case 'router':
        if (result.decision === expected.decision) score += 0.4;
        if (result.confidence >= 0.3) score += 0.3;
        if (expected.decision === 'clarify' && result.question) score += 0.3;
        checks = 3;
        break;
        
      case 'proposal':
        if (Array.isArray(result.operations)) score += 0.3;
        if (result.operations?.length > 0) score += 0.3;
        if (expected.hasRecurrence && result.operations?.some(op => op.recurrence)) score += 0.2;
        if (expected.hasTimeOfDay && result.operations?.some(op => op.timeOfDay)) score += 0.2;
        checks = 4;
        break;
        
      case 'repair':
        if (Array.isArray(result.operations)) score += 0.5;
        if (expected.hasRecurrence && result.operations?.some(op => op.recurrence)) score += 0.5;
        checks = 2;
        break;
        
      case 'summary':
        if (typeof result === 'string' && result.length > 0) score += 0.5;
        if (expected.mentionsActions && result.toLowerCase().includes('create')) score += 0.5;
        checks = 2;
        break;
    }
    
    return checks > 0 ? score / checks : 0;
  }

  async runOptimization() {
    console.log(`🔧 Optimizing prompts for ${this.task} task with model ${this.model}`);
    
    const variations = PROMPT_VARIATIONS[this.task] || [];
    const scenarios = OPTIMIZATION_SCENARIOS[this.task] || [];
    
    if (variations.length === 0) {
      console.log(`❌ No prompt variations found for task: ${this.task}`);
      return;
    }
    
    if (scenarios.length === 0) {
      console.log(`❌ No test scenarios found for task: ${this.task}`);
      return;
    }
    
    const results = {};
    
    for (const variation of variations.slice(0, this.variations)) {
      console.log(`\n📝 Testing variation: ${variation.name}`);
      results[variation.name] = { scenarios: [], summary: {} };
      
      for (const scenario of scenarios) {
        console.log(`  🔄 Running scenario: ${scenario.name}`);
        
        const scenarioResults = [];
        for (let i = 0; i < this.iterations; i++) {
          const result = await this.testPromptVariation(variation, scenario);
          scenarioResults.push(result);
          
          if (i < this.iterations - 1) {
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        }
        
        results[variation.name].scenarios.push({
          name: scenario.name,
          results: scenarioResults,
          summary: this.summarizeScenarioResults(scenarioResults)
        });
      }
      
      results[variation.name].summary = this.summarizeVariationResults(results[variation.name].scenarios);
    }
    
    this.results = results;
    return results;
  }

  summarizeScenarioResults(results) {
    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);
    
    if (successful.length === 0) {
      return {
        successRate: 0,
        avgDuration: 0,
        avgQuality: 0,
        errorRate: 1
      };
    }
    
    const avgDuration = successful.reduce((sum, r) => sum + r.duration, 0) / successful.length;
    const avgQuality = successful.reduce((sum, r) => sum + r.quality, 0) / successful.length;
    
    return {
      successRate: successful.length / results.length,
      avgDuration,
      avgQuality,
      errorRate: failed.length / results.length
    };
  }

  summarizeVariationResults(scenarios) {
    const allResults = scenarios.flatMap(s => s.results);
    const successful = allResults.filter(r => r.success);
    const failed = allResults.filter(r => !r.success);
    
    const avgDuration = successful.length > 0 
      ? successful.reduce((sum, r) => sum + r.duration, 0) / successful.length 
      : 0;
    const avgQuality = successful.length > 0
      ? successful.reduce((sum, r) => sum + r.quality, 0) / successful.length
      : 0;
    
    return {
      totalTests: allResults.length,
      successRate: successful.length / allResults.length,
      avgDuration,
      avgQuality,
      errorRate: failed.length / allResults.length
    };
  }

  printResults() {
    console.log('\n📊 PROMPT OPTIMIZATION RESULTS');
    console.log('='.repeat(60));
    
    const variations = Object.keys(this.results);
    if (variations.length === 0) {
      console.log('No results to display');
      return;
    }
    
    // Sort by quality score
    const sortedVariations = variations.sort((a, b) => {
      const qualityA = this.results[a].summary.avgQuality;
      const qualityB = this.results[b].summary.avgQuality;
      return qualityB - qualityA;
    });
    
    console.log(`\n🏆 Ranking by Quality Score:`);
    console.log('-'.repeat(40));
    
    for (let i = 0; i < sortedVariations.length; i++) {
      const variation = sortedVariations[i];
      const summary = this.results[variation].summary;
      
      console.log(`${i + 1}. ${variation}`);
      console.log(`   Quality: ${(summary.avgQuality * 100).toFixed(1)}%`);
      console.log(`   Success: ${(summary.successRate * 100).toFixed(1)}%`);
      console.log(`   Duration: ${summary.avgDuration.toFixed(0)}ms`);
      console.log(`   Tests: ${summary.totalTests}`);
      console.log('');
    }
    
    // Detailed breakdown
    console.log('\n📋 Detailed Breakdown:');
    console.log('-'.repeat(40));
    
    for (const variation of sortedVariations) {
      const summary = this.results[variation].summary;
      console.log(`\n${variation}:`);
      console.log(`  Overall Quality: ${(summary.avgQuality * 100).toFixed(1)}%`);
      console.log(`  Success Rate: ${(summary.successRate * 100).toFixed(1)}%`);
      console.log(`  Average Duration: ${summary.avgDuration.toFixed(0)}ms`);
      
      // Scenario breakdown
      for (const scenario of this.results[variation].scenarios) {
        console.log(`    ${scenario.name}: ${(scenario.summary.avgQuality * 100).toFixed(1)}% quality`);
      }
    }
  }

  async saveResults(filename = null) {
    if (!filename) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      filename = `prompt_optimization_${this.task}_${timestamp}.json`;
    }
    
    const reportPath = path.join(__dirname, 'reports', filename);
    
    try {
      await fs.mkdir(path.dirname(reportPath), { recursive: true });
    } catch (error) {
      // Directory might already exist
    }
    
    const report = {
      timestamp: new Date().toISOString(),
      configuration: {
        task: this.task,
        model: this.model,
        variations: this.variations,
        iterations: this.iterations
      },
      results: this.results,
      recommendations: this.generateRecommendations()
    };
    
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(`📄 Results saved to: ${reportPath}`);
    
    return reportPath;
  }

  generateRecommendations() {
    const variations = Object.keys(this.results);
    if (variations.length === 0) return [];
    
    // Sort by quality
    const sortedVariations = variations.sort((a, b) => {
      const qualityA = this.results[a].summary.avgQuality;
      const qualityB = this.results[b].summary.avgQuality;
      return qualityB - qualityA;
    });
    
    const best = sortedVariations[0];
    const bestSummary = this.results[best].summary;
    
    const recommendations = [
      {
        type: "best_prompt",
        prompt: best,
        quality: bestSummary.avgQuality,
        reasoning: `Highest quality score (${(bestSummary.avgQuality * 100).toFixed(1)}%) with ${(bestSummary.successRate * 100).toFixed(1)}% success rate`
      }
    ];
    
    // Performance recommendations
    const fastest = variations.sort((a, b) => {
      const durationA = this.results[a].summary.avgDuration;
      const durationB = this.results[b].summary.avgDuration;
      return durationA - durationB;
    })[0];
    
    if (fastest !== best) {
      const fastestSummary = this.results[fastest].summary;
      recommendations.push({
        type: "fastest_prompt",
        prompt: fastest,
        duration: fastestSummary.avgDuration,
        reasoning: `Fastest response time (${fastestSummary.avgDuration.toFixed(0)}ms)`
      });
    }
    
    // Quality vs speed trade-off
    const qualityThreshold = 0.8;
    const speedThreshold = 1000; // ms
    
    const balanced = variations.find(v => {
      const summary = this.results[v].summary;
      return summary.avgQuality >= qualityThreshold && summary.avgDuration <= speedThreshold;
    });
    
    if (balanced && balanced !== best) {
      recommendations.push({
        type: "balanced_prompt",
        prompt: balanced,
        reasoning: "Good balance of quality and speed"
      });
    }
    
    return recommendations;
  }
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);
  
  const options = {
    task: 'router',
    model: 'llama3.2:3b',
    variations: 3,
    iterations: 2,
    saveResults: true
  };
  
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--task':
        options.task = args[++i];
        break;
      case '--model':
        options.model = args[++i];
        break;
      case '--variations':
        options.variations = parseInt(args[++i]);
        break;
      case '--iterations':
        options.iterations = parseInt(args[++i]);
        break;
      case '--no-save':
        options.saveResults = false;
        break;
      case '--help':
        console.log(`
Prompt Optimization Testing Suite

Usage:
  node tests/llm/prompt_optimizer.js [options]

Options:
  --task <task>           Task to optimize: router, proposal, repair, summary (default: router)
  --model <model>         Model to test with (default: llama3.2:3b)
  --variations <n>        Number of prompt variations to test (default: 3)
  --iterations <n>        Number of iterations per test (default: 2)
  --no-save              Don't save results to file
  --help                 Show this help

Examples:
  node tests/llm/prompt_optimizer.js --task router --model llama3.2:3b
  node tests/llm/prompt_optimizer.js --task proposal --model granite-code:8b --variations 5
        `);
        return;
    }
  }
  
  const optimizer = new PromptOptimizer(options);
  
  try {
    await optimizer.runOptimization();
    optimizer.printResults();
    
    if (options.saveResults) {
      await optimizer.saveResults();
    }
    
  } catch (error) {
    console.error('❌ Optimization failed:', error);
    process.exit(1);
  }
}

// Export for use in other test files
export { PromptOptimizer, PROMPT_VARIATIONS, OPTIMIZATION_SCENARIOS };

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
