import 'package:flutter/material.dart';

class ContextColors {
  static Color getSchoolColor() => Colors.blue.shade600;
  static Color getWorkColor() => Colors.orange.shade600;
  static Color getPersonalColor() => Colors.green.shade600;
  static Color getDefaultColor() => Colors.grey.shade600;
  
  static Color getContextColor(String? context) {
    switch (context) {
      case 'school': return getSchoolColor();
      case 'work': return getWorkColor();
      case 'personal': return getPersonalColor();
      default: return getDefaultColor();
    }
  }
  
  static Color getContextBackgroundColor(String? context) {
    final baseColor = getContextColor(context);
    return baseColor.withAlpha((0.15 * 255).round()); // Subtle background
  }

  static Color getContextButtonColor(String? context, bool isSelected) {
    if (context == null) {
      // "All" button - lighter grey when selected
      return isSelected ? Colors.grey.shade300 : Colors.grey.shade600.withAlpha((0.15 * 255).round());
    }
    final baseColor = getContextColor(context);
    return baseColor.withAlpha((isSelected ? 1.0 : 0.15 * 1.0) * 255 ~/ 1); // Always colored, different opacity
  }
  
  static IconData getContextIcon(String? context) {
    switch (context) {
      case 'school': return Icons.school;
      case 'work': return Icons.work;
      case 'personal': return Icons.person;
      default: return Icons.public;
    }
  }
  
  // Helper methods for task badges (when context is not available)
  static Color get taskBadgeBackground => Colors.grey.shade50;
  static Color get taskBadgeBorder => Colors.grey.shade300;
  static Color get taskBadgeText => Colors.black87;
}
