import { Router } from 'express';
import Ajv from 'ajv';
import db from '../database/DbService.js';
import { ymd, parseYMD, ymdInTimeZone } from '../utils/date.js';
import { isYmdString, isValidRecurrence, expandOccurrences } from '../utils/recurrence.js';

const router = Router();
const ajv = new Ajv({ allErrors: true });

const taskCreateSchema = {
  type: 'object',
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 255 },
    notes: { type: 'string' },
    scheduledFor: { anyOf: [ { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, { type: 'null' } ] },
    recurrence: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['none','daily','weekdays','weekly','every_n_days'] },
        intervalDays: { type: 'integer', minimum: 1 },
        until: { anyOf: [ { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, { type: 'null' } ] }
      },
      required: ['type']
    },
    context: { type: 'string', enum: ['school','personal','work'] }
  },
  required: ['title','recurrence'],
  additionalProperties: true
};
const validateTaskCreate = ajv.compile(taskCreateSchema);

function createTaskDb({ title, notes = '', scheduledFor = null, recurrence = undefined, context = 'personal' }) {
  return db.createTask({ title, notes, scheduledFor, recurrence: recurrence || { type: 'none' }, status: 'pending', context });
}

function findTaskById(id) { return db.getTaskById(parseInt(id, 10)); }

const TIMEZONE = process.env.TZ_NAME || 'America/New_York';

router.post('/api/tasks', (req, res) => {
  const ok = validateTaskCreate(req.body || {});
  if (!ok) return res.status(400).json({ error: 'invalid_body' });
  const { title, notes, scheduledFor, recurrence, context } = req.body || {};
  if (typeof title !== 'string' || title.trim() === '') {
    return res.status(400).json({ error: 'invalid_title' });
  }
  if (!(recurrence && typeof recurrence === 'object' && typeof recurrence.type === 'string')) {
    return res.status(400).json({ error: 'missing_recurrence' });
  }
  if (notes !== undefined && typeof notes !== 'string') {
    return res.status(400).json({ error: 'invalid_notes' });
  }
  if (scheduledFor !== undefined && scheduledFor !== null) {
    if (!isYmdString(scheduledFor) || parseYMD(scheduledFor) === null) {
      return res.status(400).json({ error: 'invalid_scheduledFor' });
    }
  }
  // tasks are all-day; no time-of-day validation
  if (!isValidRecurrence(recurrence)) {
    return res.status(400).json({ error: 'invalid_recurrence' });
  }
  if (recurrence && recurrence.type && recurrence.type !== 'none') {
    if (!(scheduledFor !== null && isYmdString(scheduledFor) && parseYMD(scheduledFor) !== null)) {
      return res.status(400).json({ error: 'missing_anchor_for_recurrence' });
    }
  }
  if (context !== undefined && !['school','personal','work'].includes(String(context))) {
    return res.status(400).json({ error: 'invalid_context' });
  }

  const task = createTaskDb({ title: title.trim(), notes: notes || '', scheduledFor: scheduledFor ?? null, recurrence: recurrence, context: context || 'personal' });
  res.json({ task });
});

router.get('/api/tasks', (req, res) => {
  const { from, to, completed, status, context } = req.query;
  if (from !== undefined && !isYmdString(from)) return res.status(400).json({ error: 'invalid_from' });
  if (to !== undefined && !isYmdString(to)) return res.status(400).json({ error: 'invalid_to' });
  let completedBool;
  if (completed !== undefined) {
    if (completed === 'true' || completed === true) completedBool = true;
    else if (completed === 'false' || completed === false) completedBool = false;
    else return res.status(400).json({ error: 'invalid_completed' });
  }
  if (status !== undefined && !['pending','completed','skipped'].includes(String(status))) return res.status(400).json({ error: 'invalid_status' });
  if (context !== undefined && !['school','personal','work'].includes(String(context))) return res.status(400).json({ error: 'invalid_context' });

  const fromDate = from ? parseYMD(from) : null;
  const toDate = to ? parseYMD(to) : null;
  if (from !== undefined && fromDate === null) return res.status(400).json({ error: 'invalid_from' });
  if (to !== undefined && toDate === null) return res.status(400).json({ error: 'invalid_to' });

  let items = db.listTasks({ from: null, to: null, status: status || null }).filter(t => t.scheduledFor !== null);
  if (completedBool !== undefined) items = items.filter(t => t.completed === completedBool);
  if (context !== undefined) items = items.filter(t => String(t.context) === String(context));

  const doExpand = !!(fromDate && toDate);
  if (!doExpand) {
    if (fromDate || toDate) {
      items = items.filter(t => {
        if (!t.scheduledFor) return false;
        const td = parseYMD(t.scheduledFor);
        if (!td) return false;
        if (fromDate && td < fromDate) return false;
        if (toDate) {
          const inclusiveEnd = new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate() + 1);
          if (td >= inclusiveEnd) return false;
        }
        return true;
      });
    }
    return res.json({ tasks: items });
  }

  const expanded = [];
  for (const t of items) {
    const isRepeating = (t.recurrence && t.recurrence.type && t.recurrence.type !== 'none');
    if (!isRepeating) {
      const td = t.scheduledFor ? parseYMD(t.scheduledFor) : null;
      if (td && (!fromDate || td >= fromDate) && (!toDate || td < new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate() + 1))) {
        expanded.push(t);
      }
    } else {
      const occs = expandOccurrences(t, fromDate, toDate, { ymd, parseYMD });
      for (const occ of occs) {
        expanded.push({ ...t, scheduledFor: occ.scheduledFor, masterId: t.id });
      }
    }
  }
  if (completedBool !== undefined || status !== undefined || context !== undefined) {
    const filtered = expanded.filter(x => (
      (completedBool === undefined || (typeof x.completed === 'boolean' && x.completed === completedBool)) &&
      (status === undefined || (typeof x.status === 'string' && x.status === status)) &&
      (context === undefined || (typeof x.context === 'string' && x.context === context))
    ));
    return res.json({ tasks: filtered });
  }
  res.json({ tasks: expanded });
});

