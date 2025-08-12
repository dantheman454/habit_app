// ignore: avoid_web_libraries_in_flutter
import 'dart:html' as html;
import 'package:flutter/material.dart';
import 'package:dio/dio.dart';

void main() {
  runApp(const App());
}

// ----- Networking -----
// Compute API base so it works in both modes:
// - When served by Express (production): use the current origin
// - When running via `flutter run -d chrome`: call the Node server on 127.0.0.1:3000
String _computeApiBase() {
  final origin = Uri.base.origin;
  if (origin.contains('127.0.0.1:3000') || origin.contains('localhost:3000')) {
    return origin;
  }
  return 'http://127.0.0.1:3000';
}

final Dio dio = Dio(BaseOptions(baseUrl: _computeApiBase()));

// ----- Models -----
class Todo {
  final int id;
  String title;
  String notes;
  String? scheduledFor; // YYYY-MM-DD or null
  String priority; // low|medium|high
  bool completed;
  final String createdAt;
  String updatedAt;

  Todo({
    required this.id,
    required this.title,
    required this.notes,
    required this.scheduledFor,
    required this.priority,
    required this.completed,
    required this.createdAt,
    required this.updatedAt,
  });

  factory Todo.fromJson(Map<String, dynamic> j) => Todo(
        id: j['id'] as int,
        title: j['title'] as String? ?? '',
        notes: j['notes'] as String? ?? '',
        scheduledFor: j['scheduledFor'] as String?,
        priority: j['priority'] as String? ?? 'medium',
        completed: j['completed'] as bool? ?? false,
        createdAt: j['createdAt'] as String? ?? '',
        updatedAt: j['updatedAt'] as String? ?? '',
      );
}

class LlmOperation {
  final String op; // create|update|delete|complete
  final int? id;
  final String? title;
  final String? notes;
  final String? scheduledFor;
  final String? priority;
  final bool? completed;
  LlmOperation({
    required this.op,
    this.id,
    this.title,
    this.notes,
    this.scheduledFor,
    this.priority,
    this.completed,
  });
  factory LlmOperation.fromJson(Map<String, dynamic> j) => LlmOperation(
        op: j['op'] as String,
        id: j['id'] is int
            ? j['id'] as int
            : (j['id'] is String ? int.tryParse(j['id']) : null),
        title: j['title'] as String?,
        notes: j['notes'] as String?,
        scheduledFor: j['scheduledFor'] as String?,
        priority: j['priority'] as String?,
        completed: j['completed'] as bool?,
      );
  Map<String, dynamic> toJson() => {
        'op': op,
        if (id != null) 'id': id,
        if (title != null) 'title': title,
        if (notes != null) 'notes': notes,
        if (scheduledFor != null) 'scheduledFor': scheduledFor,
        if (priority != null) 'priority': priority,
        if (completed != null) 'completed': completed,
      };
}

// ----- Utilities -----
class _ImportItem {
  _ImportItem({required this.text, required this.selected});
  final String text;
  bool selected;
}

String ymd(DateTime d) =>
    '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

DateTime parseYmd(String s) {
  final parts = s.split('-');
  return DateTime(int.parse(parts[0]), int.parse(parts[1]), int.parse(parts[2]));
}

class DateRange {
  final String from;
  final String to;
  const DateRange({required this.from, required this.to});
}

DateRange rangeForView(String anchor, View view) {
  final a = parseYmd(anchor);
  if (view == View.day) {
    final s = ymd(a);
    return DateRange(from: s, to: s);
  } else if (view == View.week) {
    final weekday = a.weekday; // 1=Mon..7=Sun
    final monday = a.subtract(Duration(days: weekday - 1));
    final sunday = monday.add(const Duration(days: 6));
    return DateRange(from: ymd(monday), to: ymd(sunday));
  } else {
    final first = DateTime(a.year, a.month, 1);
    final last = DateTime(a.year, a.month + 1, 0);
    return DateRange(from: ymd(first), to: ymd(last));
  }
}

// ----- App Scaffold -----
class App extends StatelessWidget {
  const App({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Todos',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.indigo),
        useMaterial3: true,
      ),
      home: const HomePage(),
    );
  }
}

enum View { day, week, month }

enum SmartList { today, scheduled, all, flagged, backlog }

enum EntryMode { direct, llm }

