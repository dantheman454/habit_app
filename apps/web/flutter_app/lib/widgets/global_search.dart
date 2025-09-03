import 'package:flutter/material.dart';
// import 'package:flutter/services.dart';

class GlobalSearchField extends StatelessWidget {
  final TextEditingController controller;
  final FocusNode focusNode;
  final LayerLink link;
  final bool searching;
  final void Function(String) onChanged;
  final void Function(bool)? onFocusChange;
  final KeyEventResult Function(FocusNode, KeyEvent)? onKeyEvent;
  final VoidCallback? onClear;
  final bool autofocus; // NEW

  const GlobalSearchField({
    super.key,
    required this.controller,
    required this.focusNode,
    required this.link,
    required this.searching,
    required this.onChanged,
    this.onFocusChange,
    this.onKeyEvent,
    this.onClear,
    this.autofocus = false, // NEW default
  });

  @override
  Widget build(BuildContext context) {
    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 320),
      child: CompositedTransformTarget(
        link: link,
        child: Focus(
          focusNode: focusNode,
          onFocusChange: (f) {
            if (onFocusChange != null) onFocusChange!(f);
          },
          onKeyEvent: onKeyEvent,
          child: TextField(
            controller: controller,
            autofocus: autofocus, // NEW
            decoration: InputDecoration(
              prefixIcon: const Icon(Icons.search),
              hintText: 'Search',
              filled: true,
              fillColor: Theme.of(context).colorScheme.surfaceContainerHigh,
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(24),
                borderSide: BorderSide(
                  color: Theme.of(context)
                      .colorScheme
                      .outline
                      .withAlpha((0.4 * 255).round()),
                ),
              ),
              focusedBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(24),
                borderSide: BorderSide(
                  color: Theme.of(context).colorScheme.primary,
                  width: 2,
                ),
              ),
              suffixIcon: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (searching)
                    SizedBox(
                      width: 16,
                      height: 16,
                      child: Padding(
                        padding: EdgeInsets.all(8),
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                        ),
                      ),
                    ),
                  if (controller.text.isNotEmpty)
                    IconButton(
                      icon: const Icon(Icons.clear),
                      onPressed: onClear,
                    ),
                ],
              ),
            ),
            onChanged: onChanged,
          ),
        ),
      ),
    );
  }
}


