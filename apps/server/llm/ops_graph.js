// LangGraph-based assistant pipeline with file-backed checkpoints and SSE streaming.
// Implements structured node execution: BuildContext → BuildTools → Propose → Validate → Dedupe → Summarize → Clarify.

import { runOpsAgentToolCalling } from './ops_agent.js';
import { buildFocusedContext } from './context.js';
import { buildOperationTools, parseToolResponseStrict } from './lc_adapters.js';
import { logIO } from './logging.js';
import { OperationRegistry } from '../operations/operation_registry.js';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Run the LangGraph-based operations pipeline with structured node execution.
 * Provides file-backed checkpointing, SSE streaming, and graceful fallbacks.
 */
function writeCheckpoint(correlationId, stage, delta) {
  try {
    const dir = process.env.ASSISTANT_CHECKPOINT_DIR || path.join(process.cwd(), 'data', 'assistant_state');
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    const file = path.join(dir, `${String(correlationId || 'run')}.jsonl`);
    const entry = { t: Date.now(), stage, delta };
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  } catch {}
}

function pruneCheckpoints() {
  try {
    const maxDays = Number(process.env.ASSISTANT_CHECKPOINT_MAX_DAYS || '7');
    if (!Number.isFinite(maxDays) || maxDays <= 0) return;
    
    const dir = process.env.ASSISTANT_CHECKPOINT_DIR || path.join(process.cwd(), 'data', 'assistant_state');
    const cutoff = Date.now() - (maxDays * 24 * 60 * 60 * 1000);
    
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    let pruned = 0;
    
    for (const file of files) {
      try {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat.mtime.getTime() < cutoff) {
          fs.unlinkSync(fullPath);
          pruned++;
        }
      } catch {}
    }
    
    if (pruned > 0) {
      console.log(`[Checkpoints] Pruned ${pruned} old checkpoint files (>${maxDays}d)`);
    }
  } catch {}
}

