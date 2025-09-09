import '../models.dart';

// Lightweight date label formatter without intl.
// Contract: prettyDateLabel(ViewMode view, String anchorYmd)
String prettyDateLabel(ViewMode view, String anchorYmd) {
  final a = _parseYmd(anchorYmd);
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const monthsAbbrev = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
  ];
  const monthsFull = [
    'January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'
  ];

  switch (view) {
    case ViewMode.day:
      final wd = weekdays[a.weekday % 7]; // Sunday=0
      final m = monthsAbbrev[a.month - 1];
      return '$wd, $m ${a.day}, ${a.year}';
    case ViewMode.week:
      final sunday = a.subtract(Duration(days: a.weekday % 7));
      final saturday = sunday.add(const Duration(days: 6));
      final sameMonth = sunday.month == saturday.month;
      if (sameMonth) {
        final m = monthsAbbrev[sunday.month - 1];
        return '$m ${sunday.day}–${saturday.day}, ${saturday.year}';
      } else {
        final m1 = monthsAbbrev[sunday.month - 1];
        final m2 = monthsAbbrev[saturday.month - 1];
        return '$m1 ${sunday.day}–$m2 ${saturday.day}, ${saturday.year}';
      }
    case ViewMode.month:
      final m = monthsFull[a.month - 1];
      return '$m ${a.year}';
  }
}

DateTime _parseYmd(String s) {
  final parts = s.split('-');
  return DateTime(
    int.parse(parts[0]),
    int.parse(parts[1]),
    int.parse(parts[2]),
  );
}
