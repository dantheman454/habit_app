#!/usr/bin/env node

/**
 * Test for TestRunner
 * Verifies that the test runner can execute tests and generate reports
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TestRunner } from './test_runner.js';

test('TestRunner - Basic functionality', async (t) => {
  const testRunner = new TestRunner();
  
  await t.test('should run single test successfully', async () => {
    const results = await testRunner.runTest('test-model', 'router', 1);
    
    assert.ok(Array.isArray(results), 'Should return array of results');
    assert.ok(results.length === 1, 'Should have one result for one iteration');
    
    const result = results[0];
    assert.ok(result.testRun, 'Should have test run information');
    assert.ok(result.scenarios, 'Should have scenario results');
    assert.ok(result.summary, 'Should have summary');
    
    // Check test run info
    assert.ok(result.testRun.modelName === 'test-model', 'Should have correct model name');
    assert.ok(result.testRun.taskType === 'router', 'Should have correct task type');
    assert.ok(result.testRun.iteration === 1, 'Should have correct iteration');
    assert.ok(result.testRun.duration > 0, 'Should have duration');
    
    // Check summary
    assert.ok(result.summary.totalScenarios > 0, 'Should have scenarios');
    assert.ok(result.summary.overallAccuracy >= 0, 'Should have accuracy');
    assert.ok(result.summary.averageLatency >= 0, 'Should have latency');
  });
  
  await t.test('should run multiple iterations', async () => {
    const results = await testRunner.runTest('test-model', 'proposal', 2);
    
    assert.ok(results.length === 2, 'Should have two results for two iterations');
    
    for (const result of results) {
      assert.ok(result.testRun.iteration >= 1 && result.testRun.iteration <= 2, 'Should have correct iteration number');
      assert.ok(result.summary.totalScenarios > 0, 'Each iteration should have scenarios');
    }
  });
  
  await t.test('should generate comparison report', async () => {
    const comparisonResults = {
      'model-1': {
        'router': [{
          testRun: { modelName: 'model-1', taskType: 'router', iteration: 1, duration: 100 },
          summary: { overallAccuracy: 0.9, averageLatency: 50, totalScenarios: 10, passedScenarios: 9, failedScenarios: 1 }
        }]
      },
      'model-2': {
        'router': [{
          testRun: { modelName: 'model-2', taskType: 'router', iteration: 1, duration: 150 },
          summary: { overallAccuracy: 0.8, averageLatency: 75, totalScenarios: 10, passedScenarios: 8, failedScenarios: 2 }
        }]
      }
    };
    
    const report = testRunner.generateComparisonReport(comparisonResults);
    
    assert.ok(report.includes('LLM Model Comparison Report'), 'Should have report title');
    assert.ok(report.includes('model-1'), 'Should include model-1');
    assert.ok(report.includes('model-2'), 'Should include model-2');
    assert.ok(report.includes('90.0%'), 'Should include accuracy for model-1');
    assert.ok(report.includes('80.0%'), 'Should include accuracy for model-2');
  });
  
  await t.test('should save results to file', async () => {
    const testData = {
      testRun: { modelName: 'test-model', taskType: 'router', iteration: 1, duration: 100 },
      summary: { overallAccuracy: 0.9, averageLatency: 50, totalScenarios: 10, passedScenarios: 9, failedScenarios: 1 }
    };
    
    const outputPath = 'tests/llm/reports/test_save.json';
    
    await testRunner.saveResults(testData, outputPath);
    
    // Verify file was created
    const fs = await import('node:fs/promises');
    const fileExists = await fs.access(outputPath).then(() => true).catch(() => false);
    assert.ok(fileExists, 'File should be created');
    
    // Verify content
    const content = JSON.parse(await fs.readFile(outputPath, 'utf8'));
    assert.ok(content.testRun.modelName === 'test-model', 'Should have correct model name');
    assert.ok(content.summary.overallAccuracy === 0.9, 'Should have correct accuracy');
    
    // Clean up
    await fs.unlink(outputPath);
  });
});