export async function runOpsGraph(initialState, { operationProcessor, onStage } = {}) {
  const {
    instruction = '',
    where = {},
    transcript = [],
    timezone,
    correlationId,
  } = initialState || {};

  // Stage: BuildContext
  let context = null;
  try {
    context = buildFocusedContext(where || {}, { timezone });
    try {
      logIO('graph_build_context', {
        model: 'graph',
        prompt: JSON.stringify({ where, timezone }),
        output: JSON.stringify({ counts: { tasks: context.tasks?.length || 0, events: context.events?.length || 0 }, truncated: !!(context.meta && context.meta.contextTruncated) }),
        meta: { correlationId }
      });
    } catch {}
    writeCheckpoint(correlationId, 'graph_build_context', { counts: { tasks: context.tasks?.length || 0, events: context.events?.length || 0 }, truncated: !!(context.meta && context.meta.contextTruncated) });
    try { if (typeof onStage === 'function') onStage('graph_build_context', { correlationId }); } catch {}
  } catch {}

  // Stage: BuildTools
  try {
    const registry = new OperationRegistry((await import('../database/DbService.js')).default);
    const tools = buildOperationTools(registry);
    try {
      logIO('graph_build_tools', {
        model: 'graph',
        prompt: JSON.stringify({ toolCount: Array.isArray(tools) ? tools.length : 0 }),
        output: JSON.stringify({ tools: Array.isArray(tools) ? tools.map(t => t.function?.name) : [] }),
        meta: { correlationId }
      });
    } catch {}
    writeCheckpoint(correlationId, 'graph_build_tools', { toolCount: Array.isArray(tools) ? tools.length : 0 });
    try { if (typeof onStage === 'function') onStage('graph_build_tools', { correlationId }); } catch {}
  } catch {}

  // Stage: Propose (adapted from agent for now)
  let proposal = null;
  try {
    const p = await nodeProposeLLM({ instruction, where, transcript, timezone, operationProcessor, correlationId });
    proposal = p?.proposal || { tool_calls: [], message: '' };
    writeCheckpoint(correlationId, 'graph_propose', { tool_calls: Array.isArray(proposal.tool_calls) ? proposal.tool_calls.length : 0, hasMessage: !!proposal.message });
    try { if (typeof onStage === 'function') onStage('graph_propose', { correlationId }); } catch {}
  } catch {}

  // Stage: Validate
  let validation = { validOps: [], invalid: [] };
  try {
    const v = await nodeValidateOps({ proposal, operationProcessor, correlationId });
    validation = v?.validation || validation;
    writeCheckpoint(correlationId, 'graph_validate', { valid: validation.validOps.length, invalid: validation.invalid.length });
    try { if (typeof onStage === 'function') onStage('graph_validate', { correlationId }); } catch {}
  } catch {}

  // Stage: Dedupe
  let deduped = [];
  try {
    const d = nodeDedupe({ validation, correlationId });
    deduped = d?.deduped || [];
    writeCheckpoint(correlationId, 'graph_dedupe', { out: deduped.length });
    try { if (typeof onStage === 'function') onStage('graph_dedupe', { correlationId }); } catch {}
  } catch {}

  // Stage: Summarize
  let summary = '';
  try {
    const s = nodeSummarize({ deduped, validation, proposal, correlationId });
    summary = s?.summary || '';
    writeCheckpoint(correlationId, 'graph_summarize', { summary: String(summary || '').slice(0, 120) });
    try { if (typeof onStage === 'function') onStage('graph_summarize', { correlationId }); } catch {}
  } catch {}

  // Stage: Clarify
  let clarify = { needed: false, question: null };
  try {
    const c = nodeClarify({ validation, correlationId });
    clarify = c?.clarify || clarify;
    writeCheckpoint(correlationId, 'graph_clarify', { invalid: Array.isArray(validation.invalid) ? validation.invalid.length : 0, needed: clarify.needed, question: clarify.question });
    try { if (typeof onStage === 'function') onStage('graph_clarify', { correlationId, needed: clarify.needed, question: clarify.question }); } catch {}
  } catch {}

  try {
    logIO('graph_done', {
      model: 'graph',
      prompt: JSON.stringify({}),
      output: JSON.stringify({
        proposedCalls: Array.isArray(proposal?.tool_calls) ? proposal.tool_calls.length : 0,
        valid: validation.validOps.length,
        deduped: deduped.length,
        summary: String(summary || '').slice(0, 80)
      }),
      meta: { correlationId }
    });
  } catch {}
  writeCheckpoint(correlationId, 'graph_done', { proposedCalls: Array.isArray(proposal?.tool_calls) ? proposal.tool_calls.length : 0, valid: validation.validOps.length, deduped: deduped.length });
  try { if (typeof onStage === 'function') onStage('graph_done', { correlationId }); } catch {}

  // Prune old checkpoints after each run
  try { pruneCheckpoints(); } catch {}

  try {
    // Prefer graph outputs for parity mapping
    const notes = {
      errors: Array.isArray(validation?.invalid) ? validation.invalid : [],
      contextTruncated: !!(context && context.meta && context.meta.contextTruncated),
      clarify: clarify.needed ? { question: clarify.question } : null
    };
    return {
      text: String(summary || '') || 'No actionable changes detected.',
      steps: [ { name: 'Identify targets' }, { name: 'Propose operations' } ],
      operations: Array.isArray(deduped) ? deduped : [],
      tools: Array.isArray(proposal?.tool_calls) ? proposal.tool_calls : [],
      notes,
      thinking: null,
    };
  } catch (e) {
    // Fallback to agent result on any error to preserve behavior
    const result = await runOpsAgentToolCalling({
      taskBrief: String(instruction || '').trim(),
      where: where || {},
      transcript: Array.isArray(transcript) ? transcript : [],
      timezone,
      operationProcessor,
    });
    return {
      text: result.text,
      steps: result.steps,
      operations: result.operations,
      tools: result.tools,
      notes: result.notes,
      thinking: result.thinking,
    };
  }
}

