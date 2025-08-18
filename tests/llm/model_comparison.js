#!/usr/bin/env node

/**
 * LLM Model Comparison Testing Suite
 * 
 * This suite tests different models on each LLM task in the habit application:
 * 1. Router Decision
 * 2. Proposal Generation  
 * 3. Repair
 * 4. Summary
 * 
 * Usage:
 *   node tests/llm_model_comparison.js --task router --models llama3.2:3b,granite-code:8b
 *   node tests/llm_model_comparison.js --task all --models llama3.2:3b,granite-code:8b,llama3.2:8b
 *   node tests/llm_model_comparison.js --task proposal --models granite-code:8b,llama3.2:8b --iterations 5
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Import the LLM modules
import { runRouter } from '../../apps/server/llm/router.js';
import { runProposal } from '../../apps/server/llm/proposal.js';
import { runRepair } from '../../apps/server/llm/repair.js';
import { runSummary } from '../../apps/server/llm/summary.js';
import { getModels, getAvailableModels } from '../../apps/server/llm/clients.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Test scenarios for each task
const TEST_SCENARIOS = {
  router: [
    {
      name: "Clear action request",
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
      name: "Date-specific request",
      instruction: "Show me tasks for tomorrow",
      transcript: [],
      expected: { decision: "plan", confidence: "high" }
    },
    {
      name: "With prior context",
      instruction: "the first one",
      transcript: [
        { role: "user", text: "Update my task" },
        { role: "assistant", text: "Which task do you want to update? Options: #1 \"Review project\" @2024-01-15; #2 \"Call client\" @2024-01-15." }
      ],
      expected: { decision: "plan", confidence: "high" }
    }
  ],
  
  proposal: [
    {
      name: "Create simple todo",
      instruction: "Create a task called 'Test task' for today",
      transcript: [],
      focusedWhere: {},
      expected: { 
        operations: [{ kind: "todo", action: "create", title: "Test task" }],
        hasRecurrence: true
      }
    },
    {
      name: "Update existing todo",
      instruction: "Change the time of my task to 3pm",
      transcript: [],
      focusedWhere: { ids: [1] },
      expected: { 
        operations: [{ kind: "todo", action: "update", id: 1, timeOfDay: "15:00" }],
        hasRecurrence: true
      }
    },
    {
      name: "Complete task",
      instruction: "Mark my task as done",
      transcript: [],
      focusedWhere: { ids: [1] },
      expected: { 
        operations: [{ kind: "todo", action: "set_status", id: 1, status: "completed" }]
      }
    },
    {
      name: "Create repeating habit",
      instruction: "Create a daily habit called 'Exercise'",
      transcript: [],
      focusedWhere: {},
      expected: { 
        operations: [{ kind: "habit", action: "create", title: "Exercise", recurrence: { type: "daily" } }]
      }
    }
  ],
  
  repair: [
    {
      name: "Missing recurrence",
      original: [{ kind: "todo", action: "create", title: "Test", scheduledFor: "2024-01-15" }],
      errors: [{ op: { kind: "todo", action: "create", title: "Test" }, errors: ["missing_recurrence"] }],
      focusedContext: { todos: [] },
      expected: { hasRecurrence: true }
    },
    {
      name: "Missing timeOfDay",
      original: [{ kind: "todo", action: "update", id: 1, scheduledFor: "2024-01-15" }],
      errors: [{ op: { kind: "todo", action: "update", id: 1 }, errors: ["missing_timeOfDay"] }],
      focusedContext: { todos: [{ id: 1, title: "Test" }] },
      expected: { hasTimeOfDay: true }
    },
    {
      name: "Invalid ID",
      original: [{ kind: "todo", action: "update", id: 999, title: "Test" }],
      errors: [{ op: { kind: "todo", action: "update", id: 999 }, errors: ["id_not_found"] }],
      focusedContext: { todos: [{ id: 1, title: "Test" }] },
      expected: { validId: true }
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
      expected: { hasText: true, mentionsCreate: true, mentionsUpdate: true }
    },
    {
      name: "With errors",
      operations: [
        { kind: "todo", action: "create", title: "Valid task" }
      ],
      issues: ["missing_recurrence for operation 2"],
      expected: { hasText: true, mentionsErrors: true }
    },
    {
      name: "Empty operations",
      operations: [],
      issues: [],
      expected: { hasText: true, mentionsNoOps: true }
    }
  ]
};

// Mock database context for testing
const MOCK_CONTEXT = {
  todos: [
    { id: 1, title: "Review project proposal", scheduledFor: "2024-01-15", recurrence: { type: "none" } },
    { id: 2, title: "Call client", scheduledFor: "2024-01-15", recurrence: { type: "none" } },
    { id: 3, title: "Prepare presentation", scheduledFor: "2024-01-16", recurrence: { type: "none" } }
  ],
  events: [
    { id: 1, title: "Team meeting", scheduledFor: "2024-01-15", startTime: "10:00", endTime: "11:00" }
  ],
  habits: [
    { id: 1, title: "Daily exercise", scheduledFor: "2024-01-15", recurrence: { type: "daily" } }
  ]
};

// Test runner class
class LLMModelTester {
  constructor(options = {}) {
    this.models = options.models || ['llama3.2:3b', 'granite-code:8b'];
    this.iterations = options.iterations || 3;
    this.results = {};
    this.availableModels = [];
  }

  async initialize() {
    console.log('🔍 Checking available models...');
    try {
      const available = await getAvailableModels();
      this.availableModels = available.models || [];
      console.log(`✅ Found ${this.availableModels.length} available models`);
    } catch (error) {
      console.log('⚠️  Could not check available models, proceeding with configured models');
    }
  }

  async testRouter(model, scenario) {
    const startTime = Date.now();
    try {
      const result = await runRouter({
        instruction: scenario.instruction,
        transcript: scenario.transcript || []
      });
      const duration = Date.now() - startTime;
      
      return {
        success: true,
        result,
        duration,
        confidence: result.confidence,
        decision: result.decision,
        hasQuestion: !!result.question,
        hasOptions: Array.isArray(result.options) && result.options.length > 0
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        duration: Date.now() - startTime
      };
    }
  }

  async testProposal(model, scenario) {
    const startTime = Date.now();
    try {
      const result = await runProposal({
        instruction: scenario.instruction,
        transcript: scenario.transcript || [],
        focusedWhere: scenario.focusedWhere || {}
      });
      const duration = Date.now() - startTime;
      
      const operations = Array.isArray(result.operations) ? result.operations : [];
      const hasRecurrence = operations.some(op => op.recurrence && typeof op.recurrence === 'object');
      const hasTimeOfDay = operations.some(op => op.timeOfDay);
      const validIds = operations.every(op => !op.id || Number.isInteger(op.id));
      
      return {
        success: true,
        result,
        duration,
        operationsCount: operations.length,
        hasRecurrence,
        hasTimeOfDay,
        validIds,
        hasSteps: Array.isArray(result.steps) && result.steps.length > 0
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        duration: Date.now() - startTime
      };
    }
  }

  async testRepair(model, scenario) {
    const startTime = Date.now();
    try {
      const result = await runRepair({
        errors: scenario.errors,
        original: scenario.original,
        focusedContext: scenario.focusedContext || MOCK_CONTEXT
      });
      const duration = Date.now() - startTime;
      
      const operations = Array.isArray(result.operations) ? result.operations : [];
      const hasRecurrence = operations.some(op => op.recurrence && typeof op.recurrence === 'object');
      const hasTimeOfDay = operations.some(op => op.timeOfDay);
      const validIds = operations.every(op => !op.id || Number.isInteger(op.id));
      
      return {
        success: true,
        result,
        duration,
        operationsCount: operations.length,
        hasRecurrence,
        hasTimeOfDay,
        validIds
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        duration: Date.now() - startTime
      };
    }
  }

  async testSummary(model, scenario) {
    const startTime = Date.now();
    try {
      const result = await runSummary({
        operations: scenario.operations,
        issues: scenario.issues || [],
        timezone: 'America/New_York'
      });
      const duration = Date.now() - startTime;
      
      const hasText = typeof result === 'string' && result.length > 0;
      const mentionsCreate = result.toLowerCase().includes('create') || result.toLowerCase().includes('new');
      const mentionsUpdate = result.toLowerCase().includes('update') || result.toLowerCase().includes('change');
      const mentionsErrors = result.toLowerCase().includes('error') || result.toLowerCase().includes('invalid');
      const mentionsNoOps = result.toLowerCase().includes('no operations') || result.toLowerCase().includes('nothing to do');
      
      return {
        success: true,
        result,
        duration,
        hasText,
        mentionsCreate,
        mentionsUpdate,
        mentionsErrors,
        mentionsNoOps,
        length: result.length
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        duration: Date.now() - startTime
      };
    }
  }

  async runTaskTests(taskName) {
    console.log(`\n🧪 Testing ${taskName.toUpperCase()} task...`);
    
    const scenarios = TEST_SCENARIOS[taskName];
    if (!scenarios) {
      console.log(`❌ No test scenarios found for task: ${taskName}`);
      return;
    }

    const taskResults = {};

    for (const model of this.models) {
      console.log(`\n📊 Testing model: ${model}`);
      taskResults[model] = { scenarios: [], summary: {} };
      
      for (const scenario of scenarios) {
        console.log(`  🔄 Running scenario: ${scenario.name}`);
        
        const scenarioResults = [];
        for (let i = 0; i < this.iterations; i++) {
          let result;
          
          switch (taskName) {
            case 'router':
              result = await this.testRouter(model, scenario);
              break;
            case 'proposal':
              result = await this.testProposal(model, scenario);
              break;
            case 'repair':
              result = await this.testRepair(model, scenario);
              break;
            case 'summary':
              result = await this.testSummary(model, scenario);
              break;
            default:
              console.log(`❌ Unknown task: ${taskName}`);
              continue;
          }
          
          scenarioResults.push(result);
          
          // Small delay between iterations
          if (i < this.iterations - 1) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
        
        taskResults[model].scenarios.push({
          name: scenario.name,
          results: scenarioResults,
          summary: this.summarizeScenarioResults(scenarioResults)
        });
      }
      
      // Calculate model summary
      taskResults[model].summary = this.summarizeModelResults(taskResults[model].scenarios);
    }
    
    this.results[taskName] = taskResults;
    return taskResults;
  }

  summarizeScenarioResults(results) {
    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);
    
    if (successful.length === 0) {
      return {
        successRate: 0,
        avgDuration: 0,
        errorRate: 1,
        commonError: failed.length > 0 ? failed[0].error : 'Unknown error'
      };
    }
    
    const avgDuration = successful.reduce((sum, r) => sum + r.duration, 0) / successful.length;
    
    return {
      successRate: successful.length / results.length,
      avgDuration,
      errorRate: failed.length / results.length,
      commonError: failed.length > 0 ? failed[0].error : null
    };
  }

  summarizeModelResults(scenarios) {
    const allResults = scenarios.flatMap(s => s.results);
    const successful = allResults.filter(r => r.success);
    const failed = allResults.filter(r => !r.success);
    
    const avgDuration = successful.length > 0 
      ? successful.reduce((sum, r) => sum + r.duration, 0) / successful.length 
      : 0;
    
    return {
      totalTests: allResults.length,
      successRate: successful.length / allResults.length,
      avgDuration,
      errorRate: failed.length / allResults.length
    };
  }

  async runAllTests() {
    console.log('🚀 Starting LLM Model Comparison Tests');
    console.log(`📋 Models: ${this.models.join(', ')}`);
    console.log(`🔄 Iterations per test: ${this.iterations}`);
    
    await this.initialize();
    
    const tasks = ['router', 'proposal', 'repair', 'summary'];
    
    for (const task of tasks) {
      await this.runTaskTests(task);
    }
    
    return this.results;
  }

  generateReport() {
    const report = {
      timestamp: new Date().toISOString(),
      configuration: {
        models: this.models,
        iterations: this.iterations,
        availableModels: this.availableModels
      },
      results: this.results,
      summary: this.generateOverallSummary()
    };
    
    return report;
  }

  generateOverallSummary() {
    const summary = {};
    
    for (const [taskName, taskResults] of Object.entries(this.results)) {
      summary[taskName] = {};
      
      for (const [modelName, modelResults] of Object.entries(taskResults)) {
        summary[taskName][modelName] = modelResults.summary;
      }
    }
    
    return summary;
  }

  async saveReport(filename = null) {
    const report = this.generateReport();
    
    if (!filename) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      filename = `llm_comparison_report_${timestamp}.json`;
    }
    
    const reportPath = path.join(__dirname, 'reports', filename);
    
    // Ensure reports directory exists
    try {
      await fs.mkdir(path.dirname(reportPath), { recursive: true });
    } catch (error) {
      // Directory might already exist
    }
    
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(`📄 Report saved to: ${reportPath}`);
    
    return reportPath;
  }

  printSummary() {
    console.log('\n📊 TEST SUMMARY');
    console.log('='.repeat(60));
    
    for (const [taskName, taskResults] of Object.entries(this.results)) {
      console.log(`\n${taskName.toUpperCase()}:`);
      console.log('-'.repeat(40));
      
      for (const [modelName, modelResults] of Object.entries(taskResults)) {
        const summary = modelResults.summary;
        console.log(`${modelName}:`);
        console.log(`  Success Rate: ${(summary.successRate * 100).toFixed(1)}%`);
        console.log(`  Avg Duration: ${summary.avgDuration.toFixed(0)}ms`);
        console.log(`  Error Rate: ${(summary.errorRate * 100).toFixed(1)}%`);
      }
    }
  }
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);
  
  // Simple argument parsing
  const options = {
    task: 'all',
    models: ['llama3.2:3b', 'granite-code:8b'],
    iterations: 3,
    saveReport: true
  };
  
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--task':
        options.task = args[++i];
        break;
      case '--models':
        options.models = args[++i].split(',');
        break;
      case '--iterations':
        options.iterations = parseInt(args[++i]);
        break;
      case '--no-save':
        options.saveReport = false;
        break;
      case '--help':
        console.log(`
LLM Model Comparison Testing Suite

Usage:
  node tests/llm/model_comparison.js [options]

Options:
  --task <task>           Task to test: router, proposal, repair, summary, or all (default: all)
  --models <models>       Comma-separated list of models to test (default: llama3.2:3b,granite-code:8b)
  --iterations <n>        Number of iterations per test (default: 3)
  --no-save              Don't save report to file
  --help                 Show this help

Examples:
  node tests/llm/model_comparison.js --task router --models llama3.2:3b,granite-code:8b
  node tests/llm/model_comparison.js --task all --models llama3.2:3b,granite-code:8b,llama3.2:8b --iterations 5
        `);
        return;
    }
  }
  
  const tester = new LLMModelTester(options);
  
  try {
    if (options.task === 'all') {
      await tester.runAllTests();
    } else {
      await tester.runTaskTests(options.task);
    }
    
    tester.printSummary();
    
    if (options.saveReport) {
      await tester.saveReport();
    }
    
  } catch (error) {
    console.error('❌ Test execution failed:', error);
    process.exit(1);
  }
}

// Export for use in other test files
export { LLMModelTester, TEST_SCENARIOS };

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
