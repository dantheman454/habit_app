import { Router } from 'express';
import db from '../database/DbService.js';
import { parseYMD } from '../utils/date.js';
import { isYmdString, matchesRule } from '../utils/recurrence.js';
import { ymd } from '../utils/date.js';

const router = Router();

function expandTaskOccurrences(task, fromDate, toDate) {
  const occurrences = [];
  const anchor = task.scheduledFor ? parseYMD(task.scheduledFor) : null;
  if (!anchor) return occurrences;
  const untilYmd = task.recurrence?.until ?? undefined;
  const untilDate = (untilYmd && isYmdString(untilYmd)) ? parseYMD(untilYmd) : null;
  const inclusiveEnd = new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate() + 1);
  for (let d = new Date(Math.max(fromDate.getTime(), anchor.getTime())); d < inclusiveEnd; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    if (untilDate && d > untilDate) break;
    if (matchesRule(d, anchor, task.recurrence)) {
      const dateStr = ymd(d);
      const occCompleted = Array.isArray(task.completedDates) && task.completedDates.includes(dateStr);
      const occSkipped = Array.isArray(task.skippedDates) && task.skippedDates.includes(dateStr);
      occurrences.push({
        id: task.id,
        masterId: task.id,
        title: task.title,
        notes: task.notes,
        scheduledFor: dateStr,
        timeOfDay: task.timeOfDay,
        completed: !!occCompleted,
        status: occCompleted ? 'completed' : (occSkipped ? 'skipped' : 'pending'),
        recurrence: task.recurrence,
        context: task.context,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      });
    }
  }
  return occurrences;
}

function expandEventOccurrences(event, fromDate, toDate) {
  const occurrences = [];
  const anchor = event.scheduledFor ? parseYMD(event.scheduledFor) : null;
  if (!anchor) return occurrences;
  const untilYmd = event.recurrence?.until ?? undefined;
  const untilDate = (untilYmd && isYmdString(untilYmd)) ? parseYMD(untilYmd) : null;
  const inclusiveEnd = new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate() + 1);
  for (let d = new Date(Math.max(fromDate.getTime(), anchor.getTime())); d < inclusiveEnd; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
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

router.get('/api/schedule', (req, res) => {
  const { from, to, kinds, completed, status_task, context } = req.query || {};
  if (!isYmdString(from)) return res.status(400).json({ error: 'invalid_from' });
  if (!isYmdString(to)) return res.status(400).json({ error: 'invalid_to' });
  let completedBool;
  if (completed !== undefined) {
    if (completed === 'true' || completed === true) completedBool = true;
    else if (completed === 'false' || completed === false) completedBool = false;
    else return res.status(400).json({ error: 'invalid_completed' });
  }
  if (status_task !== undefined && !['pending','completed','skipped'].includes(String(status_task))) return res.status(400).json({ error: 'invalid_status_task' });
  if (context !== undefined && !['school','personal','work'].includes(String(context))) return res.status(400).json({ error: 'invalid_context' });

  const requestedKinds = (() => {
    const csv = String(kinds || 'task,event').trim();
    const parts = csv.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const set = new Set(parts.length ? parts : ['task','event']);
    return ['task','event'].filter(k => set.has(k));
  })();

  try {
    const fromDate = parseYMD(from);
    const toDate = parseYMD(to);
    const inclusiveEnd = new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate() + 1);
    const inRange = (d) => {
      if (!d) return false;
      return (d >= fromDate) && (d < inclusiveEnd);
    };

    const items = [];

    if (requestedKinds.includes('task')) {
      let tasks = db.listTasks({ from: null, to: null, status: status_task || null, context: context || null }).filter(t => t.scheduledFor !== null);
      for (const t of tasks) {
        const isRepeating = (t.recurrence && t.recurrence.type && t.recurrence.type !== 'none');
        if (isRepeating) {
          for (const occ of expandTaskOccurrences(t, fromDate, toDate)) {
            if (status_task === undefined || occ.status === status_task) {
              items.push({ kind: 'task', ...occ });
            }
          }
        } else {
          const td = t.scheduledFor ? parseYMD(t.scheduledFor) : null;
          if (inRange(td) && (status_task === undefined || t.status === status_task)) {
            items.push({
              kind: 'task',
              id: t.id,
              title: t.title,
              notes: t.notes,
              scheduledFor: t.scheduledFor,
              status: t.status,
              timeOfDay: t.timeOfDay ?? null,
              recurrence: t.recurrence,
              context: t.context,
              createdAt: t.createdAt,
              updatedAt: t.updatedAt,
            });
          }
        }
      }
    }

    if (requestedKinds.includes('event')) {
      let events = db.listEvents({ from: null, to: null, context: context || null }).filter(e => e.scheduledFor !== null);
      const shouldSplit = (s, e) => {
        if (!s || !e) return false;
        return String(e) < String(s);
      };
      const pushEventOrSplit = (base) => {
        const s = base.startTime || '';
        const e = base.endTime || '';
        if (shouldSplit(s, e)) {
          // Segment A: current day start..23:59
          items.push({ ...base, endTime: '23:59' });
          // Segment B: next day 00:00..end
          const d = parseYMD(base.scheduledFor);
          if (d) {
            const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
            if (inRange(next)) {
              items.push({ ...base, scheduledFor: ymd(next), startTime: '00:00' });
            }
          }
        } else {
          items.push(base);
        }
      };

      for (const e of events) {
        const isRepeating = (e.recurrence && e.recurrence.type && e.recurrence.type !== 'none');
        if (isRepeating) {
          for (const occ of expandEventOccurrences(e, fromDate, toDate)) {
            if (completedBool === undefined || occ.completed === completedBool) {
              pushEventOrSplit({ kind: 'event', ...occ });
            }
          }
        } else {
          const ed = e.scheduledFor ? parseYMD(e.scheduledFor) : null;
          if (inRange(ed) && (completedBool === undefined || e.completed === completedBool)) {
            pushEventOrSplit({
              kind: 'event',
              id: e.id,
              title: e.title,
              notes: e.notes,
              scheduledFor: e.scheduledFor,
              completed: e.completed,
              startTime: e.startTime ?? null,
              endTime: e.endTime ?? null,
              location: e.location ?? null,
              recurrence: e.recurrence,
              context: e.context,
              createdAt: e.createdAt,
              updatedAt: e.updatedAt,
            });
          }
        }
      }
    }

    const kindOrder = { event: 0, task: 1 };
    items.sort((a, b) => {
      const da = String(a.scheduledFor || '');
      const dbs = String(b.scheduledFor || '');
      if (da !== dbs) return da.localeCompare(dbs);
      const ta = (a.kind === 'event') ? (a.startTime || '') : (a.timeOfDay || '');
      const tb = (b.kind === 'event') ? (b.startTime || '') : (b.timeOfDay || '');
      if (ta === '' && tb !== '') return -1;
      if (ta !== '' && tb === '') return 1;
      if (ta !== tb) return ta.localeCompare(tb);
      const ka = kindOrder[a.kind] ?? 99;
      const kb = kindOrder[b.kind] ?? 99;
      if (ka !== kb) return ka - kb;
      return (a.id || 0) - (b.id || 0);
    });

    return res.json({ items });
  } catch (e) {
    return res.status(500).json({ error: 'schedule_error' });
  }
});

export default router;


