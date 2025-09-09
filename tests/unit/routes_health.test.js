import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import healthRouter from '../../apps/server/routes/health.js';

describe('Health routes', () => {
  let server;
  let app;
  const port = 0; // Use random available port

  before(() => {
    app = express();
    app.use(healthRouter);
    server = http.createServer(app);
    
    return new Promise((resolve) => {
      server.listen(port, () => {
        resolve();
      });
    });
  });

  after(() => {
    return new Promise((resolve) => {
      if (server) {
        server.close(() => resolve());
      } else {
        resolve();
      }
    });
  });

  function makeRequest(path) {
    return new Promise((resolve, reject) => {
      const address = server.address();
      const req = http.request({
        hostname: 'localhost',
        port: address.port,
        path,
        method: 'GET'
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const body = data ? JSON.parse(data) : {};
            resolve({ status: res.statusCode, body });
          } catch (e) {
            resolve({ status: res.statusCode, body: data });
          }
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  describe('GET /health', () => {
    test('should return 200 with ok: true', async () => {
      const response = await makeRequest('/health');
      
      assert.equal(response.status, 200);
      assert.ok(response.body);
      assert.equal(response.body.ok, true);
    });

    test('should return JSON content type', async () => {
      const response = await makeRequest('/health');
      
      assert.equal(response.status, 200);
      assert.equal(typeof response.body, 'object');
    });
  });

  describe('GET /api/llm/health', () => {
    test('should return LLM health information', async () => {
      const response = await makeRequest('/api/llm/health');
      
      // Should return either success or error, but be a valid response
      assert.ok(response.status === 200 || response.status === 500);
      assert.ok(response.body);
      assert.equal(typeof response.body.ok, 'boolean');
    });

    test('should include configured models on success', async () => {
      const response = await makeRequest('/api/llm/health');
      
      if (response.status === 200) {
        assert.ok(response.body.configured);
        assert.ok(Array.isArray(response.body.available));
        assert.ok(response.body.present);
        assert.equal(typeof response.body.present.convo, 'boolean');
        assert.equal(typeof response.body.present.code, 'boolean');
      }
    });

    test('should handle LLM service errors gracefully', async () => {
      const response = await makeRequest('/api/llm/health');
      
      if (response.status === 500) {
        assert.equal(response.body.ok, false);
        assert.ok(response.body.error);
        assert.equal(typeof response.body.error, 'string');
      }
    });

    test('should always return valid JSON', async () => {
      const response = await makeRequest('/api/llm/health');
      
      // Both success and error responses should be valid JSON objects
      assert.ok(response.body);
      assert.equal(typeof response.body, 'object');
      assert.equal(typeof response.body.ok, 'boolean');
    });
  });

  describe('Route integration', () => {
    test('should handle multiple concurrent health checks', async () => {
      const requests = Array.from({ length: 5 }, () => makeRequest('/health'));
      const responses = await Promise.all(requests);
      
      responses.forEach(response => {
        assert.equal(response.status, 200);
        assert.equal(response.body.ok, true);
      });
    });

    test('should handle invalid paths gracefully', async () => {
      const response = await makeRequest('/invalid-path');
      
      // Express should return 404 for unknown routes
      assert.equal(response.status, 404);
    });
  });
});