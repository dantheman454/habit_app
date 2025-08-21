Map<String, List<Map<String, dynamic>>> groupEventsByDate(List<dynamic> items) {
  final Map<String, List<Map<String, dynamic>>> byDate = {};
  for (final raw in items) {
    if (raw is! Map) continue;
    final item = Map<String, dynamic>.from(raw as Map);
    final kind = (item['kind'] ?? '').toString();
    final date = item['scheduledFor'];
    if (kind != 'event') continue;
    if (date == null || date is! String || date.isEmpty) continue;
    final list = byDate.putIfAbsent(date, () => <Map<String, dynamic>>[]);
    list.add(Map<String, dynamic>.from(item));
  }
  return byDate;
}

Map<String, List<Map<String, dynamic>>> groupTasksByDate(List<dynamic> items) {
  final Map<String, List<Map<String, dynamic>>> byDate = {};
  for (final raw in items) {
    if (raw is! Map) continue;
    final item = Map<String, dynamic>.from(raw as Map);
    final kind = (item['kind'] ?? '').toString();
    final date = item['scheduledFor'];
    if (kind == 'event') continue;
    if (date == null || date is! String || date.isEmpty) continue;
    final list = byDate.putIfAbsent(date, () => <Map<String, dynamic>>[]);
    list.add(Map<String, dynamic>.from(item));
  }
  return byDate;
}


