import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_app/main.dart' as app;

Future<void> _pumpApp(WidgetTester tester) async {
  app.TestHooks.skipRefresh = true;
  await tester.pumpWidget(const app.App());
  await tester.pumpAndSettle(const Duration(milliseconds: 50));
}

void main() {
  setUp(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
  });

  testWidgets('Todos inline quick-add success clears fields and re-enables Add', (tester) async {
    tester.view.devicePixelRatio = 1.0;
    tester.view.physicalSize = const Size(1600, 1000);
    addTearDown(() { tester.view.resetDevicePixelRatio(); tester.view.resetPhysicalSize(); });

    // Stub API with a tiny async delay so UI can paint disabled state before resolve
    app.createTodoFn = (data) async {
      await Future<void>.delayed(const Duration(milliseconds: 1));
      return {'id': 1, 'title': data['title']};
    };

    await _pumpApp(tester);

    // Enter title and submit
    await tester.enterText(find.byKey(const Key('qa_todo_title')), 'Sample');
    await tester.tap(find.widgetWithText(FilledButton, 'Add').first);
    await tester.pump();
    // Disabled during submit
    final todoRow = find.ancestor(of: find.byKey(const Key('qa_todo_title')), matching: find.byType(Row));
    var addBtn = tester.widget<FilledButton>(find.descendant(of: todoRow, matching: find.byType(FilledButton)));
    expect(addBtn.onPressed, isNull);

    // Let future resolve
    await tester.pump(const Duration(milliseconds: 50));
    // Re-enabled and field cleared
    addBtn = tester.widget<FilledButton>(find.descendant(of: todoRow, matching: find.byType(FilledButton)));
    expect(addBtn.onPressed, isNotNull);
    expect(find.text('Sample'), findsNothing);
  });

  testWidgets('Events inline quick-add success clears fields and re-enables Add', (tester) async {
    tester.view.devicePixelRatio = 1.0;
    tester.view.physicalSize = const Size(1600, 1000);
    addTearDown(() { tester.view.resetDevicePixelRatio(); tester.view.resetPhysicalSize(); });

    app.createEventFn = (data) async => {'id': 2, 'title': data['title']};

    await _pumpApp(tester);
    await tester.tap(find.text('Events'));
    await tester.pumpAndSettle(const Duration(milliseconds: 50));

    await tester.enterText(find.byKey(const Key('qa_event_title')), 'Meet');
    await tester.tap(find.widgetWithText(FilledButton, 'Add').first);
    await tester.pump();
    var addBtn = tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Add').first);
    expect(addBtn.onPressed, isNull);
    await tester.pump(const Duration(milliseconds: 50));
    addBtn = tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Add').first);
    expect(addBtn.onPressed, isNotNull);
    expect(find.text('Meet'), findsNothing);
  });

  testWidgets('Habits inline quick-add success clears fields and re-enables Add', (tester) async {
    tester.view.devicePixelRatio = 1.0;
    tester.view.physicalSize = const Size(1600, 1000);
    addTearDown(() { tester.view.resetDevicePixelRatio(); tester.view.resetPhysicalSize(); });

    app.createHabitFn = (data) async => {'id': 3, 'title': data['title']};

    await _pumpApp(tester);
    await tester.tap(find.text('Habits'));
    await tester.pumpAndSettle(const Duration(milliseconds: 50));

    await tester.enterText(find.byKey(const Key('qa_habit_title')), 'Drink');
    await tester.tap(find.widgetWithText(FilledButton, 'Add').first);
    await tester.pump();
    var addBtn = tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Add').first);
    expect(addBtn.onPressed, isNull);
    await tester.pump(const Duration(milliseconds: 50));
    addBtn = tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Add').first);
    expect(addBtn.onPressed, isNotNull);
    expect(find.text('Drink'), findsNothing);
  });

  testWidgets('Goals inline quick-add success clears fields and re-enables Add', (tester) async {
    tester.view.devicePixelRatio = 1.0;
    tester.view.physicalSize = const Size(1600, 1000);
    addTearDown(() { tester.view.resetDevicePixelRatio(); tester.view.resetPhysicalSize(); });

    app.createGoalFn = (data) async => {'id': 4, 'title': data['title']};

    await _pumpApp(tester);
    await tester.tap(find.text('Goals'));
    await tester.pumpAndSettle(const Duration(milliseconds: 50));

    await tester.enterText(find.byKey(const Key('qa_goal_title')), 'Read 10 books');
    await tester.tap(find.widgetWithText(FilledButton, 'Add').first);
    await tester.pump();
    var addBtn = tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Add').first);
    expect(addBtn.onPressed, isNull);
    await tester.pump(const Duration(milliseconds: 50));
    addBtn = tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Add').first);
    expect(addBtn.onPressed, isNotNull);
    expect(find.text('Read 10 books'), findsNothing);
  });
}