class HomePage extends StatefulWidget {
  const HomePage({super.key});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  // Header state
  String anchor = ymd(DateTime.now());
  View view = View.week;
  bool showCompleted = false;
  EntryMode entryMode = EntryMode.llm;
  final TextEditingController quickCtrl = TextEditingController();
  final TextEditingController searchCtrl = TextEditingController();

  // Sidebar state
  SmartList selected = SmartList.today;

  // Data
  List<Todo> scheduled = [];
  List<Todo> backlog = [];
  List<Todo> searchResults = [];

  // LLM proposal panel
  List<LlmOperation> proposed = [];
  List<bool> proposedChecked = [];

  bool loading = false;
  String? message;
  bool proposing = false;

  // Import (.txt) state
  List<_ImportItem> importItems = [];
  String importPriority = 'medium';
  String importSchedule = 'anchor'; // 'anchor' or 'unscheduled'
  bool importApplying = false;

  @override
  void initState() {
    super.initState();
    _refreshAll();
  }

  Future<void> _refreshAll() async {
    setState(() => loading = true);
    try {
      final r = rangeForView(anchor, view);
      final futures = <Future>[];
      futures.add(dio.get('/api/todos', queryParameters: {
        'from': r.from,
        'to': r.to,
        if (!showCompleted) 'completed': 'false',
      }));
      futures.add(dio.get('/api/todos/backlog'));
      final rs = await Future.wait(futures);
      final sList = (rs[0].data['todos'] as List<dynamic>)
          .map((e) => Todo.fromJson(e as Map<String, dynamic>))
          .toList();
      var bList = (rs[1].data['todos'] as List<dynamic>)
          .map((e) => Todo.fromJson(e as Map<String, dynamic>))
          .toList();
      if (!showCompleted) {
        bList = bList.where((t) => !t.completed).toList();
      }
      setState(() {
        scheduled = sList;
        backlog = bList;
        message = null;
      });
    } catch (e) {
      setState(() => message = 'Load failed: $e');
    } finally {
      setState(() => loading = false);
    }
  }

  Future<void> _runSearch(String q) async {
    if (q.trim().isEmpty) {
      setState(() => searchResults = []);
      return;
    }
    try {
      final res = await dio.get('/api/todos/search', queryParameters: {'query': q});
      final items = (res.data['todos'] as List<dynamic>)
          .map((e) => Todo.fromJson(e as Map<String, dynamic>))
          .toList();
      setState(() => searchResults = items);
    } catch (e) {
      setState(() => message = 'Search failed: $e');
    }
  }

  Future<void> _toggleCompleted(Todo t) async {
    try {
      await dio.patch('/api/todos/${t.id}', data: {'completed': !t.completed});
      await _refreshAll();
    } catch (e) {
      setState(() => message = 'Toggle failed: $e');
    }
  }

