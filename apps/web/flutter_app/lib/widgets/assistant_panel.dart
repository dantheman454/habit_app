import 'package:flutter/material.dart';
import 'dart:convert';
import '../api.dart' as api;

class LlmOperationLike {
  final String op;
  final int? id;
  final String? title;
  final String? notes;
  final String? scheduledFor;
  final bool? completed;
  const LlmOperationLike({
    required this.op,
    this.id,
    this.title,
    this.notes,
    this.scheduledFor,
    this.completed,
  });
}

String defaultOpLabel(LlmOperationLike op) {
  final parts = <String>[op.op];
  if (op.id != null) parts.add('#${op.id}');
  if (op.title != null) parts.add('- ${op.title}');
  if (op.scheduledFor != null) parts.add('@${op.scheduledFor}');
  if (op.completed != null) parts.add(op.completed! ? '[done]' : '[undone]');
  return parts.join(' ');
}

class AssistantPanel extends StatelessWidget {
  final List<Map<String, String>> transcript;
  final List<dynamic>
  operations; // Accepts domain type with fields used above (supports annotated ops)
  final List<bool> operationsChecked;
  final bool sending;
  final Map<String, Map<String, dynamic>>? previewsByKey;
  final void Function(int index, bool value) onToggleOperation;
  final VoidCallback onApplySelected;
  final VoidCallback onDiscard;
  final TextEditingController inputController;
  final VoidCallback onSend;
  final String Function(dynamic op)? opLabel;
  final VoidCallback? onClearChat;
  // Clarify UI
  final String? clarifyQuestion;
  final List<Map<String, dynamic>> clarifyOptions;
  final void Function(int id)? onToggleClarifyId;
  final void Function(String? date)? onSelectClarifyDate;
  // Progress stage label
  final String? progressStage;
  // Optional progress metadata
  final int? progressValid;
  final int? progressInvalid;
  final DateTime? progressStart;
  // Helper for date quick-selects
  final String? todayYmd;
  // Selected clarify state for UI reflection
  final Set<int>? selectedClarifyIds;
  final String? selectedClarifyDate;
  // Thinking data for optional display
  final String? thinking;
  final bool showThinking;
  final VoidCallback? onToggleThinking;
  

  const AssistantPanel({
    super.key,
    required this.transcript,
    required this.operations,
    required this.operationsChecked,
    required this.sending,
    
    this.previewsByKey,
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
    
    this.progressStage,
  this.progressValid,
  this.progressInvalid,
  this.progressStart,
    this.todayYmd,
    this.selectedClarifyIds,
    this.selectedClarifyDate,
    this.thinking,
    this.showThinking = false,
    this.onToggleThinking,
    
  });

