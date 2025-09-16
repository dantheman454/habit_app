import { Router } from 'express';
import Ajv from 'ajv';
import db from '../database/DbService.js';
import { isYmdString, isValidRecurrence } from '../utils/recurrence.js';
import { parseYMD } from '../utils/date.js';

const router = Router();
const ajv = new Ajv({ allErrors: true });

const habitCreateSchema = {
  type: 'object',
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 255 },
    notes: { type: 'string' },
    startedOn: { anyOf: [ { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, { type: 'null' } ] },
    recurrence: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['none','daily','weekdays','weekly','every_n_days'] },
        intervalDays: { type: 'integer', minimum: 1 },
        until: { anyOf: [ { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, { type: 'null' } ] }
      },
      required: ['type']
    },
    weeklyTargetCount: { anyOf: [ { type: 'integer', minimum: 1 }, { type: 'null' } ] },
    context: { type: 'string', enum: ['school','personal','work'] }
  },
  required: ['title'],
  additionalProperties: true
};
const validateHabitCreate = ajv.compile(habitCreateSchema);

router.get('/api/habits', (req, res) => {
  const { context } = req.query || {};
  if (context !== undefined && !['school','personal','work'].includes(String(context))) {
    return res.status(400).json({ error: 'invalid_context' });
  }
  try {
    const habits = db.listHabits({ context: context || null });
    return res.json({ habits });
  } catch {
    return res.status(500).json({ error: 'db_error' });
  }
});