// Export node helpers for unit testing
export function nodeBuildContext({ where = {}, timezone, correlationId } = {}) {
  const ctx = buildFocusedContext(where || {}, { timezone });
  try {
    logIO('graph_build_context', {
      model: 'graph',
      prompt: JSON.stringify({ where, timezone }),
      output: JSON.stringify({ counts: { tasks: ctx.tasks?.length || 0, events: ctx.events?.length || 0 }, truncated: !!(ctx.meta && ctx.meta.contextTruncated) }),
      meta: { correlationId }
    });
  } catch {}
  return { context: ctx };
}

export async function nodeBuildTools({ correlationId } = {}) {
  const registry = new OperationRegistry((await import('../database/DbService.js')).default);
  const tools = buildOperationTools(registry);
  try {
    logIO('graph_build_tools', {
      model: 'graph',
      prompt: JSON.stringify({}),
      output: JSON.stringify({ tools: Array.isArray(tools) ? tools.map(t => t.function?.name) : [] }),
      meta: { correlationId }
    });
  } catch {}
  return { tools };
}

// Propose node: for now, adapt the existing agent's output into a proposal shape
export async function nodeProposeLLM({ instruction = '', where = {}, transcript = [], timezone, operationProcessor, correlationId } = {}) {
  const agent = await runOpsAgentToolCalling({ taskBrief: String(instruction || '').trim(), where, transcript, timezone, operationProcessor });
  const proposal = {
    tool_calls: Array.isArray(agent.operations)
      ? agent.operations.map((op) => {
          const name = `${op.kind}.${op.action}`;
          const args = { ...op };
          delete args.kind; delete args.action;
          return { function: { name, arguments: args } };
        })
      : [],
    message: typeof agent.text === 'string' ? agent.text : ''
  };
  try {
    const parsed = parseToolResponseStrict(proposal);
    logIO('graph_propose', {
      model: 'graph',
      prompt: JSON.stringify({ instruction: String(instruction).slice(0, 200) }),
      output: JSON.stringify({ tool_calls: parsed.tool_calls?.length || 0, hasMessage: !!parsed.message }),
      meta: { correlationId }
    });
  } catch {}
  return { proposal };
}

// --- Remaining node shells ---
function toolCallToOperation(call) {
  const name = call?.function?.name || call?.name || '';
  const argsRaw = call?.function?.arguments || call?.arguments || {};
  const [kind, action] = String(name).split('.').map(s => String(s || '').trim().toLowerCase());
  let args = argsRaw;
  if (typeof argsRaw === 'string') {
    try { args = JSON.parse(argsRaw); } catch { args = {}; }
  }
  return { kind, action, ...(args || {}) };
}

function buildOpKey(op) {
  try {
    return [
      op.kind || 'task',
      op.action || 'create',
      op.id || '',
      op.scheduledFor || '',
      op.startTime || '',
      op.title || '',
      op.status || '',
      op.occurrenceDate || ''
    ].join('|');
  } catch { return ''; }
}

export async function nodeValidateOps({ proposal, operationProcessor, correlationId } = {}) {
  const calls = Array.isArray(proposal?.tool_calls) ? proposal.tool_calls : [];
  const operations = calls.map(toolCallToOperation);
  const validOps = [];
  const invalid = [];
  for (const op of operations) {
    try {
      const type = operationProcessor?.inferOperationType ? operationProcessor.inferOperationType(op) : null;
      const validator = type ? operationProcessor.validators.get(type) : null;
      const v = validator ? await validator(op) : { valid: false, errors: ['unknown_operation_type'] };
      if (v.valid) validOps.push(op); else invalid.push({ op, errors: v.errors || [] });
    } catch (e) {
      invalid.push({ op, errors: [String(e && e.message ? e.message : e)] });
    }
  }
  try {
    logIO('graph_validate', {
      model: 'graph',
      prompt: JSON.stringify({ operations: operations.length }),
      output: JSON.stringify({ valid: validOps.length, invalid: invalid.length }),
      meta: { correlationId }
    });
  } catch {}
  return { validation: { validOps, invalid } };
}

