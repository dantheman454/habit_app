import 'package:flutter/material.dart';
import '../util/context_colors.dart';
import '../util/time_format.dart';

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
  final Set<int> _expanded = <int>{};

  @override
  Widget build(BuildContext context) {
    final labels = const ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return Column(
      children: [
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
              // Slightly taller cells reduce empty whitespace look on sparse months
              childAspectRatio: 1.0,
            ),
            itemCount: widget.gridYmd.length,
            itemBuilder: (ctx, i) {
              final y = widget.gridYmd[i];
              final ev = widget.eventsByDate[y] ?? const <Map<String, dynamic>>[];
              final tk = widget.tasksByDate[y] ?? const <Map<String, dynamic>>[];
              final items = _interleaved(ev, tk);
              final today = DateTime.now();
              final todayY = '${today.year.toString().padLeft(4,'0')}-${today.month.toString().padLeft(2,'0')}-${today.day.toString().padLeft(2,'0')}';
              final isToday = y == todayY;
              return MouseRegion(
                onEnter: (_) => setState(() => _hoveredIndex = i),
                onExit: (_) => setState(() { _hoveredIndex = null; _expanded.remove(i); }),
                child: Focus(
                  onFocusChange: (has) { if (!has) setState(() { _expanded.remove(i); }); },
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
                          child: _MonthCell(
                            ymd: y,
                            items: items,
                            expanded: _expanded.contains(i),
                            onExpand: () => setState(() => _expanded.add(i)),
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
    // Events first, ordered by start time
    for (final e in events) {
      items.add(_PreviewItem(
        title: (e['title'] ?? '').toString(),
        kind: 'event',
        startMinutes: _parseMinutes(e['startTime']),
        timeLabel: _formatTimeRange(e['startTime'], e['endTime']),
        notes: (e['notes'] ?? '').toString(),
      ));
    }
    // Then tasks, without time labels; push after any event by assigning a large startMinutes
    for (final t in tasks) {
      items.add(_PreviewItem(
        title: (t['title'] ?? '').toString(),
        kind: 'task',
        startMinutes: 24 * 60 + 1,
        timeLabel: '',
        notes: (t['notes'] ?? '').toString(),
      ));
    }
    items.sort((a, b) => (a.startMinutes).compareTo(b.startMinutes));
    return items.take(5).toList();
  }

  List<_PreviewItem> _interleaved(List<Map<String, dynamic>> events, List<Map<String, dynamic>> tasks) {
    final List<_PreviewItem> items = [];
    // Events first, ordered by start time
    for (final e in events) {
      items.add(_PreviewItem(
        title: (e['title'] ?? '').toString(),
        kind: 'event',
        startMinutes: _parseMinutes(e['startTime']),
        timeLabel: _formatTimeRange(e['startTime'], e['endTime']),
        notes: (e['notes'] ?? '').toString(),
        contextValue: (e['context'] ?? '').toString(),
      ));
    }
    // Then tasks, without time labels; push after any event
    for (final t in tasks) {
      items.add(_PreviewItem(
        title: (t['title'] ?? '').toString(),
        kind: 'task',
        startMinutes: 24 * 60 + 1,
        timeLabel: '',
        notes: (t['notes'] ?? '').toString(),
        contextValue: (t['context'] ?? '').toString(),
      ));
    }
    items.sort((a, b) => (a.startMinutes).compareTo(b.startMinutes));
    return items;
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
      return AmericanTimeFormat.to12h(hhmm);
    }
    return '';
  }
}


class _PreviewItem {
  final String title;
  final String kind; // 'event' | 'task'
  final int startMinutes; // used for sorting; 24*60+ pushes to end
  final String timeLabel;
  final String? notes;
  final String contextValue;
  _PreviewItem({required this.title, required this.kind, required this.startMinutes, required this.timeLabel, this.notes, this.contextValue = ''});
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
                      child: Builder(builder: (context) {
                        final title = it.title;
                        final firstLine = (it.notes ?? '').split('\n').first.trim();
                        final suffix = firstLine.isEmpty ? '' : ' • ${firstLine.length > 40 ? firstLine.substring(0, 40) + '…' : firstLine}';
                        final base = it.timeLabel.isEmpty ? title : '${it.timeLabel}  $title';
                        return Text(
                          '$base$suffix',
                          overflow: TextOverflow.ellipsis,
                          style: Theme.of(context).textTheme.bodySmall,
                        );
                      }),
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


class _MonthCell extends StatelessWidget {
  final String ymd;
  final List<_PreviewItem> items;
  final bool expanded;
  final VoidCallback onExpand;
  const _MonthCell({required this.ymd, required this.items, required this.expanded, required this.onExpand});

  @override
  Widget build(BuildContext context) {
    final day = ymd.split('-').last;
    final visible = expanded ? items : items.take(4).toList();
    final more = items.length - visible.length;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(day, style: const TextStyle(fontWeight: FontWeight.w600)),
        const SizedBox(height: 6),
        ...visible.map((it) => _MonthRow(item: it)),
        if (more > 0)
          TextButton(
            onPressed: onExpand,
            child: Text('Show $more more'),
          ),
      ],
    );
  }
}

class _MonthRow extends StatelessWidget {
  final _PreviewItem item;
  const _MonthRow({required this.item});

  @override
  Widget build(BuildContext context) {
    final color = ContextColors.getContextColor(
      (item.contextValue.isEmpty) ? null : item.contextValue,
    );
    final bool isTask = (item.kind == 'task');
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        children: [
          Container(width: 6, height: 6, decoration: BoxDecoration(color: color, shape: BoxShape.circle)),
          const SizedBox(width: 6),
          if (item.timeLabel.isNotEmpty) ...[
            Text(item.timeLabel, style: TextStyle(fontSize: 11, color: Theme.of(context).colorScheme.onSurfaceVariant)),
            const SizedBox(width: 6),
          ],
          Expanded(
            child: Text(
              item.title.isEmpty ? (item.kind == 'event' ? 'Event' : 'Task') : item.title,
              overflow: TextOverflow.ellipsis,
            ),
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


