export function endOfCurrentYearYmd() {
  try {
    const now = new Date();
    return `${now.getFullYear()}-12-31`;
  } catch { return '2099-12-31'; }
}

export function normalizeTodo(todo) {
  try {
    const t = { ...todo };
    if (t.timeOfDay === undefined) t.timeOfDay = null;
    if (!t || typeof t.recurrence !== 'object') {
      t.recurrence = { type: 'none', until: endOfCurrentYearYmd() };
    } else {
      if (!t.recurrence.type) t.recurrence.type = 'none';
      if (t.recurrence.until === undefined) t.recurrence.until = endOfCurrentYearYmd();
    }
    if (t.recurrence.type !== 'none') {
      if (!Array.isArray(t.completedDates)) t.completedDates = [];
    }
    if (typeof t.completed !== 'boolean') t.completed = false;
    return t;
  } catch {
    return todo;
  }
}

export function normalizeHabit(habit) {
  try {
    const h = { ...habit };
    if (h.timeOfDay === undefined) h.timeOfDay = null;
    if (!h || typeof h.recurrence !== 'object') {
      h.recurrence = { type: 'daily', until: endOfCurrentYearYmd() };
    } else {
      if (!h.recurrence.type) h.recurrence.type = 'daily';
      if (h.recurrence.until === undefined) h.recurrence.until = endOfCurrentYearYmd();
    }
    if (!Array.isArray(h.completedDates)) h.completedDates = [];
    if (typeof h.completed !== 'boolean') h.completed = false;
    return h;
  } catch {
    return habit;
  }
}

export function applyRecurrenceMutation(targetTodo, incomingRecurrence) {
  const t = targetTodo;
  const nextType = incomingRecurrence?.type || 'none';
  const prevType = t?.recurrence?.type || 'none';
  t.recurrence = { ...(t.recurrence || {}), ...(incomingRecurrence || {}) };
  if (prevType === 'none' && nextType !== 'none') {
    t.completedDates = Array.isArray(t.completedDates) ? t.completedDates : [];
    t.skippedDates = Array.isArray(t.skippedDates) ? t.skippedDates : [];
  }
  if (nextType === 'none') {
    delete t.completedDates;
    delete t.skippedDates;
  }
  return t;
}


