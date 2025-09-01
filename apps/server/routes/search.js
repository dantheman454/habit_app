import { Router } from 'express';
import db from '../database/DbService.js';
import { ymdInTimeZone } from '../utils/date.js';

const router = Router();
const TIMEZONE = process.env.TZ_NAME || 'America/New_York';

// Unified search across tasks + events 
// Params: q (required), scope=task|event|all (default all),
// completed (optional for events), status_task (optional), context (optional), limit (default 30)
router.get('/api/search', (req, res) => {
  const qRaw = String(req.query.q || req.query.query || '');
  const q = qRaw.trim();
  if (q.length === 0) return res.status(400).json({ error: 'invalid_query' });
  const scope = String(req.query.scope || 'all').toLowerCase();
  let completedBool;
  if (req.query.completed !== undefined) {
    if (req.query.completed === 'true' || req.query.completed === true) completedBool = true;
    else if (req.query.completed === 'false' || req.query.completed === false) completedBool = false;
    else return res.status(400).json({ error: 'invalid_completed' });
  }
  const status_task = (req.query.status_task === undefined) ? undefined : String(req.query.status_task);
  if (status_task !== undefined && !['pending','completed','skipped'].includes(status_task)) return res.status(400).json({ error: 'invalid_status_task' });
  const context = (req.query.context === undefined) ? undefined : String(req.query.context);
  if (context !== undefined && !['school','personal','work'].includes(context)) return res.status(400).json({ error: 'invalid_context' });
  const limit = (() => {
    const n = parseInt(String(req.query.limit ?? '30'), 10);
    if (!Number.isFinite(n)) return 30;
    return Math.max(1, Math.min(200, n));
  })();

  const wantTasks = (scope === 'all' || scope === 'task');
  const wantEvents = (scope === 'all' || scope === 'event');
  if (!wantTasks && !wantEvents) return res.status(400).json({ error: 'invalid_scope' });

  try {
    let out = [];
    const todayY = ymdInTimeZone(new Date(), TIMEZONE);
    const boosterScore = (rec) => {
      let s = 0;
      const overdue = ((rec.status ? (rec.status !== 'completed' && rec.status !== 'skipped') : !rec.completed) && rec.scheduledFor && String(rec.scheduledFor) < String(todayY));
      if (overdue) s += 0.5;
      // Only boost events that have a start time; tasks are all-day and should not be boosted by time
      if (rec.kind === 'event' && !!rec.startTime) s += 0.05;
      return s;
    };

    if (wantTasks) {
      let items = db.searchTasks({ q, status: status_task, context });
      if (q.length < 2) {
        const ql = q.toLowerCase();
        items = items.filter(t => String(t.title || '').toLowerCase().includes(ql) || String(t.notes || '').toLowerCase().includes(ql));
      }
      out.push(...items.map(t => ({
        kind: 'task',
        id: t.id,
        title: t.title,
        notes: t.notes,
        scheduledFor: t.scheduledFor,
        status: t.status,
        context: t.context,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      })));
    }
    if (wantEvents) {
      let items = db.searchEvents({ q, context });
      if (q.length < 2) {
        const ql = q.toLowerCase();
        items = items.filter(e => String(e.title || '').toLowerCase().includes(ql) || String(e.notes || '').toLowerCase().includes(ql) || String(e.location || '').toLowerCase().includes(ql));
      }
      out.push(...items.map(e => ({
        kind: 'event',
        id: e.id,
        title: e.title,
        notes: e.notes,
        scheduledFor: e.scheduledFor,
        completed: e.completed,
        startTime: e.startTime ?? null,
        endTime: e.endTime ?? null,
        location: e.location ?? null,
        context: e.context,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
      })));
    }

    const scored = out.map(r => ({ r, s: boosterScore(r) }))
      .sort((a, b) => {
        // Primary: booster score (desc)
        if (b.s !== a.s) return b.s - a.s;
        // Secondary: date asc
        const da = String(a.r.scheduledFor || '');
        const dbs = String(b.r.scheduledFor || '');
        if (da !== dbs) return da.localeCompare(dbs);
        // Tertiary: for events only, sort by startTime; tasks ignore time
        const aIsEvent = a.r.kind === 'event';
        const bIsEvent = b.r.kind === 'event';
        if (aIsEvent && bIsEvent) {
          const sta = String(a.r.startTime || '');
          const stb = String(b.r.startTime || '');
          if (sta !== stb) return sta.localeCompare(stb);
        }
        // Ensure events come before tasks when otherwise equal
        if (aIsEvent !== bIsEvent) return aIsEvent ? -1 : 1;
        // Finally: id asc
        return (a.r.id || 0) - (b.r.id || 0);
      })
      .slice(0, limit)
      .map(x => x.r);
    return res.json({ items: scored });
  } catch (e) {
    return res.status(500).json({ error: 'search_failed' });
  }
});

export default router;


