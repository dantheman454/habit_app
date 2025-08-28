import 'package:flutter/material.dart';
import '../util/animation.dart';
import '../util/context_colors.dart';

class WeekView extends StatefulWidget {
  final List<String> weekYmd; // Sunday..Saturday YYYY-MM-DD
  final Map<String, List<Map<String, dynamic>>> eventsByDate;
  final Map<String, List<Map<String, dynamic>>> tasksByDate;
  final void Function(String ymd) onOpenDay;

  const WeekView({
    super.key,
    required this.weekYmd,
    required this.eventsByDate,
    required this.tasksByDate,
    required this.onOpenDay,
  });

  @override
  State<WeekView> createState() => _WeekViewState();
}

class _WeekViewState extends State<WeekView> {
  int? _hoveredIndex;
  final Set<int> _expanded = <int>{};

  @override
  Widget build(BuildContext context) {
    final labels = const ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return Column(
      children: [
        // Weekday + date header; only header opens Day view
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
          child: Row(
            children: List.generate(7, (i) {
              final y = widget.weekYmd[i];
              return Expanded(
                child: InkWell(
                  onTap: () => widget.onOpenDay(y),
                  child: Column(
                    children: [
                      Text(labels[i], style: const TextStyle(fontWeight: FontWeight.w600)),
                      const SizedBox(height: 2),
                      Text(y, style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant, fontSize: 12)),
                    ],
                  ),
                ),
              );
            }),
          ),
        ),
        const Divider(height: 1),
        Expanded(
          child: Row(
            children: List.generate(7, (i) {
              final y = widget.weekYmd[i];
              final ev = widget.eventsByDate[y] ?? const <Map<String, dynamic>>[];
              final tk = widget.tasksByDate[y] ?? const <Map<String, dynamic>>[];
              final items = _interleaveByTime(ev, tk);
              final visibleCount = (_expanded.contains(i) ? items.length : items.length.clamp(0, 4));
              final more = (items.length - visibleCount).clamp(0, items.length);
              final isHovered = _hoveredIndex == i;
              return Expanded(
                child: MouseRegion(
                  onEnter: (_) => setState(() => _hoveredIndex = i),
                  onExit: (_) => setState(() => _hoveredIndex = null),
                  child: Padding(
                    padding: const EdgeInsets.all(8.0),
                    child: Stack(
                      clipBehavior: Clip.none,
                      children: [
                        Container(
                          decoration: BoxDecoration(
                            color: Theme.of(context).colorScheme.surface,
                            border: Border.all(color: Theme.of(context).colorScheme.outlineVariant),
                            borderRadius: BorderRadius.circular(8),
                          ),
                          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                          child: AnimatedSize(
                            duration: AppAnim.medium,
                            curve: AppAnim.easeOut,
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                if (items.isEmpty)
                                  Padding(
                                    padding: const EdgeInsets.symmetric(vertical: 18),
                                    child: Center(child: Text('—', style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant))),
                                  )
                                else ...[
                                  for (int r = 0; r < visibleCount; r++) _WeekRow(item: items[r]),
                                  if (more > 0)
                                    Align(
                                      alignment: Alignment.centerLeft,
                                      child: TextButton(
                                        onPressed: () => setState(() => _expanded.add(i)),
                                        child: Text('Show $more more'),
                                      ),
                                    ),
                                ],
                              ],
                            ),
                          ),
                        ),
                        if (isHovered)
                          Positioned(
                            top: -4,
                            right: 8,
                            child: IgnorePointer(
                              child: _HoverPreview(items: items.take(5).toList()),
                            ),
                          ),
                      ],
                    ),
                  ),
                ),
              );
            }),
          ),
        ),
      ],
    );
  }

  List<Map<String, dynamic>> _interleaveByTime(List<Map<String, dynamic>> events, List<Map<String, dynamic>> tasks) {
    final List<Map<String, dynamic>> items = [];
    // Tasks first, without time labels (upper bar semantics)
    for (final t in tasks) {
      items.add({
        ...t,
        'kind': 'todo',
        // Force tasks to appear before timed events regardless of timeOfDay
        'startMinutes': -1,
        // Hide times for tasks in week view
        'timeLabel': '',
      });
    }
    // Then events, sorted by start time
    for (final e in events) {
      items.add({
        ...e,
        'kind': 'event',
        'startMinutes': _parseMinutes(e['startTime'] ?? e['timeOfDay']),
        'timeLabel': _formatTimeRange(e['startTime'], e['endTime']),
      });
    }
    items.sort((a, b) => (a['startMinutes'] as int).compareTo(b['startMinutes'] as int));
    return items;
  }

  int _parseMinutes(dynamic hhmm) {
    if (hhmm is String && hhmm.contains(':')) {
      final parts = hhmm.split(':');
      final h = int.tryParse(parts[0]) ?? 0;
      final m = int.tryParse(parts[1]) ?? 0;
      return (h * 60) + m;
    }
    return 24 * 60 + 1; // push no-time to end
  }

  String _formatTimeRange(dynamic start, dynamic end) {
    final s = _formatSingleTime(start);
    final e = _formatSingleTime(end);
    if (s.isEmpty && e.isEmpty) return '';
    if (s.isNotEmpty && e.isNotEmpty) return '$s–$e';
    return s;
  }

  String _formatSingleTime(dynamic hhmm) {
    if (hhmm is String && hhmm.contains(':')) {
      final parts = hhmm.split(':');
      final h = int.tryParse(parts[0]) ?? 0;
      final m = int.tryParse(parts[1]) ?? 0;
      return '${h.toString().padLeft(2, '0')}:${m.toString().padLeft(2, '0')}';
    }
    return '';
  }
}

