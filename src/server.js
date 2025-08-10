#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from 'fs';
import path from 'path';

// Persistent storage configuration
const DATA_DIR = path.join(process.cwd(), 'data');
const TODOS_FILE = path.join(DATA_DIR, 'todos.json');
const COUNTER_FILE = path.join(DATA_DIR, 'counter.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Persistent storage functions
const loadTodos = () => {
  try {
    if (fs.existsSync(TODOS_FILE)) {
      const data = fs.readFileSync(TODOS_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Error loading todos:', error);
  }
  return [];
};

const saveTodos = (todos) => {
  try {
    fs.writeFileSync(TODOS_FILE, JSON.stringify(todos, null, 2));
  } catch (error) {
    console.error('Error saving todos:', error);
  }
};

const loadNextId = () => {
  try {
    if (fs.existsSync(COUNTER_FILE)) {
      const data = fs.readFileSync(COUNTER_FILE, 'utf8');
      return JSON.parse(data).nextId;
    }
  } catch (error) {
    console.error('Error loading counter:', error);
  }
  return 1;
};

const saveNextId = (nextId) => {
  try {
    fs.writeFileSync(COUNTER_FILE, JSON.stringify({ nextId }, null, 2));
  } catch (error) {
    console.error('Error saving counter:', error);
  }
};

// Initialize persistent storage
let todos = loadTodos();
let nextId = loadNextId();

// Todo model
const createTodo = (title, notes = '', scheduledFor = null, priority = 'medium') => {
  const todo = {
    id: nextId++,
    title,
    notes,
    scheduledFor, // null = forever, ISO string = specific date/time
    priority, // 'low', 'medium', 'high'
    completed: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  
  // Save the updated counter
  saveNextId(nextId);
  
  return todo;
};

// Helper functions
const findTodoById = (id) => todos.find(t => t.id === parseInt(id));
const formatTodo = (todo) => JSON.stringify(todo, null, 2);

// Create server
const server = new Server(
  {
    name: "todo-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {},
    },
  }
);

// Tools for CRUD operations
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "create_todo",
        description: "Create a new todo item",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Todo title (required)" },
            notes: { type: "string", description: "Optional notes" },
            scheduledFor: { 
              type: ["string", "null"], 
              description: "ISO date string for scheduled time, or null for forever" 
            },
            priority: { 
              type: "string", 
              enum: ["low", "medium", "high"],
              description: "Priority level" 
            }
          },
          required: ["title"]
        }
      },
      {
        name: "list_todos",
        description: "List all todo items",
        inputSchema: {
          type: "object",
          properties: {
            completed: { 
              type: "boolean", 
              description: "Filter by completion status (optional)" 
            },
            priority: {
              type: "string",
              enum: ["low", "medium", "high"],
              description: "Filter by priority (optional)"
            },
            scheduledFrom: {
              type: "string",
              description: "Inclusive start date (YYYY-MM-DD)"
            },
            scheduledTo: {
              type: "string",
              description: "Inclusive end date (YYYY-MM-DD)"
            }
          }
        }
      },
      {
        name: "search_todos",
        description: "Search todos by substring in title or notes (case-insensitive)",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query (required)" }
          },
          required: ["query"]
        }
      },
      {
        name: "get_todo",
        description: "Get a specific todo by ID",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: ["integer", "string"], description: "Todo ID" }
          },
          required: ["id"]
        }
      },
      {
        name: "update_todo",
        description: "Update an existing todo",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: ["integer", "string"], description: "Todo ID" },
            title: { type: "string", description: "New title" },
            notes: { type: "string", description: "New notes" },
            scheduledFor: { 
              type: ["string", "null"], 
              description: "New scheduled time or null" 
            },
            priority: { 
              type: "string", 
              enum: ["low", "medium", "high"],
              description: "New priority" 
            },
            completed: { type: "boolean", description: "Completion status" }
          },
          required: ["id"]
        }
      },
      {
        name: "delete_todo",
        description: "Delete a todo item",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: ["integer", "string"], description: "Todo ID to delete" }
          },
          required: ["id"]
        }
      }
    ]
  };
});

// Tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "create_todo":
      const newTodo = createTodo(
        args.title,
        args.notes,
        args.scheduledFor,
        args.priority
      );
      todos.push(newTodo);
      saveTodos(todos); // Persist the changes
      return {
        content: [
          {
            type: "text",
            text: `Created todo:\n${formatTodo(newTodo)}`
          }
        ]
      };

    case "list_todos":
      let filteredTodos = todos;
      if (args.completed !== undefined) {
        filteredTodos = filteredTodos.filter(t => t.completed === args.completed);
      }
      if (args.priority) {
        const p = String(args.priority).toLowerCase();
        filteredTodos = filteredTodos.filter(t => String(t.priority).toLowerCase() === p);
      }
      const parseYMD = (s) => {
        try {
          const [y, m, d] = String(s).split('-').map(v => parseInt(v, 10));
          if (!y || !m || !d) return null;
          // Construct date at local midnight
          return new Date(y, m - 1, d);
        } catch { return null; }
      };
      const fromDate = args.scheduledFrom ? parseYMD(args.scheduledFrom) : null;
      const toDate = args.scheduledTo ? parseYMD(args.scheduledTo) : null;
      if (fromDate || toDate) {
        filteredTodos = filteredTodos.filter(t => {
          if (!t.scheduledFor) return false;
          const td = parseYMD(t.scheduledFor);
          if (!td) return false;
          if (fromDate && td < fromDate) return false;
          if (toDate) {
            // inclusive end: add 1 day and compare < next day
            const inclusiveEnd = new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate() + 1);
            if (td >= inclusiveEnd) return false;
          }
          return true;
        });
      }
      return {
        content: [
          {
            type: "text",
            text: `Found ${filteredTodos.length} todos:\n${JSON.stringify(filteredTodos, null, 2)}`
          }
        ]
      };

    case "search_todos":
      {
        const q = String(args.query || '').toLowerCase();
        const results = !q ? [] : todos.filter(t =>
          String(t.title || '').toLowerCase().includes(q) ||
          String(t.notes || '').toLowerCase().includes(q)
        );
        return {
          content: [
            { type: "text", text: `Found ${results.length} todos:\n${JSON.stringify(results, null, 2)}` }
          ]
        };
      }

    case "get_todo":
      const todo = findTodoById(args.id);
      if (!todo) {
        throw new Error(`Todo with ID ${args.id} not found`);
      }
      return {
        content: [
          {
            type: "text",
            text: formatTodo(todo)
          }
        ]
      };

    case "update_todo":
      const todoToUpdate = findTodoById(args.id);
      if (!todoToUpdate) {
        throw new Error(`Todo with ID ${args.id} not found`);
      }
      
      Object.assign(todoToUpdate, {
        ...(args.title !== undefined && { title: args.title }),
        ...(args.notes !== undefined && { notes: args.notes }),
        ...(args.scheduledFor !== undefined && { scheduledFor: args.scheduledFor }),
        ...(args.priority !== undefined && { priority: args.priority }),
        ...(args.completed !== undefined && { completed: args.completed }),
        updatedAt: new Date().toISOString()
      });

      saveTodos(todos); // Persist the changes

      return {
        content: [
          {
            type: "text",
            text: `Updated todo:\n${formatTodo(todoToUpdate)}`
          }
        ]
      };

    case "delete_todo":
      const index = todos.findIndex(t => t.id === parseInt(args.id));
      if (index === -1) {
        throw new Error(`Todo with ID ${args.id} not found`);
      }
      
      const deletedTodo = todos.splice(index, 1)[0];
      saveTodos(todos); // Persist the changes
      return {
        content: [
          {
            type: "text",
            text: `Deleted todo: ${deletedTodo.title} (ID: ${deletedTodo.id})`
          }
        ]
      };

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// Resources for todo data
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: "todo://all",
        name: "All Todos",
        description: "Complete list of all todo items",
        mimeType: "application/json"
      },
      {
        uri: "todo://pending",
        name: "Pending Todos",
        description: "List of incomplete todo items",
        mimeType: "application/json"
      },
      {
        uri: "todo://completed",
        name: "Completed Todos", 
        description: "List of completed todo items",
        mimeType: "application/json"
      }
    ]
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  switch (uri) {
    case "todo://all":
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(todos, null, 2)
          }
        ]
      };

    case "todo://pending":
      const pending = todos.filter(t => !t.completed);
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(pending, null, 2)
          }
        ]
      };

    case "todo://completed":
      const completed = todos.filter(t => t.completed);
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(completed, null, 2)
          }
        ]
      };

    default:
      throw new Error(`Unknown resource: ${uri}`);
  }
});

// Prompts for common operations
server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return {
    prompts: [
      {
        name: "daily_review",
        description: "Generate a daily todo review and planning prompt"
      },
      {
        name: "priority_analysis",
        description: "Analyze todo priorities and suggest reorganization"
      },
      {
        name: "schedule_conflicts",
        description: "Check for scheduling conflicts in todos"
      }
    ]
  };
});

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name } = request.params;

  switch (name) {
    case "daily_review":
      const todaysTodos = todos.filter(t => {
        if (!t.scheduledFor) return false;
        const todoDate = new Date(t.scheduledFor).toDateString();
        const today = new Date().toDateString();
        return todoDate === today;
      });

      return {
        description: "Daily todo review and planning",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Review today's todos and help me plan:

Current todos for today:
${JSON.stringify(todaysTodos, null, 2)}

All todos:
${JSON.stringify(todos, null, 2)}

Please:
1. Summarize what's due today
2. Identify any overdue items
3. Suggest priorities for today
4. Recommend any scheduling adjustments`
            }
          }
        ]
      };

    case "priority_analysis":
      return {
        description: "Analyze and optimize todo priorities",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Analyze my todo list priorities:

${JSON.stringify(todos, null, 2)}

Please:
1. Review current priority assignments
2. Identify any priority conflicts or issues
3. Suggest better priority distribution
4. Recommend which high-priority items need immediate attention`
            }
          }
        ]
      };

    case "schedule_conflicts":
      const scheduledTodos = todos.filter(t => t.scheduledFor);
      return {
        description: "Check for scheduling conflicts",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Check for scheduling conflicts in my todos:

Scheduled todos:
${JSON.stringify(scheduledTodos, null, 2)}

Please:
1. Identify any time conflicts
2. Find todos scheduled too close together
3. Suggest rescheduling options
4. Flag any unrealistic scheduling`
            }
          }
        ]
      };

    default:
      throw new Error(`Unknown prompt: ${name}`);
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Todo MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
