import 'package:flutter/material.dart';

class LlmOperationLike {
  final String op;
  final int? id;
  final String? title;
  final String? notes;
  final String? scheduledFor;
  final String? priority;
  final bool? completed;
  const LlmOperationLike({
    required this.op,
    this.id,
    this.title,
    this.notes,
    this.scheduledFor,
    this.priority,
    this.completed,
  });
}

String defaultOpLabel(LlmOperationLike op) {
  final parts = <String>[op.op];
  if (op.id != null) parts.add('#${op.id}');
  if (op.title != null) parts.add('- ${op.title}');
  if (op.priority != null) parts.add('(prio ${op.priority})');
  if (op.scheduledFor != null) parts.add('@${op.scheduledFor}');
  if (op.completed != null) parts.add(op.completed! ? '[done]' : '[undone]');
  return parts.join(' ');
}

class AssistantPanel extends StatelessWidget {
  final List<Map<String, String>> transcript;
  final List<dynamic> operations; // Accepts domain type with fields used above (supports annotated ops)
  final List<bool> operationsChecked;
  final bool sending;
  final bool showDiff;
  final VoidCallback onToggleDiff;
  final void Function(int index, bool value) onToggleOperation;
  final VoidCallback onApplySelected;
  final VoidCallback onDiscard;
  final TextEditingController inputController;
  final VoidCallback onSend;
  final String Function(dynamic op)? opLabel;
  final String? mode; // 'chat' | 'plan'
  final void Function(String mode)? onModeChanged;
  final VoidCallback? onClearChat;

  const AssistantPanel({
    super.key,
    required this.transcript,
    required this.operations,
    required this.operationsChecked,
    required this.sending,
    required this.showDiff,
    required this.onToggleDiff,
    required this.onToggleOperation,
    required this.onApplySelected,
    required this.onDiscard,
    required this.inputController,
    required this.onSend,
    this.opLabel,
    this.mode,
    this.onModeChanged,
    this.onClearChat,
  });

