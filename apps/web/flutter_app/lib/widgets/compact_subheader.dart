import 'package:flutter/material.dart';
import 'context_filter.dart';
import '../util/animation.dart';

class CompactSubheader extends StatelessWidget {
  final VoidCallback? onPrev;
  final VoidCallback? onNext;
  final VoidCallback? onToday;
  final String dateLabel;

  final String? selectedContext;
  final void Function(String?) onContextChanged;

  final bool showCompleted;
  final void Function(bool) onShowCompletedChanged;

  const CompactSubheader({
    super.key,
    required this.dateLabel,
    required this.onPrev,
    required this.onNext,
    required this.onToday,
    required this.selectedContext,
    required this.onContextChanged,
    required this.showCompleted,
    required this.onShowCompletedChanged,
  });

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Theme.of(context).colorScheme.surfaceContainerLow,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        child: LayoutBuilder(
          builder: (ctx, cons) {
            final isNarrow = cons.maxWidth < 1280; // desktop-only breakpoint
            return Row(
              children: [
                // Date controls
                Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    IconButton(
                      icon: const Icon(Icons.chevron_left),
                      tooltip: 'Previous',
                      onPressed: onPrev,
                    ),
                    AnimatedSwitcher(
                      duration: AppAnim.medium,
                      switchInCurve: AppAnim.easeOut,
                      switchOutCurve: AppAnim.easeIn,
                      child: Text(
                        dateLabel,
                        key: ValueKey(dateLabel),
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                    ),
                    IconButton(
                      icon: const Icon(Icons.chevron_right),
                      tooltip: 'Next',
                      onPressed: onNext,
                    ),
                    const SizedBox(width: 4),
                    if (onToday != null)
                      TextButton.icon(
                        icon: const Icon(Icons.today, size: 18),
                        label: const Text('Today'),
                        onPressed: onToday,
                      ),
                  ],
                ),

                const SizedBox(width: 12),

                // Context selector (single-choice)
                Flexible(
                  fit: FlexFit.tight,
                  child: Align(
                    alignment: Alignment.centerLeft,
                    child: AnimatedSwitcher(
                      duration: AppAnim.medium,
                      switchInCurve: AppAnim.easeOut,
                      switchOutCurve: AppAnim.easeIn,
                      child: ContextFilter(
                        key: ValueKey(selectedContext ?? 'all'),
                        selectedContext: selectedContext,
                        onChanged: onContextChanged,
                      ),
                    ),
                  ),
                ),

                const SizedBox(width: 8),

                // Inline Show Completed (wide only)
                if (!isNarrow)
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Icon(Icons.check_circle_outline, size: 16),
                      const SizedBox(width: 8),
                      const Text('Show Completed'),
                      const SizedBox(width: 8),
                      Switch(
                        value: showCompleted,
                        onChanged: onShowCompletedChanged,
                      ),
                    ],
                  ),

                // Kebab overflow (narrow): exposes Show Completed toggle
                if (isNarrow)
                  Padding(
                    padding: const EdgeInsets.only(left: 4),
                    child: PopupMenuButton<int>(
                      tooltip: 'More options',
                      icon: const Icon(Icons.more_vert),
                      onSelected: (v) {
                        if (v == 1) {
                          onShowCompletedChanged(!showCompleted);
                        }
                      },
                      itemBuilder: (ctx) => [
                        PopupMenuItem<int>(
                          value: 1,
                          child: Row(
                            children: [
                              Checkbox(
                                value: showCompleted,
                                onChanged: (_) {
                                  Navigator.of(ctx).pop();
                                  onShowCompletedChanged(!showCompleted);
                                },
                                materialTapTargetSize:
                                    MaterialTapTargetSize.shrinkWrap,
                              ),
                              const SizedBox(width: 8),
                              const Text('Show Completed'),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
              ],
            );
          },
        ),
      ),
    );
  }
}


