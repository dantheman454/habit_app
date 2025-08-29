import 'package:flutter/material.dart';

class FabActions extends StatelessWidget {
  final VoidCallback onCreateTask;
  final VoidCallback onCreateEvent;
  final String? currentDate; // For smart defaults

  const FabActions({
    super.key,
    required this.onCreateTask,
    required this.onCreateEvent,
    this.currentDate,
  });

  @override
  Widget build(BuildContext context) {
    return PopupMenuButton<String>(
      onSelected: (v) {
        if (v == 'task') {
          onCreateTask();
        } else if (v == 'event') {
          onCreateEvent();
        }
      },
      itemBuilder: (c) => [
        PopupMenuItem<String>(
          value: 'task',
          child: Row(
            children: [
              const Icon(Icons.task, size: 18),
              const SizedBox(width: 8),
              const Text('New Task'),
              if (currentDate != null) ...[
                const Spacer(),
                Text(
                  currentDate!,
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
            ],
          ),
        ),
        PopupMenuItem<String>(
          value: 'event',
          child: Row(
            children: [
              const Icon(Icons.event, size: 18),
              const SizedBox(width: 8),
              const Text('New Event'),
              if (currentDate != null) ...[
                const Spacer(),
                Text(
                  currentDate!,
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
            ],
          ),
        ),
      ],
      child: FloatingActionButton(
        onPressed: null,
        child: const Icon(Icons.add),
      ),
    );
  }
}
