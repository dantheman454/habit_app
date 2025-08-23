import { Router } from 'express';
import Ajv from 'ajv';
import db from '../database/DbService.js';
import { parseYMD } from '../utils/date.js';
import { isYmdString, isValidTimeOfDay, isValidRecurrence } from '../utils/recurrence.js';

const router = Router();
const ajv = new Ajv({ allErrors: true });

const habitCreateSchema = {
  type: 'object',
  properties: {
    title: { type: 'string', minLength: 1 },
    notes: { type: 'string' },
    scheduledFor: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    timeOfDay: { anyOf: [ { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' }, { type: 'null' } ] },
    recurrence: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['daily','weekdays','weekly','every_n_days'] },
        intervalDays: { type: 'integer', minimum: 1 },
        until: { anyOf: [ { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, { type: 'null' } ] }
      },
      required: ['type']
    },
    context: { type: 'string', enum: ['school','personal','work'] }
  },
  required: ['title','recurrence','scheduledFor'],
  additionalProperties: true
};
const validateHabitCreate = ajv.compile(habitCreateSchema);

router.post('/api/habits', (req, res) => {
  const ok = validateHabitCreate(req.body || {});
  if (!ok) return res.status(400).json({ error: 'invalid_body' });
  const { title, notes, scheduledFor, timeOfDay, recurrence, context } = req.body || {};
  if (typeof title !== 'string' || title.trim() === '') return res.status(400).json({ error: 'invalid_title' });
  if (!(scheduledFor !== null && isYmdString(scheduledFor))) return res.status(400).json({ error: 'missing_anchor_for_recurrence' });
  if (!isValidTimeOfDay(timeOfDay === '' ? null : timeOfDay)) return res.status(400).json({ error: 'invalid_timeOfDay' });
  if (context !== undefined && !['school','personal','work'].includes(String(context))) return res.status(400).json({ error: 'invalid_context' });
  if (!(recurrence && typeof recurrence === 'object' && typeof recurrence.type === 'string')) return res.status(400).json({ error: 'missing_recurrence' });
  if (!isValidRecurrence(recurrence) || recurrence.type === 'none') return res.status(400).json({ error: 'invalid_recurrence' });
  try {
    const h = db.createHabit({ title: title.trim(), notes: notes || '', scheduledFor, timeOfDay: (timeOfDay === '' ? null : timeOfDay) ?? null, recurrence, completed: false, context: context || 'personal' });
    return res.json({ habit: h });
  } catch { return res.status(500).json({ error: 'create_failed' }); }
});

router.get('/api/habits', (req, res) => {
  const { from, to, completed, context } = req.query;
  if (from !== undefined && !isYmdString(from)) return res.status(400).json({ error: 'invalid_from' });
  if (to !== undefined && !isYmdString(to)) return res.status(400).json({ error: 'invalid_to' });
  let completedBool;
  if (completed !== undefined) {
    if (completed === 'true' || completed === true) completedBool = true;
    else if (completed === 'false' || completed === false) completedBool = false;
    else return res.status(400).json({ error: 'invalid_completed' });
  }
  if (context !== undefined && !['school','personal','work'].includes(String(context))) return res.status(400).json({ error: 'invalid_context' });
  const fromDate = from ? parseYMD(from) : null;
  const toDate = to ? parseYMD(to) : null;
  let items = db.listHabits({ from: null, to: null, context: context || null }).filter(h => h.scheduledFor !== null);
  if (fromDate || toDate) {
    items = items.filter(h => {
      if (!h.scheduledFor) return false;
      const hd = parseYMD(h.scheduledFor);
      if (!hd) return false;
      if (fromDate && hd < fromDate) return false;
      if (toDate) {
        const inclusiveEnd = new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate() + 1);
        if (hd >= inclusiveEnd) return false;
      }
      return true;
    });
  }
  if (completedBool !== undefined) items = items.filter(h => h.completed === completedBool);
  let fromY = fromDate ? `${fromDate.getFullYear()}-${String(fromDate.getMonth()+1).padStart(2,'0')}-${String(fromDate.getDate()).padStart(2,'0')}` : null;
  let toY = toDate ? `${toDate.getFullYear()}-${String(toDate.getMonth()+1).padStart(2,'0')}-${String(toDate.getDate()).padStart(2,'0')}` : null;
  const withStats = (fromY && toY) ? items.map(h => ({ ...h, ...db.computeHabitStats(h, { from: fromY, to: toY }) })) : items;
  const sorted = withStats.slice().sort((a, b) => {
    const sfa = String(a.scheduledFor || '');
    const sfb = String(b.scheduledFor || '');
    if (sfa !== sfb) return sfa.localeCompare(sfb);
    const at = a.timeOfDay || '';
    const bt = b.timeOfDay || '';
    if (at === '' && bt !== '') return -1;
    if (at !== '' && bt === '') return 1;
    if (at !== bt) return at.localeCompare(bt);
    return (a.id || 0) - (b.id || 0);
  });
  return res.json({ habits: sorted });
});

