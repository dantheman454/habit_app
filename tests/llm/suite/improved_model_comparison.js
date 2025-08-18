#!/usr/bin/env node

/**
 * Improved LLM Model Comparison Testing Suite
 * 
 * This is the new test runner that replaces the old model_comparison.js
 * with enhanced validation, semantic testing, and realistic metrics.
 * 
 * Usage:
 *   node tests/llm/improved/improved_model_comparison.js --validate-scenarios
 *   node tests/llm/improved/improved_model_comparison.js --run-tests --task router --models llama3.2:3b --iterations 5
 *   node tests/llm/improved/improved_model_comparison.js --compare-models --tasks router,proposal,repair --models llama3.2:3b,granite-code:8b
 *   node tests/llm/improved/improved_model_comparison.js --generate-report --output detailed
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';


import { TestRunner } from './test_runner.js';
import { MetricsCollector } from './metrics_collector.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execAsync = promisify(exec);

// Parse command line arguments
const args = process.argv.slice(2);
const command = args[0];

async function main() {
  try {
    switch (command) {
      case '--validate-scenarios':
        await validateScenarios();
        break;
      case '--run-tests':
        await runTests(args.slice(1));
        break;
      case '--compare-models':
        await compareModels(args.slice(1));
        break;
      case '--generate-report':
        await generateReport(args.slice(1));
        break;
      case '--help':
      case '-h':
        showHelp();
        break;
      default:
        console.error('Unknown command. Use --help for usage information.');
        process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

async function validateScenarios() {
  console.log('Opening validation review interface...');
  
  const htmlPath = path.join(__dirname, 'validation_review.html');
  const absolutePath = path.resolve(htmlPath);
  
  // Check if file exists
  try {
    await fs.access(absolutePath);
  } catch (error) {
    throw new Error(`Validation review HTML file not found at: ${absolutePath}`);
  }
  
  // Open in default browser
  const platform = process.platform;
  let command;
  
  switch (platform) {
    case 'darwin':
      command = `open "${absolutePath}"`;
      break;
    case 'win32':
      command = `start "${absolutePath}"`;
      break;
    default:
      command = `xdg-open "${absolutePath}"`;
      break;
  }
  
  try {
    await execAsync(command);
    console.log('✅ Validation review interface opened in browser');
    console.log(`📁 File location: ${absolutePath}`);
    console.log('\n📋 Review Instructions:');
    console.log('- Review all 15 scenarios (5 each for router/proposal/repair)');
    console.log('- Check human annotations and expected outcomes');
    console.log('- Use approval buttons to mark scenarios as approved/needs revision/rejected');
    console.log('- Progress bar will show completion status');
  } catch (error) {
    console.error('Failed to open browser automatically. Please open manually:');
    console.error(`file://${absolutePath}`);
  }
}

async function runTests(args) {
  // Parse arguments
  const task = args.find(arg => arg.startsWith('--task='))?.split('=')[1] || 'router';
  const models = args.find(arg => arg.startsWith('--models='))?.split('=')[1]?.split(',') || ['test-model'];
  const iterations = parseInt(args.find(arg => arg.startsWith('--iterations='))?.split('=')[1]) || 1;
  
  console.log(`🚀 Running tests for task: ${task}, models: ${models.join(', ')}, iterations: ${iterations}`);
  
  const testRunner = new TestRunner();
  
  // Check LLM availability
  console.log('\n🔍 Checking LLM availability...');
  const llmAvailable = await testRunner.checkLLMAvailability();
  
  if (!llmAvailable) {
    console.warn('⚠️ LLM services may not be available - tests may fail');
  }
  
  try {
    for (const model of models) {
      console.log(`\n📊 Testing model: ${model}`);
      const results = await testRunner.runTest(model, task, iterations);
      
      // Save results
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const outputPath = `tests/llm/reports/${model}_${task}_${timestamp}.json`;
      await testRunner.saveResults(results, outputPath);
      
      // Generate and save report
      const metricsCollector = new MetricsCollector();
      metricsCollector.metrics = testRunner.lastMetrics;
      const report = metricsCollector.exportMetrics('detailed');
      const reportPath = `tests/llm/reports/${model}_${task}_${timestamp}_report.md`;
      const fs = await import('node:fs/promises');
      await fs.writeFile(reportPath, report);
      console.log(`📄 Report saved to: ${reportPath}`);
    }
  } catch (error) {
    console.error('❌ Test execution failed:', error.message);
    process.exit(1);
  }
}

async function compareModels(args) {
  // Parse arguments
  const tasks = args.find(arg => arg.startsWith('--tasks='))?.split('=')[1]?.split(',') || ['router', 'proposal', 'repair'];
  const models = args.find(arg => arg.startsWith('--models='))?.split('=')[1]?.split(',') || ['test-model-1', 'test-model-2'];
  const iterations = parseInt(args.find(arg => arg.startsWith('--iterations='))?.split('=')[1]) || 1;
  
  console.log(`🔍 Comparing models: ${models.join(', ')} on tasks: ${tasks.join(', ')} (${iterations} iteration${iterations > 1 ? 's' : ''})`);
  
  const testRunner = new TestRunner();
  
  try {
    const comparisonResults = await testRunner.runModelComparison(models, tasks, iterations);
    
    // Generate comparison report
    const report = testRunner.generateComparisonReport(comparisonResults);
    
    // Save comparison results
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputPath = `tests/llm/reports/comparison_${timestamp}.json`;
    await testRunner.saveResults(comparisonResults, outputPath);
    
    // Save comparison report
    const reportPath = `tests/llm/reports/comparison_${timestamp}_report.md`;
    const fs = await import('node:fs/promises');
    await fs.writeFile(reportPath, report);
    
    console.log(`📊 Comparison results saved to: ${outputPath}`);
    console.log(`📄 Comparison report saved to: ${reportPath}`);
    
    // Print summary
    console.log('\n📋 Comparison Summary:');
    console.log(report);
    
  } catch (error) {
    console.error('❌ Model comparison failed:', error.message);
    process.exit(1);
  }
}

async function generateReport(args) {
  // Parse arguments
  const output = args.find(arg => arg.startsWith('--output='))?.split('=')[1] || 'summary';
  const inputFile = args.find(arg => arg.startsWith('--input='))?.split('=')[1];
  
  if (!inputFile) {
    console.error('❌ Please specify input file with --input=<path>');
    process.exit(1);
  }
  
  console.log(`📄 Generating ${output} report from: ${inputFile}`);
  
  try {
    const fs = await import('node:fs/promises');
    const data = JSON.parse(await fs.readFile(inputFile, 'utf8'));
    
    const metricsCollector = new MetricsCollector();
    metricsCollector.metrics = data;
    
    const report = metricsCollector.exportMetrics(output);
    
    // Save report
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const reportPath = `tests/llm/reports/generated_${output}_${timestamp}.md`;
    await fs.writeFile(reportPath, report);
    
    console.log(`📄 Report saved to: ${reportPath}`);
    
    // Print report
    console.log('\n📋 Generated Report:');
    console.log(report);
    
  } catch (error) {
    console.error('❌ Report generation failed:', error.message);
    process.exit(1);
  }
}

function showHelp() {
  console.log(`
Improved LLM Model Comparison Testing Suite

Usage:
  node tests/llm/improved/improved_model_comparison.js <command> [options]

Commands:
  --validate-scenarios    Open HTML interface to review and validate test scenarios
  --run-tests            Run tests for specific task and models
  --compare-models       Compare multiple models across tasks
  --generate-report      Generate detailed analysis reports
  --help, -h            Show this help message

Examples:
  node tests/llm/improved/improved_model_comparison.js --validate-scenarios
  node tests/llm/improved/improved_model_comparison.js --run-tests --task router --models llama3.2:3b --iterations 5
  node tests/llm/improved/improved_model_comparison.js --compare-models --tasks router,proposal,repair --models llama3.2:3b,granite-code:8b
  node tests/llm/improved/improved_model_comparison.js --generate-report --output detailed

This is the new test runner that replaces the old model_comparison.js with:
- Enhanced validation with human-annotated scenarios
- Semantic validation using existing MCP client
- Realistic test data and performance metrics
- Comprehensive reporting and analysis
`);
}

// Run main function if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
