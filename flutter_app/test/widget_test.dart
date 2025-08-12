// Basic smoke test for app boot.
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_app/main.dart';

void main() {
  testWidgets('App boots', (tester) async {
    await tester.pumpWidget(const App());
    // Initial frame renders without throwing.
    expect(find.byType(App), findsOneWidget);
  });
}