router.get('/api/tasks/search', (req, res) => {
  const qRaw = String(req.query.query || '');
  const q = qRaw.trim();
  if (q.length === 0) return res.status(400).json({ error: 'invalid_query' });
  const status = (req.query.status === undefined) ? undefined : String(req.query.status);
  if (status !== undefined && !['pending','completed','skipped'].includes(status)) return res.status(400).json({ error: 'invalid_status' });
  const context = (req.query.context === undefined) ? undefined : String(req.query.context);
  if (context !== undefined && !['school','personal','work'].includes(context)) return res.status(400).json({ error: 'invalid_context' });
  try {
    let items = db.searchTasks({ q, status, context });
    if (q.length < 2) {
      const ql = q.toLowerCase();
      items = items.filter(t => String(t.title || '').toLowerCase().includes(ql) || String(t.notes || '').toLowerCase().includes(ql));
    }
    const todayY = ymdInTimeZone(new Date(), TIMEZONE);
    const score = (t) => {
      let s = 0;
      const overdue = ((t.status !== 'completed' && t.status !== 'skipped') && t.scheduledFor && String(t.scheduledFor) < String(todayY));
      if (overdue) s += 0.5;
      return s;
    };
    items = items.map(t => ({ t, s: score(t) }))
      .sort((a, b) => b.s - a.s || String(a.t.scheduledFor || '').localeCompare(String(b.t.scheduledFor || '')) || (a.t.id - b.t.id))
      .map(x => x.t);
    return res.json({ tasks: items });
  } catch {
    return res.status(500).json({ error: 'search_failed' });
  }
});

router.get('/api/tasks/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  const t = findTaskById(id);
  if (!t) return res.status(404).json({ error: 'not_found' });
  res.json({ task: t });
});

router.patch('/api/tasks/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  const t = findTaskById(id);
  if (!t) return res.status(404).json({ error: 'not_found' });
  const body = req.body || {};
  if (body.title !== undefined) {
    if (typeof body.title !== 'string' || body.title.trim() === '') return res.status(400).json({ error: 'invalid_title' });
    t.title = body.title.trim();
  }
  if (body.notes !== undefined) {
    if (typeof body.notes !== 'string') return res.status(400).json({ error: 'invalid_notes' });
    t.notes = body.notes;
  }
  if (body.scheduledFor !== undefined) {
    if (!(body.scheduledFor === null || (isYmdString(body.scheduledFor) && parseYMD(body.scheduledFor) !== null))) return res.status(400).json({ error: 'invalid_scheduledFor' });
    if (t.recurrence && t.recurrence.type && t.recurrence.type !== 'none') {
      if (!(body.scheduledFor !== null && isYmdString(body.scheduledFor) && parseYMD(body.scheduledFor) !== null)) return res.status(400).json({ error: 'missing_anchor_for_recurrence' });
    }
    t.scheduledFor = body.scheduledFor;
  }
  // tasks are all-day; ignore any time-related fields in patch
  if (body.recurrence !== undefined) {
    if (!isValidRecurrence(body.recurrence)) return res.status(400).json({ error: 'invalid_recurrence' });
    if (body.recurrence && body.recurrence.type && body.recurrence.type !== 'none') {
      const anchor = (body.scheduledFor !== undefined) ? body.scheduledFor : t.scheduledFor;
      if (!(anchor !== null && isYmdString(anchor) && parseYMD(anchor) !== null)) return res.status(400).json({ error: 'missing_anchor_for_recurrence' });
    }
    t.recurrence = { ...(t.recurrence || {}), ...body.recurrence };
  }
  if (body.status !== undefined) {
    if (!['pending','completed','skipped'].includes(String(body.status))) return res.status(400).json({ error: 'invalid_status' });
    t.status = String(body.status);
  }
  if (body.context !== undefined) {
    if (!['school','personal','work'].includes(String(body.context))) return res.status(400).json({ error: 'invalid_context' });
    t.context = String(body.context);
  }
  try { const updated = db.updateTask(id, t); res.json({ task: updated }); } catch { res.json({ task: t }); }
});

router.patch('/api/tasks/:id/occurrence', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  const occurrenceDate = String(req.body?.occurrenceDate || '');
  if (!isYmdString(occurrenceDate) || parseYMD(occurrenceDate) === null) {
    return res.status(400).json({ error: 'invalid_occurrenceDate' });
  }
  const task = findTaskById(id);
  if (!task) return res.status(404).json({ error: 'not_found' });
  let status = req.body?.status;
  if (status === undefined) {
    if (typeof req.body?.completed === 'boolean') {
      status = req.body.completed ? 'completed' : 'pending';
    }
  }
  status = String(status || '');
  if (!['pending','completed','skipped'].includes(status)) return res.status(400).json({ error: 'invalid_status' });
  try {
    const updated = db.setTaskOccurrenceStatus({ id, occurrenceDate, status });
    return res.json({ task: updated });
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (msg === 'not_repeating') return res.status(400).json({ error: 'not_repeating' });
    return res.status(500).json({ error: 'update_failed' });
  }
});

router.delete('/api/tasks/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  db.deleteTask(id);
  res.json({ ok: true });
});

export default router;


