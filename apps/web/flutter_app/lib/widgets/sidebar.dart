import 'package:flutter/material.dart';

class Sidebar extends StatelessWidget {
  final String selectedKey; // 'today' | 'scheduled' | 'all' | 'flagged' | 'backlog'
  final void Function(String) onSelect;
  final bool showCompleted;
  final void Function(bool) onToggleShowCompleted;

  const Sidebar({
    super.key,
    required this.selectedKey,
    required this.onSelect,
    required this.showCompleted,
    required this.onToggleShowCompleted,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Expanded(
          child: ListView(
            children: [
              _tile('Today', 'today', Icons.today),
              _tile('Scheduled', 'scheduled', Icons.calendar_month),
              _tile('All', 'all', Icons.inbox),
              _tile('Flagged', 'flagged', Icons.flag),
              _tile('Backlog', 'backlog', Icons.list_alt),
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

  Widget _tile(String label, String key, IconData icon) {
    final active = selectedKey == key;
    return ListTile(
      leading: Icon(icon, size: 20),
      title: Text(label),
      selected: active,
      onTap: () => onSelect(key),
    );
  }
}


