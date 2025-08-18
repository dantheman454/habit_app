// Semantic Validator for LLM Test Suite
// Validates LLM responses against human-annotated expected outcomes

export class SemanticValidator {
  constructor(dbManager) {
    this.dbManager = dbManager;
  }

  async validateRouterDecision(scenario, result) {
    const scores = {
      decisionCorrectness: this.scoreDecisionCorrectness(scenario.expected.decision, result.decision),
      confidenceAppropriateness: this.scoreConfidence(scenario.expected.confidence, result.confidence),
      questionQuality: this.scoreQuestionQuality(scenario, result),
      optionsRelevance: this.scoreOptionsRelevance(scenario, result),
      whereAccuracy: this.scoreWhereAccuracy(scenario.expected.where, result.where)
    };

    return {
      overallScore: this.calculateWeightedScore(scores),
      breakdown: scores,
      passed: this.calculateWeightedScore(scores) >= 0.8,
      humanAnnotation: scenario.expected.humanAnnotation
    };
  }

  async validateProposalOperations(scenario, result) {
    // Execute operations using existing MCP client
    const executionResult = await this.executeOperationsWithExistingMCP(result.operations);
    
    const scores = {
      operationCorrectness: this.scoreOperationCorrectness(scenario.expected.operations, result.operations),
      executionSuccess: this.scoreExecutionSuccess(executionResult),
      resultAccuracy: this.scoreResultAccuracy(scenario.expected.expectedResult, executionResult),
      completeness: this.scoreCompleteness(scenario.expected, result)
    };

    return {
      overallScore: this.calculateWeightedScore(scores),
      breakdown: scores,
      executionResult,
      passed: this.calculateWeightedScore(scores) >= 0.8,
      humanAnnotation: scenario.expected.humanAnnotation
    };
  }

  async validateRepairResult(scenario, result) {
    // Execute repaired operations using existing MCP client
    const executionResult = await this.executeOperationsWithExistingMCP(result.operations);
    
    const scores = {
      errorFixCompleteness: this.scoreErrorFixCompleteness(scenario.errors, result.operations),
      operationPreservation: this.scoreOperationPreservation(scenario.original, result.operations),
      executionSuccess: this.scoreExecutionSuccess(executionResult),
      resultAccuracy: this.scoreResultAccuracy(scenario.expected.expectedResult, executionResult)
    };

    return {
      overallScore: this.calculateWeightedScore(scores),
      breakdown: scores,
      executionResult,
      passed: this.calculateWeightedScore(scores) >= 0.8,
      humanAnnotation: scenario.expected.humanAnnotation
    };
  }

  async executeOperationsWithExistingMCP(operations) {
    // Use existing MCP client directly for operation execution
    const results = {};
    
    for (const op of operations) {
      try {
        // Use existing MCP client for operation execution
        const result = await this.dbManager.executeOperation(op);
        results[op.id || 'new'] = result;
      } catch (error) {
        results[op.id || 'new'] = { error: error.message };
      }
    }
    
    return results;
  }

  // Scoring methods
  scoreDecisionCorrectness(expected, actual) {
    if (expected === actual) return 1.0;
    if (expected === 'clarify' && actual === 'plan') return 0.5; // Partial credit for plan vs clarify
    if (expected === 'plan' && actual === 'clarify') return 0.5; // Partial credit for clarify vs plan
    return 0.0;
  }

  scoreConfidence(expected, actual) {
    if (typeof expected === 'number' && typeof actual === 'number') {
      const diff = Math.abs(expected - actual);
      if (diff <= 0.1) return 1.0;
      if (diff <= 0.2) return 0.9;
      if (diff <= 0.3) return 0.8;
      if (diff <= 0.4) return 0.6;
      return 0.4; // Give some credit even for larger differences
    }
    // Handle string confidence levels
    const confidenceMap = { 'high': 0.9, 'medium': 0.6, 'low': 0.3 };
    const expectedNum = confidenceMap[expected] || 0.5;
    const actualNum = confidenceMap[actual] || 0.5;
    return this.scoreConfidence(expectedNum, actualNum);
  }

