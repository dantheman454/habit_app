import 'package:flutter/material.dart';

class TypeTabs extends StatelessWidget {
  final String? selectedType; // 'todo', 'event', or null for both
  final void Function(String?) onTypeChanged;

  const TypeTabs({
    super.key,
    required this.selectedType,
    required this.onTypeChanged,
  });

  @override
  Widget build(BuildContext context) {
    return SegmentedButton<String?>(
      segments: [
        ButtonSegment(
          value: null,
          label: Text('All'),
        ),
        ButtonSegment(
          value: 'todo',
          label: Text('Tasks'),
        ),
        ButtonSegment(
          value: 'event',
          label: Text('Events'),
        ),
      ],
      selected: {selectedType},
      onSelectionChanged: (s) => onTypeChanged(s.first),
    );
  }
}