  Future<void> _deleteTodo(Todo t) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('Delete todo?'),
        content: Text(t.title),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Delete')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await dio.delete('/api/todos/${t.id}');
      await _refreshAll();
    } catch (e) {
      setState(() => message = 'Delete failed: $e');
    }
  }

  Future<void> _editTodo(Todo t) async {
    final titleCtrl = TextEditingController(text: t.title);
    final notesCtrl = TextEditingController(text: t.notes);
    final dateCtrl = TextEditingController(text: t.scheduledFor ?? '');
    String prio = t.priority;
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('Edit todo'),
        content: SizedBox(
          width: 420,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(controller: titleCtrl, decoration: const InputDecoration(labelText: 'Title')),
              TextField(controller: notesCtrl, decoration: const InputDecoration(labelText: 'Notes')),
              TextField(controller: dateCtrl, decoration: const InputDecoration(labelText: 'Scheduled (YYYY-MM-DD or empty)')),
              const SizedBox(height: 8),
              DropdownButtonFormField<String>(
                value: prio,
                decoration: const InputDecoration(labelText: 'Priority'),
                items: const [
                  DropdownMenuItem(value: 'low', child: Text('low')),
                  DropdownMenuItem(value: 'medium', child: Text('medium')),
                  DropdownMenuItem(value: 'high', child: Text('high')),
                ],
                onChanged: (v) => prio = v ?? 'medium',
              ),
            ],
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Save')),
        ],
      ),
    );
    if (ok != true) return;

    final patch = <String, dynamic>{};
    if (titleCtrl.text != t.title) patch['title'] = titleCtrl.text;
    if (notesCtrl.text != t.notes) patch['notes'] = notesCtrl.text;
    final sched = dateCtrl.text.trim();
    final normalized = sched.isEmpty ? null : sched;
    if (normalized != (t.scheduledFor ?? '')) patch['scheduledFor'] = normalized;
    if (prio != t.priority) patch['priority'] = prio;

    if (patch.isEmpty) return;
    try {
      await dio.patch('/api/todos/${t.id}', data: patch);
      await _refreshAll();
    } catch (e) {
      setState(() => message = 'Edit failed: $e');
    }
  }

  Future<void> _quickSubmit() async {
    final text = quickCtrl.text.trim();
    if (text.isEmpty) return;

    if (entryMode == EntryMode.direct) {
      try {
        await dio.post('/api/todos', data: {
          'title': text,
          'notes': '',
          'scheduledFor': anchor, // default to anchor/today
          'priority': 'medium',
        });
        quickCtrl.clear();
        await _refreshAll();
      } catch (e) {
        setState(() => message = 'Create failed: $e');
      }
    } else {
      // LLM propose with in-button spinner
      setState(() => proposing = true);
      try {
        final res = await dio.post('/api/llm/propose', data: {'instruction': text});
        final ops = (res.data['operations'] as List<dynamic>)
            .map((e) => LlmOperation.fromJson(e as Map<String, dynamic>))
            .toList();
        setState(() {
          proposed = ops;
          proposedChecked = List<bool>.filled(ops.length, true);
          message = null;
        });
      } catch (e) {
        setState(() => message = 'Propose failed: $e');
      } finally {
        setState(() => proposing = false);
      }
    }
  }

  Future<void> _applySelectedOps() async {
    try {
      final selectedOps = <Map<String, dynamic>>[];
      for (var i = 0; i < proposed.length; i++) {
        if (proposedChecked[i]) selectedOps.add(proposed[i].toJson());
      }
      if (selectedOps.isEmpty) {
        setState(() => message = 'No operations selected.');
        return;
      }
      final res = await dio.post('/api/llm/apply', data: {'operations': selectedOps});
      final summary = res.data['summary'];
    setState(() {
        message = 'Applied: c=${summary['created']}, u=${summary['updated']}, d=${summary['deleted']}, done=${summary['completed']}';
        proposed = [];
        proposedChecked = [];
        quickCtrl.clear();
      });
      await _refreshAll();
    } catch (e) {
      setState(() => message = 'Apply failed: $e');
    }
  }

  Widget _priorityBadge(String p) {
    Color bg;
    Color fg;
    switch (p) {
      case 'high':
        bg = const Color(0xFFFFC9C9);
        fg = const Color(0xFF7D1414);
        break;
      case 'low':
        bg = const Color(0xFFD3F9D8);
        fg = const Color(0xFF205B2A);
        break;
      default:
        bg = const Color(0xFFFFE8CC);
        fg = const Color(0xFF9C3B00);
    }
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(999)),
      child: Text(p, style: TextStyle(color: fg, fontSize: 12)),
    );
  }

  Map<String, List<Todo>> _groupByDate(List<Todo> items) {
    final map = <String, List<Todo>>{};
    for (final t in items) {
      final k = t.scheduledFor ?? 'unscheduled';
      map.putIfAbsent(k, () => []).add(t);
    }
    final sorted = Map.fromEntries(map.entries.toList()
      ..sort((a, b) => a.key.compareTo(b.key)));
    return sorted;
  }

  List<Todo> _currentList() {
    switch (selected) {
      case SmartList.today:
        return scheduled;
      case SmartList.scheduled:
        return scheduled;
      case SmartList.backlog:
        return backlog;
      case SmartList.flagged:
        return [...scheduled, ...backlog].where((t) => t.priority == 'high').toList();
      case SmartList.all:
        return [...scheduled, ...backlog];
    }
  }

  @override
  Widget build(BuildContext context) {
    final body = loading
        ? const Center(child: CircularProgressIndicator())
        : Row(
            children: [
              // Sidebar
              SizedBox(
                width: 220,
                child: ListView(
                  children: [
                    _sidebarTile('Today', SmartList.today, Icons.today),
                    _sidebarTile('Scheduled', SmartList.scheduled, Icons.calendar_month),
                    _sidebarTile('All', SmartList.all, Icons.inbox),
                    _sidebarTile('Flagged', SmartList.flagged, Icons.flag),
                    _sidebarTile('Backlog', SmartList.backlog, Icons.list_alt),
                  ],
                ),
              ),
              const VerticalDivider(width: 1),
              // Main content
              Expanded(
                child: Column(
                  children: [
                    // Header controls
                    Padding(
                      padding: const EdgeInsets.all(12),
                      child: Wrap(
                        spacing: 12,
                        runSpacing: 8,
                        crossAxisAlignment: WrapCrossAlignment.center,
                        children: [
                          // Anchor date
                          Row(mainAxisSize: MainAxisSize.min, children: [
                            const Text('Anchor'),
                            const SizedBox(width: 6),
                            SizedBox(
                              width: 156,
                              child: TextField(
                                controller: TextEditingController(text: anchor),
                                decoration: const InputDecoration(isDense: true, hintText: 'YYYY-MM-DD'),
                                onSubmitted: (v) {
                                  if (RegExp(r'^\d{4}-\d{2}-\d{2}').hasMatch(v)) {
                                    setState(() => anchor = v);
                                    _refreshAll();
                                  }
                                },
                              ),
                            ),
                          ]),
                          // View select
                          DropdownButton<View>(
                            value: view,
                            items: const [
                              DropdownMenuItem(value: View.day, child: Text('Day')),
                              DropdownMenuItem(value: View.week, child: Text('Week')),
                              DropdownMenuItem(value: View.month, child: Text('Month')),
                            ],
                            onChanged: (v) {
                              if (v != null) setState(() => view = v);
                              _refreshAll();
                            },
                          ),
                          // Show completed
                          Row(mainAxisSize: MainAxisSize.min, children: [
                            const Text('Show completed'),
                            Switch(
                              value: showCompleted,
                              onChanged: (v) {
                                setState(() => showCompleted = v);
                                _refreshAll();
                              },
                            ),
                          ]),
                          // Search
                          SizedBox(
                            width: 220,
                            child: TextField(
                              controller: searchCtrl,
                              decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: 'Search'),
                              onChanged: (v) => _runSearch(v),
                            ),
                          ),
                          // Quick entry + mode + button + import
                          SizedBox(
                            width: 320,
                            child: TextField(
                              controller: quickCtrl,
                              decoration: const InputDecoration(hintText: 'Quick entry'),
                              onSubmitted: (_) => _quickSubmit(),
                            ),
                          ),
                          DropdownButton<EntryMode>(
                            value: entryMode,
                            items: const [
                              DropdownMenuItem(value: EntryMode.llm, child: Text('LLM')),
                              DropdownMenuItem(value: EntryMode.direct, child: Text('Direct')),
                            ],
                            onChanged: (v) => setState(() => entryMode = v ?? EntryMode.llm),
                          ),
                          FilledButton(
                            onPressed: proposing ? null : _quickSubmit,
                            child: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                if (entryMode == EntryMode.llm && proposing) ...[
                                  SizedBox(
                                    width: 16,
                                    height: 16,
                                    child: CircularProgressIndicator(
                                      strokeWidth: 2,
                                      valueColor: AlwaysStoppedAnimation(
                                        Theme.of(context).colorScheme.onPrimary,
                                      ),
                                    ),
                                  ),
                                  const SizedBox(width: 8),
                                  const Text('Proposing…'),
                                ] else ...[
                                  Text(entryMode == EntryMode.direct ? 'Add' : 'Propose'),
                                ],
                              ],
                            ),
                          ),
                          OutlinedButton.icon(
                            onPressed: importApplying ? null : _onImportTxt,
                            icon: const Icon(Icons.file_download),
                            label: const Text('Import'),
                          ),
                        ],
                      ),
                    ),
                    if (message != null)
                      Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 12),
                        child: Align(
                          alignment: Alignment.centerLeft,
                          child: Text(message!, style: const TextStyle(color: Colors.redAccent)),
                        ),
                      ),
                    const Divider(height: 1),
                    // Proposal panel
                    if (proposed.isNotEmpty)
                      Container(
                        padding: const EdgeInsets.all(12),
                        color: Theme.of(context).colorScheme.surfaceVariant.withOpacity(0.4),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Text('Proposed operations', style: TextStyle(fontWeight: FontWeight.w600)),
                            const SizedBox(height: 8),
                            ...List.generate(proposed.length, (i) {
                              final op = proposed[i];
                              return Row(
                                children: [
                                  Checkbox(
                                    value: proposedChecked[i],
                                    onChanged: (v) => setState(() => proposedChecked[i] = v ?? true),
                                  ),
                                  Expanded(child: Text(_opLabel(op))),
                                ],
                              );
                            }),
                            const SizedBox(height: 8),
                            Wrap(spacing: 8, children: [
                              FilledButton(onPressed: _applySelectedOps, child: const Text('Apply Selected')),
                              TextButton(
                                onPressed: () => setState(() {
                                  proposed = [];
                                  proposedChecked = [];
                                }),
                                child: const Text('Discard'),
                              ),
                            ]),
                          ],
                        ),
                      ),
                    // Main lists
                    Expanded(
                      child: Row(
                        children: [
                          Expanded(child: _buildMainList()),
                          if (searchCtrl.text.trim().isNotEmpty)
                            SizedBox(
                              width: 360,
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  const Padding(
                                    padding: EdgeInsets.all(8.0),
                                    child: Text('Search results', style: TextStyle(fontWeight: FontWeight.w600)),
                                  ),
                                  const Divider(height: 1),
                                  Expanded(child: _buildSimpleList(searchResults)),
                                ],
                              ),
                            ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ],
          );

    return Scaffold(body: body);
  }

  String _opLabel(LlmOperation op) {
    final parts = <String>['${op.op}'];
    if (op.id != null) parts.add('#${op.id}');
    if (op.title != null) parts.add('– ${op.title}');
    if (op.priority != null) parts.add('(prio ${op.priority})');
    if (op.scheduledFor != null) parts.add('@${op.scheduledFor}');
    if (op.completed != null) parts.add(op.completed! ? '[done]' : '[undone]');
    return parts.join(' ');
  }

  // ----- Import (web) -----
  Future<void> _onImportTxt() async {
    try {
      final input = html.FileUploadInputElement();
      input.accept = '.txt';
      input.click();
      await input.onChange.first;
      if (input.files == null || input.files!.isEmpty) return;
      final file = input.files!.first;
      final reader = html.FileReader();
      reader.readAsText(file);
      await reader.onLoad.first;
      final text = reader.result?.toString() ?? '';
      final lines = text.split(RegExp(r'\r?\n')).map((s) => s.trim()).where((s) => s.isNotEmpty).toList();
      // Deduplicate exact lines within this import as requested
      final seen = <String>{};
      final unique = <String>[];
      for (final l in lines) { if (seen.add(l)) unique.add(l); }
      importItems = unique.map((t) => _ImportItem(text: t, selected: true)).toList();
      importPriority = 'medium';
      importSchedule = 'anchor';
      await _showImportDialog();
    } catch (e) {
      setState(() => message = 'Import failed: $e');
    }
  }

  Future<void> _showImportDialog() async {
    await showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (c) {
        return StatefulBuilder(builder: (c, setStateDialog) {
          return AlertDialog(
            title: const Text('Import tasks from .txt'),
            content: SizedBox(
              width: 520,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Row(children: [
                    const Text('Schedule:'),
                    const SizedBox(width: 8),
                    DropdownButton<String>(
                      value: importSchedule,
                      items: const [
                        DropdownMenuItem(value: 'anchor', child: Text('Anchor date')),
                        DropdownMenuItem(value: 'unscheduled', child: Text('Unscheduled (Backlog)')),
                      ],
                      onChanged: (v) => setStateDialog(() => importSchedule = v ?? 'anchor'),
                    ),
                    const SizedBox(width: 16),
                    const Text('Priority:'),
                    const SizedBox(width: 8),
                    DropdownButton<String>(
                      value: importPriority,
                      items: const [
                        DropdownMenuItem(value: 'low', child: Text('low')),
                        DropdownMenuItem(value: 'medium', child: Text('medium')),
                        DropdownMenuItem(value: 'high', child: Text('high')),
                      ],
                      onChanged: (v) => setStateDialog(() => importPriority = v ?? 'medium'),
                    ),
                  ]),
                  const SizedBox(height: 8),
                  Container(
                    constraints: const BoxConstraints(maxHeight: 360),
                    child: ListView.builder(
                      shrinkWrap: true,
                      itemCount: importItems.length,
                      itemBuilder: (_, i) {
                        final it = importItems[i];
                        return StatefulBuilder(builder: (context, setStateRow) {
                          return CheckboxListTile(
                            value: it.selected,
                            onChanged: (v) {
                              setStateRow(() => it.selected = v ?? true);
                            },
                            title: Text(_truncate(it.text, 120)),
                          );
                        });
                      },
                    ),
                  ),
                ],
              ),
            ),
            actions: [
              TextButton(onPressed: () => Navigator.pop(c), child: const Text('Cancel')),
              FilledButton(
                onPressed: importApplying ? null : () async {
                  await _applyImport(setStateDialog);
                },
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  if (importApplying) ...[
                    const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)),
                    const SizedBox(width: 8),
                  ],
                  const Text('Import Selected'),
                ]),
              ),
            ],
          );
        });
      },
    );
  }

  Future<void> _applyImport(void Function(void Function()) setStateDialog) async {
    try {
      setStateDialog(() => importApplying = true);
      final selected = importItems.where((x) => x.selected).toList();
      if (selected.isEmpty) {
        setStateDialog(() => importApplying = false);
        return;
      }
      final ops = <Map<String, dynamic>>[];
      final sched = importSchedule == 'anchor' ? anchor : null;
      for (final it in selected) {
        ops.add({
          'op': 'create',
          'title': it.text,
          'scheduledFor': sched,
          'priority': importPriority,
        });
      }
      final res = await dio.post('/api/llm/apply', data: {'operations': ops});
      final summary = res.data['summary'];
      setState(() {
        message = 'Imported: c=${summary['created']}';
      });
      Navigator.of(context).pop();
      await _refreshAll();
    } catch (e) {
      setStateDialog(() => importApplying = false);
      setState(() => message = 'Import failed: $e');
    }
  }

  String _truncate(String s, int max) => s.length <= max ? s : '${s.substring(0, max - 1)}…';

  Widget _buildMainList() {
    final items = _currentList();
    final grouped = _groupByDate(items);
    return ListView(
      padding: const EdgeInsets.all(12),
      children: [
        for (final entry in grouped.entries) ...[
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 6),
            child: Text(entry.key, style: const TextStyle(fontWeight: FontWeight.w600)),
          ),
          ...entry.value.map(_buildRow),
        ]
      ],
    );
  }

  Widget _buildSimpleList(List<Todo> items) {
    return ListView.separated(
      padding: const EdgeInsets.all(8),
      itemCount: items.length,
      separatorBuilder: (_, __) => const SizedBox(height: 6),
      itemBuilder: (context, i) => _buildRow(items[i]),
    );
  }

  Widget _buildRow(Todo t) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        border: Border.all(color: Colors.grey.shade300),
        borderRadius: BorderRadius.circular(6),
        color: t.completed ? Colors.grey.withOpacity(0.1) : null,
      ),
      child: Row(
        children: [
          Checkbox(value: t.completed, onChanged: (_) => _toggleCompleted(t)),
          const SizedBox(width: 6),
          Expanded(
        child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(children: [
                  _priorityBadge(t.priority),
                  const SizedBox(width: 6),
                  Flexible(
                    child: Text(
                      t.title,
                      style: TextStyle(
                        decoration: t.completed ? TextDecoration.lineThrough : null,
                      ),
                    ),
                  ),
                ]),
                if ((t.notes).isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Text(t.notes, style: TextStyle(color: Colors.grey.shade700, fontSize: 12)),
            ),
          ],
        ),
      ),
          const SizedBox(width: 8),
          Wrap(spacing: 6, children: [
            OutlinedButton(onPressed: () => _editTodo(t), child: const Text('Edit')),
            OutlinedButton(onPressed: () => _deleteTodo(t), child: const Text('Delete')),
          ]),
        ],
      ),
    );
  }

  Widget _sidebarTile(String label, SmartList sl, IconData icon) {
    final active = selected == sl;
    return ListTile(
      leading: Icon(icon, size: 20),
      title: Text(label),
      selected: active,
      onTap: () {
        setState(() => selected = sl);
      },
    );
  }
}
