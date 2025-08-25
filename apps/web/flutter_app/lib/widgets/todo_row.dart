import 'package:flutter/material.dart';
import '../util/context_colors.dart';
import 'expandable_text.dart';

class TodoLike {
  final int id;
  final String title;
  final String notes;
  final String? kind; // 'todo'|'event'|'habit'
  final String? timeOfDay;
  final String? status; // 'pending'|'completed'|'skipped' (todos)
  final bool completed; // events/habits or derived for UI
  final bool overdue;
  final String? context; // 'school'|'personal'|'work'
  const TodoLike({
    required this.id,
    required this.title,
    required this.notes,
    this.kind,
    this.timeOfDay,
    this.status,
    required this.completed,
    this.overdue = false,
    this.context,
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

    // Context-based colors
    final contextColor = todo.context != null
        ? ContextColors.getContextColor(todo.context)
        : Colors.grey.shade600;
    final borderColor = contextColor.withOpacity(0.3);

    return AnimatedSize(
      duration: const Duration(milliseconds: 300),
      curve: Curves.easeOutCubic,
      alignment: Alignment.topCenter,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 300),
        curve: Curves.easeOutCubic,
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        border: Border.all(
          color: highlighted
              ? Theme.of(context).colorScheme.primary
              : borderColor,
          width: highlighted ? 2 : 1,
        ),
        borderRadius: BorderRadius.circular(8),
        color: highlighted
            ? Theme.of(
                context,
              ).colorScheme.primary.withAlpha((0.06 * 255).round())
            : (isCompleted
                  ? Colors.grey.withAlpha((0.1 * 255).round())
                  : (isSkipped
                        ? Colors.orange.withAlpha((0.06 * 255).round())
                        : ContextColors.getContextBackgroundColor(
                            todo.context,
                          ))),
      ),
        child: Row(
        children: [
          AnimatedScale(
            duration: const Duration(milliseconds: 200),
            scale: isCompleted ? 1.1 : 1.0,
            child: Checkbox(
              tristate: true,
              value: isSkipped ? null : isCompleted,
              fillColor: MaterialStateProperty.resolveWith<Color?>((states) {
                if (isSkipped) return Colors.amber; // distinct look for skipped
                if (isCompleted) return Theme.of(context).colorScheme.primary;
                return Theme.of(
                  context,
                ).colorScheme.surfaceTint.withOpacity(0.4);
              }),
              onChanged: (_) =>
                  isSkipped ? (onToggleSkipped?.call()) : onToggleCompleted(),
            ),
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
                    _buildKindBadge(todo.kind ?? 'todo'),
                    const SizedBox(width: 4), // Reduced spacing
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
                        child: AnimatedDefaultTextStyle(
                          duration: const Duration(milliseconds: 300),
                          style: TextStyle(
                            decoration: isCompleted
                                ? TextDecoration.lineThrough
                                : null,
                            color: isSkipped ? Colors.black54 : null,
                            fontStyle: isSkipped ? FontStyle.italic : null,
                          ),
                          child: Text(todo.title),
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
                // Context badge moved to next to kind badge
                if (todo.notes.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: ExpandableText(
                      todo.notes,
                      maxLines: 2,
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
          // Compact action buttons with staggered animations
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (todo.kind == 'todo')
                AnimatedOpacity(
                  duration: const Duration(milliseconds: 300),
                  opacity: 1.0,
                  child: IconButton(
                    icon: Icon(
                      isSkipped ? Icons.undo : Icons.do_not_disturb_on,
                      size: 18,
                      color: isSkipped ? Colors.blue : Colors.red,
                    ),
                    onPressed: onToggleSkipped,
                    tooltip: isSkipped ? 'Unskip' : 'Skip',
                  ),
                ),
              AnimatedOpacity(
                duration: const Duration(milliseconds: 300),
                opacity: 1.0,
                child: IconButton(
                  icon: const Icon(Icons.edit, size: 18),
                  onPressed: onEdit,
                  tooltip: 'Edit',
                ),
              ),
              AnimatedOpacity(
                duration: const Duration(milliseconds: 300),
                opacity: 1.0,
                child: IconButton(
                  icon: const Icon(Icons.delete, size: 18),
                  onPressed: onDelete,
                  tooltip: 'Delete',
                ),
              ),
            ],
          ),
        ],
        ),
      ),
    );
  }

  Widget _buildContextBadge(String context) {
    final color = ContextColors.getContextColor(context);
    final icon = ContextColors.getContextIcon(context);

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: color.withOpacity(0.08), // Very subtle background
        borderRadius: BorderRadius.circular(8),
        border: Border.all(
          color: color.withOpacity(0.3),
          width: 0.5,
        ), // Thin border
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 12, color: color), // Smaller icon
          const SizedBox(width: 3),
          Text(
            context.substring(0, 1).toUpperCase() + context.substring(1),
            style: TextStyle(
              fontSize: 10,
              fontWeight: FontWeight.w500,
              color: color,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildKindBadge(String kind) {
    IconData icon;
    Color color;

    switch (kind) {
      case 'event':
        icon = Icons.event;
        color = Colors.green;
        break;
      case 'todo':
        icon = Icons.task;
        color = Colors.blue;
        break;
      case 'habit':
        icon = Icons.repeat;
        color = Colors.purple;
        break;
      default:
        icon = Icons.circle;
        color = Colors.grey;
    }

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: color.withOpacity(0.1),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: color.withOpacity(0.3), width: 1),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 12, color: color),
          const SizedBox(width: 4),
          Text(
            kind.substring(0, 1).toUpperCase() + kind.substring(1),
            style: TextStyle(
              fontSize: 10,
              fontWeight: FontWeight.w500,
              color: color,
            ),
          ),
        ],
      ),
    );
  }
}
