import 'package:flutter/material.dart';
import 'context_filter.dart';
import 'global_search.dart';
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

  // Optional assistant/search plumbing
  final VoidCallback? onToggleAssistant;
  final TextEditingController? searchController;
  final FocusNode? searchFocus;
  final LayerLink? searchLink;
  final bool searching;
  final void Function(String)? onSearchChanged;
  final void Function(bool)? onSearchFocusChange;
  final KeyEventResult Function(FocusNode, KeyEvent)? onSearchKeyEvent;
  final VoidCallback? onSearchClear;
  // Optional leading controls (e.g., Day/Week/Month segmented button)
  final Widget? leadingControls;

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
    this.onToggleAssistant,
    this.searchController,
    this.searchFocus,
    this.searchLink,
    this.searching = false,
    this.onSearchChanged,
    this.onSearchFocusChange,
    this.onSearchKeyEvent,
    this.onSearchClear,
    this.leadingControls,
  });

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Theme.of(context).colorScheme.surface,
      elevation: 1,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            child: LayoutBuilder(
          builder: (ctx, cons) {
            // Compute simple responsiveness thresholds
            // Narrow when layout width is below 1024
            final bool showCompletedLabel = cons.maxWidth >= 900;
            if (cons.maxWidth < 1024) {
              return Row(
                children: [
                  // Date controls
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      IconButton(
                        visualDensity: VisualDensity.compact,
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
                        visualDensity: VisualDensity.compact,
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

                  if (leadingControls != null) ...[
                    leadingControls!,
                    const SizedBox(width: 12),
                  ],

                  ConstrainedBox(
                    constraints: const BoxConstraints(minWidth: 0),
                    child: Align(
                      alignment: Alignment.centerLeft,
                      child: ContextFilter(
                        key: ValueKey(selectedContext ?? 'all'),
                        selectedContext: selectedContext,
                        onChanged: onContextChanged,
                      ),
                    ),
                  ),

                  const SizedBox(width: 8),

          Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
            if (showCompletedLabel) const SizedBox(width: 8),
            if (showCompletedLabel) const Text('Completed'),
                      if (showCompletedLabel) const SizedBox(width: 6),
                      Tooltip(
                        message: 'Show completed',
                        child: Switch(
                          value: showCompleted,
                          onChanged: onShowCompletedChanged,
                          materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                        ),
                      ),
                    ],
                  ),

                  const Spacer(),

                  if (searchController != null)
                    IconButton(
                      tooltip: 'Search',
                      icon: const Icon(Icons.search),
                      onPressed: () {
                        showDialog(
                          context: context,
                          barrierDismissible: true,
                          builder: (dCtx) {
                            return Stack(
                              children: [
                                Positioned.fill(
                                  child: GestureDetector(
                                    onTap: () => Navigator.of(dCtx).pop(),
                                  ),
                                ),
                                Align(
                                  alignment: Alignment.topCenter,
                                  child: SafeArea(
                                    child: Padding(
                                      padding: const EdgeInsets.only(top: 64),
                                      child: Material(
                                        color: Theme.of(context).colorScheme.surface,
                                        elevation: 8,
                                        borderRadius: BorderRadius.circular(12),
                                        clipBehavior: Clip.antiAlias,
                                        child: ConstrainedBox(
                                          constraints: const BoxConstraints(maxWidth: 560),
                                          child: Padding(
                                            padding: const EdgeInsets.all(12),
                                            child: GlobalSearchField(
                                              controller: searchController!,
                                              focusNode: searchFocus ?? FocusNode(),
                                              link: searchLink ?? LayerLink(),
                                              searching: searching,
                                              onChanged: onSearchChanged ?? (_) {},
                                              onFocusChange: onSearchFocusChange,
                                              onKeyEvent: onSearchKeyEvent,
                                              onClear: onSearchClear,
                                              autofocus: true,
                                            ),
                                          ),
                                        ),
                                      ),
                                    ),
                                  ),
                                ),
                              ],
                            );
                          },
                        );
                      },
                    ),
                  // Assistant toggle removed from header
                ],
              );
            }
            return Row(
              children: [
                // Date controls
                Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    IconButton(
                      visualDensity: VisualDensity.compact,
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
                      visualDensity: VisualDensity.compact,
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

                // Optional leading controls (e.g., view segmented control)
                if (leadingControls != null) ...[
                  leadingControls!,
                  const SizedBox(width: 12),
                ],

                // Context selector (single-choice), allow intrinsic width to prevent clipping
                ConstrainedBox(
                  constraints: const BoxConstraints(minWidth: 0),
                  child: Align(
                    alignment: Alignment.centerLeft,
                    child: ContextFilter(
                      key: ValueKey(selectedContext ?? 'all'),
                      selectedContext: selectedContext,
                      onChanged: onContextChanged,
                    ),
                  ),
                ),

                const SizedBox(width: 8),

                // Labeled Show Completed switch next to ContextFilter
        Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
          if (showCompletedLabel) const SizedBox(width: 8),
          if (showCompletedLabel) const Text('Completed'),
                    if (showCompletedLabel) const SizedBox(width: 6),
                    Tooltip(
                      message: 'Show completed',
                      child: Switch(
                        value: showCompleted,
                        onChanged: onShowCompletedChanged,
                        materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                      ),
                    ),
                  ],
                ),

                // Spacer before right-side controls
                const Spacer(),

                // Search icon (opens dialog with GlobalSearchField)
                if (searchController != null)
                  IconButton(
                    tooltip: 'Search',
                    icon: const Icon(Icons.search),
                    onPressed: () {
                      showDialog(
                        context: context,
                        barrierDismissible: true,
                        builder: (dCtx) {
                          return Stack(
                            children: [
                              Positioned.fill(
                                child: GestureDetector(
                                  onTap: () => Navigator.of(dCtx).pop(),
                                ),
                              ),
                              Align(
                                alignment: Alignment.topCenter,
                                child: SafeArea(
                                  child: Padding(
                                    padding: const EdgeInsets.only(top: 64),
                                    child: Material(
                                      color: Theme.of(context).colorScheme.surface,
                                      elevation: 8,
                                      borderRadius: BorderRadius.circular(12),
                                      clipBehavior: Clip.antiAlias,
                                      child: ConstrainedBox(
                                        constraints: const BoxConstraints(maxWidth: 560),
                                        child: Padding(
                                          padding: const EdgeInsets.all(12),
                                          child: GlobalSearchField(
                                            controller: searchController!,
                                            focusNode: searchFocus ?? FocusNode(),
                                            link: searchLink ?? LayerLink(),
                                            searching: searching,
                                            onChanged: onSearchChanged ?? (_) {},
                                            onFocusChange: onSearchFocusChange,
                                            onKeyEvent: onSearchKeyEvent,
                                            onClear: onSearchClear,
                                            autofocus: true,
                                          ),
                                        ),
                                      ),
                                    ),
                                  ),
                                ),
                              ),
                            ],
                          );
                        },
                      );
                    },
                  ),
                // Assistant toggle removed from header

                // Icon-only toggle removed in favor of labeled switch near ContextFilter

                // Kebab removed (no remaining items)
              ],
            );
          },
        ),
      ),
          Divider(
            height: 1,
            thickness: 1,
            color: Theme.of(context).colorScheme.outlineVariant,
          ),
        ],
      ),
    );
  }
}


