import 'package:flutter/material.dart';
import '../models.dart' show ViewMode;
import '../main.dart' show DateNavigation;

class HabitusLogo extends StatelessWidget {
  const HabitusLogo({super.key});

  @override
  Widget build(BuildContext context) {
    return Container(
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
    );
  }
}

class Sidebar extends StatelessWidget {
  final Map<String, int> counters;
  final ViewMode currentView;
  final void Function(ViewMode) onViewChanged;
  final String? selectedContext;
  final void Function(String?) onContextChanged;
  final VoidCallback? onDatePrev;
  final VoidCallback? onDateNext;
  final VoidCallback? onDateToday;
  final String currentDate;
  final bool showCompleted;
  final void Function(bool) onShowCompletedChanged;

  const Sidebar({
    super.key,
    required this.currentView,
    required this.onViewChanged,
    required this.selectedContext,
    required this.onContextChanged,
    this.counters = const <String, int>{},
    this.onDatePrev,
    this.onDateNext,
    this.onDateToday,
    required this.currentDate,
    required this.showCompleted,
    required this.onShowCompletedChanged,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
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
        
        // Date Navigation (centered)
        if (onDatePrev != null && onDateNext != null && onDateToday != null)
          Padding(
            padding: const EdgeInsets.all(12),
            child: Center(
              child: DateNavigation(
                onPrev: onDatePrev!,
                onNext: onDateNext!,
                onToday: onDateToday!,
                currentDate: currentDate,
              ),
            ),
          ),
        if (onDatePrev != null && onDateNext != null && onDateToday != null)
          const Divider(height: 1),
        
        // Context filters
        Expanded(
          child: Column(
            children: [
              Expanded(
                child: ListView(
                  children: [
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
              // Show Completed toggle at bottom
              const Divider(height: 1),
              ListTile(
                leading: const Icon(Icons.check_circle_outline, size: 20),
                title: const Text('Show Completed'),
                trailing: Switch(
                  value: showCompleted,
                  onChanged: onShowCompletedChanged,
                ),
              ),
            ],
          ),
        ),
      ],
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
