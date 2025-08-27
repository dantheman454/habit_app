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
  });

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Theme.of(context).colorScheme.surface,
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

                // Assistant toggle removed from subheader (replaced by attached handle)

                const SizedBox(width: 8),

                // Spacer before right-side controls
                const Spacer(),

                // Inline Search (wide only)
                if (!isNarrow &&
                    searchController != null &&
                    searchFocus != null &&
                    searchLink != null)
                  Padding(
                    padding: const EdgeInsets.only(right: 12),
                    child: GlobalSearchField(
                      controller: searchController!,
                      focusNode: searchFocus!,
                      link: searchLink!,
                      searching: searching,
                      onChanged: onSearchChanged ?? (_) {},
                      onFocusChange: onSearchFocusChange,
                      onKeyEvent: onSearchKeyEvent,
                      onClear: onSearchClear,
                    ),
                  ),

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

                // Kebab overflow (narrow): exposes Show Completed toggle and Search
                if (isNarrow)
                  Padding(
                    padding: const EdgeInsets.only(left: 4),
                    child: PopupMenuButton<int>(
                      tooltip: 'More options',
                      icon: const Icon(Icons.more_vert),
                      onSelected: (v) {
                        if (v == 1) {
                          onShowCompletedChanged(!showCompleted);
                        } else if (v == 2) {
                          if (searchController != null) {
                            showDialog(
                              context: context,
                              builder: (dCtx) {
                                return AlertDialog(
                                  title: const Text('Search'),
                                  content: GlobalSearchField(
                                    controller: searchController!,
                                    focusNode: searchFocus ?? FocusNode(),
                                    link: searchLink ?? LayerLink(),
                                    searching: searching,
                                    // In-dialog: do not trigger overlay show
                                    onChanged: onSearchChanged ?? (_) {},
                                    onFocusChange: null,
                                    onKeyEvent: onSearchKeyEvent,
                                    onClear: onSearchClear,
                                  ),
                                  actions: [
                                    TextButton(
                                      onPressed: () => Navigator.of(dCtx).pop(),
                                      child: const Text('Close'),
                                    ),
                                  ],
                                );
                              },
                            );
                          }
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
                        if (searchController != null)
                          const PopupMenuItem<int>(
                            value: 2,
                            child: ListTile(
                              leading: Icon(Icons.search),
                              title: Text('Search'),
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


