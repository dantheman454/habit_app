import { runProposal } from './proposal.js';
import { runRepair } from './repair.js';
import { buildFocusedContext } from './context.js';
import { extractFirstJson } from './json_extract.js';
import { mkCorrelationId } from './logging.js';
import db from '../database/DbService.js';

// Lightweight validation helpers (kept minimal to avoid cycles with server.js)
function isYmdString(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}
function isValidTimeOfDay(value) {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'string') return false;
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}
function isValidRecurrence(rec) {
  if (rec === null || rec === undefined) return true;
  if (typeof rec !== 'object') return false;
  const allowed = ['none','daily','weekdays','weekly','every_n_days'];
  const type = rec.type;
  if (!allowed.includes(String(type))) return false;
  if (type === 'every_n_days') {
    const n = rec.intervalDays;
    if (!Number.isInteger(n) || n < 1) return false;
  }
  if (!(rec.until === null || rec.until === undefined || isYmdString(rec.until))) return false;
  return true;
}

function inferOperationShape(o) {
  if (!o || typeof o !== 'object') return null;
  const op = { ...o };
  if (op.scheduledFor === '') op.scheduledFor = null;
  return op;
}

function validateOperation(op) {
  const errors = [];
  if (!op || typeof op !== 'object') return ['invalid_operation_object'];
  const kindV3 = op.kind && String(op.kind).toLowerCase();
  const actionV3 = op.action && String(op.action).toLowerCase();
  const inferred = inferOperationShape(op);
  const opType = inferred?.op || actionV3 || null;
  if (op.scheduledFor !== undefined && !(op.scheduledFor === null || isYmdString(op.scheduledFor))) errors.push('invalid_scheduledFor');
  if (op.timeOfDay !== undefined && !isValidTimeOfDay(op.timeOfDay === '' ? null : op.timeOfDay)) errors.push('invalid_timeOfDay');
  if (op.recurrence !== undefined && !isValidRecurrence(op.recurrence)) errors.push('invalid_recurrence');
  if ((actionV3 === 'create' || actionV3 === 'update') && !(op.recurrence && typeof op.recurrence === 'object' && 'type' in op.recurrence)) errors.push('missing_recurrence');
  if (kindV3 === 'habit' && op.recurrence && op.recurrence.type === 'none') errors.push('invalid_recurrence');
  if ((actionV3 === 'update' || actionV3 === 'delete' || actionV3 === 'complete' || actionV3 === 'complete_occurrence' || actionV3 === 'set_status') && !Number.isFinite(op.id)) errors.push('missing_or_invalid_id');
  if (actionV3 === 'complete_occurrence') {
    if (!isYmdString(op.occurrenceDate)) errors.push('invalid_occurrenceDate');
    if (op.completed !== undefined && typeof op.completed !== 'boolean') errors.push('invalid_completed');
  }
  if ((actionV3 === 'create' || actionV3 === 'update') && op.recurrence && op.recurrence.type && op.recurrence.type !== 'none') {
    const anchor = op.scheduledFor;
    if (!(anchor && isYmdString(anchor))) errors.push('missing_anchor_for_recurrence');
  }
  
  // Additional validation for time-related updates
  if (actionV3 === 'update' && kindV3 === 'todo') {
    // If this is a time-related update (has scheduledFor but no timeOfDay), suggest adding timeOfDay
    if (op.scheduledFor && op.timeOfDay === undefined) {
      // This is not an error, but we could add a warning or suggestion
      // For now, we'll let the repair system handle this
    }
  }
  
  return errors;
}

function validateProposal(ops) {
  const shaped = (Array.isArray(ops) ? ops.map(inferOperationShape).filter(Boolean) : []);
  const results = shaped.map((o, i) => ({ index: i, op: o, errors: validateOperation(o) }));
  const invalid = results.filter(r => r.errors.length > 0);
  return { operations: shaped, results, errors: invalid.length ? ['invalid_operations'] : [] };
}

