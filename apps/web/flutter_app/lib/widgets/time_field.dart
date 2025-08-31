import 'package:flutter/material.dart';
import '../util/time_format.dart';
import 'american_time_picker.dart';

class TimeField extends StatefulWidget {
  final TextEditingController controller;
  final String label;
  final String? semantics;
  const TimeField({super.key, required this.controller, this.label = 'Time', this.semantics});
  @override State<TimeField> createState() => _TimeFieldState();
}

class _TimeFieldState extends State<TimeField> {
  late final TextEditingController _displayCtrl;
  @override void initState() {
    super.initState();
    _displayCtrl = TextEditingController(text: AmericanTimeFormat.to12h(widget.controller.text));
  }
  @override void didUpdateWidget(TimeField old) {
    super.didUpdateWidget(old);
    _displayCtrl.text = AmericanTimeFormat.to12h(widget.controller.text);
  }
  @override void dispose() { _displayCtrl.dispose(); super.dispose(); }

  void _syncFromDisplay() {
    final parsed = AmericanTimeFormat.parseFlexible(_displayCtrl.text);
    if (parsed != null) {
      widget.controller.text = parsed;
      _displayCtrl.text = AmericanTimeFormat.to12h(parsed);
      setState(() {});
    }
  }

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Expanded(
          child: TextField(
            controller: _displayCtrl,
            decoration: InputDecoration(labelText: widget.label),
            onEditingComplete: _syncFromDisplay,
            onSubmitted: (_) => _syncFromDisplay(),
          ),
        ),
        const SizedBox(width: 8),
        IconButton(
          tooltip: widget.semantics ?? 'Choose time',
          icon: const Icon(Icons.access_time),
          onPressed: () async {
            final seed = widget.controller.text.isNotEmpty
                ? widget.controller.text
                : AmericanTimeFormat.roundToNearestHour24(DateTime.now());
            final picked = await showAmericanTimePicker(context: context, initial24h: seed);
            if (picked != null) {
              widget.controller.text = picked;
              _displayCtrl.text = AmericanTimeFormat.to12h(picked);
              setState(() {});
            }
          },
        ),
      ],
    );
  }
}


