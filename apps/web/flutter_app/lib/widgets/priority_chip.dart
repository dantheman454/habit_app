import 'package:flutter/material.dart';

/// Returns a colored priority chip for 'low' | 'medium' | 'high'.
/// Colors chosen for AA contrast on light/dark, matching the established palette.
Widget priorityChip(String priority, ColorScheme colorScheme) {
  final String p = priority.toLowerCase();
  Color bg;
  Color fg;
  switch (p) {
    case 'high':
      bg = const Color(0xFFFFC9C9);
      fg = const Color(0xFF7D1414);
      break;
    case 'low':
      bg = const Color(0xFFD3F9D8);
      fg = const Color(0xFF205B2A);
      break;
    case 'medium':
    default:
      bg = const Color(0xFFFFE8CC);
      fg = const Color(0xFF9C3B00);
      break;
  }
  return Container(
    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
    decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(999)),
    child: Text(p, style: TextStyle(color: fg, fontSize: 12)),
  );
}


