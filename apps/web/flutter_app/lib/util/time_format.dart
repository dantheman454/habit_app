class AmericanTimeFormat {
  static String to12h(String? hhmm) {
    if (hhmm == null || hhmm.isEmpty || !hhmm.contains(':')) return '';
    final parts = hhmm.split(':');
    int h = int.tryParse(parts[0]) ?? 0;
    final m = int.tryParse(parts[1]) ?? 0;
    final isPm = h >= 12;
    int hour12 = h % 12;
    if (hour12 == 0) hour12 = 12;
    final mm = m.toString().padLeft(2, '0');
    return '$hour12:$mm ${isPm ? 'PM' : 'AM'}';
  }

  static String hourLabel12(int hour0to23) {
    final isPm = hour0to23 >= 12;
    int hour12 = hour0to23 % 12;
    if (hour12 == 0) hour12 = 12;
    return '$hour12 ${isPm ? 'PM' : 'AM'}';
  }

  static String? parseFlexible(String input) {
    final s = input.trim();
    if (s.isEmpty) return null;
    final lower = s.toLowerCase();
    final hasAm = lower.endsWith('am');
    final hasPm = lower.endsWith('pm');
    final core = (hasAm || hasPm) ? lower.replaceAll(RegExp(r'\s*(am|pm)\s*$'), '') : lower;
    if (!core.contains(':')) return null;
    final parts = core.split(':');
    if (parts.length != 2) return null;
    int? h = int.tryParse(parts[0].trim());
    int? m = int.tryParse(parts[1].trim());
    if (h == null || m == null || m < 0 || m > 59) return null;
    if (hasAm || hasPm) {
      if (h < 1 || h > 12) return null;
      if (hasAm) {
        if (h == 12) h = 0;
      } else {
        if (h != 12) h = h + 12;
      }
    } else {
      if (h < 0 || h > 23) return null;
    }
    final hh = h.toString().padLeft(2, '0');
    final mm = m.toString().padLeft(2, '0');
    return '$hh:$mm';
  }

  static String roundToNearestHour24(DateTime dt) {
    int h = dt.hour;
    h = dt.minute >= 30 ? (h + 1) % 24 : h;
    return '${h.toString().padLeft(2, '0')}:00';
  }

  static ({String hhmm, bool wrapped}) addOneHour(String hhmm) {
    final parts = hhmm.split(':');
    int h = int.tryParse(parts[0]) ?? 0;
    final m = int.tryParse(parts[1]) ?? 0;
    int nh = (h + 1) % 24;
    final wrapped = nh == 0 && h == 23 && m >= 0;
    return (hhmm: '${nh.toString().padLeft(2, '0')}:${m.toString().padLeft(2, '0')}', wrapped: wrapped);
  }
}