router.get('/api/habits/search', (req, res) => {
  const qRaw = String(req.query.query || '');
  const q = qRaw.trim();
  if (q.length === 0) return res.status(400).json({ error: 'invalid_query' });
  let completedBool;
  if (req.query.completed !== undefined) {
    if (req.query.completed === 'true' || req.query.completed === true) completedBool = true;
    else if (req.query.completed === 'false' || req.query.completed === false) completedBool = false;
    else return res.status(400).json({ error: 'invalid_completed' });
  }
  const context = (req.query.context === undefined) ? undefined : String(req.query.context);
  if (context !== undefined && !['school','personal','work'].includes(context)) return res.status(400).json({ error: 'invalid_context' });
  try {
    let items = db.searchHabits({ q, completed: completedBool, context });
    if (q.length < 2) {
      const ql = q.toLowerCase();
      items = items.filter(h => String(h.title || '').toLowerCase().includes(ql) || String(h.notes || '').toLowerCase().includes(ql));
    }
    return res.json({ habits: items });
  } catch (e) {
    return res.status(500).json({ error: 'search_failed' });
  }
});

router.get('/api/habits/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  const h = db.getHabitById(id);
  if (!h) return res.status(404).json({ error: 'not_found' });
  return res.json({ habit: h });
});

router.post('/api/habits/:id/items', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  const { todos = [], events = [] } = req.body || {};
  try {
    db.addHabitTodoItems(id, (Array.isArray(todos) ? todos : []).map(Number).filter(Number.isFinite));
    db.addHabitEventItems(id, (Array.isArray(events) ? events : []).map(Number).filter(Number.isFinite));
    return res.status(204).end();
  } catch { return res.status(500).json({ error: 'link_failed' }); }
});

router.delete('/api/habits/:id/items/todo/:todoId', (req, res) => {
  const hid = parseInt(req.params.id, 10);
  const tid = parseInt(req.params.todoId, 10);
  if (!Number.isFinite(hid) || !Number.isFinite(tid)) return res.status(400).json({ error: 'invalid_id' });
  try { db.removeHabitTodoItem(hid, tid); return res.status(204).end(); }
  catch { return res.status(500).json({ error: 'unlink_failed' }); }
});

router.delete('/api/habits/:id/items/event/:eventId', (req, res) => {
  const hid = parseInt(req.params.id, 10);
  const eid = parseInt(req.params.eventId, 10);
  if (!Number.isFinite(hid) || !Number.isFinite(eid)) return res.status(400).json({ error: 'invalid_id' });
  try { db.removeHabitEventItem(hid, eid); return res.status(204).end(); }
  catch { return res.status(500).json({ error: 'unlink_failed' }); }
});

router.patch('/api/habits/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  const { title, notes, scheduledFor, completed, timeOfDay, recurrence, context } = req.body || {};
  if (title !== undefined && typeof title !== 'string') return res.status(400).json({ error: 'invalid_title' });
  if (notes !== undefined && typeof notes !== 'string') return res.status(400).json({ error: 'invalid_notes' });
  if (!(scheduledFor === undefined || scheduledFor === null || isYmdString(scheduledFor))) return res.status(400).json({ error: 'invalid_scheduledFor' });
  if (completed !== undefined && typeof completed !== 'boolean') return res.status(400).json({ error: 'invalid_completed' });
  if (timeOfDay !== undefined && !isValidTimeOfDay(timeOfDay === '' ? null : timeOfDay)) return res.status(400).json({ error: 'invalid_timeOfDay' });
  if (context !== undefined && !['school','personal','work'].includes(String(context))) return res.status(400).json({ error: 'invalid_context' });
  if (recurrence !== undefined) {
    if (!isValidRecurrence(recurrence)) return res.status(400).json({ error: 'invalid_recurrence' });
    if (recurrence && recurrence.type === 'none') return res.status(400).json({ error: 'invalid_recurrence' });
    if (recurrence && recurrence.type && recurrence.type !== 'none') {
      const anchor = (scheduledFor !== undefined) ? scheduledFor : (db.getHabitById(id)?.scheduledFor ?? null);
      if (!(anchor !== null && isYmdString(anchor))) return res.status(400).json({ error: 'missing_anchor_for_recurrence' });
    }
  }
  try {
    const h = db.updateHabit(id, { title, notes, scheduledFor, timeOfDay, completed, recurrence, context });
    return res.json({ habit: h });
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (msg === 'not_found') return res.status(404).json({ error: 'not_found' });
    return res.status(500).json({ error: 'update_failed' });
  }
});

router.patch('/api/habits/:id/occurrence', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { occurrenceDate, completed } = req.body || {};
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  if (!isYmdString(occurrenceDate)) return res.status(400).json({ error: 'invalid_occurrenceDate' });
  if (completed !== undefined && typeof completed !== 'boolean') return res.status(400).json({ error: 'invalid_completed' });
  try {
    const updated = db.toggleHabitOccurrence({ id, occurrenceDate, completed: !!completed });
    return res.json({ habit: updated });
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (msg === 'not_repeating') return res.status(400).json({ error: 'not_repeating' });
    if (msg === 'not_found') return res.status(404).json({ error: 'not_found' });
    return res.status(500).json({ error: 'occurrence_failed' });
  }
});

export default router;


