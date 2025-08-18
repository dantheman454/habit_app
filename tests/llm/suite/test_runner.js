// Test Runner for LLM Test Suite
// Integrates all components to execute comprehensive LLM tests

import { TestDatabaseManager } from './test_database_manager.js';
import { SemanticValidator } from './semantic_validator.js';
import { MetricsCollector } from './metrics_collector.js';
import { LLMIntegration } from './llm_integration.js';
import { ENHANCED_SCENARIOS } from './enhanced_scenarios.js';

export class TestRunner {
  constructor() {
    this.dbManager = new TestDatabaseManager();
    this.validator = null; // Will be initialized with dbManager
    this.metricsCollector = new MetricsCollector();
    this.llmIntegration = new LLMIntegration();
  }

  async runTest(modelName, taskType, iterations = 1) {
    console.log(`🚀 Starting test run for ${modelName} on ${taskType} (${iterations} iteration${iterations > 1 ? 's' : ''})`);
    
    const results = [];
    
    for (let iteration = 1; iteration <= iterations; iteration++) {
      console.log(`\n📋 Iteration ${iteration}/${iterations}`);
      
      // Set up test database and validator
      const dbResult = await this.dbManager.setupTestDatabase(modelName, `test-${iteration}`);
      this.validator = new SemanticValidator(this.dbManager);
      
      // Start metrics collection
      this.metricsCollector.startTestRun(modelName, taskType, iteration);
      
      // Get scenarios for the task type
      const scenarios = ENHANCED_SCENARIOS[taskType] || [];
      
      if (scenarios.length === 0) {
        console.warn(`⚠️ No scenarios found for task type: ${taskType}`);
        continue;
      }
      
      // Run each scenario
      for (const scenario of scenarios) {
        await this.runScenario(scenario, taskType);
      }
      
      // End metrics collection
      this.metricsCollector.endTestRun();
      
      // Get metrics for this iteration
      const iterationMetrics = this.metricsCollector.getMetrics();
      results.push(iterationMetrics);
      
      // Clean up
      await dbResult.cleanup();
      
      // Store the last metrics before resetting (for report generation)
      this.lastMetrics = iterationMetrics;
      
      // Reset metrics for next iteration
      this.metricsCollector.reset();
    }
    
    return results;
  }

  async runScenario(scenario, taskType) {
    const startTime = Date.now();
    
    try {
      // Seed database with scenario-specific data
      await this.dbManager.seedScenarioData(scenario);
      
      // Initialize validator with fresh database state
      this.validator = new SemanticValidator(this.dbManager);
      
      let validationResult;
      
      // Call real LLM based on task type
      const llmResponse = await this.callRealLLM(scenario, taskType);
      
      // Debug: Log actual vs expected for failing scenarios
      if (scenario.name === "Complete specific task" || scenario.name === "Create new task") {
        console.log(`🔍 Debug ${scenario.name}:`);
        console.log(`  Expected: ${JSON.stringify(scenario.expected, null, 2)}`);
        console.log(`  Actual: ${JSON.stringify(llmResponse, null, 2)}`);
      }
      
      // Validate the response
      switch (taskType) {
        case 'router':
          validationResult = await this.validator.validateRouterDecision(scenario, llmResponse);
          break;
        case 'proposal':
          validationResult = await this.validator.validateProposalOperations(scenario, llmResponse);
          break;
        case 'repair':
          validationResult = await this.validator.validateRepairResult(scenario, llmResponse);
          break;
        default:
          throw new Error(`Unknown task type: ${taskType}`);
      }
      
      const endTime = Date.now();
      
      // Record metrics
      this.metricsCollector.recordScenario(scenario.name, startTime, endTime, validationResult);
      
      return validationResult;
      
    } catch (error) {
      const endTime = Date.now();
      
      // Record failed scenario
      const failedResult = {
        passed: false,
        overallScore: 0,
        breakdown: {},
        humanAnnotation: scenario.expected.humanAnnotation,
        error: error.message
      };
      
      this.metricsCollector.recordScenario(scenario.name, startTime, endTime, failedResult);
      
      console.error(`❌ Error in scenario ${scenario.name}: ${error.message}`);
      return failedResult;
    }
  }

