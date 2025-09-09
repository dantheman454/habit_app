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
  // NEW: Sunday-based calculation
  const daysFromSunday = jsWeekday; // Sun->0, Mon->1, Tue->2, etc.
  const sunday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysFromSunday);
  const saturday = new Date(sunday.getFullYear(), sunday.getMonth(), sunday.getDate() + 6);
  return { fromYmd: ymd(sunday), toYmd: ymd(saturday) };
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

  if (typeof where.completed === 'boolean') {
    filtered = filtered.filter((t) => !!t.completed === where.completed);
  }
  if (typeof where.repeating === 'boolean') {
    const isRepeating = (x) => !!(x?.recurrence && x.recurrence.type && x.recurrence.type !== 'none');
    filtered = filtered.filter((t) => isRepeating(t) === where.repeating);
  }
  return filtered;
}

function listAllTasksRaw() {
  try { return db.searchTasks({ q: ' ' }); } catch { return []; }
}
function listAllEventsRaw() {
  try { return db.searchEvents({ q: ' ' }); } catch { return []; }
}

// Helper function to build title indexes for case-insensitive matching
function buildTitleIndexes(tasks, events) {
  const taskIndex = {};
  const eventIndex = {};
  
  // Build task index (first 50 items)
  tasks.slice(0, 50).forEach(task => {
    if (task.title) {
      const key = task.title.toLowerCase().trim();
      taskIndex[key] = task.id;
    }
  });
  
  // Build event index (first 50 items)
  events.slice(0, 50).forEach(event => {
    if (event.title) {
      const key = event.title.toLowerCase().trim();
      eventIndex[key] = event.id;
    }
  });
  
  return { taskIndex, eventIndex };
}

// Helper: build compact id→kind and id→title maps to reduce ambiguity
function buildIdIndexes(tasks, events) {
  const idToKind = {};
  const idToTitle = {};
  for (const t of tasks) { idToKind[t.id] = 'task'; idToTitle[t.id] = t.title || ''; }
  for (const e of events) { idToKind[e.id] = 'event'; idToTitle[e.id] = e.title || ''; }
  return { idToKind, idToTitle };
}

// Helper function to build focused candidates from UI selection
function buildFocusedCandidates(where, tasks, events) {
  const candidates = [];
  
  // Handle UI selection from where.selected
  if (where.selected) {
    if (Array.isArray(where.selected.tasks)) {
      where.selected.tasks.forEach(id => {
        const task = tasks.find(t => t.id === id);
        if (task) {
          candidates.push({
            kind: 'task',
            id: task.id,
            title: task.title,
            reason: 'selected_in_ui'
          });
        }
      });
    }
    
    if (Array.isArray(where.selected.events)) {
      where.selected.events.forEach(id => {
        const event = events.find(e => e.id === id);
        if (event) {
          candidates.push({
            kind: 'event',
            id: event.id,
            title: event.title,
            reason: 'selected_in_ui'
          });
        }
      });
    }
  }
  
  // Handle single where.id (backward compatibility)
  if (where.id && Number.isFinite(where.id)) {
    const task = tasks.find(t => t.id === where.id);
    if (task) {
      candidates.push({
        kind: 'task',
        id: task.id,
        title: task.title,
        reason: 'explicit_id'
      });
    } else {
      const event = events.find(e => e.id === where.id);
      if (event) {
        candidates.push({
          kind: 'event',
          id: event.id,
          title: event.title,
          reason: 'explicit_id'
        });
      }
    }
  }
  
  return candidates;
}

// buildRouterSnapshots removed (unused)

