// Metrics Collector for LLM Test Suite
// Collects comprehensive metrics during test execution

export class MetricsCollector {
  constructor() {
    this.metrics = {
      testRun: {
        startTime: null,
        endTime: null,
        duration: null,
        modelName: null,
        taskType: null,
        iteration: null
      },
      scenarios: [],
      summary: {
        totalScenarios: 0,
        passedScenarios: 0,
        failedScenarios: 0,
        overallAccuracy: 0,
        averageLatency: 0,
        totalLatency: 0,
        taskBreakdown: {}
      }
    };
  }

  startTestRun(modelName, taskType, iteration = 1) {
    this.metrics.testRun.startTime = new Date();
    this.metrics.testRun.modelName = modelName;
    this.metrics.testRun.taskType = taskType;
    this.metrics.testRun.iteration = iteration;
    
    console.log(`📊 Starting metrics collection for ${modelName} on ${taskType} (iteration ${iteration})`);
  }

  endTestRun() {
    this.metrics.testRun.endTime = new Date();
    this.metrics.testRun.duration = this.metrics.testRun.endTime - this.metrics.testRun.startTime;
    
    this.calculateSummary();
    
    console.log(`📊 Test run completed in ${this.metrics.testRun.duration}ms`);
    console.log(`📊 Overall accuracy: ${(this.metrics.summary.overallAccuracy * 100).toFixed(1)}%`);
    console.log(`📊 Average latency: ${this.metrics.summary.averageLatency.toFixed(0)}ms`);
  }

  recordScenario(scenarioName, startTime, endTime, validationResult) {
    const latency = endTime - startTime;
    
    const scenarioMetrics = {
      name: scenarioName,
      startTime: startTime,
      endTime: endTime,
      latency: latency,
      passed: validationResult.passed,
      overallScore: validationResult.overallScore,
      breakdown: validationResult.breakdown,
      humanAnnotation: validationResult.humanAnnotation,
      executionResult: validationResult.executionResult || null
    };

    this.metrics.scenarios.push(scenarioMetrics);
    
    console.log(`  📋 ${scenarioName}: ${validationResult.passed ? '✅ PASS' : '❌ FAIL'} (${latency}ms, ${(validationResult.overallScore * 100).toFixed(1)}%)`);
  }

  calculateSummary() {
    const scenarios = this.metrics.scenarios;
    const totalScenarios = scenarios.length;
    
    if (totalScenarios === 0) return;

    const passedScenarios = scenarios.filter(s => s.passed).length;
    const failedScenarios = totalScenarios - passedScenarios;
    const overallAccuracy = passedScenarios / totalScenarios;
    const totalLatency = scenarios.reduce((sum, s) => sum + s.latency, 0);
    const averageLatency = totalLatency / totalScenarios;

    // Calculate task-specific breakdowns
    const taskBreakdown = this.calculateTaskBreakdown();

    this.metrics.summary = {
      totalScenarios,
      passedScenarios,
      failedScenarios,
      overallAccuracy,
      averageLatency,
      totalLatency,
      taskBreakdown
    };
  }

  calculateTaskBreakdown() {
    const scenarios = this.metrics.scenarios;
    const breakdown = {};

    // Group scenarios by task type (router, proposal, repair)
    const taskGroups = {};
    scenarios.forEach(scenario => {
      const taskType = this.inferTaskType(scenario.name);
      if (!taskGroups[taskType]) {
        taskGroups[taskType] = [];
      }
      taskGroups[taskType].push(scenario);
    });

    // Calculate metrics for each task type
    for (const [taskType, taskScenarios] of Object.entries(taskGroups)) {
      const total = taskScenarios.length;
      const passed = taskScenarios.filter(s => s.passed).length;
      const accuracy = passed / total;
      const avgLatency = taskScenarios.reduce((sum, s) => sum + s.latency, 0) / total;
      const avgScore = taskScenarios.reduce((sum, s) => sum + s.overallScore, 0) / total;

      breakdown[taskType] = {
        total,
        passed,
        failed: total - passed,
        accuracy,
        averageLatency: avgLatency,
        averageScore: avgScore
      };
    }

    return breakdown;
  }

