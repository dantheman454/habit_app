import 'package:flutter/material.dart';
import 'dart:async';
import 'widgets/assistant_panel.dart';
import 'widgets/sidebar.dart' as sb;
import 'widgets/todo_row.dart' as row;
import 'widgets/fab_actions.dart' as fab;
import 'api.dart' as api;
import 'package:dio/dio.dart';
import 'package:flutter/services.dart';
import 'dart:math' as math;
import 'dart:ui' as ui;

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
  View view = View.day;
  bool showCompleted = false;
  
  final TextEditingController searchCtrl = TextEditingController();
  Timer? _searchDebounce;
  CancelToken? _searchCancelToken;
  final FocusNode _searchFocus = FocusNode();
  final LayerLink _searchLink = LayerLink();
  OverlayEntry? _searchOverlay;
  int _searchHoverIndex = -1;
  bool _searching = false;
  int? _highlightedId;

  // Map of row keys for ensureVisible
  final Map<int, GlobalKey> _rowKeys = {};

  // Sidebar state
  SmartList selected = SmartList.today;

  // Data
  List<Todo> scheduled = [];
  List<Todo> scheduledAllTime = [];
  List<Todo> backlog = [];
  List<Todo> searchResults = [];
  Map<String, int> sidebarCounts = {};

  bool loading = false;
  String? message;
  
    
  final TextEditingController assistantCtrl = TextEditingController();
  final List<Map<String, String>> assistantTranscript = [];
  List<AnnotatedOp> assistantOps = [];
  List<bool> assistantOpsChecked = [];
  bool assistantSending = false;
  bool assistantShowDiff = false;
  // Assistant mode: 'chat' | 'plan' (server default remains 'plan' if omitted)
  String assistantMode = 'chat';

 

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
    _searchFocus.dispose();
    _removeSearchOverlay();
    super.dispose();
  }

  Future<void> _refreshAll() async {
    setState(() => loading = true);
    try {
      final r = rangeForView(anchor, view);
      final scheduledRaw = await api.fetchScheduled(from: r.from, to: r.to, completed: showCompleted ? null : false);
      final scheduledAllRaw = await api.fetchScheduledAllTime(completed: showCompleted ? null : false);
      final backlogRaw = await api.fetchBacklog();
      final sList = scheduledRaw.map((e) => Todo.fromJson(e as Map<String, dynamic>)).toList();
      final sAllList = scheduledAllRaw.map((e) => Todo.fromJson(e as Map<String, dynamic>)).toList();
      var bList = backlogRaw.map((e) => Todo.fromJson(e as Map<String, dynamic>)).toList();
      if (!showCompleted) {
        bList = bList.where((t) => !t.completed).toList();
      }
      final nowYmd = ymd(DateTime.now());
      final todayCount = sList.where((t) => t.scheduledFor == nowYmd).length;
      final scheduledCount = sList.length;
      final backlogCount = bList.length;
      final flaggedCount = [...sAllList, ...bList].where((t) => t.priority == 'high').length;
      final allCount = sAllList.length + backlogCount;
      final counts = <String, int>{
        'today': todayCount,
        'scheduled': scheduledCount,
        'all': allCount,
        'flagged': flaggedCount,
        'backlog': backlogCount,
      };
      setState(() {
        scheduled = sList;
        scheduledAllTime = sAllList;
        backlog = bList;
        sidebarCounts = counts;
        message = null;
      });
    } catch (e) {
      setState(() => message = 'Load failed: $e');
    } finally {
      setState(() => loading = false);
    }
  }

  Future<void> _runSearch(String q) async {
    if (q.trim().length < 2) {
      setState(() => searchResults = []);
      _removeSearchOverlay();
      return;
    }
    try {
      // Cancel any in-flight search
      try { _searchCancelToken?.cancel('replaced'); } catch (_) {}
      _searchCancelToken = CancelToken();
      setState(() => _searching = true);
      final list = await api.searchTodos(q, completed: showCompleted ? null : false, cancelToken: _searchCancelToken);
      final items = (list)
          .map((e) => Todo.fromJson(e as Map<String, dynamic>))
          .toList();
      setState(() {
        searchResults = items;
        _searching = false;
      });
      _showSearchOverlayIfNeeded();
    } catch (e) {
      setState(() {
        message = 'Search failed: $e';
        _searching = false;
      });
    }
  }

  void _onSearchChanged(String v) {
    _searchDebounce?.cancel();
    _searchDebounce = Timer(const Duration(milliseconds: 250), () => _runSearch(v));
  }

  void _showSearchOverlayIfNeeded() {
    if (!_searchFocus.hasFocus || searchCtrl.text.trim().length < 2) {
      _removeSearchOverlay();
      return;
    }
    if (_searchOverlay != null) {
      _searchOverlay!.markNeedsBuild();
      return;
    }
    _searchOverlay = OverlayEntry(builder: (context) {
      final theme = Theme.of(context);
      final results = searchResults.take(7).toList();
      return Positioned.fill(
        child: GestureDetector(
          behavior: HitTestBehavior.translucent,
          onTap: _removeSearchOverlay,
          child: Stack(children: [
            CompositedTransformFollower(
              link: _searchLink,
              offset: const Offset(0, 44),
              showWhenUnlinked: false,
              child: Material(
                color: Colors.transparent,
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 560),
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(12),
                    child: BackdropFilter(
                      filter: ui.ImageFilter.blur(sigmaX: 12, sigmaY: 12),
                      child: Container(
                        margin: const EdgeInsets.only(left: 0, right: 0),
                        decoration: BoxDecoration(
                          color: Colors.white.withOpacity(0.72),
                          borderRadius: BorderRadius.circular(12),
                          border: Border.all(color: theme.colorScheme.outline.withOpacity(0.35)),
                          boxShadow: [
                            BoxShadow(
                              color: Colors.black.withOpacity(0.08),
                              blurRadius: 16,
                              offset: const Offset(0, 8),
                            ),
                          ],
                        ),
                        child: (_searching && results.isEmpty)
                            ? const Padding(
                                padding: EdgeInsets.all(12),
                                child: Center(child: SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))),
                              )
                            : ListView.separated(
                                padding: const EdgeInsets.symmetric(vertical: 6),
                                shrinkWrap: true,
                                itemBuilder: (c, i) {
                                  final t = results[i];
                                  final selected = i == _searchHoverIndex;
                                  return InkWell(
                                    onTap: () => _selectSearchResult(t as Todo),
                                    onHover: (h) => setState(() => _searchHoverIndex = h ? i : _searchHoverIndex),
                                    child: Container(
                                      color: selected ? theme.colorScheme.primary.withOpacity(0.08) : Colors.transparent,
                                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                                      child: Row(
                                        children: [
                                          Expanded(
                                            child: Column(
                                              crossAxisAlignment: CrossAxisAlignment.start,
                                              children: [
                                                Text((t as Todo).title, maxLines: 1, overflow: TextOverflow.ellipsis),
                                                const SizedBox(height: 4),
                                                Wrap(spacing: 6, runSpacing: 4, children: [
                                                  _chip((t.scheduledFor ?? 'unscheduled')),
                                                  _chip('prio ${t.priority}')
                                                ]),
                                              ],
                                            ),
                                          ),
                                        ],
                                      ),
                                    ),
                                  );
                                },
                                separatorBuilder: (_, __) => Divider(height: 1, color: theme.colorScheme.outline.withOpacity(0.2)),
                                itemCount: results.length,
                              ),
                      ),
                    ),
                  ),
                ),
              ),
            )
          ]),
        ),
      );
    });
    Overlay.of(context, debugRequiredFor: widget).insert(_searchOverlay!);
  }

  void _removeSearchOverlay() {
    try { _searchOverlay?.remove(); } catch (_) {}
    _searchOverlay = null;
    _searchHoverIndex = -1;
  }

  Widget _chip(String text) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: Colors.grey.shade200,
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: Colors.grey.shade300),
      ),
      child: Text(text, style: const TextStyle(fontSize: 12, color: Colors.black87)),
    );
  }

  Future<void> _selectSearchResult(Todo t) async {
    _removeSearchOverlay();
    _searchFocus.unfocus();
    searchCtrl.clear();
    setState(() { searchResults = []; _searchHoverIndex = -1; });
    // Determine list membership
    final isScheduled = t.scheduledFor != null;
    final targetList = isScheduled ? SmartList.all : SmartList.all; // Ensure visibility regardless
    if (selected != targetList) {
      setState(() => selected = targetList);
      await _refreshAll();
      await Future.delayed(Duration.zero);
    }
    final key = _rowKeys[t.id];
    if (key != null && key.currentContext != null) {
      await Scrollable.ensureVisible(key.currentContext!, duration: const Duration(milliseconds: 250));
      setState(() => _highlightedId = t.id);
      await Future.delayed(const Duration(seconds: 1));
      if (mounted && _highlightedId == t.id) setState(() => _highlightedId = null);
    }
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

  // ----- Assistant (chat) -----
  Future<void> _sendAssistantMessage() async {
    final text = assistantCtrl.text.trim();
    if (text.isEmpty) return;
    setState(() {
      assistantTranscript.add({'role': 'user', 'text': text});
      assistantSending = true;
    });
    // Clear input immediately for snappier UX while preserving `text` captured above
    assistantCtrl.clear();
    try {
      // Send last 3 turns and request streaming summary (server will fall back to JSON if not SSE)
      final recent = assistantTranscript.length <= 3 ? assistantTranscript : assistantTranscript.sublist(assistantTranscript.length - 3);
      final res = await api.assistantMessage(text, transcript: recent, streamSummary: true, mode: assistantMode);
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
        return [...scheduledAllTime, ...backlog];
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
                padding: const EdgeInsets.symmetric(horizontal: 0, vertical: 0),
                child: SizedBox(
                  height: 56,
                  child: Row(
                    children: [
                      // Reserve space visually aligned with left sidebar width
                      const SizedBox(width: 220),
                      // Full-height divider aligning with body split (left of main tasks)
                      VerticalDivider(width: 1, thickness: 1, color: Theme.of(context).colorScheme.outline),
                      // Search box (responsive, centered within available region)
                      Expanded(
                        child: Center(
                          child: ConstrainedBox(
                            constraints: const BoxConstraints(minWidth: 320, maxWidth: 560),
                            child: CompositedTransformTarget(
                              link: _searchLink,
                              child: Focus(
                                focusNode: _searchFocus,
                                onFocusChange: (f) {
                                  if (!f) _removeSearchOverlay();
                                  else _showSearchOverlayIfNeeded();
                                },
                                onKey: (node, event) {
                                  if (!_searchFocus.hasFocus) return KeyEventResult.ignored;
                                  if (event is! RawKeyDownEvent) return KeyEventResult.ignored;
                                  final len = math.min(searchResults.length, 7);
                                  if (event.logicalKey == LogicalKeyboardKey.arrowDown) {
                                    setState(() { _searchHoverIndex = len == 0 ? -1 : (_searchHoverIndex + 1) % len; });
                                    _showSearchOverlayIfNeeded();
                                    return KeyEventResult.handled;
                                  } else if (event.logicalKey == LogicalKeyboardKey.arrowUp) {
                                    setState(() { _searchHoverIndex = len == 0 ? -1 : (_searchHoverIndex - 1 + len) % len; });
                                    _showSearchOverlayIfNeeded();
                                    return KeyEventResult.handled;
                                  } else if (event.logicalKey == LogicalKeyboardKey.enter) {
                                    final list = searchResults.take(7).toList();
                                    if (list.isEmpty) return KeyEventResult.handled;
                                    final idx = _searchHoverIndex >= 0 && _searchHoverIndex < list.length ? _searchHoverIndex : 0;
                                    _selectSearchResult(list[idx] as Todo);
                                    return KeyEventResult.handled;
                                  }
                                  return KeyEventResult.ignored;
                                },
                                child: TextField(
                                  controller: searchCtrl,
                                  decoration: InputDecoration(
                                    prefixIcon: const Icon(Icons.search),
                                    hintText: 'Search',
                                    filled: true,
                                    fillColor: Colors.white.withOpacity(0.9),
                                    border: OutlineInputBorder(
                                      borderRadius: BorderRadius.circular(24),
                                      borderSide: BorderSide(color: Theme.of(context).colorScheme.outline.withOpacity(0.4)),
                                    ),
                                    focusedBorder: OutlineInputBorder(
                                      borderRadius: BorderRadius.circular(24),
                                      borderSide: BorderSide(color: Theme.of(context).colorScheme.primary, width: 2),
                                    ),
                                    suffixIcon: Row(
                                      mainAxisSize: MainAxisSize.min,
                                      children: [
                                        if (_searching) SizedBox(width: 16, height: 16, child: Padding(padding: EdgeInsets.all(8), child: CircularProgressIndicator(strokeWidth: 2))),
                                        if (searchCtrl.text.isNotEmpty)
                                          IconButton(
                                            icon: const Icon(Icons.clear),
                                            onPressed: () {
                                              searchCtrl.clear();
                                              setState(() { searchResults = []; _searchHoverIndex = -1; });
                                              _removeSearchOverlay();
                                            },
                                          ),
                                      ],
                                    ),
                                  ),
                                  onChanged: (v) { _onSearchChanged(v); _showSearchOverlayIfNeeded(); },
                                ),
                              ),
                            ),
                          ),
                        ),
                      ),
                      // Full-height divider aligning with body split (right of main tasks / left of assistant)
                      VerticalDivider(width: 1, thickness: 1, color: Theme.of(context).colorScheme.outline),
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
                                    Text('Mr. Assister', style: TextStyle(fontWeight: FontWeight.w600, color: Colors.white)),
                                  ],
                                )
                              : const Icon(Icons.smart_toy_outlined, color: Colors.white, size: 18),
                        ),
                      ),
                    ],
                  ),
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
                        onSelect: (k) async {
                          final sl = _smartListFromKey(k);
                          if (sl == SmartList.today) {
                            setState(() {
                              selected = sl;
                              view = View.day;
                              anchor = ymd(DateTime.now());
                            });
                            await _refreshAll();
                          } else if (sl == SmartList.scheduled) {
                            setState(() {
                              selected = sl;
                              view = View.week;
                            });
                            await _refreshAll();
                          } else {
                            setState(() {
                              selected = sl;
                            });
                          }
                        },
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
                                    mode: assistantMode,
                                    onModeChanged: (m) => setState(() {
                                      assistantMode = m;
                                      // Clear pending ops when switching to chat mode to avoid stale UI
                                      if (assistantMode == 'chat') {
                                        assistantOps = [];
                                        assistantOpsChecked = [];
                                        assistantShowDiff = false;
                                      }
                                    }),
                                    onClearChat: () => setState(() {
                                      assistantTranscript.clear();
                                      assistantOps = [];
                                      assistantOpsChecked = [];
                                      assistantShowDiff = false;
                                    }),
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
    final key = _rowKeys.putIfAbsent(t.id, () => GlobalKey());
    return KeyedSubtree(
      key: key,
      child: row.TodoRow(
        todo: like,
        onToggleCompleted: () => _toggleCompleted(t),
        onEdit: () => _editTodo(t),
        onDelete: () => _deleteTodo(t),
        highlighted: _highlightedId == t.id,
      ),
    );
  }
}
