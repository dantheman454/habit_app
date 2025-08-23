import 'package:flutter/material.dart';
import '../util/context_colors.dart';

class MonthView extends StatefulWidget {
  final List<String> gridYmd; // 42 dates (6x7), Sun..Sat rows
  final Map<String, List<Map<String, dynamic>>> eventsByDate;
  final Map<String, List<Map<String, dynamic>>> tasksByDate;
  final VoidCallback onPrev;
  final VoidCallback onNext;
  final VoidCallback onToday;
  final void Function(String ymd) onOpenDay;

  const MonthView({
    super.key,
    required this.gridYmd,
    required this.eventsByDate,
    required this.tasksByDate,
    required this.onPrev,
    required this.onNext,
    required this.onToday,
    required this.onOpenDay,
  });

  @override
  State<MonthView> createState() => _MonthViewState();
}

class _MonthViewState extends State<MonthView> {
  int? _hoveredIndex;

  @override
  Widget build(BuildContext context) {
    final labels = const ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return Column(
      children: [
        // Header
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
          child: Row(
            children: [
              IconButton(onPressed: widget.onPrev, icon: const Icon(Icons.chevron_left)),
              const Spacer(),
              FilledButton.tonal(onPressed: widget.onToday, child: const Text('Today')),
              const Spacer(),
              IconButton(onPressed: widget.onNext, icon: const Icon(Icons.chevron_right)),
            ],
          ),
        ),
        // Weekday header
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
          child: Row(
            children: List.generate(7, (i) => Expanded(
              child: Center(child: Text(labels[i], style: const TextStyle(fontWeight: FontWeight.w600))),
            )),
          ),
        ),
        const Divider(height: 1),
        // Grid 6x7
        Expanded(
          child: GridView.builder(
            gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
              crossAxisCount: 7,
              childAspectRatio: 1.1,
            ),
            itemCount: widget.gridYmd.length,
            itemBuilder: (ctx, i) {
              final y = widget.gridYmd[i];
              final ev = widget.eventsByDate[y] ?? const <Map<String, dynamic>>[];
              final tk = widget.tasksByDate[y] ?? const <Map<String, dynamic>>[];
              final today = DateTime.now();
              final todayY = '${today.year.toString().padLeft(4,'0')}-${today.month.toString().padLeft(2,'0')}-${today.day.toString().padLeft(2,'0')}';
              final isToday = y == todayY;
              return MouseRegion(
                onEnter: (_) => setState(() => _hoveredIndex = i),
                onExit: (_) => setState(() => _hoveredIndex = null),
                child: InkWell(
                  onTap: () => widget.onOpenDay(y),
                  child: Stack(
                    clipBehavior: Clip.none,
                    children: [
                      Container(
                        margin: const EdgeInsets.all(4),
                        padding: const EdgeInsets.all(6),
                        decoration: BoxDecoration(
                          borderRadius: BorderRadius.circular(8),
                          border: Border.all(
                            color: isToday
                              ? Theme.of(context).colorScheme.primary
                              : Theme.of(context).colorScheme.outlineVariant,
                            width: isToday ? 2 : 1,
                          ),
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            // Date number
                            Text(y.split('-').last, style: const TextStyle(fontWeight: FontWeight.w600)),
                            const SizedBox(height: 4),
                            // Density ticks for events (4 buckets)
                            _DensityBar(events: ev),
                            const SizedBox(height: 4),
                            // Up to 3 task badges then +N more
                            _TaskBadges(tasks: tk),
                          ],
                        ),
                      ),
                      if (_hoveredIndex == i)
                        Positioned(
                          top: 28,
                          right: 8,
                          child: IgnorePointer(
                            child: _HoverPreview(items: _interleavedTopFive(ev, tk)),
                          ),
                        ),
                    ],
                  ),
                ),
              );
            },
          ),
        ),
      ],
    );
  }

  List<_PreviewItem> _interleavedTopFive(List<Map<String, dynamic>> events, List<Map<String, dynamic>> tasks) {
    final List<_PreviewItem> items = [];
    for (final e in events) {
      items.add(_PreviewItem(
        title: (e['title'] ?? '').toString(),
        kind: 'event',
        startMinutes: _parseMinutes(e['startTime'] ?? e['timeOfDay']),
        timeLabel: _formatTimeRange(e['startTime'], e['endTime']),
      ));
    }
    for (final t in tasks) {
      items.add(_PreviewItem(
        title: (t['title'] ?? '').toString(),
        kind: 'todo',
        startMinutes: _parseMinutes(t['timeOfDay']),
        timeLabel: _formatSingleTime(t['timeOfDay']),
      ));
    }
    items.sort((a, b) => (a.startMinutes).compareTo(b.startMinutes));
    return items.take(5).toList();
  }

  int _parseMinutes(dynamic hhmm) {
    if (hhmm is String && hhmm.contains(':')) {
      final parts = hhmm.split(':');
      final h = int.tryParse(parts[0]) ?? 0;
      final m = int.tryParse(parts[1]) ?? 0;
      return (h * 60) + m;
    }
    // push items without time to the end of the list
    return 24 * 60 + 1;
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
      final label = '${h.toString().padLeft(2, '0')}:${m.toString().padLeft(2, '0')}';
      return label;
    }
    return '';
  }
}

