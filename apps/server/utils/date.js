export function ymd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function parseYMD(ymdStr) {
  if (typeof ymdStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(ymdStr)) return null;
  const [y, m, d] = ymdStr.split('-').map(n => parseInt(n, 10));
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || (dt.getMonth() + 1) !== m || dt.getDate() !== d) return null;
  return dt;
}

// addDays removed (unused)

export function weekRangeFromToday(tz) {
  const now = new Date();
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
    const y = parseInt(map.year, 10);
    const m = parseInt(map.month, 10);
    const d = parseInt(map.day, 10);
    const today = new Date(y, m - 1, d);
    const jsWeekday = today.getDay(); // 0..6
    const sunday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - jsWeekday);
    const saturday = new Date(sunday.getFullYear(), sunday.getMonth(), sunday.getDate() + 6);
    return { fromYmd: ymd(sunday), toYmd: ymd(saturday) };
  } catch {
    const jsWeekday = now.getDay();
    const sunday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - jsWeekday);
    const saturday = new Date(sunday.getFullYear(), sunday.getMonth(), sunday.getDate() + 6);
    return { fromYmd: ymd(sunday), toYmd: ymd(saturday) };
  }
}

export function ymdInTimeZone(date, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}