  scoreQuestionQuality(scenario, result) {
    if (!scenario.expected.requiresClarification || !result.question) return 1.0;
    
    const expectedQuestion = scenario.expected.question;
    const actualQuestion = result.question;
    
    // Simple similarity check - could be enhanced with semantic similarity
    const expectedWords = expectedQuestion.toLowerCase().split(/\s+/);
    const actualWords = actualQuestion.toLowerCase().split(/\s+/);
    const commonWords = expectedWords.filter(word => actualWords.includes(word));
    
    return commonWords.length / Math.max(expectedWords.length, actualWords.length);
  }

  scoreOptionsRelevance(scenario, result) {
    if (!scenario.expected.options || !result.options) return 1.0;
    
    const expectedOptions = scenario.expected.options;
    const actualOptions = result.options;
    
    if (expectedOptions.length !== actualOptions.length) return 0.5;
    
    let score = 0;
    for (const expected of expectedOptions) {
      const matching = actualOptions.find(actual => 
        actual.id === expected.id && actual.title === expected.title
      );
      if (matching) score += 1;
    }
    
    return score / expectedOptions.length;
  }

  scoreWhereAccuracy(expected, actual) {
    if (typeof expected === 'string' && typeof actual === 'string') {
      return expected === actual ? 1.0 : 0.0;
    }
    
    if (expected && expected.ids && actual && actual.ids) {
      const expectedIds = new Set(expected.ids);
      const actualIds = new Set(actual.ids);
      const intersection = new Set([...expectedIds].filter(x => actualIds.has(x)));
      
      // If there's any overlap, give partial credit
      if (intersection.size > 0) {
        return Math.max(intersection.size / Math.max(expectedIds.size, actualIds.size), 0.8);
      }
      
      // If no overlap but both are ID-based, give some credit for correct approach
      return 0.5;
    }
    
    return 0.0;
  }

  scoreOperationCorrectness(expected, actual) {
    if (!expected || !actual) return 0.0;
    if (expected.length !== actual.length) return 0.5;
    
    let score = 0;
    for (let i = 0; i < expected.length; i++) {
      const expectedOp = expected[i];
      const actualOp = actual[i];
      
      // Check key fields
      const keyFields = ['kind', 'action', 'title', 'id', 'status'];
      let opScore = 0;
      for (const field of keyFields) {
        if (expectedOp[field] === actualOp[field]) opScore += 1;
      }
      score += opScore / keyFields.length;
    }
    
    return score / expected.length;
  }

  scoreExecutionSuccess(executionResult) {
    if (!executionResult || Object.keys(executionResult).length === 0) return 0.0;
    
    let successCount = 0;
    let totalCount = 0;
    
    for (const result of Object.values(executionResult)) {
      totalCount++;
      if (result.ok && !result.error) {
        successCount++;
      }
    }
    
    return totalCount > 0 ? successCount / totalCount : 0.0;
  }

  scoreResultAccuracy(expected, actual) {
    if (!expected || !actual) return 0.0;
    
    let score = 0;
    let totalChecks = 0;
    
    // Check todos
    if (expected.todos && actual.todos) {
      for (const expectedTodo of expected.todos) {
        const matching = actual.todos.find(actualTodo => 
          actualTodo.title === expectedTodo.title
        );
        if (matching) {
          // Check key fields
          const fields = ['title', 'scheduledFor', 'status', 'recurrence'];
          let todoScore = 0;
          for (const field of fields) {
            if (expectedTodo[field] && matching[field] && 
                JSON.stringify(expectedTodo[field]) === JSON.stringify(matching[field])) {
              todoScore += 1;
            }
          }
          score += todoScore / fields.length;
        }
        totalChecks++;
      }
    }
    
    // Check events
    if (expected.events && actual.events) {
      for (const expectedEvent of expected.events) {
        const matching = actual.events.find(actualEvent => 
          actualEvent.title === expectedEvent.title
        );
        if (matching) {
          const fields = ['title', 'startTime', 'endTime'];
          let eventScore = 0;
          for (const field of fields) {
            if (expectedEvent[field] && matching[field] && 
                expectedEvent[field] === matching[field]) {
              eventScore += 1;
            }
          }
          score += eventScore / fields.length;
        }
        totalChecks++;
      }
    }
    
    return totalChecks > 0 ? score / totalChecks : 0.0;
  }

