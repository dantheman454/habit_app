import 'package:flutter/material.dart';
import '../widgets/event_timeline.dart';
import '../widgets/task_list.dart';

class DayView extends StatelessWidget {
  final String dateYmd;
  final List<Map<String, dynamic>> events;
  final List<Map<String, dynamic>> tasks;
  final VoidCallback onPrev;
  final VoidCallback onNext;
  final VoidCallback onToday;
  final void Function(int id, bool completed) onToggleEventOccurrence;
  final void Function(int id, String status) onSetTodoStatusOrOccurrence;

  const DayView({
    super.key,
    required this.dateYmd,
    required this.events,
    required this.tasks,
    required this.onPrev,
    required this.onNext,
    required this.onToday,
    required this.onToggleEventOccurrence,
    required this.onSetTodoStatusOrOccurrence,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Row(
          children: [
            IconButton(onPressed: onPrev, icon: const Icon(Icons.chevron_left)),
            Text(dateYmd, style: Theme.of(context).textTheme.titleMedium),
            IconButton(onPressed: onNext, icon: const Icon(Icons.chevron_right)),
            const Spacer(),
            TextButton(onPressed: onToday, child: const Text('Today')),
          ],
        ),
        const Divider(height: 1),
        Expanded(
          child: Row(
            children: [
              Expanded(
                flex: 3,
                child: EventTimeline(
                  dateYmd: dateYmd,
                  events: events,
                  onToggleCompleted: onToggleEventOccurrence,
                ),
              ),
              const VerticalDivider(width: 1),
              Expanded(
                flex: 2,
                child: TaskList(
                  tasks: tasks,
                  onSetStatus: onSetTodoStatusOrOccurrence,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}


