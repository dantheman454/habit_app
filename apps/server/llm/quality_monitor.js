// Quality monitoring for LLM responses
// Tracks performance metrics and response quality


export class ResponseQualityMonitor {
  constructor() {
    this.metrics = {
      totalRequests: 0,
      successfulResponses: 0,
      failedResponses: 0,
      averageConfidence: 0,
      commonErrors: new Map(),
      responseTimes: [],
      modelUsage: new Map(),
    };
  }
  
  recordRequest(correlationId, requestType, model) {
    this.metrics.totalRequests++;
    this.metrics.modelUsage.set(model, (this.metrics.modelUsage.get(model) || 0) + 1);
    console.log(`[Quality] Request ${correlationId}: ${requestType} (${model})`);
  }
  
  recordResponse(correlationId, response, confidence, errors = [], responseTime = null) {
    // Ensure errors is always an array
    const errorArray = Array.isArray(errors) ? errors : [];
    
    if (errorArray.length === 0) {
      this.metrics.successfulResponses++;
    } else {
      this.metrics.failedResponses++;
      errorArray.forEach(error => {
        const count = this.metrics.commonErrors.get(error) || 0;
        this.metrics.commonErrors.set(error, count + 1);
      });
    }
    
    if (confidence !== undefined) {
      this.metrics.averageConfidence = 
        (this.metrics.averageConfidence * (this.metrics.successfulResponses - 1) + confidence) / 
        this.metrics.successfulResponses;
    }
    
    if (responseTime !== null) {
      this.metrics.responseTimes.push(responseTime);
      // Keep only last 100 response times
      if (this.metrics.responseTimes.length > 100) {
        this.metrics.responseTimes.shift();
      }
    }
    
    console.log(`[Quality] Response ${correlationId}: confidence=${confidence}, errors=${errors.length}, time=${responseTime}ms`);
  }
  
  getQualityReport() {
    const successRate = this.metrics.totalRequests > 0 
      ? (this.metrics.successfulResponses / this.metrics.totalRequests * 100).toFixed(1)
      : 0;
    
    const avgResponseTime = this.metrics.responseTimes.length > 0
      ? (this.metrics.responseTimes.reduce((a, b) => a + b, 0) / this.metrics.responseTimes.length).toFixed(0)
      : 0;
    
    return {
      successRate: `${successRate}%`,
      averageConfidence: this.metrics.averageConfidence.toFixed(2),
      averageResponseTime: `${avgResponseTime}ms`,
      totalRequests: this.metrics.totalRequests,
      modelUsage: Object.fromEntries(this.metrics.modelUsage),
      commonErrors: Array.from(this.metrics.commonErrors.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([error, count]) => ({ error, count }))
    };
  }
  
  reset() {
    this.metrics = {
      totalRequests: 0,
      successfulResponses: 0,
      failedResponses: 0,
      averageConfidence: 0,
      commonErrors: new Map(),
      responseTimes: [],
      modelUsage: new Map(),
    };
  }
}

export const qualityMonitor = new ResponseQualityMonitor();
