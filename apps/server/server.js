#!/usr/bin/env node

// Single-server Express app that serves the UI and provides CRUD + search + backlog APIs.
// Persistence uses SQLite (better-sqlite3) at ./data/app.db with schema at apps/server/database/schema.sql.

import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import db from './database/DbService.js';
import app, { setOperationProcessor } from './app.js';
import { logIO, mkCorrelationId } from './llm/logging.js';
import { batchRecorder } from './utils/batch_recorder.js';
 

import { HabitusMCPServer } from './mcp/mcp_server.js';
import { OperationProcessor } from './operations/operation_processor.js';
import { OperationRegistry } from './operations/operation_registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Cache configured LLM models once at startup to keep a single source of truth
// throughout the server process. This is intentionally read-once so runtime
// behaviour is consistent and so we can log configured models at startup.
const MODELS = {
  convo: 'qwen3-coder:30b',
  code: 'qwen3-coder:30b',
  host: process.env.OLLAMA_HOST || '127.0.0.1',
  port: process.env.OLLAMA_PORT || '11434',
};

// Orchestrator configuration (feature-flagged)
const ORCHESTRATOR = {
  enabled: /^(1|true|yes|on)$/i.test(String(process.env.ORCHESTRATOR_ENABLED || '1')),
  model: process.env.ORCHESTRATOR_MODEL || 'qwen3-coder:30b',
  timeoutMs: Number(process.env.ORCHESTRATOR_TIMEOUT_MS || 15000)
};

// --- Paths ---
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(REPO_ROOT, 'data');
const STATIC_DIR = process.env.STATIC_DIR || path.join(REPO_ROOT, 'apps', 'web', 'flutter_app', 'build', 'web');
const SCHEMA_FILE = path.join(REPO_ROOT, 'apps', 'server', 'database', 'schema.sql');

// --- Timezone (fixed semantics) ---
const TIMEZONE = process.env.TZ_NAME || 'America/New_York';

// weekRangeFromToday is provided by utils/date.js

// DB-backed helpers removed (unused)



// Ensure data dir exists and bootstrap DB schema
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
// Ensure assistant checkpoint directory exists (no-op if not used yet)
try {
  const ckptDir = process.env.ASSISTANT_CHECKPOINT_DIR || path.join(DATA_DIR, 'assistant_state');
  fs.mkdirSync(ckptDir, { recursive: true });
} catch {}
// Prune old checkpoint files on server boot
try {
  const { pruneCheckpoints } = await import('./llm/ops_graph.js');
  pruneCheckpoints();
} catch {}
try {
  const schemaSql = fs.readFileSync(SCHEMA_FILE, 'utf8');
  db.bootstrapSchema(schemaSql);
} catch {}

// --- Server ---
// Initialize MCP server and operation processor
const operationProcessor = new OperationProcessor();
operationProcessor.setDbService(db);
const operationRegistry = new OperationRegistry(db);
operationRegistry.registerAllOperations(operationProcessor);

// Set the operation processor in the assistant routes
setOperationProcessor(operationProcessor);

const mcpServer = new HabitusMCPServer(app);
mcpServer.setOperationProcessor(operationProcessor);

// Log orchestrator configuration at startup
try {
  const summary = { enabled: ORCHESTRATOR.enabled, model: ORCHESTRATOR.model, timeoutMs: ORCHESTRATOR.timeoutMs };
  console.log('Orchestrator config:', summary);
  try { logIO('assistant_orchestrator_config', { model: 'orchestrator', prompt: JSON.stringify({}), output: JSON.stringify(summary) }); } catch {}
} catch {}

// --- Security: shared-secret auth for MCP mutations ---
function requireMcpToken(req, res, next) {
  try {
    const shared = String(process.env.MCP_SHARED_SECRET || '').trim();
    if (!shared) return next();
    const provided = String(req.headers['x-mcp-token'] || req.headers['x-mcp-secret'] || '').trim();
    if (provided && provided === shared) return next();
    return res.status(401).json({ error: 'unauthorized' });
  } catch {
    return res.status(401).json({ error: 'unauthorized' });
  }
}

