import 'package:flutter/material.dart';
import '../util/animation.dart';
import '../widgets/event_timeline.dart';
import '../widgets/task_list.dart';

class DayView extends StatelessWidget {
  final String dateYmd;
  final List<Map<String, dynamic>> events;
  final List<Map<String, dynamic>> tasks;
  final void Function(int id, String status) onSetTodoStatusOrOccurrence;
  final void Function(int id)? onEditTask;
  final void Function(int id)? onDeleteTask;
  final void Function(int id)? onEditEvent;
  final ScrollController? scrollController;

  const DayView({
    super.key,
    required this.dateYmd,
    required this.events,
    required this.tasks,
    required this.onSetTodoStatusOrOccurrence,
    this.onEditTask,
    this.onDeleteTask,
    this.onEditEvent,
    this.scrollController,
  });

  @override
  Widget build(BuildContext context) {
    // Feature toggle: unified timeline prototype (events + tasks in one column)
    const bool unified = true;

    if (!unified) {
      // Existing two-pane layout
      return Column(
        children: [
          const Divider(height: 1),
          Expanded(
            child: Row(
              children: [
                Expanded(
                  flex: 3,
                  child: EventTimeline(
                    dateYmd: dateYmd,
                    events: events,
                    onTapEvent: onEditEvent,
                    scrollController: scrollController,
                    minHour: 0,
                    maxHour: 24,
                    pixelsPerMinute: 1.2,
                  ),
                ),
                const VerticalDivider(width: 1),
                Expanded(
                  flex: 2,
                  child: TaskList(
                    tasks: tasks,
                    onSetStatus: onSetTodoStatusOrOccurrence,
                    onEdit: onEditTask,
                    onDelete: onDeleteTask,
                  ),
                ),
              ],
            ),
          ),
        ],
      );
    }

    // Unified timeline data prep
    final List<Map<String, dynamic>> allDayTasks = [];
    final List<Map<String, dynamic>> allDayEvents = [];
    final List<Map<String, dynamic>> timedUnified = [];

    // Normalize events: timed vs all-day
    for (final e in events) {
      final hasStart = ((e['startTime'] ?? '') as String).toString().isNotEmpty ||
          ((e['timeOfDay'] ?? '') as String).toString().isNotEmpty;
      if (hasStart) {
        timedUnified.add(e);
      } else {
        allDayEvents.add(e);
      }
    }

    // Normalize tasks: always render in All Day (never on timeline), even if timeOfDay is set
    for (final t in tasks) {
      allDayTasks.add(t);
    }

    // Auto-scroll to earliest timed item (one-shot heuristic)
    try {
      if (scrollController != null) {
        int _parseHmToMinutes(String? hhmm) {
          if (hhmm == null || hhmm.isEmpty) return 0;
          final parts = hhmm.split(':');
          if (parts.length != 2) return 0;
          final h = int.tryParse(parts[0]) ?? 0;
          final m = int.tryParse(parts[1]) ?? 0;
          return (h * 60) + m;
        }
        int? earliest;
        for (final itm in timedUnified) {
          final start = ((itm['startTime'] ?? itm['timeOfDay']) as String?) ?? '';
          final mins = _parseHmToMinutes(start);
          if (earliest == null || mins < earliest) earliest = mins;
        }
        if (earliest != null) {
          final double pxPerMin = 1.2; // matches EventTimeline pixelsPerMinute
          final target = (earliest * pxPerMin) - 120; // small top margin
          final desired = target < 0 ? 0.0 : target.toDouble();
          WidgetsBinding.instance.addPostFrameCallback((_) {
            try {
              if (scrollController!.hasClients) {
                final max = scrollController!.position.maxScrollExtent;
                final target = desired.clamp(0.0, max);
                final current = scrollController!.position.pixels;
                if ((current - target).abs() > 4) {
                  scrollController!.animateTo(
                    target,
                    duration: AppAnim.microInteraction,
                    curve: AppAnim.easeOut,
                  );
                }
              }
            } catch (_) {}
          });
        }
      }
    } catch (_) {}

    Widget buildAllDaySection() {
      final hasAny = allDayTasks.isNotEmpty || allDayEvents.isNotEmpty;
      if (!hasAny) return const SizedBox.shrink();
      return Padding(
        padding: const EdgeInsets.only(top: 8, left: 8, right: 8, bottom: 4),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.only(left: 4, bottom: 6),
              child: Text(
                'All Day',
                style: TextStyle(
                  fontWeight: FontWeight.w600,
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
              ),
            ),
            Card(
              clipBehavior: Clip.antiAlias,
              elevation: 0,
              color: Theme.of(context).colorScheme.surface,
              child: Column(
                children: [
                  // All-day tasks with auto-collapse + toggle
                  _AllDayTasksCollapsible(
                    dateYmd: dateYmd,
                    tasks: allDayTasks,
                    onSetStatus: onSetTodoStatusOrOccurrence,
                    onEdit: onEditTask,
                    onDelete: onDeleteTask,
                  ),
                  // All-day events
                  for (final e in allDayEvents)
                    _AllDayEventRow(
                      item: e,
                      onTap: onEditEvent,
                    ),
                ],
              ),
            ),
          ],
        ),
      );
    }

    return Column(
      children: [
        const Divider(height: 1),
        // All Day section with subtle fade/slide in
        AnimatedSwitcher(
          duration: AppAnim.microInteraction,
          switchInCurve: AppAnim.easeOut,
          switchOutCurve: AppAnim.easeIn,
          child: (allDayTasks.isEmpty && allDayEvents.isEmpty)
              ? const SizedBox.shrink()
              : TweenAnimationBuilder<double>(
                  key: ValueKey('all_day_${allDayTasks.length}_${allDayEvents.length}'),
                  duration: AppAnim.microInteraction,
                  curve: AppAnim.easeOut,
                  tween: Tween(begin: 0.0, end: 1.0),
                  builder: (context, t, child) {
                    return Opacity(
                      opacity: t,
                      child: Transform.translate(
                        offset: Offset(0, (1 - t) * 6),
                        child: child,
                      ),
                    );
                  },
                  child: buildAllDaySection(),
                ),
        ),
        // Unified timeline (timed items only)
        Expanded(
          child: AnimatedSwitcher(
            duration: AppAnim.majorTransition,
            switchInCurve: AppAnim.easeOut,
            switchOutCurve: AppAnim.easeIn,
            child: EventTimeline(
              key: ValueKey('timeline_${timedUnified.length}'),
              dateYmd: dateYmd,
              events: timedUnified,
              onTapEvent: onEditEvent,
              scrollController: scrollController,
              minHour: 0,
              maxHour: 24,
              pixelsPerMinute: 1.2,
            ),
          ),
        ),
      ],
    );
  }
}

