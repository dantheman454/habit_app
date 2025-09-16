import 'package:flutter/material.dart';
import '../models.dart';

class HabitRow extends StatelessWidget {
  final Habit habit;
  final String weekStartYmd; // Sunday
  final Set<String> completedDates;
  final void Function(String ymd, bool done) onToggle;
  const HabitRow({
    super.key,
    required this.habit,
    required this.weekStartYmd,
    required this.completedDates,
    required this.onToggle,
  });

  @override
  Widget build(BuildContext context) {
    final DateTime start = DateTime.parse(weekStartYmd);
    final days = List.generate(7, (i) {
      final d = DateTime(start.year, start.month, start.day + i);
      return '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';
    });
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    habit.title.isEmpty ? 'Habit' : habit.title,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontWeight: FontWeight.w600),
                  ),
                ),
                if (habit.weeklyTargetCount != null)
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                    decoration: BoxDecoration(
                      color: Theme.of(context).colorScheme.surfaceVariant,
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: Text(
                      ' ${completedDates.length} / ${habit.weeklyTargetCount}',
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                for (final y in days)
                  Padding(
                    padding: const EdgeInsets.only(right: 6),
                    child: _DaySquare(
                      dateYmd: y,
                      initialDone: completedDates.contains(y),
                      onToggle: (done) => onToggle(y, done),
                    ),
                  ),
              ],
            )
          ],
        ),
      ),
    );
  }
}

class _DaySquare extends StatefulWidget {
  final String dateYmd;
  final bool initialDone;
  final void Function(bool done) onToggle;
  const _DaySquare({ required this.dateYmd, required this.initialDone, required this.onToggle });

  @override
  State<_DaySquare> createState() => _DaySquareState();
}

class _DaySquareState extends State<_DaySquare> {
  bool done = false;

  @override
  void initState() {
    super.initState();
    done = widget.initialDone;
  }

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: () {
        setState(() => done = !done);
        widget.onToggle(done);
      },
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 120),
        width: 28,
        height: 28,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: done ? Theme.of(context).colorScheme.primary : Colors.transparent,
          border: Border.all(color: Theme.of(context).colorScheme.outlineVariant),
          borderRadius: BorderRadius.circular(6),
        ),
        child: done
            ? Icon(Icons.check, size: 18, color: Theme.of(context).colorScheme.onPrimary)
            : const SizedBox.shrink(),
      ),
    );
  }
}