  async callRealLLM(scenario, taskType) {
    // Call the actual LLM based on task type
    switch (taskType) {
      case 'router':
        return await this.llmIntegration.callRouterLLM(scenario);
        
      case 'proposal':
        return await this.llmIntegration.callProposalLLM(scenario);
        
      case 'repair':
        return await this.llmIntegration.callRepairLLM(scenario);
        
      default:
        throw new Error(`Unknown task type: ${taskType}`);
    }
  }

  async runModelComparison(models, taskTypes = ['router', 'proposal', 'repair'], iterations = 1) {
    console.log(`🔍 Starting model comparison for ${models.length} models on ${taskTypes.length} task types`);
    
    const comparisonResults = {};
    
    for (const model of models) {
      comparisonResults[model] = {};
      
      for (const taskType of taskTypes) {
        console.log(`\n📊 Testing ${model} on ${taskType}`);
        
        const results = await this.runTest(model, taskType, iterations);
        comparisonResults[model][taskType] = results;
      }
    }
    
    return comparisonResults;
  }

  generateComparisonReport(comparisonResults) {
    let report = `# LLM Model Comparison Report\n\n`;
    report += `Generated: ${new Date().toISOString()}\n\n`;
    
    for (const [modelName, modelResults] of Object.entries(comparisonResults)) {
      report += `## ${modelName}\n\n`;
      
      for (const [taskType, taskResults] of Object.entries(modelResults)) {
        if (taskResults.length === 0) continue;
        
        const latestResult = taskResults[taskResults.length - 1];
        const summary = latestResult.summary;
        
        report += `### ${taskType.toUpperCase()}\n`;
        report += `- **Overall Accuracy**: ${(summary.overallAccuracy * 100).toFixed(1)}%\n`;
        report += `- **Average Latency**: ${summary.averageLatency.toFixed(0)}ms\n`;
        report += `- **Total Scenarios**: ${summary.totalScenarios}\n`;
        report += `- **Passed**: ${summary.passedScenarios}\n`;
        report += `- **Failed**: ${summary.failedScenarios}\n\n`;
        
        // Task breakdown
        if (summary.taskBreakdown && Object.keys(summary.taskBreakdown).length > 0) {
          report += `**Task Breakdown:**\n`;
          for (const [task, metrics] of Object.entries(summary.taskBreakdown)) {
            report += `- ${task}: ${(metrics.accuracy * 100).toFixed(1)}% (${metrics.averageLatency.toFixed(0)}ms)\n`;
          }
          report += `\n`;
        }
      }
    }
    
    return report;
  }

  async saveResults(results, outputPath) {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    
    // Ensure directory exists
    const dir = path.dirname(outputPath);
    await fs.mkdir(dir, { recursive: true });
    
    // Save results
    await fs.writeFile(outputPath, JSON.stringify(results, null, 2));
    console.log(`💾 Results saved to: ${outputPath}`);
  }

  async checkLLMAvailability() {
    try {
      const models = this.llmIntegration.getAvailableModels();
      console.log(`🔍 LLM Models Available: ${JSON.stringify(models)}`);
      
      // Try to get available models from Ollama
      const { getAvailableModels } = await import('../../../apps/server/llm/clients.js');
      const available = await getAvailableModels();
      
      if (available.ok) {
        console.log(`✅ Ollama connection successful`);
        console.log(`📋 Available models: ${available.models?.map(m => m.name).join(', ') || 'None'}`);
        return true;
      } else {
        console.warn(`⚠️ Ollama connection failed - using fallback models`);
        return false;
      }
    } catch (error) {
      console.error(`❌ LLM availability check failed: ${error.message}`);
      return false;
    }
  }
}
