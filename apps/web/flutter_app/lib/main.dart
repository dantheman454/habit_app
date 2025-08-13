import 'package:flutter/material.dart';
import 'dart:async';
import 'widgets/assistant_panel.dart';
import 'widgets/sidebar.dart' as sb;
import 'widgets/todo_row.dart' as row;
import 'widgets/fab_actions.dart' as fab;
import 'api.dart' as api;

void main() {
  runApp(const App());
}

// Networking moved to api.dart

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

class AnnotatedOp {
  final LlmOperation op;
  final List<String> errors;
  AnnotatedOp({required this.op, required this.errors});
  factory AnnotatedOp.fromJson(Map<String, dynamic> j) => AnnotatedOp(
        op: LlmOperation.fromJson(Map<String, dynamic>.from(j['op'] as Map)),
        errors: (j['errors'] as List<dynamic>? ?? const <dynamic>[])
            .map((e) => e.toString())
            .toList(),
      );
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
  
  final TextEditingController searchCtrl = TextEditingController();
  Timer? _searchDebounce;

  // Sidebar state
  SmartList selected = SmartList.today;

  // Data
  List<Todo> scheduled = [];
  List<Todo> backlog = [];
  List<Todo> searchResults = [];

  // LLM proposal panel (removed)

  bool loading = false;
  String? message;
  

  // Assistant (chat) panel state
  final TextEditingController assistantCtrl = TextEditingController();
  final List<Map<String, String>> assistantTranscript = [];
  // Annotated operations with per-op errors
  List<AnnotatedOp> assistantOps = [];
  List<bool> assistantOpsChecked = [];
  bool assistantSending = false;
  bool assistantShowDiff = false;

  // Import UI removed; state no longer used

  @override
  void initState() {
    super.initState();
    _refreshAll();
  }

  @override
  void dispose() {
    _searchDebounce?.cancel();
    assistantCtrl.dispose();
    
    searchCtrl.dispose();
    super.dispose();
  }

  Future<void> _refreshAll() async {
    setState(() => loading = true);
    try {
      final r = rangeForView(anchor, view);
      final scheduledRaw = await api.fetchScheduled(from: r.from, to: r.to, completed: showCompleted ? null : false);
      final backlogRaw = await api.fetchBacklog();
      final sList = scheduledRaw.map((e) => Todo.fromJson(e as Map<String, dynamic>)).toList();
      var bList = backlogRaw.map((e) => Todo.fromJson(e as Map<String, dynamic>)).toList();
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
      final list = await api.searchTodos(q);
      final items = (list)
          .map((e) => Todo.fromJson(e as Map<String, dynamic>))
          .toList();
      setState(() => searchResults = items);
    } catch (e) {
      setState(() => message = 'Search failed: $e');
    }
  }

  void _onSearchChanged(String v) {
    _searchDebounce?.cancel();
    _searchDebounce = Timer(const Duration(milliseconds: 250), () => _runSearch(v));
  }

  Future<void> _toggleCompleted(Todo t) async {
    try {
      await api.updateTodo(t.id, {'completed': !t.completed});
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
      await api.deleteTodo(t.id);
      await _refreshAll();
    } catch (e) {
      setState(() => message = 'Delete failed: $e');
    }
  }

