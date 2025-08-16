import 'package:flutter/material.dart';

enum AppTab { todos, events, habits, goals }

class TabsHeader extends StatelessWidget {
  final AppTab selected;
  final void Function(AppTab) onChanged;

  const TabsHeader({super.key, required this.selected, required this.onChanged});

  @override
  Widget build(BuildContext context) {
    return SegmentedButton<AppTab>(
      segments: const [
        ButtonSegment(value: AppTab.todos, label: Text('Todos')),
        ButtonSegment(value: AppTab.events, label: Text('Events')),
        ButtonSegment(value: AppTab.habits, label: Text('Habits')),
        ButtonSegment(value: AppTab.goals, label: Text('Goals')),
      ],
      selected: <AppTab>{selected},
      onSelectionChanged: (s) => onChanged(s.first),
      style: const ButtonStyle(
        visualDensity: VisualDensity.compact,
      ),
    );
  }
}