  @override
  Widget build(BuildContext context) {
    final labeler = opLabel ?? (dynamic op) {
      // Support annotated ops: { op: {...}, errors: [...] }
      final candidate = op is Map<String, dynamic> && op.containsKey('op') ? (op['op'] as dynamic) : op;
      final like = LlmOperationLike(
        op: _getString(candidate, 'op') ?? '',
        id: _getInt(candidate, 'id'),
        title: _getString(candidate, 'title'),
        notes: _getString(candidate, 'notes'),
        scheduledFor: _getString(candidate, 'scheduledFor'),
        priority: _getString(candidate, 'priority'),
        completed: _getBool(candidate, 'completed'),
      );
      return defaultOpLabel(like);
    };

    return Container(
      color: Theme.of(context).colorScheme.surfaceVariant.withOpacity(0.15),
      child: Column(
        children: [
        // Header controls
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
          child: Row(
            children: [
              if (onModeChanged != null && mode != null)
                SegmentedButton<String>(
                  segments: const [
                    ButtonSegment(value: 'chat', label: Text('Chat')),
                    ButtonSegment(value: 'plan', label: Text('Plan')),
                  ],
                  selected: <String>{mode!},
                  onSelectionChanged: (s) {
                    if (s.isNotEmpty) onModeChanged!(s.first);
                  },
                ),
              const Spacer(),
              if (onClearChat != null)
                TextButton.icon(
                  onPressed: onClearChat,
                  icon: const Icon(Icons.clear_all, size: 16),
                  label: const Text('Clear'),
                ),
            ],
          ),
        ),
        Expanded(
          child: ListView(
            padding: const EdgeInsets.all(8),
            children: [
              for (final turn in transcript)
                _buildTurnBubble(context, turn),
              if (sending)
                _buildTypingBubble(context),
              if (operations.isNotEmpty) ...[
                const SizedBox(height: 8),
                const Text('Proposed operations', style: TextStyle(fontWeight: FontWeight.w600)),
                const SizedBox(height: 4),
                ...List.generate(operations.length, (i) {
                  final op = operations[i];
                  final errs = _getErrors(op);
                  final isInvalid = errs.isNotEmpty;
                  return Row(children: [
                    Checkbox(
                      value: operationsChecked[i],
                      onChanged: (v) => onToggleOperation(i, v ?? true),
                    ),
                    Expanded(child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(labeler(op)),
                        if (isInvalid)
                          Padding(
                            padding: const EdgeInsets.only(top: 2),
                            child: Text(
                              errs.join(', '),
                              style: TextStyle(color: Theme.of(context).colorScheme.error, fontSize: 12),
                            ),
                          ),
                      ],
                    )),
                  ]);
                }),
                const SizedBox(height: 8),
                Wrap(spacing: 8, runSpacing: 8, children: [
                  FilledButton(onPressed: onApplySelected, child: const Text('Apply Selected')),
                  OutlinedButton(onPressed: onToggleDiff, child: Text(showDiff ? 'Hide changes' : 'Review changes')),
                  TextButton(onPressed: onDiscard, child: const Text('Discard')),
                ]),
                if (showDiff) ...[
                  const SizedBox(height: 8),
                  _buildOpsDiffView(operations, labeler, context),
                ],
              ],
            ],
          ),
        ),
        const Divider(height: 1),
        Padding(
          padding: const EdgeInsets.all(8.0),
          child: Row(
            children: [
              Expanded(
                child: TextField(
                  controller: inputController,
                  decoration: InputDecoration(
                    hintText: 'Message Mr. Assister...',
                    filled: true,
                    fillColor: Colors.white,
                    contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(24),
                      borderSide: BorderSide.none,
                    ),
                  ),
                  onSubmitted: (_) => onSend(),
                ),
              ),
              const SizedBox(width: 8),
              FilledButton(
                onPressed: sending ? null : onSend,
                style: FilledButton.styleFrom(
                  padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 12),
                  shape: const StadiumBorder(),
                ),
                child: const Text('Send'),
              ),
            ],
          ),
        ),
      ],
    ));
  }

  Widget _buildTurnBubble(BuildContext context, Map<String, String> turn) {
    final isUser = (turn['role'] == 'user');
    final Color bg = isUser
        ? Theme.of(context).colorScheme.primary
        : Theme.of(context).colorScheme.surfaceVariant.withOpacity(0.6);
    final Color fg = isUser
        ? Theme.of(context).colorScheme.onPrimary
        : Theme.of(context).colorScheme.onSurfaceVariant;
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 4),
      alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(
          color: bg,
          borderRadius: BorderRadius.circular(8),
        ),
        child: Text(
          turn['text'] ?? '',
          style: TextStyle(color: fg),
        ),
      ),
    );
  }

  Widget _buildOpsDiffView(List<dynamic> ops, String Function(dynamic) labeler, BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final op in ops)
          Container(
            margin: const EdgeInsets.only(bottom: 6),
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(
              border: Border.all(color: Colors.grey.shade300),
              borderRadius: BorderRadius.circular(6),
            ),
            child: Text(labeler(op)),
          ),
      ],
    );
  }

  static String? _getString(dynamic obj, String key) {
    try { final v = (obj as dynamic)[key]; return v is String ? v : null; } catch (_) { return null; }
  }
  static int? _getInt(dynamic obj, String key) {
    try {
      final v = (obj as dynamic)[key];
      if (v is int) return v;
      if (v is String) return int.tryParse(v);
      return null;
    } catch (_) { return null; }
  }
  static bool? _getBool(dynamic obj, String key) {
    try { final v = (obj as dynamic)[key]; return v is bool ? v : null; } catch (_) { return null; }
  }

  static List<String> _getErrors(dynamic obj) {
    try {
      final errs = (obj as dynamic)['errors'];
      if (errs is List) {
        return errs.map((e) => e.toString()).toList();
      }
      return const <String>[];
    } catch (_) { return const <String>[]; }
  }

  Widget _buildTypingBubble(BuildContext context) {
    final bg = Theme.of(context).colorScheme.surfaceVariant.withOpacity(0.6);
    final fg = Theme.of(context).colorScheme.onSurfaceVariant;
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 4),
      alignment: Alignment.centerLeft,
      child: Container(
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(
          color: bg,
          borderRadius: BorderRadius.circular(8),
        ),
        child: const _TypingDots(),
      ),
    );
  }
}

class _TypingDots extends StatefulWidget {
  const _TypingDots();

  @override
  State<_TypingDots> createState() => _TypingDotsState();
}

class _TypingDotsState extends State<_TypingDots> with SingleTickerProviderStateMixin {
  late final AnimationController _c;

  @override
  void initState() {
    super.initState();
    _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 900))..repeat();
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final color = Theme.of(context).colorScheme.onSurfaceVariant;
    return AnimatedBuilder(
      animation: _c,
      builder: (_, __) {
        final t = _c.value; // 0..1
        final active = (t * 3).floor() % 3; // 0,1,2 cycling
        return Row(
          mainAxisSize: MainAxisSize.min,
          children: List.generate(3, (i) {
            final on = i <= active;
            return Padding(
              padding: const EdgeInsets.symmetric(horizontal: 2),
              child: Opacity(
                opacity: on ? 1.0 : 0.3,
                child: Container(
                  width: 6,
                  height: 6,
                  decoration: BoxDecoration(color: color, shape: BoxShape.circle),
                ),
              ),
            );
          }),
        );
      },
    );
  }
}