  inferTaskType(scenarioName) {
    // Infer task type from scenario name or structure
    if (scenarioName.toLowerCase().includes('router') || 
        scenarioName.toLowerCase().includes('decision') ||
        scenarioName.toLowerCase().includes('clarify')) {
      return 'router';
    }
    if (scenarioName.toLowerCase().includes('proposal') || 
        scenarioName.toLowerCase().includes('operation') ||
        scenarioName.toLowerCase().includes('create') ||
        scenarioName.toLowerCase().includes('update')) {
      return 'proposal';
    }
    if (scenarioName.toLowerCase().includes('repair') || 
        scenarioName.toLowerCase().includes('fix') ||
        scenarioName.toLowerCase().includes('error')) {
      return 'repair';
    }
    return 'unknown';
  }

  getMetrics() {
    return this.metrics;
  }

  exportMetrics(format = 'json') {
    switch (format.toLowerCase()) {
      case 'json':
        return JSON.stringify(this.metrics, null, 2);
      case 'summary':
        return this.generateSummaryReport();
      case 'detailed':
        return this.generateDetailedReport();
      default:
        return JSON.stringify(this.metrics, null, 2);
    }
  }

  generateSummaryReport() {
    const { testRun, summary } = this.metrics;
    
    return `
# LLM Test Suite Summary Report

## Test Run Information
- **Model**: ${testRun.modelName}
- **Task Type**: ${testRun.taskType}
- **Iteration**: ${testRun.iteration}
- **Duration**: ${testRun.duration}ms
- **Start Time**: ${testRun.startTime.toISOString()}
- **End Time**: ${testRun.endTime.toISOString()}

## Overall Results
- **Total Scenarios**: ${summary.totalScenarios}
- **Passed**: ${summary.passedScenarios}
- **Failed**: ${summary.failedScenarios}
- **Overall Accuracy**: ${(summary.overallAccuracy * 100).toFixed(1)}%
- **Average Latency**: ${summary.averageLatency.toFixed(0)}ms

## Task Breakdown
${Object.entries(summary.taskBreakdown).map(([task, metrics]) => `
### ${task.toUpperCase()}
- **Total**: ${metrics.total}
- **Passed**: ${metrics.passed}
- **Accuracy**: ${(metrics.accuracy * 100).toFixed(1)}%
- **Average Latency**: ${metrics.averageLatency.toFixed(0)}ms
- **Average Score**: ${(metrics.averageScore * 100).toFixed(1)}%
`).join('')}
`;
  }

  generateDetailedReport() {
    const { testRun, scenarios, summary } = this.metrics;
    
    let report = this.generateSummaryReport();
    
    report += `
## Detailed Scenario Results

${scenarios.map(scenario => `
### ${scenario.name}
- **Status**: ${scenario.passed ? '✅ PASS' : '❌ FAIL'}
- **Score**: ${(scenario.overallScore * 100).toFixed(1)}%
- **Latency**: ${scenario.latency}ms
- **Human Annotation**: ${scenario.humanAnnotation}

**Score Breakdown:**
${Object.entries(scenario.breakdown).map(([key, score]) => `- ${key}: ${(score * 100).toFixed(1)}%`).join('\n')}

${scenario.executionResult ? `
**Execution Result:**
\`\`\`json
${JSON.stringify(scenario.executionResult, null, 2)}
\`\`\`
` : ''}
`).join('')}
`;
    
    return report;
  }

  reset() {
    this.metrics = {
      testRun: {
        startTime: null,
        endTime: null,
        duration: null,
        modelName: null,
        taskType: null,
        iteration: null
      },
      scenarios: [],
      summary: {
        totalScenarios: 0,
        passedScenarios: 0,
        failedScenarios: 0,
        overallAccuracy: 0,
        averageLatency: 0,
        totalLatency: 0,
        taskBreakdown: {}
      }
    };
  }
}
