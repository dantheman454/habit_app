import 'package:flutter/material.dart';
import '../widgets/event_timeline.dart';

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
  late final List<ScrollController> _controllers;
  static const double _pxPerMin = 2.0; // shared scale for all columns

  @override
  void initState() {
    super.initState();
    _controllers = List.generate(7, (_) => ScrollController());
    for (var i = 0; i < _controllers.length; i++) {
      _controllers[i].addListener(() => _onScrollFrom(i));
    }
  }

  bool _syncing = false;
  void _onScrollFrom(int srcIndex) {
    if (_syncing) return;
    if (!_controllers[srcIndex].hasClients) return;
    _syncing = true;
    final offset = _controllers[srcIndex].offset;
    for (var i = 0; i < _controllers.length; i++) {
      final c = _controllers[i];
      if (!c.hasClients || i == srcIndex) continue;
      if ((c.offset - offset).abs() > 1) {
        c.jumpTo(offset);
      }
    }
    _syncing = false;
  }

  @override
  void dispose() {
    for (final c in _controllers) {
      c.removeListener(() {}); // listeners are anonymous closures; safe to dispose controllers directly
      c.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final labels = const ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return Column(
      children: [
        // Weekday header
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
          child: Row(
            children: List.generate(7, (i) {
              return Expanded(
                child: Column(
                  children: [
                    Text(labels[i], style: const TextStyle(fontWeight: FontWeight.w600)),
                    const SizedBox(height: 2),
                    Text(widget.weekYmd[i], style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant, fontSize: 12)),
                  ],
                ),
              );
            }),
          ),
        ),
        const Divider(height: 1),
        // Columns
        Expanded(
          child: Row(
            children: List.generate(7, (i) {
              final y = widget.weekYmd[i];
              final ev = widget.eventsByDate[y] ?? const <Map<String, dynamic>>[];
              final tk = widget.tasksByDate[y] ?? const <Map<String, dynamic>>[];
              return Expanded(
                child: InkWell(
                  onTap: () => widget.onOpenDay(y),
                  child: Padding(
                    padding: const EdgeInsets.all(8.0),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('Events (${ev.length})', style: const TextStyle(fontWeight: FontWeight.w600)),
                        const SizedBox(height: 6),
                        // Scroll-synced compact timeline (shared pixelsPerMinute)
                        SizedBox(
                          height: 180,
                          child: Container(
                            decoration: BoxDecoration(
                              border: Border.all(color: Theme.of(context).colorScheme.outlineVariant),
                              borderRadius: BorderRadius.circular(6),
                            ),
                            child: ClipRRect(
                              borderRadius: BorderRadius.circular(6),
                              child: ev.isEmpty
                                  ? Center(
                                      child: Text(
                                        '—',
                                        style: TextStyle(
                                          color: Theme.of(context).colorScheme.onSurfaceVariant,
                                        ),
                                      ),
                                    )
                                  : EventTimeline(
                                      dateYmd: y,
                                      events: ev,
                                      minHour: 6,
                                      maxHour: 22,
                                      scrollController: _controllers[i],
                                      pixelsPerMinute: _pxPerMin,
                                    ),
                            ),
                          ),
                        ),
                        const SizedBox(height: 8),
                        Text('Tasks (${tk.length})', style: const TextStyle(fontWeight: FontWeight.w600)),
                        const SizedBox(height: 6),
                        // Responsive tasks disclosure
                        LayoutBuilder(
                          builder: (ctx, cons) {
                            final screenW = MediaQuery.of(ctx).size.width;
                            final wide = screenW >= 1200;
                            if (wide) {
                              // Show a simple visible list of task titles (max 5)
                              final show = tk.take(5).toList();
                              return Container(
                                height: 140,
                                decoration: BoxDecoration(
                                  border: Border.all(color: Theme.of(context).colorScheme.outlineVariant),
                                  borderRadius: BorderRadius.circular(6),
                                ),
                                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                                child: show.isEmpty
                                    ? Center(child: Text('—', style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant)))
                                    : ListView.separated(
                                        itemCount: show.length,
                                        separatorBuilder: (_, __) => const Divider(height: 1),
                                        itemBuilder: (_, i) {
                                          final t = show[i];
                                          final title = (t['title'] ?? '').toString();
                                          final time = (t['timeOfDay'] ?? '').toString();
                                          return Row(
                                            children: [
                                              Expanded(child: Text(title.isEmpty ? 'Task' : title, overflow: TextOverflow.ellipsis)),
                                              if (time.isNotEmpty) ...[
                                                const SizedBox(width: 6),
                                                Container(
                                                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                                  decoration: BoxDecoration(
                                                    color: Colors.blue.shade50,
                                                    border: Border.all(color: Colors.blue.shade200),
                                                    borderRadius: BorderRadius.circular(999),
                                                  ),
                                                  child: Text(time, style: TextStyle(fontSize: 11, color: Colors.blue.shade900)),
                                                ),
                                              ],
                                            ],
                                          );
                                        },
                                      ),
                              );
                            }
                            // Collapse into ExpansionTile on narrow screens
                            return Container(
                              decoration: BoxDecoration(
                                border: Border.all(color: Theme.of(context).colorScheme.outlineVariant),
                                borderRadius: BorderRadius.circular(6),
                              ),
                              child: Theme(
                                data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
                                child: ExpansionTile(
                                  tilePadding: const EdgeInsets.symmetric(horizontal: 8),
                                  title: Text('Tasks (${tk.length})'),
                                  childrenPadding: const EdgeInsets.only(left: 8, right: 8, bottom: 8),
                                  children: tk.isEmpty
                                      ? [Center(child: Text('—', style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant)))]
                                      : tk.take(7).map((t) {
                                          final title = (t['title'] ?? '').toString();
                                          final time = (t['timeOfDay'] ?? '').toString();
                                          return Padding(
                                            padding: const EdgeInsets.symmetric(vertical: 2),
                                            child: Row(
                                              children: [
                                                Expanded(child: Text(title.isEmpty ? 'Task' : title, overflow: TextOverflow.ellipsis)),
                                                if (time.isNotEmpty) ...[
                                                  const SizedBox(width: 6),
                                                  Container(
                                                    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                                    decoration: BoxDecoration(
                                                      color: Colors.blue.shade50,
                                                      border: Border.all(color: Colors.blue.shade200),
                                                      borderRadius: BorderRadius.circular(999),
                                                    ),
                                                    child: Text(time, style: TextStyle(fontSize: 11, color: Colors.blue.shade900)),
                                                  ),
                                                ],
                                              ],
                                            ),
                                          );
                                        }).toList(),
                                ),
                              ),
                            );
                          },
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
}


