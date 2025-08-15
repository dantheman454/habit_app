import 'package:flutter/material.dart';

class TodoLike {
  final int id;
  final String title;
  final String notes;
  final String? timeOfDay;
  final String priority;
  final bool completed;
  final bool overdue;
  const TodoLike({
    required this.id,
    required this.title,
    required this.notes,
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

  const TodoRow({
    super.key,
    required this.todo,
    required this.onToggleCompleted,
    required this.onEdit,
    required this.onDelete,
    this.highlighted = false,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        border: Border.all(color: highlighted ? Theme.of(context).colorScheme.primary : Colors.grey.shade300, width: highlighted ? 2 : 1),
        borderRadius: BorderRadius.circular(6),
        color: highlighted
            ? Theme.of(context).colorScheme.primary.withValues(alpha: 0.06)
            : (todo.completed ? Colors.grey.withValues(alpha: 0.1) : null),
      ),
      child: Row(
        children: [
          Checkbox(value: todo.completed, onChanged: (_) => onToggleCompleted()),
          const SizedBox(width: 6),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(children: [
                  _priorityBadge(todo.priority),
                  const SizedBox(width: 6),
                  Flexible(
                    child: Text(
                      todo.title,
                      style: TextStyle(
                        decoration: todo.completed ? TextDecoration.lineThrough : null,
                      ),
                    ),
                  ),
                  if (todo.timeOfDay != null) ...[
                    const SizedBox(width: 8),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                      decoration: BoxDecoration(
                        color: const Color(0xFFEEF2FF),
                        borderRadius: BorderRadius.circular(999),
                      ),
                      child: Text(
                        todo.timeOfDay!,
                        style: TextStyle(
                          fontSize: 12,
                          color: todo.overdue ? Colors.red : null,
                        ),
                      ),
                    ),
                  ],
                ]),
                if (todo.notes.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Text(todo.notes, style: TextStyle(color: Colors.grey.shade700, fontSize: 12)),
                  ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          Wrap(spacing: 6, children: [
            OutlinedButton(onPressed: onEdit, child: const Text('Edit')),
            OutlinedButton(onPressed: onDelete, child: const Text('Delete')),
          ]),
        ],
      ),
    );
  }

  Widget _priorityBadge(String p) {
    Color bg;
    Color fg;
    switch (p) {
      case 'high':
        bg = const Color(0xFFFFC9C9);
        fg = const Color(0xFF7D1414);
        break;
      case 'low':
        bg = const Color(0xFFD3F9D8);
        fg = const Color(0xFF205B2A);
        break;
      default:
        bg = const Color(0xFFFFE8CC);
        fg = const Color(0xFF9C3B00);
    }
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(999)),
      child: Text(p, style: TextStyle(color: fg, fontSize: 12)),
    );
  }
}


