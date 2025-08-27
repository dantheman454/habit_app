import 'package:flutter/material.dart';

class AssistantHandle extends StatelessWidget {
  final VoidCallback onTap;
  final bool open; // true when panel is open
  final bool insidePanel; // render style when inside the panel

  const AssistantHandle({
    super.key,
    required this.onTap,
    this.open = false,
    this.insidePanel = false,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final bg = insidePanel
        ? theme.colorScheme.surfaceContainerHighest.withAlpha((0.7 * 255).round())
        : theme.colorScheme.surface;
    final fg = theme.colorScheme.onSurface;

    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(18),
        child: Container(
          width: 36,
          height: 120,
          decoration: BoxDecoration(
            color: bg,
            borderRadius: BorderRadius.circular(18),
            boxShadow: [
              BoxShadow(
                color: theme.colorScheme.shadow.withAlpha(30),
                blurRadius: 6,
                offset: const Offset(0, 2),
              ),
            ],
          ),
          padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 6),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(open ? Icons.smart_toy : Icons.smart_toy_outlined, size: 18, color: fg),
              const SizedBox(height: 6),
              RotatedBox(
                quarterTurns: 3,
                child: Text(
                  'Assistant',
                  style: TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w600,
                    color: fg.withAlpha(200),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}