  Future<void> _openFabSheet() async {
    final titleCtrl = TextEditingController();
    final notesCtrl = TextEditingController();
    final dateCtrl = TextEditingController(text: anchor);
    String prio = 'medium';

    await showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      builder: (c) {
        return Padding(
          padding: EdgeInsets.only(bottom: MediaQuery.of(c).viewInsets.bottom),
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Create task', style: TextStyle(fontWeight: FontWeight.w600)),
                const SizedBox(height: 12),
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
                const SizedBox(height: 12),
                Align(
                  alignment: Alignment.centerRight,
                  child: FilledButton(
                    onPressed: () async {
                      final title = titleCtrl.text.trim();
                      if (title.isEmpty) return;
                      final sched = dateCtrl.text.trim();
                      await api.createTodo({
                        'title': title,
                        'notes': notesCtrl.text,
                        'scheduledFor': sched.isEmpty ? null : sched,
                        'priority': prio,
                      });
                      Navigator.pop(c);
                      await _refreshAll();
                    },
                    child: const Text('Create'),
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
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
      await api.updateTodo(t.id, patch);
      await _refreshAll();
    } catch (e) {
      setState(() => message = 'Edit failed: $e');
    }
  }

  // Quick entry removed

  // Legacy propose/apply removed

  // ----- Assistant (chat) -----
  Future<void> _sendAssistantMessage() async {
    final text = assistantCtrl.text.trim();
    if (text.isEmpty) return;
    setState(() {
      assistantTranscript.add({'role': 'user', 'text': text});
      assistantSending = true;
    });
    try {
      // Send last 3 turns and request streaming summary (server will fall back to JSON if not SSE)
      final recent = assistantTranscript.length <= 3 ? assistantTranscript : assistantTranscript.sublist(assistantTranscript.length - 3);
      final res = await api.assistantMessage(text, transcript: recent, streamSummary: true);
      final reply = (res['text'] as String?) ?? '';
      final opsRaw = res['operations'] as List<dynamic>?;
      final ops = opsRaw == null
          ? <AnnotatedOp>[]
          : opsRaw.map((e) => AnnotatedOp.fromJson(e as Map<String, dynamic>)).toList();
      setState(() {
        assistantTranscript.add({'role': 'assistant', 'text': reply});
        assistantOps = ops;
        // Auto-check only valid ops
        assistantOpsChecked = List<bool>.generate(ops.length, (i) => ops[i].errors.isEmpty);
        assistantShowDiff = false;
      });
      assistantCtrl.clear();
    } catch (e) {
      setState(() {
        assistantTranscript.add({'role': 'assistant', 'text': 'Sorry, I could not process that. (${e.toString()})'});
      });
    } finally {
      setState(() => assistantSending = false);
    }
  }

  Future<void> _applyAssistantOps() async {
    try {
      final selectedOps = <Map<String, dynamic>>[];
      for (var i = 0; i < assistantOps.length; i++) {
        if (assistantOpsChecked[i] && assistantOps[i].errors.isEmpty) {
          selectedOps.add(assistantOps[i].op.toJson());
        }
      }
      if (selectedOps.isEmpty) {
        setState(() => message = 'No operations selected.');
        return;
      }
      final res = await api.applyOperations(selectedOps);
      final summary = res['summary'];
      setState(() {
        message = 'Applied: c=${summary['created']}, u=${summary['updated']}, d=${summary['deleted']}, done=${summary['completed']}';
        assistantOps = [];
        assistantOpsChecked = [];
        assistantShowDiff = false;
      });
      await _refreshAll();
    } catch (e) {
      setState(() => message = 'Apply failed: $e');
    }
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

  String _smartListKey(SmartList sl) {
    switch (sl) {
      case SmartList.today:
        return 'today';
      case SmartList.scheduled:
        return 'scheduled';
      case SmartList.all:
        return 'all';
      case SmartList.flagged:
        return 'flagged';
      case SmartList.backlog:
        return 'backlog';
    }
  }

  SmartList _smartListFromKey(String k) {
    switch (k) {
      case 'today':
        return SmartList.today;
      case 'scheduled':
        return SmartList.scheduled;
      case 'all':
        return SmartList.all;
      case 'flagged':
        return SmartList.flagged;
      case 'backlog':
      default:
        return SmartList.backlog;
    }
  }

  @override
  Widget build(BuildContext context) {
    final w = MediaQuery.of(context).size.width;
    final showAssistantText = w >= 900;
    final body = loading
        ? const Center(child: CircularProgressIndicator())
        : Column(
            children: [
              // Unified dark-blue header spanning entire app width
              Container(
                color: const Color(0xFF0B3D91),
                padding: const EdgeInsets.all(12),
                child: Row(
                  children: [
                    // Reserve space visually aligned with left sidebar width
                    const SizedBox(width: 220),
                    const SizedBox(width: 1),
                    // Search box (responsive, centered within available region)
                    Expanded(
                      child: Center(
                        child: ConstrainedBox(
                          constraints: const BoxConstraints(minWidth: 320, maxWidth: 560),
                          child: TextField(
                            controller: searchCtrl,
                            decoration: InputDecoration(
                              prefixIcon: const Icon(Icons.search),
                              hintText: 'Search',
                              filled: true,
                              fillColor: Colors.white,
                              border: OutlineInputBorder(
                                borderRadius: BorderRadius.circular(8),
                                borderSide: BorderSide.none,
                              ),
                            ),
                            onChanged: _onSearchChanged,
                          ),
                        ),
                      ),
                    ),
                    // Push assistant zone to the far right so header split aligns with body split
                    const Spacer(),
                    // Header divider aligned with body split
                    Container(width: 1, height: 36, color: Theme.of(context).colorScheme.outline),
                    // Assistant header zone (right-aligned)
                    SizedBox(
                      width: 360,
                      child: Center(
                        child: showAssistantText
                            ? Row(
                                mainAxisSize: MainAxisSize.min,
                                mainAxisAlignment: MainAxisAlignment.center,
                                children: const [
                                  Icon(Icons.smart_toy_outlined, color: Colors.white, size: 18),
                                  SizedBox(width: 6),
                                  Text('Assistant', style: TextStyle(fontWeight: FontWeight.w600, color: Colors.white)),
                                ],
                              )
                            : const Icon(Icons.smart_toy_outlined, color: Colors.white, size: 18),
                      ),
                    ),
                  ],
                ),
              ),
              const Divider(height: 1),
              // Body below the unified header
              Expanded(
                child: Row(
                  children: [
                    // Sidebar
                    SizedBox(
                      width: 220,
                      child: sb.Sidebar(
                        selectedKey: _smartListKey(selected),
                        onSelect: (k) => setState(() => selected = _smartListFromKey(k)),
                        showCompleted: showCompleted,
                        onToggleShowCompleted: (v) {
                          setState(() => showCompleted = v);
                          _refreshAll();
                        },
                      ),
                    ),
                    const VerticalDivider(width: 1),
                    // Right region: message + main + assistant
                    Expanded(
                      child: Column(
                        children: [
                          if (message != null)
                            Padding(
                              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                              child: Align(
                                alignment: Alignment.centerLeft,
                                child: Text(message!, style: const TextStyle(color: Colors.redAccent)),
                              ),
                            ),
                          Expanded(
                            child: Row(
                              children: [
                                // Main content
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [
                                      if (searchCtrl.text.trim().isNotEmpty) ...[
                                        const Padding(
                                          padding: EdgeInsets.all(8.0),
                                          child: Text('Search results', style: TextStyle(fontWeight: FontWeight.w600)),
                                        ),
                                        const Divider(height: 1),
                                        SizedBox(height: 240, child: _buildSimpleList(searchResults)),
                                        const Divider(height: 1),
                                      ],
                                      Expanded(child: Stack(children: [
                                        _buildMainList(),
                                        Positioned(
                                          right: 16,
                                          bottom: 16,
                                          child: fab.FabActions(onPressed: _openFabSheet),
                                        ),
                                      ])),
                                    ],
                                  ),
                                ),
                                const VerticalDivider(width: 1),
                                // Assistant panel (without internal header)
                                SizedBox(
                                  width: 360,
                                  child: AssistantPanel(
                                    transcript: assistantTranscript,
                                    operations: assistantOps,
                                    operationsChecked: assistantOpsChecked,
                                    sending: assistantSending,
                                    showDiff: assistantShowDiff,
                                    onToggleDiff: () => setState(() => assistantShowDiff = !assistantShowDiff),
                                    onToggleOperation: (i, v) => setState(() => assistantOpsChecked[i] = v),
                                    onApplySelected: _applyAssistantOps,
                                    onDiscard: () => setState(() { assistantOps = []; assistantOpsChecked = []; assistantShowDiff = false; }),
                                    inputController: assistantCtrl,
                                    onSend: _sendAssistantMessage,
                                    opLabel: (op) => _opLabel((op as AnnotatedOp).op),
                                  ),
                                ),
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

  // Import UI removed

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
    final like = row.TodoLike(
      id: t.id,
      title: t.title,
      notes: t.notes,
      priority: t.priority,
      completed: t.completed,
    );
    return row.TodoRow(
      todo: like,
      onToggleCompleted: () => _toggleCompleted(t),
      onEdit: () => _editTodo(t),
      onDelete: () => _deleteTodo(t),
    );
  }

  // Removed inline assistant panel; extracted to widgets/assistant_panel.dart
}
