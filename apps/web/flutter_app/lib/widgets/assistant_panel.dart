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
  if (op.title != null) parts.add('– ${op.title}');
  if (op.priority != null) parts.add('(prio ${op.priority})');
  if (op.scheduledFor != null) parts.add('@${op.scheduledFor}');
  if (op.completed != null) parts.add(op.completed! ? '[done]' : '[undone]');
  return parts.join(' ');
}

class AssistantPanel extends StatelessWidget {
  final List<Map<String, String>> transcript;
  final List<dynamic> operations; // Accepts domain type with fields used above
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
  });

  @override
  Widget build(BuildContext context) {
    final labeler = opLabel ?? (dynamic op) {
      // Best-effort mapping of dynamic op to label using reflection-like access
      final like = LlmOperationLike(
        op: _getString(op, 'op') ?? '',
        id: _getInt(op, 'id'),
        title: _getString(op, 'title'),
        notes: _getString(op, 'notes'),
        scheduledFor: _getString(op, 'scheduledFor'),
        priority: _getString(op, 'priority'),
        completed: _getBool(op, 'completed'),
      );
      return defaultOpLabel(like);
    };

    return Container(
      color: Theme.of(context).colorScheme.surfaceVariant.withOpacity(0.15),
      child: Column(
        children: [
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          alignment: Alignment.centerLeft,
          child: const Text('Assistant', style: TextStyle(fontWeight: FontWeight.w600)),
        ),
        const Divider(height: 1),
        Expanded(
          child: ListView(
            padding: const EdgeInsets.all(8),
            children: [
              for (final turn in transcript)
                _buildTurnBubble(context, turn),
              if (operations.isNotEmpty) ...[
                const SizedBox(height: 8),
                const Text('Proposed operations', style: TextStyle(fontWeight: FontWeight.w600)),
                const SizedBox(height: 4),
                ...List.generate(operations.length, (i) {
                  final op = operations[i];
                  return Row(children: [
                    Checkbox(
                      value: operationsChecked[i],
                      onChanged: (v) => onToggleOperation(i, v ?? true),
                    ),
                    Expanded(child: Text(labeler(op))),
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
                  decoration: const InputDecoration(hintText: 'Message the assistant...'),
                  onSubmitted: (_) => onSend(),
                ),
              ),
              const SizedBox(width: 8),
              FilledButton(onPressed: sending ? null : onSend, child: const Text('Send')),
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
}


