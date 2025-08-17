import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_app/widgets/habits_tracker.dart';

void main() {
  testWidgets('HabitsTracker calls onToggle when cell tapped', (tester) async {
    final week = <String>[
      '2025-01-06',
      '2025-01-07',
      '2025-01-08',
      '2025-01-09',
      '2025-01-10',
      '2025-01-11',
      '2025-01-12',
    ];
    final habits = [
      const HabitRowData(id: 1, title: 'Drink water'),
    ];
    bool toggled = false;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(
            height: 400,
            child: HabitsTracker(
              habits: habits,
              weekYmd: week,
              statsById: const <int, Map<String, dynamic>>{
                1: {'weekHeatmap': []},
              },
              onToggle: (id, ymd, completed) {
                toggled = true;
              },
            ),
          ),
        ),
      ),
    );
    // Tap roughly where first row's first cell would be (no keys available; smoke verifies no exceptions)
    await tester.tapAt(const Offset(500, 50));
    await tester.pump();
    expect(toggled, isTrue);
  });
}
