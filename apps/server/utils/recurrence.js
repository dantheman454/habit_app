const RECURRENCE_TYPES = ['none', 'daily', 'weekdays', 'weekly', 'every_n_days'];

export function isYmdString(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

// isValidTimeOfDay removed (unused)

export function isValidRecurrence(rec) {
  if (rec === null || rec === undefined) return true;
  if (typeof rec !== 'object') return false;
  const type = rec.type;
  if (!RECURRENCE_TYPES.includes(String(type))) return false;
  if (type === 'every_n_days') {
    const n = rec.intervalDays;
    if (!Number.isInteger(n) || n < 1) return false;
  }
  if (!(rec.until === null || rec.until === undefined || isYmdString(rec.until))) return false;
  return true;
}

export function daysBetween(a, b) {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const aMid = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const bMid = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((bMid.getTime() - aMid.getTime()) / MS_PER_DAY);
}

export function matchesRule(dateObj, anchorDateObj, recurrence) {
  const type = recurrence && recurrence.type;
  if (!type || type === 'none') return false;
  if (type === 'daily') return daysBetween(anchorDateObj, dateObj) >= 0;
  if (type === 'weekdays') {
    const diff = daysBetween(anchorDateObj, dateObj);
    const wd = dateObj.getDay();
    return diff >= 0 && wd >= 1 && wd <= 5;
  }
  if (type === 'weekly') {
    const diff = daysBetween(anchorDateObj, dateObj);
    return diff >= 0 && diff % 7 === 0;
  }
  if (type === 'every_n_days') {
    const step = Number.isInteger(recurrence.intervalDays) ? recurrence.intervalDays : 0;
    const diff = daysBetween(anchorDateObj, dateObj);
    return step >= 1 && diff >= 0 && diff % step === 0;
  }
  return false;
}

export function expandOccurrences(master, fromDate, toDate, { ymd, parseYMD } = {}) {
  if (typeof ymd !== 'function' || typeof parseYMD !== 'function') {
    throw new Error('expandOccurrences requires ymd and parseYMD helpers');
  }
  const occurrences = [];
  const anchor = master.scheduledFor ? parseYMD(master.scheduledFor) : null;
  if (!anchor) return occurrences;
  const untilYmd = master.recurrence?.until ?? undefined; // null = no cap
  const untilDate = (untilYmd && isYmdString(untilYmd)) ? parseYMD(untilYmd) : null;
  const inclusiveEnd = new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate() + 1);
  for (let d = new Date(Math.max(fromDate.getTime(), anchor.getTime())); d < inclusiveEnd; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    if (untilDate && d > untilDate) break;
    if (matchesRule(d, anchor, master.recurrence)) {
      occurrences.push({
        id: master.id,
        masterId: master.id,
        scheduledFor: ymd(d),
      });
    }
  }
  return occurrences;
}