export function nodeDedupe({ validation, correlationId } = {}) {
  const ops = Array.isArray(validation?.validOps) ? validation.validOps : [];
  const seen = new Set();
  const deduped = [];
  for (const op of ops) {
    const key = buildOpKey(op);
    if (!seen.has(key)) { seen.add(key); deduped.push(op); }
  }
  try {
    logIO('graph_dedupe', {
      model: 'graph',
      prompt: JSON.stringify({ in: ops.length }),
      output: JSON.stringify({ out: deduped.length }),
      meta: { correlationId }
    });
  } catch {}
  return { deduped };
}

export function nodeSummarize({ deduped = [], validation = { invalid: [] }, proposal = { message: '' }, correlationId } = {}) {
  const ops = Array.isArray(deduped) ? deduped : [];
  let created = 0, updated = 0, deleted = 0, completed = 0;
  for (const op of ops) {
    if (op.action === 'create') created++;
    else if (op.action === 'update') updated++;
    else if (op.action === 'delete') deleted++;
    else if (op.action === 'complete' || op.action === 'set_status') completed++;
  }
  const parts = [];
  if (created) parts.push(`creating ${created}`);
  if (updated) parts.push(`updating ${updated}`);
  if (deleted) parts.push(`deleting ${deleted}`);
  if (completed) parts.push(`completing ${completed}`);
  let summary = parts.length ? `${parts.join(', ')}.` : (proposal?.message || 'No actionable changes detected.');
  const invalidCount = Array.isArray(validation?.invalid) ? validation.invalid.length : 0;
  if (!ops.length && invalidCount) summary = 'Some suggestions were invalid. Please specify IDs or details.';
  try {
    logIO('graph_summarize', {
      model: 'graph',
      prompt: JSON.stringify({}),
      output: JSON.stringify({ summary: String(summary).slice(0, 120) }),
      meta: { correlationId }
    });
  } catch {}
  return { summary };
}

export function nodeClarify({ validation = { invalid: [] }, correlationId } = {}) {
  const invalids = Array.isArray(validation?.invalid) ? validation.invalid : [];
  const needed = invalids.length > 0 && !invalids.some(x => Array.isArray(x.errors) && x.errors.length === 0);
  let question = null;
  if (needed) {
    const idMissing = invalids.some(x => Array.isArray(x.errors) && x.errors.includes('Valid ID is required'));
    if (idMissing) question = 'Which task or event do you mean? Provide the exact title or ID.';
    else question = 'Could you clarify which item and fields to change?';
  }
  try {
    logIO('graph_clarify', {
      model: 'graph',
      prompt: JSON.stringify({ invalid: invalids.length }),
      output: JSON.stringify({ needed, question }),
      meta: { correlationId }
    });
  } catch {}
  return { clarify: { needed, question } };
}

export function resumeRun({ correlationId, onStage } = {}) {
  try {
    const dir = process.env.ASSISTANT_CHECKPOINT_DIR || path.join(process.cwd(), 'data', 'assistant_state');
    const file = path.join(dir, `${String(correlationId || 'run')}.jsonl`);
    let stages = 0;
    const data = fs.readFileSync(file, 'utf8');
    const lines = String(data || '').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const stage = entry && entry.stage;
        if (stage) {
          stages += 1;
          try { if (typeof onStage === 'function') onStage(stage, { correlationId }); } catch {}
        }
      } catch {}
    }
    return { ok: true, stages };
  } catch {
    return { ok: false, stages: 0 };
  }
}

export { pruneCheckpoints };


