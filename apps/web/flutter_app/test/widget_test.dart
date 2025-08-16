// Basic smoke test for app boot.
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_app/main.dart';
import 'package:flutter/material.dart';

void main() {
  testWidgets('App boots', (tester) async {
    tester.view.devicePixelRatio = 1.0;
    tester.view.physicalSize = const Size(1600, 1000);
    addTearDown(() {
      tester.view.resetDevicePixelRatio();
      tester.view.resetPhysicalSize();
    });
    await tester.pumpWidget(const App());
    // Initial frame renders without throwing.
    expect(find.byType(App), findsOneWidget);
  });

  // Further UI tests are covered in isolated widget tests to avoid VM layout constraints.
}
