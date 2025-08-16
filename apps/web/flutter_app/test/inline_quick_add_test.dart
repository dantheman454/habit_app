import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_app/main.dart';

Future<void> _pumpAppUntilLoaded(WidgetTester tester) async {
  await tester.pumpWidget(const App());
  // Give the app some time to flip from loading to content on failed network
  for (int i = 0; i < 20; i++) {
    await tester.pump(const Duration(milliseconds: 100));
    // Stop early if the progress indicator is gone
    final stillLoading = find.byType(CircularProgressIndicator);
    if (stillLoading.evaluate().isEmpty) break;
  }
}

void main() {
  setUp(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
  });

  testWidgets('Todos inline quick-add shows validation on empty title', (tester) async {
    tester.view.devicePixelRatio = 1.0;
    tester.view.physicalSize = const Size(1600, 1000);
    addTearDown(() {
      tester.view.resetDevicePixelRatio();
      tester.view.resetPhysicalSize();
    });

    await _pumpAppUntilLoaded(tester);

    // Ensure Todos is selected (default) and quick-add exists
    expect(find.byKey(const Key('qa_todo_title')), findsOneWidget);

    // Press Add with empty title -> validation SnackBar
    await tester.tap(find.widgetWithText(FilledButton, 'Add').first);
    await tester.pump();
    expect(find.text('Please enter a title.'), findsOneWidget);
  });

  testWidgets('Todos inline quick-add shows time validation for invalid HH:MM and disables Add on Enter', (tester) async {
    tester.view.devicePixelRatio = 1.0;
    tester.view.physicalSize = const Size(1600, 1000);
    addTearDown(() {
      tester.view.resetDevicePixelRatio();
      tester.view.resetPhysicalSize();
    });

    await _pumpAppUntilLoaded(tester);

    // Enter invalid time
    await tester.enterText(find.byKey(const Key('qa_todo_title')), 'Sample');
    await tester.enterText(find.byKey(const Key('qa_todo_time')), '99:99');
    await tester.tap(find.widgetWithText(FilledButton, 'Add').first);
    await tester.pump();
    expect(find.text('Use 24‑hour time, e.g. 09:00.'), findsOneWidget);

    // Fix time, then press Enter to submit and verify button disables
    await tester.enterText(find.byKey(const Key('qa_todo_time')), '');
    await tester.tap(find.byKey(const Key('qa_todo_title')));
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();

    final addBtn = tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Add').first);
    expect(addBtn.onPressed, isNull, reason: 'Add should be disabled during submission');
  });

  testWidgets('Events inline quick-add shows validation on empty title', (tester) async {
    tester.view.devicePixelRatio = 1.0;
    tester.view.physicalSize = const Size(1600, 1000);
    addTearDown(() {
      tester.view.resetDevicePixelRatio();
      tester.view.resetPhysicalSize();
    });

    await _pumpAppUntilLoaded(tester);

    // Switch to Events via segmented tabs
    await tester.tap(find.text('Events'));
    await tester.pumpAndSettle(const Duration(milliseconds: 100));

    expect(find.byKey(const Key('qa_event_title')), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, 'Add').first);
    await tester.pump();
    expect(find.text('Please enter a title.'), findsOneWidget);
  });

  testWidgets('Events inline quick-add shows time validation for invalid HH:MM', (tester) async {
    tester.view.devicePixelRatio = 1.0;
    tester.view.physicalSize = const Size(1600, 1000);
    addTearDown(() {
      tester.view.resetDevicePixelRatio();
      tester.view.resetPhysicalSize();
    });

    await _pumpAppUntilLoaded(tester);
    await tester.tap(find.text('Events'));
    await tester.pumpAndSettle(const Duration(milliseconds: 100));

    await tester.enterText(find.byKey(const Key('qa_event_title')), 'Meet');
    await tester.enterText(find.byKey(const Key('qa_event_start')), '24:00');
    await tester.tap(find.widgetWithText(FilledButton, 'Add').first);
    await tester.pump();
    expect(find.text('Use 24‑hour time, e.g. 09:00.'), findsOneWidget);
  });

  testWidgets('Habits inline quick-add shows validation on empty title', (tester) async {
    tester.view.devicePixelRatio = 1.0;
    tester.view.physicalSize = const Size(1600, 1000);
    addTearDown(() {
      tester.view.resetDevicePixelRatio();
      tester.view.resetPhysicalSize();
    });

    await _pumpAppUntilLoaded(tester);

    // Switch to Habits
    await tester.tap(find.text('Habits'));
    await tester.pumpAndSettle(const Duration(milliseconds: 100));

    expect(find.byKey(const Key('qa_habit_title')), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, 'Add').first);
    await tester.pump();
    expect(find.text('Please enter a title.'), findsOneWidget);
  });

  testWidgets('Habits inline quick-add shows time validation for invalid HH:MM', (tester) async {
    tester.view.devicePixelRatio = 1.0;
    tester.view.physicalSize = const Size(1600, 1000);
    addTearDown(() {
      tester.view.resetDevicePixelRatio();
      tester.view.resetPhysicalSize();
    });

    await _pumpAppUntilLoaded(tester);
    await tester.tap(find.text('Habits'));
    await tester.pumpAndSettle(const Duration(milliseconds: 100));

    await tester.enterText(find.byKey(const Key('qa_habit_title')), 'Drink water');
    await tester.enterText(find.byKey(const Key('qa_habit_time')), '25:61');
    await tester.tap(find.widgetWithText(FilledButton, 'Add').first);
    await tester.pump();
    expect(find.text('Use 24‑hour time, e.g. 09:00.'), findsOneWidget);
  });

  testWidgets('Goals inline quick-add shows validation on empty title', (tester) async {
    tester.view.devicePixelRatio = 1.0;
    tester.view.physicalSize = const Size(1600, 1000);
    addTearDown(() {
      tester.view.resetDevicePixelRatio();
      tester.view.resetPhysicalSize();
    });

    await _pumpAppUntilLoaded(tester);

    // Switch to Goals
    await tester.tap(find.text('Goals'));
    await tester.pump(const Duration(milliseconds: 200));

    expect(find.byKey(const Key('qa_goal_title')), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, 'Add').first);
    await tester.pump();
    expect(find.text('Please enter a title.'), findsOneWidget);
  });
}


