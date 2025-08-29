import { Router } from 'express';
import db from '../database/DbService.js';

const router = Router();

router.post('/api/goals', (req, res) => {
  const { title, notes, status, currentProgressValue, targetProgressValue, progressUnit } = req.body || {};
  if (typeof title !== 'string' || title.trim() === '') return res.status(400).json({ error: 'invalid_title' });
  if (status !== undefined && !['active','completed','archived'].includes(String(status))) return res.status(400).json({ error: 'invalid_status' });
  try {
    const g = db.createGoal({ title: title.trim(), notes: notes || '', status: status || 'active', currentProgressValue, targetProgressValue, progressUnit });
    return res.json({ goal: g });
  } catch { return res.status(500).json({ error: 'create_failed' }); }
});

router.get('/api/goals', (req, res) => {
  const { status } = req.query || {};
  if (status !== undefined && !['active','completed','archived'].includes(String(status))) return res.status(400).json({ error: 'invalid_status' });
  try { const list = db.listGoals({ status: status || null }); return res.json({ goals: list }); }
  catch { return res.status(500).json({ error: 'db_error' }); }
});

router.get('/api/goals/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  const g = db.getGoalById(id, { includeItems: String(req.query.includeItems||'false')==='true', includeChildren: String(req.query.includeChildren||'false')==='true' });
  if (!g) return res.status(404).json({ error: 'not_found' });
  return res.json({ goal: g });
});

router.patch('/api/goals/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  const { title, notes, status, currentProgressValue, targetProgressValue, progressUnit } = req.body || {};
  if (title !== undefined && typeof title !== 'string') return res.status(400).json({ error: 'invalid_title' });
  if (notes !== undefined && typeof notes !== 'string') return res.status(400).json({ error: 'invalid_notes' });
  if (status !== undefined && !['active','completed','archived'].includes(String(status))) return res.status(400).json({ error: 'invalid_status' });
  try { const g = db.updateGoal(id, { title, notes, status, currentProgressValue, targetProgressValue, progressUnit }); return res.json({ goal: g }); }
  catch (e) { const msg=String(e&&e.message?e.message:e); if(msg==='not_found') return res.status(404).json({error:'not_found'}); return res.status(500).json({ error: 'update_failed' }); }
});

router.delete('/api/goals/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  try { db.deleteGoal(id); return res.json({ ok: true }); }
  catch { return res.status(500).json({ error: 'delete_failed' }); }
});

router.post('/api/goals/:id/items', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  const { tasks = [], events = [] } = req.body || {};
  try {
    const taskIds = (Array.isArray(tasks) ? tasks : []).map(Number).filter(Number.isFinite);
    if (taskIds.length) db.addGoalTaskItems(id, taskIds);
    db.addGoalEventItems(id, (Array.isArray(events)?events:[]).map(Number).filter(Number.isFinite));
    return res.json({ ok: true });
  } catch { return res.status(500).json({ error: 'add_items_failed' }); }
});

router.delete('/api/goals/:goalId/items/event/:eventId', (req, res) => {
  const gid = parseInt(req.params.goalId, 10);
  const eid = parseInt(req.params.eventId, 10);
  if (!Number.isFinite(gid) || !Number.isFinite(eid)) return res.status(400).json({ error: 'invalid_id' });
  try { db.removeGoalEventItem(gid, eid); return res.json({ ok: true }); }
  catch { return res.status(500).json({ error: 'remove_item_failed' }); }
});

// Delete link to a task item
router.delete('/api/goals/:goalId/items/task/:taskId', (req, res) => {
  const gid = parseInt(req.params.goalId, 10);
  const tid = parseInt(req.params.taskId, 10);
  if (!Number.isFinite(gid) || !Number.isFinite(tid)) return res.status(400).json({ error: 'invalid_id' });
  try { db.removeGoalTaskItem(gid, tid); return res.json({ ok: true }); }
  catch { return res.status(500).json({ error: 'remove_item_failed' }); }
});

router.post('/api/goals/:id/children', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });
  const children = Array.isArray(req.body) ? req.body : [];
  try { db.addGoalChildren(id, children.map(Number).filter(Number.isFinite)); return res.json({ ok: true }); }
  catch { return res.status(500).json({ error: 'add_children_failed' }); }
});

router.delete('/api/goals/:parentId/children/:childId', (req, res) => {
  const pid = parseInt(req.params.parentId, 10);
  const cid = parseInt(req.params.childId, 10);
  if (!Number.isFinite(pid) || !Number.isFinite(cid)) return res.status(400).json({ error: 'invalid_id' });
  try { db.removeGoalChild(pid, cid); return res.json({ ok: true }); }
  catch { return res.status(500).json({ error: 'remove_child_failed' }); }
});

export default router;


