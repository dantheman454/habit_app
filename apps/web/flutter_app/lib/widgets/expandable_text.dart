import 'package:flutter/material.dart';

class ExpandableText extends StatefulWidget {
  const ExpandableText(this.text, {super.key, this.maxLines = 2, this.style});
  final String text;
  final int maxLines;
  final TextStyle? style;
  @override
  State<ExpandableText> createState() => _ExpandableTextState();
}

class _ExpandableTextState extends State<ExpandableText> {
  bool _expanded = false;
  @override
  Widget build(BuildContext context) {
    final text = Text(
      widget.text,
      style: widget.style,
      maxLines: _expanded ? null : widget.maxLines,
      overflow: _expanded ? TextOverflow.visible : TextOverflow.ellipsis,
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        text,
        if (_needsToggle(context))
          InkWell(
            onTap: () => setState(() => _expanded = !_expanded),
            child: Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text(
                _expanded ? 'Less' : 'More',
                style: TextStyle(
                  color: Theme.of(context).colorScheme.primary,
                  fontSize: 11,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ),
      ],
    );
  }

  bool _needsToggle(BuildContext context) {
    // Simple heuristic: show toggle when text length is likely to overflow
    return widget.text.trim().length > (widget.maxLines * 40);
  }
}