// MCP Server endpoints
app.get('/api/mcp/tools', async (req, res) => {
  try {
    const tools = await mcpServer.listAvailableTools();
    res.json({ tools });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/mcp/resources', async (req, res) => {
  try {
    const resources = await mcpServer.listAvailableResources();
    res.json({ resources });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/mcp/resources/:type/:name', async (req, res) => {
  try {
    const { type, name } = req.params;
    const fullUri = `habitus://${type}/${name}`;
    const content = await mcpServer.readResource(fullUri);
    if (content === null) {
      return res.status(404).json({ error: 'Resource not found' });
    }
    res.json({ uri: fullUri, content });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/mcp/tools/call', requireMcpToken, async (req, res) => {
  try {
    const { name, arguments: args } = req.body || {};
    if (!name) {
      return res.status(400).json({ error: 'Tool name is required' });
    }
    
    // Get correlation ID from header or generate one
    const correlationId = req.headers['x-correlation-id'] || mkCorrelationId();
    
    // Ensure batch exists for this correlation
    const batchId = await batchRecorder.ensureBatch(correlationId);
    
    // Convert tool call to operation format
    const op = mcpServer.convertToolCallToOperation(name, args || {});
    
    // Fetch before state if needed
    let before = null;
    if (op.id && (op.action === 'update' || op.action === 'delete' || op.action === 'set_status' || op.action === 'complete_occurrence')) {
      try {
        if (op.kind === 'task') {
          before = await db.getTaskById(op.id);
        } else if (op.kind === 'event') {
          before = await db.getEventById(op.id);
        }
      } catch (e) {
        console.warn('Failed to fetch before state:', e.message);
      }
    }
    
    // Execute the operation
    const result = await mcpServer.handleToolCall(name, args || {});
    
    // Fetch after state
    let after = null;
    if (result?.results?.[0]?.ok) {
      try {
        if (op.action === 'create') {
          // For create, the result should contain the created entity
          after = result.results[0].created || result.results[0].updated;
        } else if (op.id) {
          // For update/delete, fetch current state
          if (op.kind === 'task') {
            after = op.action === 'delete' ? null : await db.getTaskById(op.id);
          } else if (op.kind === 'event') {
            after = op.action === 'delete' ? null : await db.getEventById(op.id);
          }
        }
      } catch (e) {
        console.warn('Failed to fetch after state:', e.message);
      }
    }
    
    // Record the operation
    await batchRecorder.recordOp({
      batchId,
      seq: Date.now(),
      op,
      before,
      after
    });
    
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Dev helper route to surface MCP token value (for local setup only)
if (process.env.NODE_ENV !== 'production') {
  app.get('/__dev/mcp_token', (_req, res) => {
    const present = !!String(process.env.MCP_SHARED_SECRET || '').trim();
    res.json({ configured: present, key: present ? 'MCP_SHARED_SECRET' : null });
  });
}

// Undo endpoints for propose-only pipeline
app.get('/api/assistant/last_batch', async (req, res) => {
  try {
    const lastBatch = await batchRecorder.getLastBatch();
    if (!lastBatch) {
      return res.status(404).json({ error: 'no_batch' });
    }
    res.json(lastBatch);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/assistant/undo_last', async (req, res) => {
  try {
    const lastBatch = await batchRecorder.getLastBatch();
    if (!lastBatch) {
      return res.status(404).json({ error: 'no_batch' });
    }
    
    // Build inverse operations
    const inverses = [];
    for (const batchOp of lastBatch.ops) {
      const op = batchOp.op;
      const before = batchOp.before;
      
      if (op.action === 'create') {
        // create → delete
        inverses.push({ kind: op.kind, action: 'delete', id: batchOp.after?.id || op.id });
      } else if (op.action === 'update') {
        // update → update with before fields
        if (before) {
          const inverseOp = { kind: op.kind, action: 'update', id: op.id };
          // Only include fields that were actually changed
          if (op.title !== undefined) inverseOp.title = before.title;
          if (op.notes !== undefined) inverseOp.notes = before.notes;
          if (op.scheduledFor !== undefined) inverseOp.scheduledFor = before.scheduledFor;
          // tasks are all-day; no time-of-day inverse fields
          if (op.recurrence !== undefined) inverseOp.recurrence = before.recurrence;
          if (op.context !== undefined) inverseOp.context = before.context;
          if (op.status !== undefined) inverseOp.status = before.status;
          inverses.push(inverseOp);
        }
      } else if (op.action === 'delete') {
        // delete → create with before fields
        if (before) {
          const inverseOp = { kind: op.kind, action: 'create' };
          inverseOp.title = before.title;
          inverseOp.notes = before.notes;
          inverseOp.scheduledFor = before.scheduledFor;
          // tasks are all-day; no time-of-day inverse fields
          inverseOp.recurrence = before.recurrence;
          inverseOp.context = before.context;
          if (op.kind === 'task') inverseOp.status = before.status;
          inverses.push(inverseOp);
        }
      } else if (op.action === 'set_status' || op.action === 'set_occurrence_status') {
        // Normalize to set_status tool with optional occurrenceDate
        if (before) {
          const inverseOp = { kind: op.kind, action: 'set_status', id: op.id };
          if (op.action === 'set_status') {
            // Revert master status to previous
            inverseOp.status = before.status;
          } else {
            // Occurrence toggle: derive status from previous state
            // If previous was completed on that date, revert to pending; else set to completed
            inverseOp.occurrenceDate = op.occurrenceDate;
            const wasCompleted = (() => {
              try {
                const list = Array.isArray(before.completedDates) ? before.completedDates : [];
                return list.includes(op.occurrenceDate);
              } catch { return false; }
            })();
            inverseOp.status = wasCompleted ? 'pending' : 'completed';
          }
          inverses.push(inverseOp);
        }
      }
    }
    
    // Apply inverse operations in reverse order
    let undoneCount = 0;
    await db.runInTransaction(async () => {
      for (const inverseOp of inverses.reverse()) {
        const toolName = _operationToToolName(inverseOp);
        const args = _operationToToolArgs(inverseOp);
        const result = await mcpServer.handleToolCall(toolName, args);
        if (result?.results?.[0]?.ok) {
          undoneCount++;
        }
      }
    });
    
    // Clear the batch after successful undo
    await batchRecorder.clearBatch(lastBatch.correlationId);
    
    res.json({ 
      ok: true, 
      undone: undoneCount, 
      correlationId: lastBatch.correlationId,
      inverses: inverses.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Helper functions for undo
function _operationToToolName(op) {
  const kind = op.kind || 'task';
  const action = op.action || 'create';
  
  switch (action) {
    case 'create':
      return `create_${kind}`;
    case 'update':
      return `update_${kind}`;
    case 'delete':
      return `delete_${kind}`;
    case 'set_status':
      return `set_${kind}_status`;
    case 'set_occurrence_status':
      // Normalize to existing set_status tool; occurrence controlled via args
      return `set_${kind}_status`;
    default:
      return `create_${kind}`;
  }
}

function _operationToToolArgs(op) {
  const args = {};
  
  // Copy all fields except kind and action
  for (const [key, value] of Object.entries(op)) {
    if (key !== 'kind' && key !== 'action') {
      args[key] = value;
    }
  }
  
  return args;
}

// Debug: list routes (optional)
if (process.env.ENABLE_DEBUG_ROUTES === 'true') {
  app.get('/__routes', (_req, res) => {
    try {
      const routes = [];
      app._router.stack.forEach((m) => {
        if (m.route && m.route.path) {
          const methods = Object.keys(m.route.methods).filter(Boolean);
          routes.push({ path: m.route.path, methods });
        }
      });
      res.json({ routes });
    } catch (e) {
      res.status(500).json({ error: String(e && e.message ? e.message : e) });
    }
  });
}

// Mount static assets last so API routes are matched first
app.use(express.static(STATIC_DIR));

// Silence noisy 404s for Flutter source maps when running in prod-like mode
app.get('/flutter.js.map', (_req, res) => res.status(204).end());

// Error handler
app.use((err, _req, res, _next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'internal_error' });
});

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '127.0.0.1';
app.listen(PORT, HOST, async () => {
  console.log(`Server listening at http://${HOST}:${PORT}`);
  try {
    // Best-effort: query Ollama for available models to report presence of configured names
    const { getAvailableModels } = await import('./llm/clients.js');
    try {
      const avail = await getAvailableModels();
      const present = Array.isArray(avail.models) ? avail.models.map(m => m.name) : [];
      const convoPresent = present.includes(MODELS.convo);
      const codePresent = present.includes(MODELS.code);
      console.log('Configured LLM models:', MODELS);
      console.log('Available Ollama models:', present.slice(0, 50));
      console.log(`Convo model present: ${convoPresent}, Code model present: ${codePresent}`);
    } catch (e) {
      console.log('Configured LLM models (availability unknown):', MODELS);
    }
  } catch (e) {
    console.log('Configured LLM models (getAvailableModels not available):', MODELS);
  }
});
