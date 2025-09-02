import 'package:flutter/material.dart';
import '../util/context_colors.dart';

class ContextFilter extends StatelessWidget {
  final String? selectedContext; // 'school', 'personal', 'work', null for 'all'
  final void Function(String?) onChanged;

  const ContextFilter({
    super.key,
    required this.selectedContext,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    final _ContextKind selected = _toKind(selectedContext);
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: SegmentedButton<_ContextKind>(
        segments: const [
          ButtonSegment<_ContextKind>(
            value: _ContextKind.all,
            label: SizedBox.shrink(),
            icon: Tooltip(message: 'All', child: Icon(Icons.public, size: 16)),
          ),
          ButtonSegment<_ContextKind>(
            value: _ContextKind.school,
            label: SizedBox.shrink(),
            icon: Tooltip(message: 'School', child: Icon(Icons.school, size: 16)),
          ),
          ButtonSegment<_ContextKind>(
            value: _ContextKind.personal,
            label: SizedBox.shrink(),
            icon: Tooltip(message: 'Personal', child: Icon(Icons.person, size: 16)),
          ),
          ButtonSegment<_ContextKind>(
            value: _ContextKind.work,
            label: SizedBox.shrink(),
            icon: Tooltip(message: 'Work', child: Icon(Icons.work, size: 16)),
          ),
        ],
        selected: <_ContextKind>{selected},
        onSelectionChanged: (s) => onChanged(_toStringValue(s.first)),
        style: const ButtonStyle(
          visualDensity: VisualDensity.compact,
          padding: WidgetStatePropertyAll(EdgeInsets.symmetric(horizontal: 8, vertical: 4)),
          minimumSize: WidgetStatePropertyAll(Size(36, 28)),
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        ),
        showSelectedIcon: false,
        multiSelectionEnabled: false,
        emptySelectionAllowed: false,
      ),
    );
  }

  // SegmentedButton helpers
}

enum _ContextKind { all, school, personal, work }

_ContextKind _toKind(String? value) {
  switch (value) {
    case 'school':
      return _ContextKind.school;
    case 'personal':
      return _ContextKind.personal;
    case 'work':
      return _ContextKind.work;
    default:
      return _ContextKind.all;
  }
}

String? _toStringValue(_ContextKind k) {
  switch (k) {
    case _ContextKind.school:
      return 'school';
    case _ContextKind.personal:
      return 'personal';
    case _ContextKind.work:
      return 'work';
    case _ContextKind.all:
      return null;
  }
}
