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
  final String? model; // raw model id (badge)
  final bool showDiff;
  final VoidCallback onToggleDiff;
  final void Function(int index, bool value) onToggleOperation;
  final VoidCallback onApplySelected;
  final VoidCallback onDiscard;
  final TextEditingController inputController;
  final VoidCallback onSend;
  final String Function(dynamic op)? opLabel;
  // mode removed
  final VoidCallback? onClearChat;
  // Clarify UI
  final String? clarifyQuestion;
  final List<Map<String, dynamic>> clarifyOptions;
  final void Function(int id)? onToggleClarifyId;
  final void Function(String? date)? onSelectClarifyDate;
  final void Function(String? priority)? onSelectClarifyPriority;
  // Progress stage label
  final String? progressStage;
  // Helper for date quick-selects
  final String? todayYmd;
  // Selected clarify state for UI reflection
  final Set<int>? selectedClarifyIds;
  final String? selectedClarifyDate;
  final String? selectedClarifyPriority;
  

  const AssistantPanel({
    super.key,
    required this.transcript,
    required this.operations,
    required this.operationsChecked,
    required this.sending,
    this.model,
    required this.showDiff,
    required this.onToggleDiff,
    required this.onToggleOperation,
    required this.onApplySelected,
    required this.onDiscard,
    required this.inputController,
    required this.onSend,
    this.opLabel,
    this.onClearChat,
    this.clarifyQuestion,
    this.clarifyOptions = const [],
    this.onToggleClarifyId,
    this.onSelectClarifyDate,
    this.onSelectClarifyPriority,
    this.progressStage,
    this.todayYmd,
    this.selectedClarifyIds,
    this.selectedClarifyDate,
    this.selectedClarifyPriority
  });

  @override
  Widget build(BuildContext context) {
    final labeler = opLabel ?? (dynamic op) {
      // Support annotated ops: { op: {...}, errors: [...] }
      final candidate = op is Map<String, dynamic> && op.containsKey('op') ? (op['op'] as dynamic) : op;
      final opStr = _getString(candidate, 'op') ?? '';
      final kind = _getString(candidate, 'kind');
      final action = _getString(candidate, 'action');
      final id = _getInt(candidate, 'id');
      final title = _getString(candidate, 'title');
      final sched = _getString(candidate, 'scheduledFor');
      final prio = _getString(candidate, 'priority');
      final done = _getBool(candidate, 'completed');
      // Prefer V3 label when present
      if (kind != null && action != null) {
        final parts = <String>[kind, action];
        if (id != null) parts.add('#$id');
        if (title != null) parts.add('– $title');
        if (prio != null) parts.add('(prio $prio)');
        if (sched != null) parts.add('@$sched');
        if (done != null) parts.add(done ? '[done]' : '[undone]');
        return parts.join(' ');
      }
      final like = LlmOperationLike(op: opStr, id: id, title: title, notes: _getString(candidate, 'notes'), scheduledFor: sched, priority: prio, completed: done);
      return defaultOpLabel(like);
    };

    return Container(
      color: Theme.of(context).colorScheme.surfaceContainerHighest.withOpacity(0.15),
      child: Column(
        children: [
        // Header controls
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
          child: Row(
            children: [
              if (model != null && model!.isNotEmpty)
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                  decoration: BoxDecoration(
                    color: Theme.of(context).colorScheme.surface,
                    borderRadius: BorderRadius.circular(999),
                    border: Border.all(color: Theme.of(context).colorScheme.outline.withOpacity(0.5)),
                  ),
                  child: Row(children: [
                    const Icon(Icons.memory, size: 14),
                    const SizedBox(width: 6),
                    Text(model!, style: const TextStyle(fontSize: 12)),
                  ]),
                ),
              const SizedBox(width: 8),
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
              for (final turn in transcript) _buildTurnBubble(context, turn),
              if ((clarifyQuestion != null && clarifyQuestion!.isNotEmpty) || clarifyOptions.isNotEmpty) ...[
                const SizedBox(height: 8),
                _buildClarifySection(context),
              ],
              if (sending)
                _buildTypingBubble(context),
              if (sending && (progressStage != null && progressStage!.isNotEmpty))
                Padding(
                  padding: const EdgeInsets.only(left: 6, bottom: 6),
                  child: Text('Progress: ${progressStage!}', style: TextStyle(fontSize: 12, color: Theme.of(context).colorScheme.onSurfaceVariant.withOpacity(0.8))),
                ),
              if (operations.isNotEmpty) ...[
                const SizedBox(height: 8),
                const Text('Proposed operations', style: TextStyle(fontWeight: FontWeight.w600)),
                const SizedBox(height: 4),
                if (operations.any((o) => _getErrors(o).isNotEmpty)) ...[
                  const SizedBox(height: 6),
                  Container(
                    padding: const EdgeInsets.all(8),
                    decoration: BoxDecoration(
                      color: Colors.amberAccent.withOpacity(0.15),
                      borderRadius: BorderRadius.circular(6),
                      border: Border.all(color: Colors.amber.withOpacity(0.6)),
                    ),
                    child: const Text(
                      'Some proposed operations are invalid and cannot be applied. Please review the errors below.',
                      style: TextStyle(fontSize: 12),
                    ),
                  ),
                  const SizedBox(height: 6),
                ],
                ..._buildGroupedOperationList(context, operations, operationsChecked, labeler),
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
                    hintText: 'Ask Away...',
                    filled: true,
                    fillColor: Theme.of(context).colorScheme.surface,
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
        : Theme.of(context).colorScheme.surfaceContainerHighest.withOpacity(0.6);
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
      final errs = (obj as dynamic).errors;
      if (errs is List) {
        return errs.map((e) => e.toString()).toList();
      }
    } catch (_) {}
    try {
      final errs = (obj as dynamic)['errors'];
      if (errs is List) {
        return errs.map((e) => e.toString()).toList();
      }
    } catch (_) {}
    return const <String>[];
  }

  String _kindOf(dynamic obj) {
    try {
      final candidate = obj is Map<String, dynamic> && obj.containsKey('op') ? (obj['op'] as dynamic) : obj;
      final k = (candidate as dynamic)['kind'];
      if (k is String && k.isNotEmpty) return k.toLowerCase();
    } catch (_) {}
    return 'todo';
  }

  Icon _kindIcon(String kind) {
    switch (kind) {
      case 'event':
        return const Icon(Icons.event, size: 16);
      case 'goal':
        return const Icon(Icons.flag, size: 16);
      default:
        return const Icon(Icons.check_box_outline_blank, size: 16);
    }
  }

  List<Widget> _buildGroupedOperationList(BuildContext context, List<dynamic> ops, List<bool> checked, String Function(dynamic) labeler) {
    // Build ordered kinds by first appearance
    final kinds = <String>[];
    final byKind = <String, List<int>>{};
    for (var i = 0; i < ops.length; i++) {
      final k = _kindOf(ops[i]);
      if (!byKind.containsKey(k)) { byKind[k] = <int>[]; kinds.add(k); }
      byKind[k]!.add(i);
    }
    final theme = Theme.of(context);
    final widgets = <Widget>[];
    for (final k in kinds) {
      widgets.add(Padding(
        padding: const EdgeInsets.only(top: 8, bottom: 4),
        child: Row(children: [
          _kindIcon(k), const SizedBox(width: 6), Text(k.toUpperCase(), style: const TextStyle(fontWeight: FontWeight.w600)),
        ]),
      ));
      for (final i in byKind[k]!) {
        final op = ops[i];
        final errs = _getErrors(op);
        final isInvalid = errs.isNotEmpty;
        widgets.add(Row(children: [
          Tooltip(
            message: isInvalid ? 'This operation is invalid and cannot be applied.' : '',
            preferBelow: false,
            child: Checkbox(
              value: checked[i],
              onChanged: isInvalid ? null : (v) => onToggleOperation(i, v ?? true),
            ),
          ),
          _kindIcon(k), const SizedBox(width: 6),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(labeler(op)),
            if (isInvalid)
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Text(
                  errs.join(', '),
                  style: TextStyle(color: theme.colorScheme.error, fontSize: 12),
                ),
              ),
          ])),
        ]));
      }
    }
    return widgets;
  }

  Widget _buildTypingBubble(BuildContext context) {
    final bg = Theme.of(context).colorScheme.surfaceContainerHighest.withOpacity(0.6);
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

  Widget _buildClarifySection(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerHighest.withOpacity(0.4),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (clarifyQuestion != null && clarifyQuestion!.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: Text(clarifyQuestion!, style: const TextStyle(fontWeight: FontWeight.w600)),
            ),
          if (clarifyOptions.isNotEmpty)
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                for (final o in clarifyOptions)
                  FilterChip(
                    label: Text('#${o['id']} ${o['title']}${o['scheduledFor'] == null ? '' : ' @${o['scheduledFor']}'}'),
                    selected: (selectedClarifyIds ?? const <int>{}).contains(o['id'] as int),
                    onSelected: (_) => onToggleClarifyId?.call((o['id'] as int)),
                  )
              ],
            ),
          const SizedBox(height: 8),
          Wrap(spacing: 6, runSpacing: 6, children: [
            OutlinedButton.icon(
              icon: const Icon(Icons.today, size: 16),
              onPressed: () => onSelectClarifyDate?.call(todayYmd),
              label: Text('Today${(selectedClarifyDate != null && selectedClarifyDate == todayYmd) ? ' ✓' : ''}'),
            ),
            OutlinedButton.icon(
              icon: const Icon(Icons.calendar_today, size: 16),
              onPressed: () => onSelectClarifyDate?.call(null),
              label: Text('Unscheduled${(selectedClarifyDate == null) ? ' ✓' : ''}'),
            ),
            OutlinedButton(
              onPressed: () => onSelectClarifyPriority?.call('high'),
              child: Text('prio: high${(selectedClarifyPriority == 'high') ? ' ✓' : ''}'),
            ),
            OutlinedButton(
              onPressed: () => onSelectClarifyPriority?.call('medium'),
              child: Text('prio: medium${(selectedClarifyPriority == 'medium') ? ' ✓' : ''}'),
            ),
            OutlinedButton(
              onPressed: () => onSelectClarifyPriority?.call('low'),
              child: Text('prio: low${(selectedClarifyPriority == 'low') ? ' ✓' : ''}'),
            ),
          ]),
        ],
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


