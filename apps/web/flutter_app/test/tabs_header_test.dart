import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_app/widgets/tabs_header.dart';

void main() {
  testWidgets('TabsHeader renders and onChanged fires', (tester) async {
    AppTab? changed;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: TabsHeader(
            selected: AppTab.tasks,
            onChanged: (t) {
              changed = t;
            },
          ),
        ),
      ),
    );

    // Expect two segments with text labels
    expect(find.text('Tasks'), findsOneWidget);
    expect(find.text('Events'), findsOneWidget);

    // Tap Events and verify callback
    await tester.tap(find.text('Events'));
    await tester.pump();
    expect(changed, AppTab.events);
  });
}
