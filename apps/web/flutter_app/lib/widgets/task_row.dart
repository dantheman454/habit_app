import 'package:flutter/material.dart';
import '../util/context_colors.dart';
import 'expandable_text.dart';

class TaskRow extends StatelessWidget {
  final Map<String, dynamic> task; // kind: 'task'|'event'
  final VoidCallback onToggleCompleted;
  final VoidCallback? onToggleSkipped; // only meaningful for tasks
  final VoidCallback onEdit;
  final VoidCallback onDelete;
  final bool highlighted;
  final Widget? extraBadge; // optional, placed in the header row
  final void Function(String newTitle)? onTitleEdited;
  final void Function(String? newTimeOfDay)? onTimeEdited; // deprecated

  const TaskRow({
    super.key,
    required this.task,
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
    final isSkipped = (task['status'] == 'skipped');
    final isCompleted = (task['completed'] == true) || (task['status'] == 'completed');

    // Minimal normalization
    final String kind = (task['kind'] ?? 'task').toString();

    // Context-based colors
    final contextColor = task['context'] != null
        ? ContextColors.getContextColor(task['context'])
        : Colors.grey.shade600;
    final borderColor = contextColor.withAlpha((0.3 * 255).round());

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
              ? Theme.of(context).colorScheme.primary.withAlpha((0.06 * 255).round())
              : (isCompleted
                    ? Colors.grey.withAlpha((0.1 * 255).round())
                    : (isSkipped
                          ? Colors.orange.withAlpha((0.06 * 255).round())
                          : ContextColors.getContextBackgroundColor(
                              task['context'],
                            ))),
        ),
        child: InkWell(
          onTap: onEdit,
          borderRadius: BorderRadius.circular(8),
          child: Row(
            children: [
              AnimatedScale(
                duration: const Duration(milliseconds: 200),
                scale: isCompleted ? 1.1 : 1.0,
                child: Checkbox(
                  tristate: true,
                  value: isSkipped ? null : isCompleted,
                  fillColor: WidgetStateProperty.resolveWith<Color?>((states) {
                    if (isSkipped) return Colors.amber; // distinct look for skipped
                    if (isCompleted) return Theme.of(context).colorScheme.primary;
                    return Theme.of(context).colorScheme.surfaceTint.withAlpha((0.4 * 255).round());
                  }),
                  onChanged: (_) => isSkipped ? (onToggleSkipped?.call()) : onToggleCompleted(),
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
                        _buildKindBadge(kind),
                        const SizedBox(width: 4),
                        Flexible(
                          child: InkWell(
                            onTap: onTitleEdited == null
                                ? null
                                : () async {
                                    final ctrl = TextEditingController(text: task['title']);
                                    final ok = await showDialog<bool>(
                                      context: context,
                                      builder: (c) => AlertDialog(
                                        title: const Text('Edit title'),
                                        content: TextField(controller: ctrl, autofocus: true),
                                        actions: [
                                          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
                                          FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Save')),
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
                                decoration: isCompleted ? TextDecoration.lineThrough : null,
                                color: isSkipped ? Colors.black54 : null,
                                fontStyle: isSkipped ? FontStyle.italic : null,
                              ),
                              child: Text(task['title'] ?? ''),
                            ),
                          ),
                        ),
                        // Spacer kept minimal; removed dead always-false block
                      ],
                    ),
                    if (task['notes'] != null && (task['notes'] as String).isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 2),
                        child: ExpandableText(
                          task['notes'],
                          maxLines: 2,
                          style: TextStyle(color: Colors.grey.shade700, fontSize: 12),
                        ),
                      ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (kind == 'task')
                    AnimatedOpacity(
                      duration: const Duration(milliseconds: 300),
                      opacity: 1.0,
                      child: IconButton(
                        icon: Icon(isSkipped ? Icons.undo : Icons.do_not_disturb_on, size: 18, color: isSkipped ? Colors.blue : Colors.red),
                        onPressed: onToggleSkipped,
                        tooltip: isSkipped ? 'Unskip' : 'Skip',
                      ),
                    ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildKindBadge(String kind) {
    switch (kind) {
      case 'task':
        return const Icon(Icons.task, size: 16);
      case 'event':
        return const Icon(Icons.event, size: 16);
      default:
        return const Icon(Icons.label, size: 16);
    }
  }
}


