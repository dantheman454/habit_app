import 'package:flutter/material.dart';

class TodoLike {
  final int id;
  final String title;
  final String notes;
  final String? kind; // 'todo'|'event'|'habit'
  final String? timeOfDay;
  final String? status; // 'pending'|'completed'|'skipped' (todos)
  final bool completed; // events/habits or derived for UI
  final bool overdue;
  const TodoLike({
    required this.id,
    required this.title,
    required this.notes,
    this.kind,
    this.timeOfDay,
    this.status,
    required this.completed,
    this.overdue = false,
  });
}

class TodoRow extends StatelessWidget {
  final TodoLike todo;
  final VoidCallback onToggleCompleted;
  final VoidCallback? onToggleSkipped; // only meaningful for todos
  final VoidCallback onEdit;
  final VoidCallback onDelete;
  final bool highlighted;
  final Widget? extraBadge; // optional, placed in the header row
  final void Function(String newTitle)? onTitleEdited;
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
    this.onTimeEdited,
    this.onToggleSkipped,
  });

  @override
  Widget build(BuildContext context) {
  final isSkipped = (todo.status == 'skipped');
  final isCompleted = todo.completed || (todo.status == 'completed');
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
      : (isCompleted
        ? Colors.grey.withOpacity(0.1)
        : (isSkipped ? Colors.orange.withOpacity(0.06) : null)),
      ),
      child: Row(
        children: [
          Checkbox(
      value: isCompleted,
            onChanged: (_) => onToggleCompleted(),
          ),
          const SizedBox(width: 6),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
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
                                if (ok == true) {
                                  onTitleEdited!(ctrl.text.trim());
                                }
                              },
                        child: Text(
                          todo.title,
                          style: TextStyle(
                            decoration: isCompleted
                                ? TextDecoration.lineThrough
                                : null,
                            color: isSkipped ? Colors.black54 : null,
                            fontStyle: isSkipped ? FontStyle.italic : null,
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
              if (todo.kind == 'todo')
                OutlinedButton.icon(
                  onPressed: onToggleSkipped,
                  icon: Icon(
                    Icons.do_not_disturb_on,
                    size: 16,
                    color: isSkipped
                        ? Theme.of(context).colorScheme.primary
                        : Colors.black54,
                  ),
                  label: Text(isSkipped ? 'Unskip' : 'Skip'),
                ),
              OutlinedButton(onPressed: onEdit, child: const Text('Edit')),
              OutlinedButton(onPressed: onDelete, child: const Text('Delete')),
            ],
          ),
        ],
      ),
    );
  }

  // _kindIcon removed (unused) to reduce analyzer noise.
}
