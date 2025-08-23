import { Router } from 'express';
import db from '../database/DbService.js';
import { parseYMD } from '../utils/date.js';
import { isYmdString, matchesRule } from '../utils/recurrence.js';
import { ymd } from '../utils/date.js';

const router = Router();

function expandTodoOccurrences(todo, fromDate, toDate) {
  const occurrences = [];
  const anchor = todo.scheduledFor ? parseYMD(todo.scheduledFor) : null;
  if (!anchor) return occurrences;
  const untilYmd = todo.recurrence?.until ?? undefined;
  const untilDate = (untilYmd && isYmdString(untilYmd)) ? parseYMD(untilYmd) : null;
  const inclusiveEnd = new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate() + 1);
  for (let d = new Date(Math.max(fromDate.getTime(), anchor.getTime())); d < inclusiveEnd; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    if (untilDate && d > untilDate) break;
    if (matchesRule(d, anchor, todo.recurrence)) {
      const dateStr = ymd(d);
      const occCompleted = Array.isArray(todo.completedDates) && todo.completedDates.includes(dateStr);
      const occSkipped = Array.isArray(todo.skippedDates) && todo.skippedDates.includes(dateStr);
      occurrences.push({
        id: todo.id,
        masterId: todo.id,
        title: todo.title,
        notes: todo.notes,
        scheduledFor: dateStr,
        timeOfDay: todo.timeOfDay,
        completed: !!occCompleted,
        status: occCompleted ? 'completed' : (occSkipped ? 'skipped' : 'pending'),
        recurrence: todo.recurrence,
        context: todo.context,
        createdAt: todo.createdAt,
        updatedAt: todo.updatedAt,
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
  const { from, to, kinds, completed, status_todo, context } = req.query || {};
  if (!isYmdString(from)) return res.status(400).json({ error: 'invalid_from' });
  if (!isYmdString(to)) return res.status(400).json({ error: 'invalid_to' });
  let completedBool;
  if (completed !== undefined) {
    if (completed === 'true' || completed === true) completedBool = true;
    else if (completed === 'false' || completed === false) completedBool = false;
    else return res.status(400).json({ error: 'invalid_completed' });
  }
  if (status_todo !== undefined && !['pending','completed','skipped'].includes(String(status_todo))) return res.status(400).json({ error: 'invalid_status_todo' });
  if (context !== undefined && !['school','personal','work'].includes(String(context))) return res.status(400).json({ error: 'invalid_context' });

  const requestedKinds = (() => {
    const csv = String(kinds || 'todo,event').trim();
    const parts = csv.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const set = new Set(parts.length ? parts : ['todo','event']);
    return ['todo','event','habit'].filter(k => set.has(k));
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

    if (requestedKinds.includes('todo')) {
      let todos = db.listTodos({ from: null, to: null, status: status_todo || null, context: context || null }).filter(t => t.scheduledFor !== null);
      for (const t of todos) {
        const isRepeating = (t.recurrence && t.recurrence.type && t.recurrence.type !== 'none');
        if (isRepeating) {
          for (const occ of expandTodoOccurrences(t, fromDate, toDate)) {
            if (status_todo === undefined || occ.status === status_todo) {
              items.push({ kind: 'todo', ...occ });
            }
          }
        } else {
          const td = t.scheduledFor ? parseYMD(t.scheduledFor) : null;
          if (inRange(td) && (status_todo === undefined || t.status === status_todo)) {
            items.push({
              kind: 'todo',
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
      for (const e of events) {
        const isRepeating = (e.recurrence && e.recurrence.type && e.recurrence.type !== 'none');
        if (isRepeating) {
          for (const occ of expandEventOccurrences(e, fromDate, toDate)) {
            if (completedBool === undefined || occ.completed === completedBool) {
              items.push({ kind: 'event', ...occ });
            }
          }
        } else {
          const ed = e.scheduledFor ? parseYMD(e.scheduledFor) : null;
          if (inRange(ed) && (completedBool === undefined || e.completed === completedBool)) {
            items.push({
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

    if (requestedKinds.includes('habit')) {
      let habits = db.listHabits({ from: null, to: null, context: context || null }).filter(h => h.scheduledFor !== null);
      for (const h of habits) {
        for (const occ of expandTodoOccurrences(h, fromDate, toDate)) {
          if (completedBool === undefined || occ.completed === completedBool) {
            items.push({ kind: 'habit', ...occ });
          }
        }
      }
    }

    const kindOrder = { event: 0, todo: 1, habit: 2 };
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


