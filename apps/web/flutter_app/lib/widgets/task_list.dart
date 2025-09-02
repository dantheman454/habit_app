import 'package:flutter/material.dart';
import '../util/context_colors.dart';

class TaskList extends StatelessWidget {
  final List<Map<String, dynamic>> tasks;
  final void Function(int id, String status) onSetStatus;
  final void Function(int id)? onEdit;
  final void Function(int id)? onDelete;

  const TaskList({
    super.key,
    required this.tasks,
    required this.onSetStatus,
    this.onEdit,
    this.onDelete,
  });

  @override
  Widget build(BuildContext context) {
    return ListView.separated(
      itemCount: tasks.length,
      separatorBuilder: (_, __) => const Divider(height: 1),
      itemBuilder: (context, index) {
        final item = tasks[index];
        final id = (item['id'] is int)
            ? item['id'] as int
            : int.tryParse('${item['id']}') ?? -1;
        final title = (item['title'] ?? '').toString();
        final status =
            (item['status'] ??
                    (item['completed'] == true ? 'completed' : 'pending'))
                .toString();
        final completed = status == 'completed';
        return Stack(
          children: [
            Container(
              decoration: BoxDecoration(
                color: ContextColors.getContextBackgroundColor(item['context']),
              ),
              child: ListTile(
                leading: Checkbox(
                  tristate: true,
                  value: status == 'skipped' ? null : completed,
                  onChanged: (_) => onSetStatus(
                    id,
                    status == 'skipped'
                        ? 'pending'
                        : (completed ? 'pending' : 'completed'),
                  ),
                  visualDensity: VisualDensity.compact,
                ),
                title: Row(
                  children: [
                    Expanded(
                      child: Text(
                        title.isEmpty ? 'Task' : title,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    const SizedBox(width: 6),
                    _timeChip(context, item),
                  ],
                ),
                subtitle: _buildSubtitle(item),
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
              ),
            ),
            Positioned(
              right: 8,
              top: 8,
              child: Tooltip(
                message: 'Skip',
                child: InkWell(
                  onTap: () => onSetStatus(
                    id,
                    status == 'skipped' ? 'pending' : 'skipped',
                  ),
                  child: Container(
                    width: 20,
                    height: 20,
                    decoration: BoxDecoration(
                      color: Theme.of(context)
                          .colorScheme
                          .surfaceContainerHighest
                          .withAlpha((0.7 * 255).round()),
                      shape: BoxShape.circle,
                    ),
                    child: Icon(
                      Icons.close,
                      size: 14,
                      color: Theme.of(context).colorScheme.onSurfaceVariant,
                    ),
                  ),
                ),
              ),
            ),
          ],
        );
      },
    );
  }

  Widget? _buildSubtitle(Map<String, dynamic> item) {
    final parts = <String>[];
    final notes = (item['notes'] ?? '').toString();
    if (notes.isNotEmpty) parts.add(notes);
    if (parts.isEmpty) return null;
    return Text(parts.join(' • '));
  }

  Widget _timeChip(BuildContext context, Map<String, dynamic> item) {
    final time = '';
    if (time.isEmpty) return const SizedBox.shrink();
    
    // Check if task is overdue
    final isOverdue = (item['overdue'] == true);
    
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: Colors.blue.shade50,
        border: Border.all(color: Colors.blue.shade200),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        time,
        style: TextStyle(
          fontSize: 11, 
          color: isOverdue 
              ? Theme.of(context).colorScheme.error 
              : Colors.blue.shade900,
        ),
      ),
    );
  }
}
