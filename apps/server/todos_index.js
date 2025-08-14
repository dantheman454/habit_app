// Lightweight in-house retrieval index for todos.
// No external deps; deterministic and rebuilt on writes.

let currentTodos = [];
let TIMEZONE = 'America/New_York';

function ymd(d) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
    const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
    return `${map.year}-${map.month}-${map.day}`;
  } catch {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }
}

function parseYMD(s) {
  try {
    const [y, m, d] = String(s).split('-').map(v => parseInt(v, 10));
    if (!y || !m || !d) return null;
    return new Date(y, m - 1, d);
  } catch { return null; }
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(Boolean);
}

function isRepeating(todo) {
  try { return !!(todo?.recurrence && todo.recurrence.type && todo.recurrence.type !== 'none'); } catch { return false; }
}

function isOverdue(todo, todayYmd) {
  try {
    if (todo.completed) return false;
    if (!todo.scheduledFor) return false;
    return String(todo.scheduledFor) < String(todayYmd);
  } catch { return false; }
}

function withinNextDays(todo, today, days) {
  try {
    if (!todo.scheduledFor) return false;
    const d = parseYMD(todo.scheduledFor);
    if (!d) return false;
    const end = new Date(today.getFullYear(), today.getMonth(), today.getDate() + days);
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    return d >= start && d <= end;
  } catch { return false; }
}

export function init(todos) {
  currentTodos = Array.isArray(todos) ? todos.slice() : [];
}

export function refresh(todos) {
  currentTodos = Array.isArray(todos) ? todos.slice() : [];
}

export function setTimeZone(tz) {
  try {
    if (typeof tz === 'string' && tz.trim()) TIMEZONE = tz;
  } catch {}
}

export function searchByQuery(query, { k = 40 } = {}) {
  const qTokens = tokenize(query);
  const today = new Date();
  const todayY = ymd(today);
  if (qTokens.length === 0) {
    // Prefer items scheduled today/next then backlog, capped to k
    const scheduledSoon = currentTodos
      .filter(t => t.scheduledFor !== null)
      .sort((a, b) => String(a.scheduledFor || '')?.localeCompare(String(b.scheduledFor || '')));
    const backlog = currentTodos.filter(t => t.scheduledFor === null);
    return [...scheduledSoon, ...backlog].slice(0, k);
  }
  const scored = currentTodos.map((t) => {
    const titleTokens = tokenize(t.title);
    const notesTokens = tokenize(t.notes);
    let score = 0;
    for (const qt of qTokens) {
      if (titleTokens.includes(qt)) score += 3;
      if (notesTokens.includes(qt)) score += 1;
    }
    // small bonus for overdue matches to surface urgent items
    if (isOverdue(t, todayY)) score += 0.5;
    return { t, s: score };
  });
  scored.sort((a, b) => b.s - a.s);
  const top = scored.filter(x => x.s > 0).slice(0, k).map(x => x.t);
  if (top.length > 0) return top;
  // Fallback: same as no-query fallback
  return searchByQuery('', { k });
}

export function filterByWhere(where = {}) {
  let items = currentTodos.slice();
  const today = new Date();
  const todayY = ymd(today);
  if (Array.isArray(where.ids) && where.ids.length) {
    const set = new Set(where.ids.map(id => parseInt(id, 10)));
    items = items.filter(t => set.has(t.id));
  }
  if (typeof where.title_contains === 'string' && where.title_contains.trim()) {
    const q = where.title_contains.toLowerCase();
    items = items.filter(t => String(t.title || '').toLowerCase().includes(q));
  }
  if (typeof where.overdue === 'boolean') {
    items = items.filter(t => isOverdue(t, todayY) === where.overdue);
  }
  if (where.scheduled_range && (where.scheduled_range.from || where.scheduled_range.to)) {
    const from = where.scheduled_range.from ? parseYMD(where.scheduled_range.from) : null;
    const to = where.scheduled_range.to ? parseYMD(where.scheduled_range.to) : null;
    items = items.filter(t => {
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
  if (typeof where.priority === 'string') {
    const p = where.priority.toLowerCase();
    items = items.filter(t => String(t.priority || '').toLowerCase() === p);
  }
  if (typeof where.completed === 'boolean') {
    items = items.filter(t => !!t.completed === where.completed);
  }
  if (typeof where.repeating === 'boolean') {
    items = items.filter(t => isRepeating(t) === where.repeating);
  }
  return items;
}

export function getAggregates() {
  const today = new Date();
  const todayY = ymd(today);
  let overdueCount = 0;
  let next7DaysCount = 0;
  let backlogCount = 0;
  let scheduledCount = 0;
  for (const t of currentTodos) {
    if (t.scheduledFor === null) backlogCount++;
    else scheduledCount++;
    if (isOverdue(t, todayY)) overdueCount++;
    if (withinNextDays(t, today, 7)) next7DaysCount++;
  }
  return { overdueCount, next7DaysCount, backlogCount, scheduledCount };
}


