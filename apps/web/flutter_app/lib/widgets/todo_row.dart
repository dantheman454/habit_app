import 'package:flutter/material.dart';
import 'package:flutter_app/widgets/priority_chip.dart' as pc;

class TodoLike {
  final int id;
  final String title;
  final String notes;
  final String? kind; // 'todo'|'event'|'habit'
  final String? timeOfDay;
  final String priority;
  final bool completed;
  final bool overdue;
  const TodoLike({
    required this.id,
    required this.title,
    required this.notes,
    this.kind,
    this.timeOfDay,
    required this.priority,
    required this.completed,
    this.overdue = false,
  });
}

class TodoRow extends StatelessWidget {
  final TodoLike todo;
  final VoidCallback onToggleCompleted;
  final VoidCallback onEdit;
  final VoidCallback onDelete;
  final bool highlighted;
  final Widget? extraBadge; // optional, placed in the header row after priority
  final void Function(String newTitle)? onTitleEdited;
  final void Function(String newPriority)?
  onPriorityEdited; // expects 'low'|'medium'|'high'
  final void Function(String? newTimeOfDay)? onTimeEdited; // 'HH:MM' or null

  const TodoRow({
    super.key,
    required this.todo,
    required this.onToggleCompleted,
    required this.onEdit,
    required this.onDelete,
    this.highlighted = false,
    this.extraBadge,
    this.onTitleEdited,
    this.onPriorityEdited,
    this.onTimeEdited,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        border: Border.all(
          color: highlighted
              ? Theme.of(context).colorScheme.primary
              : Colors.grey.shade300,
          width: highlighted ? 2 : 1,
        ),
        borderRadius: BorderRadius.circular(6),
        color: highlighted
            ? Theme.of(context).colorScheme.primary.withOpacity(0.06)
            : (todo.completed ? Colors.grey.withOpacity(0.1) : null),
      ),
      child: Row(
        children: [
          Checkbox(
            value: todo.completed,
            onChanged: (_) => onToggleCompleted(),
          ),
          const SizedBox(width: 6),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    GestureDetector(
                      onTap: () {
                        if (onPriorityEdited == null) return;
                        final next = (todo.priority == 'low')
                            ? 'medium'
                            : (todo.priority == 'medium')
                            ? 'high'
                            : 'low';
                        onPriorityEdited!(next);
                      },
                      child: pc.priorityChip(
                        todo.priority,
                        Theme.of(context).colorScheme,
                      ),
                    ),
                    if (extraBadge != null) ...[
                      const SizedBox(width: 6),
                      extraBadge!,
                    ],
                    const SizedBox(width: 6),
                    Flexible(
                      child: InkWell(
                        onTap: onTitleEdited == null
                            ? null
                            : () async {
                                final ctrl = TextEditingController(
                                  text: todo.title,
                                );
                                final ok = await showDialog<bool>(
                                  context: context,
                                  builder: (c) => AlertDialog(
                                    title: const Text('Edit title'),
                                    content: TextField(
                                      controller: ctrl,
                                      autofocus: true,
                                    ),
                                    actions: [
                                      TextButton(
                                        onPressed: () =>
                                            Navigator.pop(c, false),
                                        child: const Text('Cancel'),
                                      ),
                                      FilledButton(
                                        onPressed: () => Navigator.pop(c, true),
                                        child: const Text('Save'),
                                      ),
                                    ],
                                  ),
                                );
                                if (ok == true)
                                  onTitleEdited!(ctrl.text.trim());
                              },
                        child: Text(
                          todo.title,
                          style: TextStyle(
                            decoration: todo.completed
                                ? TextDecoration.lineThrough
                                : null,
                          ),
                        ),
                      ),
                    ),
                    if (todo.timeOfDay != null) ...[
                      const SizedBox(width: 8),
                      InkWell(
                        onTap: onTimeEdited == null
                            ? null
                            : () async {
                                final ctrl = TextEditingController(
                                  text: todo.timeOfDay ?? '',
                                );
                                final ok = await showDialog<bool>(
                                  context: context,
                                  builder: (c) => AlertDialog(
                                    title: const Text('Edit time (HH:MM)'),
                                    content: TextField(
                                      controller: ctrl,
                                      autofocus: true,
                                    ),
                                    actions: [
                                      TextButton(
                                        onPressed: () =>
                                            Navigator.pop(c, false),
                                        child: const Text('Cancel'),
                                      ),
                                      FilledButton(
                                        onPressed: () => Navigator.pop(c, true),
                                        child: const Text('Save'),
                                      ),
                                    ],
                                  ),
                                );
                                if (ok == true) {
                                  final v = ctrl.text.trim();
                                  onTimeEdited!(v.isEmpty ? null : v);
                                }
                              },
                        child: Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 8,
                            vertical: 2,
                          ),
                          decoration: BoxDecoration(
                            color: Theme.of(
                              context,
                            ).colorScheme.surfaceContainerHigh,
                            borderRadius: BorderRadius.circular(999),
                            border: Border.all(
                              color: Theme.of(context).colorScheme.outline,
                            ),
                          ),
                          child: Text(
                            todo.timeOfDay!,
                            style: TextStyle(
                              fontSize: 12,
                              color: todo.overdue
                                  ? Theme.of(context).colorScheme.error
                                  : Theme.of(
                                      context,
                                    ).colorScheme.onSurfaceVariant,
                            ),
                          ),
                        ),
                      ),
                    ],
                  ],
                ),
                if (todo.notes.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Text(
                      todo.notes,
                      style: TextStyle(
                        color: Colors.grey.shade700,
                        fontSize: 12,
                      ),
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          Wrap(
            spacing: 6,
            children: [
              OutlinedButton(onPressed: onEdit, child: const Text('Edit')),
              OutlinedButton(onPressed: onDelete, child: const Text('Delete')),
            ],
          ),
        ],
      ),
    );
  }

  Widget _kindIcon(String kind) {
    IconData icon;
    if (kind == 'event')
      icon = Icons.event;
    else if (kind == 'habit')
      icon = Icons.repeat;
    else
      icon = Icons.check_circle_outline;
    return Icon(icon, size: 12, color: Colors.black54);
  }
}
