#!/usr/bin/env node

/**
 * Test for SemanticValidator
 * Verifies that the semantic validator can score LLM responses correctly
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SemanticValidator } from './semantic_validator.js';
import { TestDatabaseManager } from './test_database_manager.js';

test('SemanticValidator - Basic functionality', async (t) => {
  const dbManager = new TestDatabaseManager();
  const validator = new SemanticValidator(dbManager);
  
  await t.test('should validate router decision correctly', async () => {
    const scenario = {
      name: "Complete specific task",
      instruction: "Complete my project proposal review",
      context: { todos: [{ id: 1, title: "Review project proposal", status: "pending" }] },
      expected: {
        decision: "plan",
        confidence: 0.9,
        where: { ids: [1] },
        requiresClarification: false,
        humanAnnotation: "Clear intent to complete a specific task"
      }
    };
    
    const result = {
      decision: "plan",
      confidence: 0.9,
      where: { ids: [1] }
    };
    
    const validation = await validator.validateRouterDecision(scenario, result);
    
    assert.ok(validation.overallScore > 0.8, 'Should have high score for correct decision');
    assert.ok(validation.passed, 'Should pass validation');
    assert.ok(validation.breakdown.decisionCorrectness === 1.0, 'Decision should be correct');
    assert.ok(validation.breakdown.confidenceAppropriateness > 0.8, 'Confidence should be appropriate');
  });
  
  await t.test('should validate proposal operations correctly', async () => {
    const scenario = {
      name: "Create single todo",
      instruction: "Create a task called 'Buy groceries' for tomorrow",
      focusedWhere: { scheduled_range: { from: "2025-08-19", to: "2025-08-19" } },
      expected: {
        operations: [
          {
            kind: "todo",
            action: "create",
            title: "Buy groceries",
            scheduledFor: "2025-08-19",
            recurrence: { type: "none" }
          }
        ],
        shouldExecute: true,
        expectedResult: { todos: [{ title: "Buy groceries", scheduledFor: "2025-08-19" }] },
        humanAnnotation: "Simple task creation with specific title and date"
      }
    };
    
    const result = {
      operations: [
        {
          kind: "todo",
          action: "create",
          title: "Buy groceries",
          scheduledFor: "2025-08-19",
          recurrence: { type: "none" }
        }
      ],
      shouldExecute: true
    };
    
    // Set up test database for operation execution
    const dbResult = await dbManager.setupTestDatabase('test-model', 'test-4');
    
    const validation = await validator.validateProposalOperations(scenario, result);
    
    assert.ok(validation.overallScore > 0.5, 'Should have reasonable score');
    assert.ok(validation.breakdown.operationCorrectness > 0.8, 'Operations should be correct');
    assert.ok(validation.executionResult, 'Should have execution result');
    
    await dbResult.cleanup();
  });
  
  await t.test('should validate repair results correctly', async () => {
    const scenario = {
      name: "Missing recurrence",
      original: [
        { kind: "todo", action: "create", title: "Test task", scheduledFor: "2025-08-18" }
      ],
      errors: [
        { op: { kind: "todo", action: "create", title: "Test task" }, errors: ["missing_recurrence"] }
      ],
      expected: {
        operations: [
          { kind: "todo", action: "create", title: "Test task", scheduledFor: "2025-08-18", recurrence: { type: "none" } }
        ],
        shouldExecute: true,
        expectedResult: { todos: [{ title: "Test task", recurrence: { type: "none" } }] },
        humanAnnotation: "Add missing recurrence field for non-repeating task"
      }
    };
    
    const result = {
      operations: [
        { kind: "todo", action: "create", title: "Test task", scheduledFor: "2025-08-18", recurrence: { type: "none" } }
      ]
    };
    
    // Set up test database for operation execution
    const dbResult = await dbManager.setupTestDatabase('test-model', 'test-5');
    
    const validation = await validator.validateRepairResult(scenario, result);
    
    assert.ok(validation.overallScore > 0.5, 'Should have reasonable score');
    assert.ok(validation.breakdown.errorFixCompleteness > 0.8, 'Should fix the error');
    assert.ok(validation.breakdown.operationPreservation > 0.8, 'Should preserve original operation');
    
    await dbResult.cleanup();
  });
  
  await t.test('should handle scoring edge cases', async () => {
    // Test confidence scoring
    const confidenceScore = validator.scoreConfidence(0.9, 0.8);
    assert.ok(confidenceScore > 0.5, 'Should give partial credit for close confidence');
    
    // Test decision scoring
    const decisionScore = validator.scoreDecisionCorrectness('plan', 'clarify');
    assert.ok(decisionScore === 0.5, 'Should give partial credit for plan vs clarify');
    
    // Test where accuracy
    const whereScore = validator.scoreWhereAccuracy(
      { ids: [1, 2] }, 
      { ids: [1, 3] }
    );
    assert.ok(whereScore === 0.5, 'Should give partial credit for partial ID match');
  });
});