  @override
  Widget build(BuildContext context) {
    final labeler =
        opLabel ??
        (dynamic op) {
          // Support annotated ops: { op: {...}, errors: [...] }
      final candidate = op is Map<String, dynamic> && op.containsKey('op')
        ? op['op']
        : op;
          final opStr = _getString(candidate, 'op') ?? '';
          final kind = _getString(candidate, 'kind');
          final action = _getString(candidate, 'action');
          final id = _getInt(candidate, 'id');
          final title = _getString(candidate, 'title');
          final sched = _getString(candidate, 'scheduledFor');
          final done = _getBool(candidate, 'completed');
          // Prefer V3 label when present
          if (kind != null && action != null) {
            final parts = <String>[kind, action];
            if (id != null) parts.add('#$id');
            if (title != null) parts.add('– $title');
            if (sched != null) parts.add('@$sched');
            if (done != null) parts.add(done ? '[done]' : '[undone]');
            return parts.join(' ');
          }
          final like = LlmOperationLike(
            op: opStr,
            id: id,
            title: title,
            notes: _getString(candidate, 'notes'),
            scheduledFor: sched,
            completed: done,
          );
          return defaultOpLabel(like);
        };

    // Responsive header tweaks
    final bool narrowHeader = () {
      try {
        return MediaQuery.of(context).size.width < 320;
      } catch (_) {
        return false;
      }
    }();

    return Container(
      color: Theme.of(
        context,
      ).colorScheme.surfaceContainerHighest.withAlpha((0.15 * 255).round()),
      child: Column(
        children: [
          // Header: compact title + single actions row
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 10, 12, 8),
            child: Row(
              children: [
                const Icon(Icons.smart_toy_outlined, size: 18),
                const SizedBox(width: 6),
                const Text(
                  'Mr. Assister',
                  style: TextStyle(fontWeight: FontWeight.w600, fontSize: 20),
                ),
                const Spacer(),
                if (onToggleThinking != null)
                  Padding(
                    padding: const EdgeInsets.only(right: 4),
                    child: TextButton.icon(
                      onPressed: onToggleThinking,
                      icon: Icon(
                        showThinking ? Icons.visibility_off_outlined : Icons.visibility_outlined,
                        size: 16,
                      ),
                      label: Text(showThinking ? 'Hide thinking' : 'Show thinking'),
                    ),
                  ),
                if (onClearChat != null)
                  (
                    narrowHeader
                      ? Tooltip(
                          message: 'Clear',
                          child: IconButton(
                            onPressed: onClearChat,
                            icon: const Icon(Icons.clear_all, size: 18),
                            visualDensity: VisualDensity.compact,
                          ),
                        )
                      : TextButton.icon(
                          onPressed: onClearChat,
                          icon: const Icon(Icons.clear_all, size: 16),
                          label: const Text('Clear'),
                        )
                  ),
              ],
            ),
          ),
          Expanded(
            child: ListView(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
              children: [
                for (final turn in transcript) _buildTurnBubble(context, turn),
                if ((clarifyQuestion != null && clarifyQuestion!.isNotEmpty) ||
                    clarifyOptions.isNotEmpty) ...[
                  const SizedBox(height: 8),
                  _buildClarifySection(context),
                ],
                if (sending) _buildTypingBubble(context),
                if (sending && (progressStage != null && progressStage!.isNotEmpty))
                  _buildProgress(context),
                if (operations.isNotEmpty) ...[
                  const SizedBox(height: 8),
                  _SectionHeader(
                    title: sending ? 'Proposed operations' : 'Executed operations (${operations.length})',
                  ),
                  if (operations.any((o) => _getErrors(o).isNotEmpty))
                    Padding(
                      padding: const EdgeInsets.only(top: 4, bottom: 4),
                      child: Row(
                        children: const [
                          Icon(Icons.error_outline, size: 16, color: Colors.amber),
                          SizedBox(width: 6),
                          Expanded(
                            child: Text(
                              'Some operations failed to run. Review errors below.',
                              style: TextStyle(fontSize: 12),
                            ),
                          ),
                        ],
                      ),
                    ),
                  const SizedBox(height: 4),
                  if (operations.any((o) => _getErrors(o).isNotEmpty)) ...[
                    const SizedBox(height: 6),
                    Container(
                      padding: const EdgeInsets.all(8),
                      decoration: BoxDecoration(
                        color: Colors.amberAccent.withAlpha((0.15 * 255).round()),
                        borderRadius: BorderRadius.circular(6),
                        border: Border.all(
                          color: Colors.amber.withAlpha((0.6 * 255).round()),
                        ),
                      ),
                      child: const Text(
                        'Some proposed operations are invalid and cannot be applied. Please review the errors below.',
                        style: TextStyle(fontSize: 12),
                      ),
                    ),
                    const SizedBox(height: 6),
                  ],
                  ..._buildGroupedOperationList(
                    context,
                    operations,
                    operationsChecked,
                    labeler,
                  ),
                  const SizedBox(height: 8),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      FilledButton(
                        onPressed: () async {
                          final anyChecked = operationsChecked.any((e) => e);
                          if (!anyChecked) {
                            onApplySelected();
                            return;
                          }
                          final confirmed = await showDialog<bool>(
                            context: context,
                            builder: (ctx) => AlertDialog(
                              title: const Text('Apply selected changes?'),
                              content: const Text('These changes will be applied to your data. You can undo the last batch from the menu.'),
                              actions: [
                                TextButton(
                                  onPressed: () => Navigator.of(ctx).pop(false),
                                  child: const Text('Cancel'),
                                ),
                                FilledButton(
                                  onPressed: () => Navigator.of(ctx).pop(true),
                                  child: const Text('Apply'),
                                ),
                              ],
                            ),
                          );
                          if (confirmed == true) onApplySelected();
                        },
                        child: const Text('Apply Selected'),
                      ),
                      // Quick selection helpers (operate via onToggleOperation)
                      TextButton(
                        onPressed: () {
                          for (var i = 0; i < operations.length; i++) {
                            // Skip invalid ops
                            if (_getErrors(operations[i]).isNotEmpty) continue;
                            if (i < operationsChecked.length && !operationsChecked[i]) {
                              onToggleOperation(i, true);
                            }
                          }
                        },
                        child: const Text('Select all'),
                      ),
                      TextButton(
                        onPressed: () {
                          for (var i = 0; i < operations.length; i++) {
                            if (i < operationsChecked.length && operationsChecked[i]) {
                              onToggleOperation(i, false);
                            }
                          }
                        },
                        child: const Text('Clear'),
                      ),
                      TextButton(
                        onPressed: onDiscard,
                        child: const Text('Discard'),
                      ),
                    ],
                  ),
                ],
              ],
            ),
          ),
          const Divider(height: 1),
          Padding(
            padding: const EdgeInsets.fromLTRB(8, 8, 8, 8),
            child: Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: inputController,
                    decoration: InputDecoration(
                      hintText: 'Ask away…',
                      filled: true,
                      fillColor: Theme.of(context).colorScheme.surface,
                      contentPadding: const EdgeInsets.symmetric(
                        horizontal: 12,
                        vertical: 10,
                      ),
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
                    padding: const EdgeInsets.symmetric(
                      horizontal: 18,
                      vertical: 12,
                    ),
                    shape: const StadiumBorder(),
                  ),
                  child: const Text('Send'),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildTurnBubble(BuildContext context, Map<String, String> turn) {
    final isUser = (turn['role'] == 'user');
  final Color bg = isUser
    ? Theme.of(context).colorScheme.primary
    : Theme.of(
      context,
      ).colorScheme.surfaceContainerHighest.withAlpha((0.6 * 255).round());
    final Color fg = isUser
        ? Theme.of(context).colorScheme.onPrimary
        : Theme.of(context).colorScheme.onSurfaceVariant;
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 4),
      alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 520),
        child: Container(
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(
            color: bg,
            borderRadius: BorderRadius.circular(8),
          ),
          child: Text(_parseLLMResponse(turn['text'] ?? ''), style: TextStyle(color: fg)),
        ),
      ),
    );
  }

  static String _opKey(dynamic candidate) {
    try {
      final m = (candidate is Map<String, dynamic> && candidate.containsKey('op'))
          ? (candidate['op'] as Map)
          : candidate as Map;
      return [
        (m['kind'] ?? 'task').toString(),
        (m['action'] ?? m['op'] ?? 'create').toString(),
        (m['id'] ?? '').toString(),
        (m['scheduledFor'] ?? '').toString(),
        (m['timeOfDay'] ?? m['startTime'] ?? '').toString(),
        (m['title'] ?? '').toString(),
        (m['status'] ?? '').toString(),
        (m['occurrenceDate'] ?? '').toString(),
      ].join('|');
    } catch (_) {
      return '';
    }
  }

  static String? _getString(dynamic obj, String key) {
    try {
      if (obj is Map) {
        final v = obj[key];
        return v is String ? v : null;
      }
  final v = obj[key];
      return v is String ? v : null;
    } catch (_) {
      return null;
    }
  }

  static int? _getInt(dynamic obj, String key) {
    try {
      if (obj is Map) {
        final v = obj[key];
        if (v is int) return v;
        if (v is String) return int.tryParse(v);
        return null;
      }
  final v = obj[key];
      if (v is int) return v;
      if (v is String) return int.tryParse(v);
      return null;
    } catch (_) {
      return null;
    }
  }

  static bool? _getBool(dynamic obj, String key) {
    try {
      if (obj is Map) {
        final v = obj[key];
        return v is bool ? v : null;
      }
  final v = obj[key];
      return v is bool ? v : null;
    } catch (_) {
      return null;
    }
  }

  static List<String> _getErrors(dynamic obj) {
    try {
      if (obj is Map) {
        final errs = obj['errors'];
        if (errs is List) return errs.map((e) => e.toString()).toList();
      } else {
  // Fallback: try dynamic property / map access
  final errs = obj['errors'];
  if (errs is List) return errs.map((e) => e.toString()).toList();
      }
    } catch (_) {}
    try {
      final errs = obj['errors'];
      if (errs is List) {
        return errs.map((e) => e.toString()).toList();
      }
    } catch (_) {}
    return const <String>[];
  }

  // Add JSON response parsing and display logic
  static String _parseLLMResponse(String rawResponse) {
    try {
      // Try to parse as JSON
      final Map<String, dynamic> parsed = jsonDecode(rawResponse);
      
      // Extract user-friendly information
      final String? response = parsed['response'];
      final String? text = parsed['text'];
      // operations parsed but not displayed here; omit unused local to satisfy analyzer
      
      // Prefer clean text over raw response
      if (text != null && text.isNotEmpty) {
        return text;
      } else if (response != null) {
        return response;
      }
    } catch (e) {
      // If not JSON, treat as plain text
    }
    
    return rawResponse;
  }

  String _kindOf(dynamic obj) {
    try {
      final candidate = obj is Map<String, dynamic> && obj.containsKey('op')
          ? obj['op']
          : obj;
      // Prefer V3 'kind'
      try {
        if (candidate is Map) {
          final k = candidate['kind'];
          if (k is String && k.isNotEmpty) return k.toLowerCase();
        } else {
          final k = candidate['kind'];
          if (k is String && k.isNotEmpty) return k.toLowerCase();
        }
      } catch (_) {}
      // Fallback: infer from 'op' verb if present
      try {
        if (candidate is Map) {
          final op = candidate['op'];
          if (op is String && op.isNotEmpty) {
            if (op.startsWith('goal_')) return 'goal';
            return 'task';
          }
        } else {
          final op = candidate['op'];
          if (op is String && op.isNotEmpty) {
            if (op.startsWith('goal_')) return 'goal';
            return 'task';
          }
        }
      } catch (_) {}
    } catch (_) {}
    return 'task';
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

  List<Widget> _buildGroupedOperationList(
    BuildContext context,
    List<dynamic> ops,
    List<bool> checked,
    String Function(dynamic) labeler,
  ) {
    // Build ordered kinds by first appearance
    final kinds = <String>[];
    final byKind = <String, List<int>>{};
    for (var i = 0; i < ops.length; i++) {
      final k = _kindOf(ops[i]);
      if (!byKind.containsKey(k)) {
        byKind[k] = <int>[];
        kinds.add(k);
      }
      byKind[k]!.add(i);
    }
    final theme = Theme.of(context);
    final widgets = <Widget>[];
    for (final k in kinds) {
      widgets.add(
        Padding(
          padding: const EdgeInsets.only(top: 8, bottom: 4),
          child: Row(
            children: [
              _kindIcon(k),
              const SizedBox(width: 6),
              Text(
                k.toUpperCase(),
                style: const TextStyle(fontWeight: FontWeight.w600),
              ),
            ],
          ),
        ),
      );
  final idxs = byKind[k] ?? const <int>[];
  for (final i in idxs) {
        final op = ops[i];
        final errs = _getErrors(op);
        final isInvalid = errs.isNotEmpty;
        widgets.add(Padding(
          padding: const EdgeInsets.symmetric(vertical: 2),
          child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Tooltip(
              message: isInvalid ? 'This operation is invalid and cannot be applied.' : '',
              preferBelow: false,
              child: Checkbox(
                value: checked[i],
                onChanged: isInvalid ? null : (v) => onToggleOperation(i, v ?? true),
              ),
            ),
            _kindIcon(k),
            const SizedBox(width: 6),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(labeler(op)),
                  if (isInvalid)
                    Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: Text(
                        errs.join(', '),
                        style: TextStyle(color: theme.colorScheme.error, fontSize: 12),
                      ),
                    ),
                  // Inline preview snippet when available
                  Builder(builder: (_) {
                    try {
                      final key = _opKey(op is Map<String, dynamic> ? op : (op as dynamic).op.toJson());
                      final preview = (previewsByKey ?? const <String, Map<String, dynamic>>{})[key];
                      if (preview == null) return const SizedBox.shrink();
                      final before = (preview['before'] as Map?)?.cast<String, dynamic>();
                      final opMap = (preview['op'] as Map?)?.cast<String, dynamic>();
                      final rows = _computeDiffRows(before, opMap);
                      if (rows.isEmpty) return const SizedBox.shrink();
                      return Padding(
                        padding: const EdgeInsets.only(top: 4, left: 0),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            _InlineDiffSnippet(rows: rows),
                            const SizedBox(height: 4),
                            Wrap(
                              spacing: 6,
                              children: [
                                ActionChip(avatar: const Icon(Icons.check, size: 16), label: const Text('Accept'), onPressed: () => onToggleOperation(i, true)),
                                ActionChip(avatar: const Icon(Icons.close, size: 16), label: const Text('Reject'), onPressed: () => onToggleOperation(i, false)),
                              ],
                            ),
                          ],
                        ),
                      );
                    } catch (_) {
                      return const SizedBox.shrink();
                    }
                  }),
                ],
              ),
            ),
          ],
        )));
      }
    }
    return widgets;
  }

  Widget _buildTypingBubble(BuildContext context) {
    final bg = Theme.of(
      context,
    ).colorScheme.surfaceContainerHighest.withAlpha((0.6 * 255).round());
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

  Widget _buildProgress(BuildContext context) {
    double stagePercent(String s) {
      switch (s) {
        case 'routing':
          return 0.15;
        case 'proposing':
          return 0.35;
        case 'validating':
          return 0.55;
        case 'repairing':
          return 0.75;
        case 'summarizing':
          return 0.9;
        case 'done':
          return 1.0;
        default:
          return 0.1;
      }
    }
    final theme = Theme.of(context);
    final pct = stagePercent(progressStage ?? '');
    final valid = progressValid ?? 0;
    final invalid = progressInvalid ?? 0;
    final start = progressStart;
    final elapsed = start == null ? '' : ' • ${(DateTime.now().difference(start).inSeconds)}s';
    return Padding(
      padding: const EdgeInsets.only(left: 8, bottom: 6, right: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Progress • ${progressStage ?? ''}$elapsed',
            style: TextStyle(
              fontSize: 12,
              color: theme.colorScheme.onSurfaceVariant.withAlpha((0.8 * 255).round()),
            ),
          ),
          const SizedBox(height: 4),
          ClipRRect(
            borderRadius: BorderRadius.circular(4),
            child: LinearProgressIndicator(
              value: pct.clamp(0.0, 1.0),
              minHeight: 6,
            ),
          ),
          if (valid + invalid > 0)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                'ops: $valid valid · $invalid invalid',
                style: TextStyle(
                  fontSize: 11,
                  color: theme.colorScheme.onSurfaceVariant.withAlpha((0.7 * 255).round()),
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildClarifySection(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
      decoration: BoxDecoration(
  color: theme.colorScheme.surfaceContainerHighest.withAlpha((0.4 * 255).round()),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (clarifyQuestion != null && clarifyQuestion!.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: Text(
                clarifyQuestion!,
                style: const TextStyle(fontWeight: FontWeight.w600),
              ),
            ),
          if (clarifyOptions.isNotEmpty)
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                for (final o in clarifyOptions)
                  FilterChip(
                    label: Text(
                      '#${o['id']} ${o['title']}${o['scheduledFor'] == null ? '' : ' @${o['scheduledFor']}'}',
                    ),
                    selected: (selectedClarifyIds ?? const <int>{}).contains(
                      o['id'] as int,
                    ),
                    onSelected: (_) =>
                        onToggleClarifyId?.call((o['id'] as int)),
                  ),
              ],
            ),
          const SizedBox(height: 8),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [
              OutlinedButton.icon(
                icon: const Icon(Icons.today, size: 16),
                onPressed: () => onSelectClarifyDate?.call(todayYmd),
                label: Text(
                  'Today${(selectedClarifyDate != null && selectedClarifyDate == todayYmd) ? ' ✓' : ''}',
                ),
              ),
              OutlinedButton.icon(
                icon: const Icon(Icons.calendar_today, size: 16),
                onPressed: () => onSelectClarifyDate?.call(null),
                label: Text(
                  'Unscheduled${(selectedClarifyDate == null) ? ' ✓' : ''}',
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _InlineDiffSnippet extends StatefulWidget {
  final List<Widget> rows;
  const _InlineDiffSnippet({required this.rows});

  @override
  State<_InlineDiffSnippet> createState() => _InlineDiffSnippetState();
}

class _InlineDiffSnippetState extends State<_InlineDiffSnippet> {
  bool expanded = false;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final visible = expanded ? widget.rows : widget.rows.take(3).toList();
    final canExpand = widget.rows.length > 3;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(
          decoration: BoxDecoration(
            color: theme.colorScheme.surfaceContainerHighest.withAlpha((0.35 * 255).round()),
            borderRadius: BorderRadius.circular(4),
          ),
          padding: const EdgeInsets.all(6),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: visible,
          ),
        ),
        if (canExpand)
          TextButton.icon(
            onPressed: () => setState(() => expanded = !expanded),
            icon: Icon(expanded ? Icons.expand_less : Icons.expand_more, size: 16),
            label: Text(expanded ? 'Hide details' : 'Show more'),
          ),
      ],
    );
  }
}
  List<Widget> _computeDiffRows(
    Map<String, dynamic>? before,
    Map<String, dynamic>? op,
  ) {
    final rows = <Widget>[];
    String fmt(dynamic v) {
      if (v == null) return '—';
      if (v is bool) return v ? 'true' : 'false';
      if (v is num) return v.toString();
      if (v is Map || v is List) return const String.fromEnvironment('dart.vm.product') == 'true' ? '[…]' : v.toString();
      return v.toString();
    }
    dynamic getNested(Map<String, dynamic>? m, List<String> path) {
      dynamic cur = m;
      for (final k in path) {
        if (cur is Map && cur.containsKey(k)) {
          cur = cur[k];
        } else {
          return null;
        }
      }
      return cur;
    }
    String getAfter(String key) {
      if (op != null && op.containsKey(key) && op[key] != null) return fmt(op[key]);
      if (before != null && before.containsKey(key)) return fmt(before[key]);
      return '—';
    }
    void addRow(String label, String? b, String a) {
      rows.add(Row(
        children: [
          SizedBox(width: 120, child: Text(label, style: const TextStyle(fontWeight: FontWeight.w500))),
          Expanded(child: Text(b ?? '—', style: const TextStyle(color: Colors.black54))),
          const SizedBox(width: 6),
          const Icon(Icons.arrow_right_alt, size: 16),
          const SizedBox(width: 6),
          Expanded(child: Text(a)),
        ],
      ));
    }
    final beforeTitle = before != null ? fmt(before['title']) : null;
    final beforeNotes = before != null ? fmt(before['notes']) : null;
    final beforeDate = before != null ? fmt(before['scheduledFor']) : null;
    final beforeStart = before != null ? fmt(before['timeOfDay'] ?? before['startTime']) : null;
    final beforeEnd = before != null ? fmt(before['endTime']) : null;
    final beforeLocation = before != null ? fmt(before['location']) : null;
    final beforeRecurType = before != null ? fmt(getNested(before, ['recurrence', 'type'])) : null;
    final beforeRecurN = before != null ? fmt(getNested(before, ['recurrence', 'intervalDays'])) : null;
    final beforeDone = before != null ? fmt(before['completed']) : null;
    addRow('Title', beforeTitle, getAfter('title'));
    addRow('Notes', beforeNotes, getAfter('notes'));
    addRow('Date', beforeDate, getAfter('scheduledFor'));
    addRow('Start', beforeStart, getAfter('timeOfDay'));
    addRow('End', beforeEnd, getAfter('endTime'));
    addRow('Location', beforeLocation, getAfter('location'));
    // Recurrence shown as two fields when present
    rows.add(Row(
      children: [
        const SizedBox(width: 120, child: Text('Recurrence', style: TextStyle(fontWeight: FontWeight.w500))),
        Expanded(child: Text(beforeRecurType ?? '—', style: const TextStyle(color: Colors.black54))),
        const SizedBox(width: 6),
        const Icon(Icons.arrow_right_alt, size: 16),
        const SizedBox(width: 6),
        Expanded(child: Text(() {
          final afterType = (op != null && op.containsKey('recurrence') && op['recurrence'] is Map)
              ? fmt((op['recurrence'] as Map)['type'])
              : (beforeRecurType ?? '—');
          final afterN = (op != null && op.containsKey('recurrence') && op['recurrence'] is Map)
              ? fmt((op['recurrence'] as Map)['intervalDays'])
              : (beforeRecurN ?? '—');
          return afterN == '—' || afterType == '—' ? afterType : '$afterType ($afterN)';
        }())),
      ],
    ));
    addRow('Completed', beforeDone, getAfter('completed'));
  return rows.whereType<Row>().toList();
  }

class _TypingDots extends StatefulWidget {
  const _TypingDots();

  @override
  State<_TypingDots> createState() => _TypingDotsState();
}

class _SectionHeader extends StatelessWidget {
  final String title;
  const _SectionHeader({required this.title});

  @override
  Widget build(BuildContext context) {
    final color = Theme.of(context).colorScheme.onSurfaceVariant;
    return Padding(
      padding: const EdgeInsets.only(top: 4, bottom: 4),
      child: Row(
        children: [
          Text(
            title,
            style: TextStyle(
              fontWeight: FontWeight.w600,
              fontSize: 13,
              color: color,
              letterSpacing: 0.2,
            ),
          ),
        ],
      ),
    );
  }
}

class _TypingDotsState extends State<_TypingDots>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c;

  @override
  void initState() {
    super.initState();
    _c = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 900),
    )..repeat();
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
                  decoration: BoxDecoration(
                    color: color,
                    shape: BoxShape.circle,
                  ),
                ),
              ),
            );
          }),
        );
      },
    );
  }
}
