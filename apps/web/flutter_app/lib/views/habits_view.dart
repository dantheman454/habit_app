import 'package:flutter/material.dart';
import '../api.dart' as api;
import '../models.dart';
import '../widgets/habit_row.dart';

class HabitsView extends StatefulWidget {
  final String weekStartYmd; // Sunday
  final String weekEndYmd;   // Saturday
  final String? contextFilter; // 'school'|'personal'|'work' or null
  final bool openQuickAdd;
  final VoidCallback? onQuickAddClosed;
  const HabitsView({
    super.key,
    required this.weekStartYmd,
    required this.weekEndYmd,
    this.contextFilter,
    this.openQuickAdd = false,
    this.onQuickAddClosed,
  });

  @override
  State<HabitsView> createState() => _HabitsViewState();
}

class _HabitsViewState extends State<HabitsView> {
  List<Habit> habits = const <Habit>[];
  bool loading = false;
  final Map<int, Set<String>> _doneByHabit = <int, Set<String>>{};
  bool _showQuickAdd = false;
  final _titleCtrl = TextEditingController();
  String? _contextValue; // 'school'|'personal'|'work'
  String? _startedOnValue; // YYYY-MM-DD
  Map<String, dynamic>? _recurrenceValue; // {type,...}
  int? _weeklyTargetValue;

  @override
  void initState() {
    super.initState();
    _showQuickAdd = widget.openQuickAdd;
    _load();
  }