export async function runOpsAgent({ taskBrief, where = {}, transcript = [], timezone } = {}) {
  const focusedContext = buildFocusedContext(where, { timezone });
  const correlationId = mkCorrelationId();
  try { 
    db.logAudit({ 
      action: 'ops_agent.input', 
      payload: { 
        taskBrief: String(taskBrief || '').slice(0, 1000), 
        where, 
        transcript: transcript.slice(-3),
        contextSize: Object.keys(focusedContext).length
      },
      meta: { correlationId }
    }); 
  } catch {}

  // 1) Propose
  const proposalRaw = await runProposal({ instruction: taskBrief, transcript, focusedWhere: where });
  // runProposal now returns { version, steps, operations, tools, notes } by contract
  let proposedOps = Array.isArray(proposalRaw && proposalRaw.operations) ? proposalRaw.operations : [];
  let proposedSteps = Array.isArray(proposalRaw && proposalRaw.steps) ? proposalRaw.steps : [];
  let proposedTools = Array.isArray(proposalRaw && proposalRaw.tools) ? proposalRaw.tools : [];

  // If raw might be text (LLM body), try extracting JSON
  if (!proposedOps.length && typeof proposalRaw === 'string') {
    const parsed = extractFirstJson(proposalRaw);
    if (parsed && Array.isArray(parsed.operations)) proposedOps = parsed.operations;
    if (parsed && Array.isArray(parsed.steps)) proposedSteps = parsed.steps;
    if (parsed && Array.isArray(parsed.tools)) proposedTools = parsed.tools;
  }

  // Normalize shapes and limit to 20 ops
  proposedOps = proposedOps.map(inferOperationShape).filter(Boolean).slice(0, 20);

  // 2) Validate
  let validation = validateProposal(proposedOps);

  let repairedCount = 0;
  if (validation.errors.length) {
    // Run repair once
    try {
      const repairRaw = await runRepair({ errors: validation.results.filter(r => r.errors.length), original: proposedOps, focusedContext });
      let repaired = Array.isArray(repairRaw && repairRaw.operations) ? repairRaw.operations : [];
      if (!repaired.length && typeof repairRaw === 'string') {
        const parsed = extractFirstJson(repairRaw);
        if (parsed && Array.isArray(parsed.operations)) repaired = parsed.operations;
      }
      repaired = repaired.map(inferOperationShape).filter(Boolean);
      // Re-validate repaired ops
      const reval = validateProposal(repaired);
      const validRepaired = reval.results.filter(r => r.errors.length === 0).map(r => r.op);
      repairedCount = validRepaired.length;
      // Keep valid repaired ops; append them to any originally-valid ops
      const originallyValid = validation.results.filter(r => r.errors.length === 0).map(r => r.op);
      proposedOps = [...originallyValid, ...validRepaired].slice(0, 20); // Limit to 20 ops
      validation = validateProposal(proposedOps);
    } catch (e) {
      // falling back to original validation
      console.error('Repair failed:', e);
    }
  }

  // 3) Build tools[] mirror (use proposed tools if available, otherwise generate from ops)
  const tools = proposedTools.length > 0 ? proposedTools : proposedOps.map((op) => {
    const name = `${String(op.kind || 'unknown')}.${String(op.action || 'unknown')}`;
    const args = { ...op };
    return { name, args };
  });

  const out = {
    version: '3',
    steps: proposedSteps.length > 0 ? proposedSteps : [ { name: 'Identify targets' }, { name: 'Plan operations' } ],
    operations: proposedOps,
    tools,
    notes: { 
      repairedCount, 
      invalidCount: validation.results.filter(r => r.errors.length > 0).length,
      errors: validation.results.filter(r => r.errors.length > 0).map(r => r.errors.join(', '))
    }
  };

  try { 
    db.logAudit({ 
      action: 'ops_agent.output', 
      payload: { 
        stepsCount: out.steps.length, 
        operationsCount: out.operations.length, 
        invalidCount: out.notes.invalidCount,
        repairedCount: out.notes.repairedCount
      },
      meta: { correlationId }
    }); 
  } catch {}
  return out;
}