export function buildFocusedContext(where = {}, { timezone = DEFAULT_TZ } = {}) {
  const tz = timezone || DEFAULT_TZ;
  const todayY = ymdInTimeZone(new Date(), tz);
  const w = where || {};
  const kindsHint = (() => {
    // where.kind: 'task'|'event' or array 
    if (typeof w.kind === 'string') return [w.kind.toLowerCase()];
    if (Array.isArray(w.kind)) return w.kind.map((k) => String(k).toLowerCase());
    return null;
  })();
  const includeTask = !kindsHint || kindsHint.includes('task');
  const includeEvent = !kindsHint || kindsHint.includes('event');

  const tasks = includeTask ? filterByWhere(listAllTasksRaw(), w, { todayY }).slice(0, 50) : [];
  const events = includeEvent ? filterByWhere(listAllEventsRaw(), w, { todayY }).slice(0, 50) : [];

  // Build focused candidates and title indexes
  const focusedCandidates = buildFocusedCandidates(w, tasks, events);
  const { taskIndex, eventIndex } = buildTitleIndexes(tasks, events);
  const { idToKind, idToTitle } = buildIdIndexes(tasks, events);

  return {
    where: w,
    // Enrich records so the Ops agent can make better decisions
    tasks: tasks.map(t => ({
      id: t.id,
      title: t.title,
      notes: t.notes ?? '',
      scheduledFor: t.scheduledFor ?? null,
      status: t.status ?? (t.completed ? 'completed' : 'pending'),
      recurrence: t.recurrence || { type: 'none' },
      context: t.context ?? 'personal',
      createdAt: t.createdAt,
      updatedAt: t.updatedAt
    })),
    events: events.map(e => ({
      id: e.id,
      title: e.title,
      notes: e.notes ?? '',
      scheduledFor: e.scheduledFor ?? null,
      startTime: e.startTime ?? null,
      endTime: e.endTime ?? null,
      location: e.location ?? null,
      recurrence: e.recurrence || { type: 'none' },
      completed: !!e.completed,
      context: e.context ?? 'personal',
      createdAt: e.createdAt,
      updatedAt: e.updatedAt
    })),
    focused: {
      candidates: focusedCandidates
    },
    indexes: {
      task_by_title_ci: taskIndex,
      event_by_title_ci: eventIndex,
      id_to_kind: idToKind,
      id_to_title: idToTitle
    },
    aggregates: {}
  };
}



// buildRouterContext removed (unused)

// Build compact, QA‑friendly context for Chat: detailed Today, summarized Week
export function buildQAContext({ timezone = DEFAULT_TZ } = {}) {
  const tz = timezone || DEFAULT_TZ;
  const today = ymdInTimeZone(new Date(), tz);
  const { fromYmd, toYmd } = weekRangeFromToday(tz);

  // Limits
  const MAX_TODAY = 30; // combined across types
  const MAX_WEEK_TITLES = 50; // titles only
  const perTypeToday = Math.max(1, Math.floor(MAX_TODAY / 3));

  // Today (detailed)
  const tasksToday = filterByWhere(listAllTasksRaw(), { scheduled_range: { from: today, to: today } }, { todayY: today })
    .slice(0, perTypeToday)
    .map(t => ({
      id: t.id,
      title: t.title,
      notes: t.notes ?? '',
      scheduledFor: t.scheduledFor ?? null,
      status: t.status ?? (t.completed ? 'completed' : 'pending'),
      recurrence: t.recurrence || { type: 'none' },
      context: t.context ?? 'personal'
    }));
  const eventsToday = filterByWhere(listAllEventsRaw(), { scheduled_range: { from: today, to: today } }, { todayY: today })
    .slice(0, perTypeToday)
    .map(e => ({
      id: e.id,
      title: e.title,
      notes: e.notes ?? '',
      scheduledFor: e.scheduledFor ?? null,
      startTime: e.startTime ?? null,
      endTime: e.endTime ?? null,
      location: e.location ?? null,
      recurrence: e.recurrence || { type: 'none' },
      completed: !!e.completed,
      context: e.context ?? 'personal'
    }));

  // Week summary (titles only)
  const tasksWeek = filterByWhere(listAllTasksRaw(), { scheduled_range: { from: fromYmd, to: toYmd }, completed: false }, { todayY: today });
  const eventsWeek = filterByWhere(listAllEventsRaw(), { scheduled_range: { from: fromYmd, to: toYmd }, completed: false }, { todayY: today });
  const pickTitles = (arr, n) => arr.slice(0, n).map(x => ({ id: x.id, title: x.title, scheduledFor: x.scheduledFor ?? null }));
  const perTypeWeek = Math.max(1, Math.floor(MAX_WEEK_TITLES / 3));

  return {
    timezone: tz,
    todayYmd: today,
    today: {
      tasks: tasksToday,
      events: eventsToday
    },
    week: {
      fromYmd,
      toYmd,
      counts: {
        tasks: tasksWeek.length,
        events: eventsWeek.length
      },
      titles: {
        tasks: pickTitles(tasksWeek, perTypeWeek),
        events: pickTitles(eventsWeek, perTypeWeek)
      },
      indexes: {
        id_to_kind: Object.fromEntries([
          ...tasksWeek.map(t => [t.id, 'task']),
          ...eventsWeek.map(e => [e.id, 'event'])
        ]),
        id_to_title: Object.fromEntries([
          ...tasksWeek.map(t => [t.id, t.title || '']),
          ...eventsWeek.map(e => [e.id, e.title || ''])
        ])
      }
    }
  };
}

