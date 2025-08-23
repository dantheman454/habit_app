import { ymd, parseYMD } from './date.js';

export function filterTodosByWhere(where = {}, { listAllTodosRaw }) {
  const items = (typeof listAllTodosRaw === 'function' ? listAllTodosRaw() : []).slice();
  let filtered = items;
  if (Array.isArray(where.ids) && where.ids.length) {
    const set = new Set(where.ids.map((id) => parseInt(id, 10)));
    filtered = filtered.filter((t) => set.has(t.id));
  }
  if (typeof where.title_contains === 'string' && where.title_contains.trim()) {
    const q = where.title_contains.toLowerCase();
    filtered = filtered.filter((t) => String(t.title || '').toLowerCase().includes(q));
  }
  if (typeof where.overdue === 'boolean') {
    const todayY = ymd(new Date());
    const isOverdue = (t) => { if (t.status === 'completed' || t.status === 'skipped') return false; if (!t.scheduledFor) return false; return String(t.scheduledFor) < String(todayY); };
    filtered = filtered.filter((t) => isOverdue(t) === where.overdue);
  }
  if (where.scheduled_range && (where.scheduled_range.from || where.scheduled_range.to)) {
    const from = where.scheduled_range.from ? parseYMD(where.scheduled_range.from) : null;
    const to = where.scheduled_range.to ? parseYMD(where.scheduled_range.to) : null;
    filtered = filtered.filter((t) => {
      if (!t.scheduledFor) return false;
      const d = parseYMD(t.scheduledFor);
      if (!d) return false;
      if (from && d < from) return false;
      if (to) {
        const inclusiveEnd = new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1);
        if (d >= inclusiveEnd) return false;
      }
      return true;
    });
  }
  if (typeof where.status === 'string') {
    filtered = filtered.filter((t) => String(t.status) === String(where.status));
  }
  if (typeof where.context === 'string') {
    filtered = filtered.filter((t) => String(t.context) === String(where.context));
  }
  if (typeof where.completed === 'boolean') {
    if (where.completed) filtered = filtered.filter((t) => String(t.status) === 'completed');
    else filtered = filtered.filter((t) => String(t.status) !== 'completed');
  }
  if (typeof where.repeating === 'boolean') {
    const isRepeating = (todo) => !!(todo?.recurrence && todo.recurrence.type && todo.recurrence.type !== 'none');
    filtered = filtered.filter((t) => isRepeating(t) === where.repeating);
  }
  return filtered;
}

export function filterItemsByWhere(items, where = {}) {
  let filtered = (Array.isArray(items) ? items.slice() : []);
  if (Array.isArray(where.ids) && where.ids.length) {
    const set = new Set(where.ids.map((id) => parseInt(id, 10)));
    filtered = filtered.filter((t) => set.has(t.id));
  }
  if (typeof where.title_contains === 'string' && where.title_contains.trim()) {
    const q = where.title_contains.toLowerCase();
    filtered = filtered.filter((t) => String(t.title || '').toLowerCase().includes(q));
  }
  if (typeof where.overdue === 'boolean') {
    const todayY = ymd(new Date());
    const isOverdue = (t) => { if (t.completed) return false; if (!t.scheduledFor) return false; return String(t.scheduledFor) < String(todayY); };
    filtered = filtered.filter((t) => isOverdue(t) === where.overdue);
  }
  if (where.scheduled_range && (where.scheduled_range.from || where.scheduled_range.to)) {
    const from = where.scheduled_range.from ? parseYMD(where.scheduled_range.from) : null;
    const to = where.scheduled_range.to ? parseYMD(where.scheduled_range.to) : null;
    filtered = filtered.filter((t) => {
      if (!t.scheduledFor) return false;
      const d = parseYMD(t.scheduledFor);
      if (!d) return false;
      if (from && d < from) return false;
      if (to) {
        const inclusiveEnd = new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1);
        if (d >= inclusiveEnd) return false;
      }
      return true;
    });
  }
  if (typeof where.completed === 'boolean') {
    filtered = filtered.filter((t) => !!t.completed === where.completed);
  }
  if (typeof where.context === 'string') {
    filtered = filtered.filter((t) => String(t.context) === String(where.context));
  }
  if (typeof where.repeating === 'boolean') {
    const isRepeating = (x) => !!(x?.recurrence && x.recurrence.type && x.recurrence.type !== 'none');
    filtered = filtered.filter((t) => isRepeating(t) === where.repeating);
  }
  return filtered;
}

export function getAggregatesFromDb({ listAllTodosRaw }) {
  const items = (typeof listAllTodosRaw === 'function' ? listAllTodosRaw() : []);
  const today = new Date();
  const todayY = ymd(today);
  let overdueCount = 0; let next7DaysCount = 0; let backlogCount = 0; let scheduledCount = 0;
  for (const t of items) {
    if (t.scheduledFor === null) backlogCount++; else scheduledCount++;
    const isOverdue = ((t.status !== 'completed' && t.status !== 'skipped') && t.scheduledFor && String(t.scheduledFor) < String(todayY));
    if (isOverdue) overdueCount++;
    if (t.scheduledFor) {
      const d = parseYMD(t.scheduledFor); if (d) {
        const end = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 7);
        const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        if (d >= start && d <= end) next7DaysCount++;
      }
    }
  }
  return { overdueCount, next7DaysCount, backlogCount, scheduledCount };
}


