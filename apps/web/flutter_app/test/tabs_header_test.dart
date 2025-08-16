import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_app/widgets/tabs_header.dart';

void main() {
  testWidgets('TabsHeader renders and onChanged fires', (tester) async {
    AppTab? changed;
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: TabsHeader(
          selected: AppTab.todos,
          onChanged: (t) { changed = t; },
        ),
      ),
    ));

    // Expect four segments with text labels
    expect(find.text('Todos'), findsOneWidget);
    expect(find.text('Events'), findsOneWidget);
    expect(find.text('Habits'), findsOneWidget);
    expect(find.text('Goals'), findsOneWidget);

    // Tap Events and verify callback
    await tester.tap(find.text('Events'));
    await tester.pump();
    expect(changed, AppTab.events);

    // Tap Habits and verify callback
    await tester.tap(find.text('Habits'));
    await tester.pump();
    expect(changed, AppTab.habits);
  });
}


