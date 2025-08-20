import 'package:flutter/material.dart';

class HabitRowData {
  final int id;
  final String title;
  const HabitRowData({
    required this.id,
    required this.title,
  });
}

class HabitsTracker extends StatelessWidget {
  final List<HabitRowData> habits;
  final List<String> weekYmd; // Mon..Sun YYYY-MM-DD
  final Map<int, Map<String, dynamic>>
  statsById; // id -> {weekHeatmap:[{date,completed}], currentStreak, longestStreak}
  final void Function(int habitId, String ymd, bool newCompleted) onToggle;

  const HabitsTracker({
    super.key,
    required this.habits,
    required this.weekYmd,
    required this.statsById,
    required this.onToggle,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _weekdayHeader(context),
        const Divider(height: 1),
        Expanded(
          child: ListView.builder(
            itemCount: habits.length,
            itemBuilder: (context, idx) {
              final h = habits[idx];
              final stats = statsById[h.id] ?? const <String, dynamic>{};
              final heat =
                  (stats['weekHeatmap'] as List<dynamic>?) ?? const <dynamic>[];
              final completedSet = <String>{
                for (final d in heat)
                  if (d is Map && d['date'] is String && d['completed'] == true)
                    d['date'] as String,
              };
              final today = DateTime.now();
              final todayY =
                  '${today.year.toString().padLeft(4, '0')}-${today.month.toString().padLeft(2, '0')}-${today.day.toString().padLeft(2, '0')}';
              return Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 6,
                ),
                child: Row(
                  children: [
                    // Left: title and streak
                    Expanded(
                      flex: 2,
                      child: Row(
                        children: [
                          Expanded(
                            child: Text(
                              h.title,
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                          const SizedBox(width: 8),
                          _streakBadge(context, stats),
                        ],
                      ),
                    ),
                    // Right: 7-day cells
                    Expanded(
                      flex: 5,
                      child: Row(
                        children: [
                          for (final y in weekYmd)
                            Padding(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 3,
                              ),
                              child: _dayCell(
                                context,
                                dateYmd: y,
                                isToday: y == todayY,
                                completed: completedSet.contains(y),
                                onTap: () => onToggle(
                                  h.id,
                                  y,
                                  !completedSet.contains(y),
                                ),
                              ),
                            ),
                        ],
                      ),
                    ),
                  ],
                ),
              );
            },
          ),
        ),
      ],
    );
  }

  Widget _weekdayHeader(BuildContext context) {
    // NEW: Sunday-first labels
    final labels = const ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      child: Row(
        children: [
          const Expanded(flex: 2, child: SizedBox()),
          Expanded(
            flex: 5,
            child: Row(
              children: [
                for (int i = 0; i < 7; i++)
                  Expanded(
                    child: Center(
                      child: Text(
                        labels[i],
                        style: const TextStyle(fontWeight: FontWeight.w600),
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _dayCell(
    BuildContext context, {
    required String dateYmd,
    required bool isToday,
    required bool completed,
    required VoidCallback onTap,
  }) {
    final bg = completed
  ? Theme.of(context).colorScheme.surfaceContainerHighest.withAlpha((0.8 * 255).round())
        : Colors.transparent;
    final borderColor = Theme.of(context).colorScheme.outlineVariant;
    return InkWell(
      onTap: onTap,
      child: Container(
        width: 36,
        height: 32,
        decoration: BoxDecoration(
          color: bg,
          borderRadius: BorderRadius.circular(6),
          border: Border.all(color: borderColor),
        ),
        child: isToday
            ? Container(
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(6),
                  border: Border.all(
                    color: Theme.of(
                      context,
                    ).colorScheme.primary.withAlpha((0.3 * 255).round()),
                  ),
                ),
              )
            : null,
      ),
    );
  }

  Widget _streakBadge(BuildContext context, Map<String, dynamic> stats) {
    final current = (stats['currentStreak'] as int?) ?? 0;
    final longest = (stats['longestStreak'] as int?) ?? 0;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: Theme.of(context).colorScheme.outline),
      ),
      child: Text(
        '🔥 $current / $longest',
        style: TextStyle(
          fontSize: 11,
          color: Theme.of(context).colorScheme.onSurfaceVariant,
        ),
      ),
    );
  }

  
}
