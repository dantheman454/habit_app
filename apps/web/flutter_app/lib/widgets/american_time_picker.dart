import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';

Future<String?> showAmericanTimePicker({
  required BuildContext context,
  String? initial24h,
}) async {
  DateTime seed;
  if (initial24h != null && initial24h.contains(':')) {
    final p = initial24h.split(':');
    final h = int.tryParse(p[0]) ?? 0;
    final m = int.tryParse(p[1]) ?? 0;
    final now = DateTime.now();
    seed = DateTime(now.year, now.month, now.day, h, m);
  } else {
    final now = DateTime.now();
    final rounded = DateTime(now.year, now.month, now.day, now.minute >= 30 ? (now.hour + 1) % 24 : now.hour, 0);
    seed = rounded;
  }

  DateTime selected = seed;
  final result = await showCupertinoModalPopup<String>(
    context: context,
    builder: (ctx) {
      return Container(
        height: 280,
        color: CupertinoColors.systemBackground.resolveFrom(ctx),
        child: Column(
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                CupertinoButton(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  child: const Text('Cancel'),
                  onPressed: () => Navigator.of(ctx).pop(null),
                ),
                CupertinoButton.filled(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  child: const Text('OK'),
                  onPressed: () {
                    final hh = selected.hour.toString().padLeft(2, '0');
                    final mm = selected.minute.toString().padLeft(2, '0');
                    Navigator.of(ctx).pop('$hh:$mm');
                  },
                ),
              ],
            ),
            const Divider(height: 1),
            Expanded(
              child: CupertinoDatePicker(
                mode: CupertinoDatePickerMode.time,
                use24hFormat: false,
                minuteInterval: 5,
                initialDateTime: seed,
                onDateTimeChanged: (dt) => selected = dt,
              ),
            ),
          ],
        ),
      );
    },
  );
  return result;
}