  Future<void> _load() async {
    setState(() => loading = true);
    try {
      final list = await api.listHabits(context: widget.contextFilter);
      final out = list.map((e) => Habit.fromJson(Map<String, dynamic>.from(e))).toList();
      setState(() => habits = out);
      // Fetch logs for the visible week, per habit (simple N calls for v1)
      final futures = <Future<void>>[];
      for (final h in out) {
        futures.add(() async {
          try {
            final logs = await api.listHabitLogs(
              h.id,
              from: widget.weekStartYmd,
              to: widget.weekEndYmd,
            );
            final done = <String>{};
            for (final m in logs) {
              final map = Map<String, dynamic>.from(m);
              if ((map['done'] == true) && map['date'] is String) {
                done.add(map['date'] as String);
              }
            }
            _doneByHabit[h.id] = done;
          } catch (_) {}
        }());
      }
      await Future.wait(futures);
      if (mounted) setState(() {});
    } catch (_) {
      // swallow
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          child: Row(
            children: [
              Text(
                'Habits',
                style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600),
              ),
              const Spacer(),
              IconButton(
                icon: const Icon(Icons.refresh),
                tooltip: 'Refresh',
                onPressed: loading ? null : _load,
              ),
              const SizedBox(width: 4),
              FilledButton.icon(
                icon: const Icon(Icons.add),
                label: const Text('Quick Add'),
                onPressed: () => setState(() => _showQuickAdd = true),
              ),
            ],
          ),
        ),
        if (_showQuickAdd) _buildQuickAdd(context),
        Expanded(
          child: loading
              ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
              : ListView.builder(
                  itemCount: habits.length,
                  itemBuilder: (context, index) {
                    final h = habits[index];
                    return HabitRow(
                      habit: h,
                      weekStartYmd: widget.weekStartYmd,
                      completedDates: _doneByHabit[h.id] ?? const <String>{},
                      onToggle: (ymd, done) async {
                        try {
                          if (done) {
                            await api.setHabitLog(h.id, ymd, done: true);
                            (_doneByHabit[h.id] ??= <String>{}).add(ymd);
                          } else {
                            await api.deleteHabitLog(h.id, ymd);
                            (_doneByHabit[h.id] ??= <String>{}).remove(ymd);
                          }
                          if (mounted) setState(() {});
                        } catch (_) {
                          // On failure, reload to reconcile
                          _load();
                        }
                      },
                    );
                  },
                ),
        ),
      ],
    );
  }

  Widget _buildQuickAdd(BuildContext context) {
    final today = DateTime.now();
    _startedOnValue ??= '${today.year.toString().padLeft(4, '0')}-${today.month.toString().padLeft(2, '0')}-${today.day.toString().padLeft(2, '0')}';
    _recurrenceValue ??= {'type': 'daily'};
    _contextValue ??= 'personal';
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 12),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Text('Quick Add Habit', style: TextStyle(fontWeight: FontWeight.w600)),
                const Spacer(),
                IconButton(
                  icon: const Icon(Icons.close),
                  tooltip: 'Close',
                  onPressed: () {
                    setState(() => _showQuickAdd = false);
                    try { widget.onQuickAddClosed?.call(); } catch (_) {}
                  },
                )
              ],
            ),
            TextField(
              controller: _titleCtrl,
              decoration: const InputDecoration(labelText: 'Title'),
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: DropdownButtonFormField<String>(
                    value: _contextValue,
                    items: const [
                      DropdownMenuItem(value: 'personal', child: Text('Personal')),
                      DropdownMenuItem(value: 'school', child: Text('School')),
                      DropdownMenuItem(value: 'work', child: Text('Work')),
                    ],
                    onChanged: (v) => setState(() => _contextValue = v),
                    decoration: const InputDecoration(labelText: 'Context'),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: TextFormField(
                    initialValue: _startedOnValue,
                    decoration: const InputDecoration(labelText: 'Start (YYYY-MM-DD)'),
                    onChanged: (v) => _startedOnValue = v,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: DropdownButtonFormField<String>(
                    value: (_recurrenceValue?['type'] as String?) ?? 'daily',
                    items: const [
                      DropdownMenuItem(value: 'none', child: Text('None')),
                      DropdownMenuItem(value: 'daily', child: Text('Daily')),
                      DropdownMenuItem(value: 'weekdays', child: Text('Weekdays')),
                      DropdownMenuItem(value: 'weekly', child: Text('Weekly')),
                      DropdownMenuItem(value: 'every_n_days', child: Text('Every N days')),
                    ],
                    onChanged: (v) {
                      setState(() {
                        _recurrenceValue = {'type': v ?? 'none'};
                      });
                    },
                    decoration: const InputDecoration(labelText: 'Recurrence'),
                  ),
                ),
                const SizedBox(width: 12),
                if ((_recurrenceValue?['type'] == 'every_n_days'))
                  Expanded(
                    child: TextFormField(
                      initialValue: (_recurrenceValue?['intervalDays']?.toString() ?? ''),
                      decoration: const InputDecoration(labelText: 'Interval days'),
                      keyboardType: TextInputType.number,
                      onChanged: (v) {
                        final n = int.tryParse(v);
                        setState(() {
                          if (n != null && n >= 1) {
                            _recurrenceValue = {
                              ...?_recurrenceValue,
                              'type': 'every_n_days',
                              'intervalDays': n,
                            };
                          }
                        });
                      },
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: TextFormField(
                    initialValue: _weeklyTargetValue?.toString() ?? '',
                    decoration: const InputDecoration(labelText: 'Weekly target (optional)'),
                    keyboardType: TextInputType.number,
                    onChanged: (v) => _weeklyTargetValue = int.tryParse(v),
                  ),
                ),
                const SizedBox(width: 12),
                FilledButton.icon(
                  icon: const Icon(Icons.save),
                  label: const Text('Create'),
                  onPressed: () async {
                    final title = _titleCtrl.text.trim();
                    if (title.isEmpty) return;
                    try {
                      final rec = Map<String, dynamic>.from(_recurrenceValue ?? {'type': 'none'});
                      final payload = {
                        'title': title,
                        'notes': '',
                        'startedOn': _startedOnValue,
                        'recurrence': rec,
                        'weeklyTargetCount': _weeklyTargetValue,
                        'context': _contextValue,
                      };
                      await api.createHabit(payload);
                      _titleCtrl.clear();
                      setState(() {
                        _showQuickAdd = false;
                      });
                      try { widget.onQuickAddClosed?.call(); } catch (_) {}
                      _load();
                    } catch (_) {}
                  },
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