  scoreCompleteness(expected, actual) {
    if (!expected || !actual) return 0.0;
    
    let score = 0;
    let totalChecks = 0;
    
    // Check if all expected operations are present
    if (expected.operations && actual.operations) {
      score += expected.operations.length === actual.operations.length ? 1 : 0.5;
      totalChecks++;
    }
    
    // Check if shouldExecute matches
    if (expected.shouldExecute !== undefined && actual.shouldExecute !== undefined) {
      score += expected.shouldExecute === actual.shouldExecute ? 1 : 0;
      totalChecks++;
    }
    
    return totalChecks > 0 ? score / totalChecks : 0.0;
  }

  scoreErrorFixCompleteness(errors, operations) {
    if (!errors || !operations) return 0.0;
    
    let fixedErrors = 0;
    let totalErrors = 0;
    
    for (const error of errors) {
      totalErrors++;
      const errorType = error.errors[0]; // Assume first error is primary
      
      // Check if the error was fixed in the operations
      const wasFixed = this.checkErrorFix(errorType, error.op, operations);
      if (wasFixed) fixedErrors++;
    }
    
    return totalErrors > 0 ? fixedErrors / totalErrors : 0.0;
  }

  checkErrorFix(errorType, originalOp, operations) {
    // Check if the specific error was fixed
    switch (errorType) {
      case 'missing_recurrence':
        return operations.some(op => op.recurrence && op.recurrence.type);
      case 'missing_timeOfDay':
        return operations.some(op => op.timeOfDay);
      case 'id_not_found':
        return operations.some(op => op.id && op.id !== originalOp.id);
      case 'missing_anchor_for_recurrence':
        return operations.some(op => op.scheduledFor);
      case 'invalid_date_format':
        return operations.some(op => {
          if (!op.scheduledFor) return false;
          const date = new Date(op.scheduledFor);
          return !isNaN(date.getTime());
        });
      default:
        return false;
    }
  }

  scoreOperationPreservation(original, operations) {
    if (!original || !operations) return 0.0;
    
    let preservedCount = 0;
    let totalCount = 0;
    
    for (const origOp of original) {
      totalCount++;
      const preserved = operations.some(op => 
        op.kind === origOp.kind && 
        op.action === origOp.action &&
        op.title === origOp.title
      );
      if (preserved) preservedCount++;
    }
    
    return totalCount > 0 ? preservedCount / totalCount : 0.0;
  }

  calculateWeightedScore(scores) {
    const weights = {
      decisionCorrectness: 0.4,
      confidenceAppropriateness: 0.2,
      questionQuality: 0.2,
      optionsRelevance: 0.1,
      whereAccuracy: 0.1,
      operationCorrectness: 0.4,
      executionSuccess: 0.3,
      resultAccuracy: 0.2,
      completeness: 0.1,
      errorFixCompleteness: 0.4,
      operationPreservation: 0.3,
      executionSuccess: 0.2,
      resultAccuracy: 0.1
    };

    let totalScore = 0;
    let totalWeight = 0;

    for (const [key, score] of Object.entries(scores)) {
      if (weights[key]) {
        totalScore += score * weights[key];
        totalWeight += weights[key];
      }
    }

    return totalWeight > 0 ? totalScore / totalWeight : 0;
  }
}