class _AllDayTaskRow extends StatelessWidget {
  final Map<String, dynamic> item;
  final void Function(int id, String status) onSetStatus;
  final void Function(int id)? onEdit;
  final void Function(int id)? onDelete;
  const _AllDayTaskRow({
    required this.item,
    required this.onSetStatus,
    this.onEdit,
    this.onDelete,
  });

  @override
  Widget build(BuildContext context) {
    final id = (item['id'] is int) ? item['id'] as int : int.tryParse('${item['id']}') ?? -1;
    final title = (item['title'] ?? '').toString();
    final status = (item['status'] ?? (item['completed'] == true ? 'completed' : 'pending')).toString();
    final completed = status == 'completed';
    return ListTile(
      dense: true,
      leading: Checkbox(
        tristate: true,
        value: status == 'skipped' ? null : completed,
        onChanged: (_) => onSetStatus(
          id,
          status == 'skipped' ? 'pending' : (completed ? 'pending' : 'completed'),
        ),
        visualDensity: VisualDensity.compact,
      ),
      title: Text(title.isEmpty ? 'Task' : title, overflow: TextOverflow.ellipsis),
      trailing: PopupMenuButton<String>(
        onSelected: (v) {
          if (v == 'edit' && onEdit != null) onEdit!(id);
          if (v == 'delete' && onDelete != null) onDelete!(id);
        },
        itemBuilder: (context) => const [
          PopupMenuItem(value: 'edit', child: Text('Edit')),
          PopupMenuItem(value: 'delete', child: Text('Delete')),
        ],
      ),
    );
  }
}