router.get('/api/habits/search', (req, res) => {
  const qRaw = String(req.query.query || '');
  const q = qRaw.trim();
  if (q.length === 0) return res.status(400).json({ error: 'invalid_query' });
  const context = (req.query.context === undefined) ? undefined : String(req.query.context);
  if (context !== undefined && !['school','personal','work'].includes(context)) return res.status(400).json({ error: 'invalid_context' });
  try {
    let items = db.searchHabits({ q, context });
    if (q.length < 2) {
      const ql = q.toLowerCase();
      items = items.filter(h => String(h.title || '').toLowerCase().includes(ql) || String(h.notes || '').toLowerCase().includes(ql));
    }
    return res.json({ habits: items });
  } catch {
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

router.post('/api/habits', (req, res) => {
  const ok = validateHabitCreate(req.body || {});
  if (!ok) return res.status(400).json({ error: 'invalid_body' });
  const { title, notes, startedOn, recurrence, weeklyTargetCount, context } = req.body || {};
  if (typeof title !== 'string' || title.trim() === '') return res.status(400).json({ error: 'invalid_title' });
  if (notes !== undefined && typeof notes !== 'string') return res.status(400).json({ error: 'invalid_notes' });
  if (startedOn !== undefined && startedOn !== null) {
    if (!isYmdString(startedOn) || parseYMD(startedOn) === null) return res.status(400).json({ error: 'invalid_startedOn' });
  }
  const rec = (recurrence && typeof recurrence === 'object') ? recurrence : { type: 'none' };
  if (!isValidRecurrence(rec)) return res.status(400).json({ error: 'invalid_recurrence' });
  if (rec.type && rec.type !== 'none') {
    if (!(startedOn && isYmdString(startedOn) && parseYMD(startedOn) !== null)) return res.status(400).json({ error: 'missing_anchor_for_recurrence' });
  }
  if (weeklyTargetCount !== undefined && !(weeklyTargetCount === null || (Number.isInteger(weeklyTargetCount) && weeklyTargetCount >= 1))) {
    return res.status(400).json({ error: 'invalid_weeklyTargetCount' });
  }
  if (context !== undefined && !['school','personal','work'].includes(String(context))) return res.status(400).json({ error: 'invalid_context' });
  try {
    const habit = db.createHabit({ title: title.trim(), notes: notes || '', startedOn: startedOn ?? null, recurrence: rec, weeklyTargetCount: weeklyTargetCount ?? null, context: context || 'personal' });
    return res.json({ habit });
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (msg === 'missing_anchor_for_recurrence') return res.status(400).json({ error: 'missing_anchor_for_recurrence' });
    return res.status(500).json({ error: 'create_failed' });
  }
});

router.patch('/api/habits/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  const h = db.getHabitById(id);
  if (!h) return res.status(404).json({ error: 'not_found' });
  const body = req.body || {};
  if (body.title !== undefined) {
    if (typeof body.title !== 'string' || body.title.trim() === '') return res.status(400).json({ error: 'invalid_title' });
    h.title = body.title.trim();
  }
  if (body.notes !== undefined) {
    if (typeof body.notes !== 'string') return res.status(400).json({ error: 'invalid_notes' });
    h.notes = body.notes;
  }
  if (body.startedOn !== undefined) {
    if (!(body.startedOn === null || (isYmdString(body.startedOn) && parseYMD(body.startedOn) !== null))) return res.status(400).json({ error: 'invalid_startedOn' });
    if (h.recurrence && h.recurrence.type && h.recurrence.type !== 'none') {
      if (!(body.startedOn !== null && isYmdString(body.startedOn) && parseYMD(body.startedOn) !== null)) return res.status(400).json({ error: 'missing_anchor_for_recurrence' });
    }
    h.startedOn = body.startedOn;
  }
  if (body.recurrence !== undefined) {
    if (!isValidRecurrence(body.recurrence)) return res.status(400).json({ error: 'invalid_recurrence' });
    if (body.recurrence && body.recurrence.type && body.recurrence.type !== 'none') {
      const anchor = (body.startedOn !== undefined) ? body.startedOn : h.startedOn;
      if (!(anchor !== null && isYmdString(anchor) && parseYMD(anchor) !== null)) return res.status(400).json({ error: 'missing_anchor_for_recurrence' });
    }
    h.recurrence = { ...(h.recurrence || {}), ...body.recurrence };
  }
  if (body.weeklyTargetCount !== undefined) {
    if (!(body.weeklyTargetCount === null || (Number.isInteger(body.weeklyTargetCount) && body.weeklyTargetCount >= 1))) return res.status(400).json({ error: 'invalid_weeklyTargetCount' });
    h.weeklyTargetCount = body.weeklyTargetCount;
  }
  if (body.context !== undefined) {
    if (!['school','personal','work'].includes(String(body.context))) return res.status(400).json({ error: 'invalid_context' });
    h.context = String(body.context);
  }
  try {
    const updated = db.updateHabit(id, h);
    return res.json({ habit: updated });
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (msg === 'not_found') return res.status(404).json({ error: 'not_found' });
    if (msg === 'missing_anchor_for_recurrence') return res.status(400).json({ error: 'missing_anchor_for_recurrence' });
    return res.status(500).json({ error: 'update_failed' });
  }
});

router.delete('/api/habits/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  try { db.deleteHabit(id); return res.json({ ok: true }); }
  catch { return res.status(500).json({ error: 'delete_failed' }); }
});

// Logs
router.get('/api/habits/:id/logs', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  const from = (req.query.from === undefined) ? undefined : String(req.query.from);
  const to = (req.query.to === undefined) ? undefined : String(req.query.to);
  if (from !== undefined && !isYmdString(from)) return res.status(400).json({ error: 'invalid_from' });
  if (to !== undefined && !isYmdString(to)) return res.status(400).json({ error: 'invalid_to' });
  const h = db.getHabitById(id);
  if (!h) return res.status(404).json({ error: 'not_found' });
  try {
    const logs = db.listHabitLogs({ habitId: id, from: from || null, to: to || null });
    return res.json({ logs });
  } catch {
    return res.status(500).json({ error: 'db_error' });
  }
});

router.put('/api/habits/:id/logs/:date', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  const date = String(req.params.date || '');
  if (!isYmdString(date) || parseYMD(date) === null) return res.status(400).json({ error: 'invalid_date' });
  const done = (typeof req.body?.done === 'boolean') ? req.body.done : true;
  const note = (req.body?.note === undefined) ? null : (req.body.note === null ? null : String(req.body.note));
  const h = db.getHabitById(id);
  if (!h) return res.status(404).json({ error: 'not_found' });
  try {
    const log = db.upsertHabitLog({ habitId: id, date, done, note });
    return res.json({ log });
  } catch {
    return res.status(500).json({ error: 'update_failed' });
  }
});

router.delete('/api/habits/:id/logs/:date', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  const date = String(req.params.date || '');
  if (!isYmdString(date) || parseYMD(date) === null) return res.status(400).json({ error: 'invalid_date' });
  const h = db.getHabitById(id);
  if (!h) return res.status(404).json({ error: 'not_found' });
  try { db.deleteHabitLog({ habitId: id, date }); return res.json({ ok: true }); }
  catch { return res.status(500).json({ error: 'delete_failed' }); }
});

export default router;