class _DensityBar extends StatelessWidget {
  final List<Map<String, dynamic>> events;
  const _DensityBar({required this.events});

  @override
  Widget build(BuildContext context) {
    // Simple 4-bucket mapping by hour: 0–6, 6–12, 12–18, 18–24
    final buckets = List<int>.filled(4, 0);
    for (final e in events) {
      final s = (e['startTime'] ?? e['timeOfDay']) as String?;
      int hour = 0;
      if (s != null && s.contains(':')) {
        hour = int.tryParse(s.split(':').first) ?? 0;
      }
      final idx = (hour ~/ 6).clamp(0, 3);
      buckets[idx] += 1;
    }
    final maxVal = buckets.fold<int>(0, (p, c) => c > p ? c : p);
    return Row(
      children: List.generate(4, (i) {
        final frac = maxVal == 0 ? 0.0 : (buckets[i] / maxVal).clamp(0.0, 1.0);
        final h = 24 + (frac * 16);
        return Expanded(
          child: Container(
            height: h,
            margin: const EdgeInsets.symmetric(horizontal: 2),
            decoration: BoxDecoration(
              color: Colors.green.shade50,
              border: Border.all(color: Colors.green.shade200),
              borderRadius: BorderRadius.circular(4),
            ),
          ),
        );
      }),
    );
  }
}

class _TaskBadges extends StatelessWidget {
  final List<Map<String, dynamic>> tasks;
  const _TaskBadges({required this.tasks});

  @override
  Widget build(BuildContext context) {
    final show = tasks.take(3).toList();
    final more = tasks.length - show.length;
    return Wrap(
      spacing: 4,
      runSpacing: 4,
      children: [
        for (final t in show)
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
            decoration: BoxDecoration(
              color: ContextColors.taskBadgeBackground,
              border: Border.all(color: ContextColors.taskBadgeBorder),
              borderRadius: BorderRadius.circular(6),
            ),
            child: Text(
              (t['title'] ?? '').toString(),
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 11, color: ContextColors.taskBadgeText),
            ),
          ),
        if (more > 0)
          Text('+${more.toString()} more', style: TextStyle(fontSize: 11, color: Theme.of(context).colorScheme.onSurfaceVariant)),
      ],
    );
  }
}

class _PreviewItem {
  final String title;
  final String kind; // 'event' | 'todo'
  final int startMinutes; // used for sorting; 24*60+ pushes to end
  final String timeLabel;
  _PreviewItem({required this.title, required this.kind, required this.startMinutes, required this.timeLabel});
}

class _HoverPreview extends StatelessWidget {
  final List<_PreviewItem> items;
  const _HoverPreview({required this.items});

  @override
  Widget build(BuildContext context) {
    if (items.isEmpty) return const SizedBox.shrink();
    return Material(
      elevation: 2,
      borderRadius: BorderRadius.circular(8),
      child: Container(
        width: 200,
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
                      it.kind == 'event' ? Icons.event : Icons.check_circle_outline,
                      size: 14,
                      color: it.kind == 'event' ? Colors.green.shade700 : Colors.blue.shade700,
                    ),
                    const SizedBox(width: 6),
                    Expanded(
                      child: Text(
                        it.timeLabel.isEmpty ? it.title : '${it.timeLabel}  ${it.title}',
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


