import 'package:flutter/material.dart';

class Sidebar extends StatelessWidget {
  final String selectedKey; // 'today' | 'scheduled' | 'all' | 'flagged' | 'backlog'
  final void Function(String) onSelect;
  final bool showCompleted;
  final void Function(bool) onToggleShowCompleted;
  final Map<String, int> counters;

  const Sidebar({
    super.key,
    required this.selectedKey,
    required this.onSelect,
    required this.showCompleted,
    required this.onToggleShowCompleted,
    this.counters = const <String, int>{},
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Expanded(
          child: ListView(
            children: [
              _tile('Today', 'today', Icons.today, count: counters['today']),
              _tile('Scheduled', 'scheduled', Icons.calendar_month, count: counters['scheduled']),
              _tile('All', 'all', Icons.inbox, count: counters['all']),
              _tile('Flagged', 'flagged', Icons.flag, count: counters['flagged']),
              _tile('Backlog', 'backlog', Icons.list_alt, count: counters['backlog']),
            ],
          ),
        ),
        const Divider(height: 1),
        Padding(
          padding: const EdgeInsets.all(12),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              const Text('Show completed'),
              Switch(value: showCompleted, onChanged: onToggleShowCompleted),
            ],
          ),
        ),
      ],
    );
  }

  Widget _tile(String label, String key, IconData icon, {int? count}) {
    final active = selectedKey == key;
    return ListTile(
      leading: Icon(icon, size: 20),
      title: Text(label),
      trailing: (count == null)
          ? null
          : Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
              decoration: BoxDecoration(
                color: Colors.black12,
                borderRadius: BorderRadius.circular(999),
              ),
              child: Text(_formatCount(count)),
            ),
      selected: active,
      onTap: () => onSelect(key),
    );
  }

  String _formatCount(int n) {
    if (n > 99) return '99+';
    return '$n';
  }
}