class _WeekRow extends StatelessWidget {
  final Map<String, dynamic> item;
  const _WeekRow({required this.item});

  @override
  Widget build(BuildContext context) {
    final title = (item['title'] ?? '').toString();
    final time = (item['timeLabel'] ?? '').toString();
    final contextValue = (item['context'] ?? '').toString();
    final color = ContextColors.getContextColor(contextValue.isEmpty ? null : contextValue);
    final bool isTask = (item['kind'] == 'todo');
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          Container(width: 6, height: 6, decoration: BoxDecoration(color: color, shape: BoxShape.circle)),
          const SizedBox(width: 8),
          if (time.isNotEmpty) ...[
            Text(time, style: TextStyle(fontSize: 11, color: Theme.of(context).colorScheme.onSurfaceVariant)),
            const SizedBox(width: 6),
          ],
          Expanded(
            child: Text(title.isEmpty ? (item['kind'] == 'event' ? 'Event' : 'Task') : title, overflow: TextOverflow.ellipsis),
          ),
          const SizedBox(width: 6),
          if (isTask)
            Icon(Icons.check_circle_outline, size: 12, color: Colors.blue.shade700)
          else
            Icon(Icons.event, size: 12, color: Colors.green.shade700),
        ],
      ),
    );
  }
}

class _HoverPreview extends StatelessWidget {
  final List<Map<String, dynamic>> items;
  const _HoverPreview({required this.items});

  @override
  Widget build(BuildContext context) {
    if (items.isEmpty) return const SizedBox.shrink();
    return Material(
      elevation: 2,
      borderRadius: BorderRadius.circular(8),
      child: Container(
        width: 220,
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.surface,
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: Theme.of(context).colorScheme.outlineVariant),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            for (final it in items)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 2),
                child: Row(
                  children: [
                    Icon(
                      (it['kind'] == 'event') ? Icons.event : Icons.check_circle_outline,
                      size: 14,
                      color: (it['kind'] == 'event') ? Colors.green.shade700 : Colors.blue.shade700,
                    ),
                    const SizedBox(width: 6),
                    Expanded(
                      child: Text(
                        ((it['timeLabel'] ?? '') as String).isEmpty
                            ? (it['title'] ?? '').toString()
                            : '${it['timeLabel']}  ${(it['title'] ?? '').toString()}',
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    ),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}

