// Test Database Manager for LLM Test Suite
// Manages isolated test databases for each test run

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DbService } from '../../../apps/server/database/DbService.js';
import { HabitusMCPServer } from '../../../apps/server/mcp/mcp_server.js';
import { OperationProcessor } from '../../../apps/server/operations/operation_processor.js';
import { OperationRegistry } from '../../../apps/server/operations/operation_registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class TestDatabaseManager {
  constructor() {
    this.dbPath = null;
    this.dbService = null;
    this.mcpServer = null;
    this.operationProcessor = null;
  }

  async setupTestDatabase(modelName, testId) {
    // Create unique database file for each test run
    this.dbPath = `tests/llm/data/test_databases/${modelName}_${testId}_${Date.now()}.db`;
    
    // Ensure directory exists
    const dbDir = path.dirname(this.dbPath);
    await fs.mkdir(dbDir, { recursive: true });
    
    // Initialize database with existing schema
    this.dbService = await this.initializeDatabase(this.dbPath);
    
    // Initialize MCP server and operation processor
    const { mcpServer, operationProcessor } = await this.initializeMCPClient();
    this.mcpServer = mcpServer;
    this.operationProcessor = operationProcessor;
    
    // Seed with simple realistic data patterns for single user
    await this.seedSimpleRealisticTestData();
    
    return {
      dbService: this.dbService,
      mcpServer: this.mcpServer,
      operationProcessor: this.operationProcessor,
      cleanup: () => this.cleanup()
    };
  }

  async initializeDatabase(dbPath) {
    // Create new DbService instance for test database
    const dbService = new DbService(dbPath);
    
    // Read and bootstrap schema
    const schemaPath = path.join(__dirname, '../../../apps/server/database/schema.sql');
    const schemaSql = await fs.readFile(schemaPath, 'utf8');
    dbService.bootstrapSchema(schemaSql);
    
    console.log(`✅ Test database initialized at: ${dbPath}`);
    return dbService;
  }

  async initializeMCPClient() {
    // Create mock Express app for MCP server
    const mockExpressApp = {
      post: () => ({ json: () => {} }),
      get: () => ({ json: () => {} })
    };
    
    // Initialize MCP server
    const mcpServer = new HabitusMCPServer(mockExpressApp);
    
    // Initialize operation processor
    const operationProcessor = new OperationProcessor();
    operationProcessor.setDbService(this.dbService);
    
    // Register all operations using the operation registry
    const operationRegistry = new OperationRegistry(this.dbService);
    operationRegistry.registerAllOperations(operationProcessor);
    
    // Set up operation processor in MCP server
    mcpServer.setOperationProcessor(operationProcessor);
    
    console.log('✅ MCP client initialized with operation processor');
    console.log(`✅ Registered ${operationProcessor.listOperationTypes().length} operation types`);
    
    return { mcpServer, operationProcessor };
  }

  async seedSimpleRealisticTestData() {
    // Simple realistic patterns: basic work tasks, personal tasks, recurring habits, meetings
    const testData = {
      todos: [
        // Basic work tasks
        { title: "Review project proposal", scheduledFor: "2025-08-18", recurrence: { type: "none" }, status: "pending" },
        { title: "Call client", scheduledFor: "2025-08-19", recurrence: { type: "none" }, status: "pending" },
        { title: "Prepare presentation", scheduledFor: "2025-08-20", recurrence: { type: "none" }, status: "pending" },
        
        // Simple recurring tasks
        { title: "Daily standup", scheduledFor: "2025-08-18", recurrence: { type: "daily" }, status: "pending" },
        { title: "Weekly planning", scheduledFor: "2025-08-20", recurrence: { type: "weekly" }, status: "pending" },
        
        // Personal tasks
        { title: "Buy groceries", scheduledFor: "2025-08-18", recurrence: { type: "none" }, status: "pending" },
        { title: "Gym workout", scheduledFor: "2025-08-18", recurrence: { type: "daily" }, status: "pending" },
        
        // Completed task for context
        { title: "Send email to team", scheduledFor: "2025-08-17", recurrence: { type: "none" }, status: "completed" }
      ],
      events: [
        // Basic work meetings
        { title: "Team meeting", scheduledFor: "2025-08-18", startTime: "10:00", endTime: "11:00" },
        { title: "Client presentation", scheduledFor: "2025-08-19", startTime: "14:00", endTime: "15:30" },
        { title: "Code review", scheduledFor: "2025-08-20", startTime: "16:00", endTime: "17:00" },
        
        // Simple personal event
        { title: "Dentist appointment", scheduledFor: "2025-08-21", startTime: "13:00", endTime: "14:00" }
      ]
    };
    
    await this.insertTestData(testData);
    console.log('✅ Test data seeded successfully');
  }

  async seedScenarioData(scenario) {
    // Clear existing data
    await this.clearTestData();
    
    const context = scenario.context || {};
    
    // Seed simplified todos from scenario context (max 5 items)
    const todos = (context.todos || []).slice(0, 5);
    for (const todo of todos) {
      await this.dbService.createTodo({
        title: todo.title,
        scheduledFor: todo.scheduledFor || null,
        status: todo.status || 'pending',
        recurrence: { type: 'none' }, // Simplified - no complex recurrence
        notes: ''
      });
    }
    
    // Seed simplified events from scenario context (max 3 items)
    const events = (context.events || []).slice(0, 3);
    for (const event of events) {
      await this.dbService.createEvent({
        title: event.title,
        scheduledFor: event.scheduledFor || null,
        startTime: event.startTime || null,
        endTime: event.endTime || null,
        location: null, // Simplified
        completed: false,
        recurrence: { type: 'none' }, // Simplified
        notes: ''
      });
    }
    
    // Skip habits for now - focus on core todos/events
    console.log(`✅ Simplified scenario data seeded: ${todos.length} todos, ${events.length} events`);
  }

  async clearTestData() {
    // Clear all test data
    await this.dbService.db.prepare('DELETE FROM todos').run();
    await this.dbService.db.prepare('DELETE FROM events').run();
    await this.dbService.db.prepare('DELETE FROM habits').run();
    await this.dbService.db.prepare('DELETE FROM goals').run();
  }

  async insertTestData(testData) {
    // Insert todos
    for (const todo of testData.todos) {
      this.dbService.createTodo(todo);
    }
    
    // Insert events
    for (const event of testData.events) {
      this.dbService.createEvent(event);
    }
  }

  async executeOperation(operation) {
    // Execute operation using the operation processor
    if (!this.operationProcessor) {
      throw new Error('Operation processor not initialized');
    }
    
    const result = await this.operationProcessor.processOperations([operation]);
    return result.results[0]; // Return first result since we're executing single operation
  }

  async cleanup() {
    if (this.dbService && this.dbService.db) {
      this.dbService.db.close();
    }
    
    if (this.dbPath) {
      try {
        await fs.unlink(this.dbPath);
        console.log(`✅ Test database cleaned up: ${this.dbPath}`);
      } catch (error) {
        console.warn(`⚠️ Could not delete test database: ${error.message}`);
      }
    }
  }
}
