import { Router } from 'express';
import Ajv from 'ajv';
import db from '../database/DbService.js';
import { ymd, parseYMD, ymdInTimeZone } from '../utils/date.js';
import { isYmdString, matchesRule } from '../utils/recurrence.js';

const router = Router();
const ajv = new Ajv({ allErrors: true });
const TIMEZONE = process.env.TZ_NAME || 'America/New_York';

const eventCreateSchema = {
  type: 'object',
  properties: {
    title: { type: 'string', minLength: 1 },
    notes: { type: 'string' },
    scheduledFor: { anyOf: [ { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, { type: 'null' } ] },
    startTime: { anyOf: [ { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' }, { type: 'null' } ] },
    endTime: { anyOf: [ { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' }, { type: 'null' } ] },
    location: { anyOf: [ { type: 'string' }, { type: 'null' } ] },
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
const validateEventCreate = ajv.compile(eventCreateSchema);

function expandEventOccurrences(event, fromDate, toDate) {
  const occurrences = [];
  const anchor = event.scheduledFor ? parseYMD(event.scheduledFor) : null;
  if (!anchor) return occurrences;
  const untilYmd = event.recurrence?.until ?? undefined;
  const untilDate = (untilYmd && isYmdString(untilYmd)) ? parseYMD(untilYmd) : null;
  const start = new Date(Math.max(fromDate.getTime(), anchor.getTime()));
  const inclusiveEnd = new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate() + 1);
  for (let d = new Date(start); d < inclusiveEnd; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    if (untilDate && d > untilDate) break;
    if (matchesRule(d, anchor, event.recurrence)) {
      const dateStr = ymd(d);
      const occCompleted = Array.isArray(event.completedDates) && event.completedDates.includes(dateStr);
      occurrences.push({
        id: event.id,
        masterId: event.id,
        title: event.title,
        notes: event.notes,
        scheduledFor: dateStr,
        startTime: event.startTime ?? null,
        endTime: event.endTime ?? null,
        location: event.location ?? null,
        completed: !!occCompleted,
        recurrence: event.recurrence,
        context: event.context,
        createdAt: event.createdAt,
        updatedAt: event.updatedAt,
      });
    }
  }
  return occurrences;
}

router.post('/api/events', (req, res) => {
  const ok = validateEventCreate(req.body || {});
  if (!ok) return res.status(400).json({ error: 'invalid_body' });
  const { title, notes, scheduledFor, startTime, endTime, location, recurrence, context } = req.body || {};
  if (typeof title !== 'string' || title.trim() === '') return res.status(400).json({ error: 'invalid_title' });
  if (startTime !== undefined && !(startTime === null || /^([01]\d|2[0-3]):[0-5]\d$/.test(String(startTime)))) return res.status(400).json({ error: 'invalid_start_time' });
  if (endTime !== undefined && !(endTime === null || /^([01]\d|2[0-3]):[0-5]\d$/.test(String(endTime)))) return res.status(400).json({ error: 'invalid_end_time' });
  if (startTime && endTime && String(endTime) < String(startTime)) return res.status(400).json({ error: 'invalid_time_range' });
  if (context !== undefined && !['school','personal','work'].includes(String(context))) return res.status(400).json({ error: 'invalid_context' });
  const rec = (recurrence && typeof recurrence === 'object') ? recurrence : { type: 'none' };
  if (rec.type && rec.type !== 'none') {
    if (!(scheduledFor && isYmdString(scheduledFor))) return res.status(400).json({ error: 'missing_anchor_for_recurrence' });
  }
  try {
    const ev = db.createEvent({ title: title.trim(), notes: notes || '', scheduledFor: scheduledFor ?? null, startTime: startTime ?? null, endTime: endTime ?? null, location: location ?? null, recurrence: rec, completed: false, context: context || 'personal' });
    return res.json({ event: ev });
  } catch (e) { return res.status(500).json({ error: 'create_failed' }); }
});

router.get('/api/events', (req, res) => {
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
  try {
    const fromDate = from ? parseYMD(from) : null;
    const toDate = to ? parseYMD(to) : null;
    let items = db.listEvents({ from: null, to: null, completed: null }).filter(e => e.scheduledFor !== null);
    const doExpand = !!(fromDate && toDate);
    if (!doExpand) {
      if (fromDate || toDate) {
        items = items.filter(e => {
          if (!e.scheduledFor) return false;
          const ed = parseYMD(e.scheduledFor);
          if (!ed) return false;
          if (fromDate && ed < fromDate) return false;
          if (toDate) {
            const inclusiveEnd = new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate() + 1);
            if (ed >= inclusiveEnd) return false;
          }
          return true;
        });
      }
      if (completedBool !== undefined) items = items.filter(e => e.completed === completedBool);
      if (context !== undefined) items = items.filter(e => String(e.context) === String(context));
      const sorted = items.slice().sort((a, b) => {
        const sfa = String(a.scheduledFor || '');
        const sfb = String(b.scheduledFor || '');
        if (sfa !== sfb) return sfa.localeCompare(sfb);
        const at = a.startTime || '';
        const bt = b.startTime || '';
        if (at === '' && bt !== '') return -1;
        if (at !== '' && bt === '') return 1;
        if (at !== bt) return at.localeCompare(bt);
        return (a.id || 0) - (b.id || 0);
      });
      return res.json({ events: sorted });
    }

    const expanded = [];
    for (const e of items) {
      const isRepeating = (e.recurrence && e.recurrence.type && e.recurrence.type !== 'none');
      if (!isRepeating) {
        const ed = e.scheduledFor ? parseYMD(e.scheduledFor) : null;
        if (ed && (!fromDate || ed >= fromDate) && (!toDate || ed < new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate() + 1))) {
          expanded.push(e);
        }
      } else {
        expanded.push(...expandEventOccurrences(e, fromDate, toDate));
      }
    }
    let out = expanded;
    if (completedBool !== undefined || context !== undefined) {
      out = expanded.filter(x => x &&
        (completedBool === undefined || (typeof x.completed === 'boolean' && x.completed === completedBool)) &&
        (context === undefined || (typeof x.context === 'string' && x.context === context))
      );
    }
    out = out.slice().sort((a, b) => {
      const sfa = String(a.scheduledFor || '');
      const sfb = String(b.scheduledFor || '');
      if (sfa !== sfb) return sfa.localeCompare(sfb);
      const at = a.startTime || '';
      const bt = b.startTime || '';
      if (at === '' && bt !== '') return -1;
      if (at !== '' && bt === '') return 1;
      if (at !== bt) return at.localeCompare(bt);
      return (a.id || 0) - (b.id || 0);
    });
    return res.json({ events: out });
  } catch (e) { return res.status(500).json({ error: 'db_error' }); }
});

router.get('/api/events/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  const ev = db.getEventById(id);
  if (!ev) return res.status(404).json({ error: 'not_found' });
  return res.json({ event: ev });
});

router.patch('/api/events/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  const { title, notes, scheduledFor, startTime, endTime, location, completed, recurrence, context } = req.body || {};
  if (title !== undefined && typeof title !== 'string') return res.status(400).json({ error: 'invalid_title' });
  if (notes !== undefined && typeof notes !== 'string') return res.status(400).json({ error: 'invalid_notes' });
  if (!(scheduledFor === undefined || scheduledFor === null || isYmdString(scheduledFor))) return res.status(400).json({ error: 'invalid_scheduledFor' });
  if (completed !== undefined && typeof completed !== 'boolean') return res.status(400).json({ error: 'invalid_completed' });
  if (startTime !== undefined && !(startTime === null || /^([01]\d|2[0-3]):[0-5]\d$/.test(String(startTime)))) return res.status(400).json({ error: 'invalid_start_time' });
  if (endTime !== undefined && !(endTime === null || /^([01]\d|2[0-3]):[0-5]\d$/.test(String(endTime)))) return res.status(400).json({ error: 'invalid_end_time' });
  if (startTime && endTime && String(endTime) < String(startTime)) return res.status(400).json({ error: 'invalid_time_range' });
  if (recurrence !== undefined && typeof recurrence !== 'object') return res.status(400).json({ error: 'invalid_recurrence' });
  if (context !== undefined && !['school','personal','work'].includes(String(context))) return res.status(400).json({ error: 'invalid_context' });
  if (recurrence && recurrence.type && recurrence.type !== 'none') {
    const anchor = (scheduledFor !== undefined) ? scheduledFor : (db.getEventById(id)?.scheduledFor ?? null);
    if (!(anchor !== null && isYmdString(anchor))) return res.status(400).json({ error: 'missing_anchor_for_recurrence' });
  }
  try {
    const ev = db.updateEvent(id, { title, notes, scheduledFor, startTime, endTime, location, completed, recurrence, context });
    return res.json({ event: ev });
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (msg === 'not_found') return res.status(404).json({ error: 'not_found' });
    return res.status(500).json({ error: 'update_failed' });
  }
});

router.patch('/api/events/:id/occurrence', (req, res) => {
  return res.status(400).json({ error: 'not_supported' });
});

router.delete('/api/events/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  try { db.deleteEvent(id); return res.json({ ok: true }); }
  catch { return res.status(500).json({ error: 'delete_failed' }); }
});

router.get('/api/events/search', (req, res) => {
  const qRaw = String(req.query.query || '');
  const q = qRaw.trim();
  if (q.length === 0) return res.status(400).json({ error: 'invalid_query' });
  let completedBool;
  if (req.query.completed !== undefined) {
    if (req.query.completed === 'true' || req.query.completed === true) completedBool = true;
    else if (req.query.completed === 'false' || req.query.completed === false) completedBool = false;
    else return res.status(400).json({ error: 'invalid_completed' });
  }
  try {
    let items = db.searchEvents({ q, completed: completedBool });
    if (q.length < 2) {
      const ql = q.toLowerCase();
      items = items.filter(e => String(e.title || '').toLowerCase().includes(ql) || String(e.notes || '').toLowerCase().includes(ql) || String(e.location || '').toLowerCase().includes(ql));
    }
    const todayY = ymdInTimeZone(new Date(), TIMEZONE);
    const score = (e) => {
      let s = 0;
      const overdue = (!e.completed && e.scheduledFor && String(e.scheduledFor) < String(todayY));
      if (overdue) s += 0.5;
      return s;
    };
    items = items.map(e => ({ e, s: score(e) }))
      .sort((a, b) => b.s - a.s || String(a.e.scheduledFor || '').localeCompare(String(b.e.scheduledFor || '')) || (a.e.id - b.e.id))
      .map(x => x.e);
    return res.json({ events: items });
  } catch (e) {
    return res.status(500).json({ error: 'search_failed' });
  }
});

export default router;
