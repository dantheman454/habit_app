import 'package:flutter/animation.dart';

class AppAnim {
  static const Duration medium = Duration(milliseconds: 300);
  static const Curve easeOut = Curves.easeOutCubic;
  static const Curve easeIn = Curves.easeInCubic;
  // Recommended UX guide timings
  static const Duration majorTransition = Duration(milliseconds: 400);
  static const Duration microInteraction = Duration(milliseconds: 200);
  static const Duration loading = Duration(milliseconds: 300);
}


