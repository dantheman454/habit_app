import { Router } from 'express';
import db from '../database/DbService.js';
import { ymdInTimeZone } from '../utils/date.js';

const router = Router();
const TIMEZONE = process.env.TZ_NAME || 'America/New_York';

// Unified search across todos + events 
// Params: q (required), scope=todo|event|all (default all),
// completed (optional for events), status_todo (optional), context (optional), limit (default 30)
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
  const status_todo = (req.query.status_todo === undefined) ? undefined : String(req.query.status_todo);
  if (status_todo !== undefined && !['pending','completed','skipped'].includes(status_todo)) return res.status(400).json({ error: 'invalid_status_todo' });
  const context = (req.query.context === undefined) ? undefined : String(req.query.context);
  if (context !== undefined && !['school','personal','work'].includes(context)) return res.status(400).json({ error: 'invalid_context' });
  const limit = (() => {
    const n = parseInt(String(req.query.limit ?? '30'), 10);
    if (!Number.isFinite(n)) return 30;
    return Math.max(1, Math.min(200, n));
  })();

  const wantTodos = (scope === 'all' || scope === 'todo');
  const wantEvents = (scope === 'all' || scope === 'event');
  if (!wantTodos && !wantEvents) return res.status(400).json({ error: 'invalid_scope' });

  try {
    let out = [];
    const todayY = ymdInTimeZone(new Date(), TIMEZONE);
    const boosterScore = (rec) => {
      let s = 0;
      const overdue = ((rec.status ? (rec.status !== 'completed' && rec.status !== 'skipped') : !rec.completed) && rec.scheduledFor && String(rec.scheduledFor) < String(todayY));
      if (overdue) s += 0.5;
      const hasTime = !!(rec.timeOfDay || rec.startTime);
      if (hasTime) s += 0.05;
      return s;
    };

    if (wantTodos) {
      let items = db.searchTodos({ q, status: status_todo, context });
      if (q.length < 2) {
        const ql = q.toLowerCase();
        items = items.filter(t => String(t.title || '').toLowerCase().includes(ql) || String(t.notes || '').toLowerCase().includes(ql));
      }
      out.push(...items.map(t => ({
        kind: 'todo',
        id: t.id,
        title: t.title,
        notes: t.notes,
        scheduledFor: t.scheduledFor,
        status: t.status,
        timeOfDay: t.timeOfDay ?? null,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      })));
    }
    if (wantEvents) {
      let items = db.searchEvents({ q, completed: completedBool, context });
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
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
      })));
    }

    const scored = out.map(r => ({ r, s: boosterScore(r) }))
      .sort((a, b) => (
        b.s - a.s ||
        String(a.r.scheduledFor || '').localeCompare(String(b.r.scheduledFor || '')) ||
        // time compare (events startTime vs todos timeOfDay)
        (String((a.r.startTime || a.r.timeOfDay || '')) || '').localeCompare(String((b.r.startTime || b.r.timeOfDay || '')) || '') ||
        ((a.r.id || 0) - (b.r.id || 0))
      ))
      .slice(0, limit)
      .map(x => x.r);
    return res.json({ items: scored });
  } catch (e) {
    return res.status(500).json({ error: 'search_failed' });
  }
});

export default router;