class _AllDayEventRow extends StatelessWidget {
  final Map<String, dynamic> item;
  final void Function(int id)? onTap;
  const _AllDayEventRow({
    required this.item,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final id = (item['id'] is int) ? item['id'] as int : int.tryParse('${item['id']}') ?? -1;
    final title = (item['title'] ?? '').toString();
    final notes = (item['notes'] ?? '').toString();
    return ListTile(
      dense: true,
      leading: const Icon(Icons.event_outlined, size: 20),
      title: Text(title.isEmpty ? 'Event' : title, overflow: TextOverflow.ellipsis),
      subtitle: notes.trim().isEmpty ? null : Text(notes, maxLines: 1, overflow: TextOverflow.ellipsis),
      onTap: onTap == null ? null : () => onTap!(id),
    );
  }
}

class _AllDayTasksCollapsible extends StatefulWidget {
  final String dateYmd;
  final List<Map<String, dynamic>> tasks;
  final void Function(int id, String status) onSetStatus;
  final void Function(int id)? onEdit;
  final void Function(int id)? onDelete;
  const _AllDayTasksCollapsible({
    required this.dateYmd,
    required this.tasks,
    required this.onSetStatus,
    this.onEdit,
    this.onDelete,
  });

  @override
  State<_AllDayTasksCollapsible> createState() => _AllDayTasksCollapsibleState();
}

class _AllDayTasksCollapsibleState extends State<_AllDayTasksCollapsible> {
  static const int kBaseVisibleCount = 5;
  bool expanded = false;

  @override
  Widget build(BuildContext context) {
    final total = widget.tasks.length;
    if (total == 0) return const SizedBox.shrink();
    // Responsive threshold: 5 base, 6 on medium, 8 on tall screens
    int visibleThreshold = kBaseVisibleCount;
    try {
      final h = MediaQuery.of(context).size.height;
      if (h >= 1000) visibleThreshold = 8;
      else if (h >= 800) visibleThreshold = 6;
    } catch (_) {}
    final bool hasToggle = total > visibleThreshold;
    final int hiddenWhenCollapsed = (total - visibleThreshold).clamp(0, total);
    final visible = expanded ? total : total.clamp(0, visibleThreshold);

    final children = <Widget>[];
    for (int i = 0; i < visible; i++) {
      final t = widget.tasks[i];
      children.add(_AllDayTaskRow(
        item: t,
        onSetStatus: widget.onSetStatus,
        onEdit: widget.onEdit,
        onDelete: widget.onDelete,
      ));
    }

    // Toggle row
    if (hasToggle) {
      children.add(
        AnimatedSwitcher(
          duration: AppAnim.microInteraction,
          switchInCurve: AppAnim.easeOut,
          switchOutCurve: AppAnim.easeIn,
          child: Align(
            key: ValueKey('toggle_${expanded}_$hiddenWhenCollapsed'),
            alignment: Alignment.centerLeft,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: TextButton(
                style: TextButton.styleFrom(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                  visualDensity: VisualDensity.compact,
                ),
                onPressed: () => setState(() => expanded = !expanded),
                child: Text(
                  expanded ? 'Show less' : '$hiddenWhenCollapsed more…',
                  style: TextStyle(
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    }

    // If expanded and many tasks, enable scrolling capped to ~10 rows
    if (expanded && total > 10) {
      const int maxVisible = 10;
      const double rowHeight = 44.0; // approximate dense ListTile height
      final double maxHeight = (maxVisible * rowHeight) + 8.0; // small padding buffer
      return SizedBox(
        height: maxHeight,
        child: Scrollbar(
          thumbVisibility: true,
          child: SingleChildScrollView(
            child: Column(children: children),
          ),
        ),
      );
    }

    return Column(children: children);
  }
}


