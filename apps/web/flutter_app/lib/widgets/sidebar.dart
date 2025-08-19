import 'package:flutter/material.dart';
import '../models.dart' show ViewMode;

class Sidebar extends StatelessWidget {
  final String selectedKey; // 'today' | 'all'
  final void Function(String) onSelect;
  final Map<String, int> counters;
  final ViewMode currentView; // Add view parameter
  final void Function(ViewMode) onViewChanged; // Add view change callback
  final String? selectedContext; // Add context parameter
  final void Function(String?) onContextChanged; // Add context change callback

  const Sidebar({
    super.key,
    required this.selectedKey,
    required this.onSelect,
    required this.currentView,
    required this.onViewChanged,
    required this.selectedContext,
    required this.onContextChanged,
    this.counters = const <String, int>{},
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        // Logo header
        Container(
          padding: const EdgeInsets.all(16),
          child: Row(
            children: [
              Icon(
                Icons.spa,
                size: 32,
                color: Theme.of(context).colorScheme.primary,
              ),
              const SizedBox(width: 8),
              Text(
                'Habitus',
                style: TextStyle(
                  fontSize: 24,
                  fontWeight: FontWeight.w600,
                  color: Theme.of(context).colorScheme.onSurface,
                  letterSpacing: 0.2,
                ),
              ),
            ],
          ),
        ),
        const Divider(height: 1),
        // View toggles
        Padding(
          padding: const EdgeInsets.all(12),
          child: SegmentedButton<ViewMode>(
            segments: const [
              ButtonSegment(
                value: ViewMode.day,
                label: Text('Day'),
              ),
              ButtonSegment(
                value: ViewMode.week,
                label: Text('Week'),
              ),
              ButtonSegment(
                value: ViewMode.month,
                label: Text('Month'),
              ),
            ],
            selected: {currentView},
            onSelectionChanged: (s) => onViewChanged(s.first),
          ),
        ),
        const Divider(height: 1),
        // Smart lists
        Expanded(
          child: ListView(
            children: [
              _tile('Today', 'today', Icons.today, count: counters['today']),
              _tile('All', 'all', Icons.inbox, count: counters['all']),
              const SizedBox(height: 8),
              // Context filters section
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                child: Text(
                  'Contexts',
                  style: Theme.of(context).textTheme.labelMedium?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              _contextTile('All', null, Icons.public),
              _contextTile('School', 'school', Icons.school, count: counters['school']),
              _contextTile('Personal', 'personal', Icons.person, count: counters['personal']),
              _contextTile('Work', 'work', Icons.work, count: counters['work']),
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

  Widget _contextTile(String label, String? contextValue, IconData icon, {int? count}) {
    final active = selectedContext == contextValue;
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
      onTap: () => onContextChanged(contextValue),
    );
  }

  String _formatCount(int n) {
    if (n > 99) return '99+';
    return '$n';
  }
}
