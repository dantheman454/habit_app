// Context builders for two‑LLM pipeline.
// These are non-invasive helpers that read from the DB directly to assemble
// compact snapshots for prompts. They intentionally duplicate a tiny amount of
// server logic to avoid circular imports with server.js.

import db from '../database/DbService.js';

const DEFAULT_TZ = process.env.TZ_NAME || 'America/New_York';

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function ymdInTimeZone(date, tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(date);
    const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
    return `${map.year}-${map.month}-${map.day}`;
  } catch {
    const d = date;
    return ymd(d);
  }
}

function parseYMD(s) {
  try {
    const [y, m, d] = String(s).split('-').map(v => parseInt(v, 10));
    if (!y || !m || !d) return null;
    return new Date(y, m - 1, d);
  } catch { return null; }
}

function weekRangeFromToday(tz) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now);
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const y = parseInt(map.year, 10);
  const m = parseInt(map.month, 10);
  const d = parseInt(map.day, 10);
  const today = new Date(y, m - 1, d);
  const jsWeekday = today.getDay(); // 0=Sun..6=Sat
  const daysFromMonday = (jsWeekday + 6) % 7; // Mon->0, Sun->6
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysFromMonday);
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  return { fromYmd: ymd(monday), toYmd: ymd(sunday) };
}

function isYmdString(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function filterByWhere(items, where = {}, { todayY } = {}) {
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
  // priority removed
  if (typeof where.completed === 'boolean') {
    filtered = filtered.filter((t) => !!t.completed === where.completed);
  }
  if (typeof where.repeating === 'boolean') {
    const isRepeating = (x) => !!(x?.recurrence && x.recurrence.type && x.recurrence.type !== 'none');
    filtered = filtered.filter((t) => isRepeating(t) === where.repeating);
  }
  return filtered;
}

function listAllTodosRaw() {
  try { return db.searchTodos({ q: ' ' }); } catch { return []; }
}
function listAllEventsRaw() {
  try { return db.searchEvents({ q: ' ' }); } catch { return []; }
}
function listAllHabitsRaw() {
  try { return db.searchHabits({ q: ' ' }); } catch { return []; }
}

export function buildRouterSnapshots({ timezone = DEFAULT_TZ } = {}) {
  const tz = timezone || DEFAULT_TZ;
  const { fromYmd, toYmd } = weekRangeFromToday(tz);
  // Completed=false by convention for week + backlog
  const todosWeek = filterByWhere(listAllTodosRaw(), { scheduled_range: { from: fromYmd, to: toYmd }, completed: false }, { todayY: ymdInTimeZone(new Date(), tz) });
  const eventsWeek = filterByWhere(listAllEventsRaw(), { scheduled_range: { from: fromYmd, to: toYmd }, completed: false }, { todayY: ymdInTimeZone(new Date(), tz) });
  const habitsWeek = filterByWhere(listAllHabitsRaw(), { scheduled_range: { from: fromYmd, to: toYmd }, completed: false }, { todayY: ymdInTimeZone(new Date(), tz) });
  const weekItems = [...todosWeek, ...eventsWeek, ...habitsWeek];
  const backlogTodos = filterByWhere(listAllTodosRaw(), { completed: false }, { todayY: ymdInTimeZone(new Date(), tz) });
  const backlogSample = backlogTodos.filter(t => t.scheduledFor === null).slice(0, 40);
  const compact = (t) => ({ id: t.id, title: t.title, scheduledFor: t.scheduledFor });
  return { week: { from: fromYmd, to: toYmd, items: weekItems.map(compact) }, backlog: backlogSample.map(compact) };
}

export function buildFocusedContext(where = {}, { timezone = DEFAULT_TZ } = {}) {
  const tz = timezone || DEFAULT_TZ;
  const todayY = ymdInTimeZone(new Date(), tz);
  const w = where || {};
  const kindsHint = (() => {
    // where.kind: 'todo'|'event'|'habit' or array
    if (typeof w.kind === 'string') return [w.kind.toLowerCase()];
    if (Array.isArray(w.kind)) return w.kind.map((k) => String(k).toLowerCase());
    return null;
  })();
  const includeTodo = !kindsHint || kindsHint.includes('todo');
  const includeEvent = kindsHint && kindsHint.includes('event');
  const includeHabit = kindsHint && kindsHint.includes('habit');

  const todos = includeTodo ? filterByWhere(listAllTodosRaw(), w, { todayY }).slice(0, 50) : [];
  const events = includeEvent ? filterByWhere(listAllEventsRaw(), w, { todayY }).slice(0, 50) : [];
  const habits = includeHabit ? filterByWhere(listAllHabitsRaw(), w, { todayY }).slice(0, 50) : [];

  return {
    where: w,
  todos: todos.map(t => ({ id: t.id, title: t.title, scheduledFor: t.scheduledFor ?? null, recurrence: t.recurrence || { type: 'none' }, completed: !!t.completed })),
  events: events.map(e => ({ id: e.id, title: e.title, scheduledFor: e.scheduledFor ?? null, startTime: e.startTime ?? null, endTime: e.endTime ?? null, location: e.location ?? null, recurrence: e.recurrence || { type: 'none' }, completed: !!e.completed })),
  habits: habits.map(h => ({ id: h.id, title: h.title, scheduledFor: h.scheduledFor ?? null, timeOfDay: h.timeOfDay ?? null, recurrence: h.recurrence || { type: 'daily' }, completed: !!h.completed })),
    aggregates: {}
  };
}

export function topClarifyCandidates(instruction, snapshot, limit = 5) {
  const tokens = String(instruction || '').toLowerCase().split(/[^a-z0-9]+/g).filter(Boolean);
  const all = [...(snapshot.week?.items || []), ...(snapshot.backlog || [])];
  const score = (item) => {
    const title = String(item.title || '').toLowerCase();
    let s = 0;
    for (const t of tokens) if (title.includes(t)) s += 1;
  // priority removed from scoring
    return s;
  };
  return all
    .map(i => ({ i, s: score(i) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map(x => x.i);
}

export function buildRouterContext({ todayYmd, timezone } = {}) {
  return { today: todayYmd || ymdInTimeZone(new Date(), timezone || DEFAULT_TZ), timezone: timezone || DEFAULT_TZ, ...buildRouterSnapshots({ timezone: timezone || DEFAULT_TZ }) };
}

