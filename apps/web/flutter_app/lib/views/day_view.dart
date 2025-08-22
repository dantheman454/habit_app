import 'package:flutter/material.dart';
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
    return Column(
      children: [
        // Date navigation removed - no longer showing scroll wheel
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
                  pixelsPerMinute: 2.0,
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
}


