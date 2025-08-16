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
  String? kind; // 'todo'|'event'|'habit' for unified schedule rows
  String? scheduledFor; // YYYY-MM-DD or null
  String? timeOfDay; // HH:MM or null
  String priority; // low|medium|high
  bool completed;
  Map<String, dynamic>? recurrence; // {type,...}
  int? masterId; // present on expanded occurrences
  final String createdAt;
  String updatedAt;

  Todo({
    required this.id,
    required this.title,
    required this.notes,
    this.kind,
    required this.scheduledFor,
    required this.timeOfDay,
    required this.priority,
    required this.completed,
    required this.recurrence,
    required this.masterId,
    required this.createdAt,
    required this.updatedAt,
  });

  factory Todo.fromJson(Map<String, dynamic> j) => Todo(
        id: j['id'] as int,
        title: j['title'] as String? ?? '',
        notes: j['notes'] as String? ?? '',
        kind: j['kind'] as String?,
        scheduledFor: j['scheduledFor'] as String?,
        timeOfDay: ((j['timeOfDay'] as String?) ?? (j['startTime'] as String?)),
        priority: j['priority'] as String? ?? 'medium',
        completed: j['completed'] as bool? ?? false,
        recurrence: j['recurrence'] as Map<String, dynamic>?,
        masterId: j['masterId'] as int?,
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
  final String? timeOfDay; // HH:MM or null
  final Map<String, dynamic>? recurrence; // {type, intervalDays, until}
  // Occurrence completion support
  final String? occurrenceDate; // YYYY-MM-DD for complete_occurrence
  LlmOperation({
    required this.op,
    this.id,
    this.title,
    this.notes,
    this.scheduledFor,
    this.priority,
    this.completed,
    this.timeOfDay,
    this.recurrence,
    this.occurrenceDate,
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
        timeOfDay: j['timeOfDay'] as String?,
        recurrence: j['recurrence'] == null
            ? null
            : Map<String, dynamic>.from(j['recurrence'] as Map),
        occurrenceDate: j['occurrenceDate'] as String?,
      );
  Map<String, dynamic> toJson() => {
        'op': op,
        if (id != null) 'id': id,
        if (title != null) 'title': title,
        if (notes != null) 'notes': notes,
        if (scheduledFor != null) 'scheduledFor': scheduledFor,
        if (priority != null) 'priority': priority,
        if (completed != null) 'completed': completed,
        if (timeOfDay != null) 'timeOfDay': timeOfDay,
        if (recurrence != null) 'recurrence': recurrence,
        if (occurrenceDate != null) 'occurrenceDate': occurrenceDate,
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
enum MainView { tasks, goals }

 

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
  MainView mainView = MainView.tasks;

  // Data
  List<Todo> scheduled = [];
  List<Todo> scheduledAllTime = [];
  List<Todo> backlog = [];
  List<Todo> searchResults = [];
  Map<String, int> sidebarCounts = {};

  // Unified schedule filters (chips)
  Set<String> _kindFilter = <String>{'todo','event','habit'}; // All by default

  bool loading = false;
  String? message;
  // Assistant model label
  String _assistantModel = '';
  
    
  final TextEditingController assistantCtrl = TextEditingController();
  final List<Map<String, String>> assistantTranscript = [];
  List<AnnotatedOp> assistantOps = [];
  List<bool> assistantOpsChecked = [];
  bool assistantSending = false;
  bool assistantShowDiff = false;
  // Assistant mode removed; server always uses auto flow
  int? assistantStreamingIndex;
  // Clarify state: question and structured options/selection
  String? _pendingClarifyQuestion;
  List<Map<String, dynamic>> _pendingClarifyOptions = const [];
  final Set<int> _clarifySelectedIds = <int>{};
  String? _clarifySelectedDate;
  String? _clarifySelectedPriority;
  String _progressStage = '';
  // Pending smooth-scroll target (YYYY-MM-DD) for Day view
  String? _pendingScrollYmd;

 

  @override
  void initState() {
    super.initState();
    _refreshAll();
    _loadAssistantModel();
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
      // Day view: use unified schedule; other views keep existing paths for now
      List<Todo> sList;
      if (view == View.day || view == View.week || view == View.month) {
        final kinds = _kindFilter.isEmpty ? null : _kindFilter.toList();
        final raw = await api.fetchSchedule(from: r.from, to: r.to, kinds: kinds, completed: showCompleted ? null : false);
        sList = raw.map((e) => Todo.fromJson(Map<String, dynamic>.from(e as Map))).toList();
      } else {
        final scheduledRaw = await api.fetchScheduled(from: r.from, to: r.to, completed: showCompleted ? null : false);
        sList = scheduledRaw.map((e) => Todo.fromJson(e as Map<String, dynamic>)).toList();
      }
      final scheduledAllRaw = await api.fetchScheduledAllTime(completed: showCompleted ? null : false);
      final backlogRaw = await api.fetchBacklog();
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
      _maybeScrollToPendingDate();
    } catch (e) {
      setState(() => message = 'Load failed: $e');
    } finally {
      setState(() => loading = false);
    }
  }

  Future<void> _loadAssistantModel() async {
    try {
      final m = await api.fetchAssistantModel();
      if (!mounted) return;
      setState(() { _assistantModel = m; });
    } catch (_) {
      // ignore
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
                          color: Colors.white.withValues(alpha: 0.72),
                          borderRadius: BorderRadius.circular(12),
                          border: Border.all(color: theme.colorScheme.outline.withValues(alpha: 0.35)),
                          boxShadow: [
                            BoxShadow(
                              color: Colors.black.withValues(alpha: 0.08),
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
                                      color: selected ? theme.colorScheme.primary.withValues(alpha: 0.08) : Colors.transparent,
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
                                separatorBuilder: (_, __) => Divider(height: 1, color: theme.colorScheme.outline.withValues(alpha: 0.2)),
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
      if (t.kind == 'event') {
        if (t.masterId != null && t.scheduledFor != null) {
          await api.toggleEventOccurrence(t.masterId!, t.scheduledFor!, !t.completed);
        } else {
          await api.updateEvent(t.id, { 'completed': !t.completed });
        }
      } else if (t.kind == 'habit') {
        if (t.masterId != null && t.scheduledFor != null) {
          await api.toggleHabitOccurrence(t.masterId!, t.scheduledFor!, !t.completed);
        } else {
          await api.updateHabit(t.id, {
            'completed': !t.completed,
            if (t.recurrence != null) 'recurrence': t.recurrence,
          });
        }
      } else {
        if (t.masterId != null && t.scheduledFor != null) {
          await api.updateOccurrence(t.masterId!, t.scheduledFor!, !t.completed);
        } else {
          await api.updateTodo(t.id, {
            'completed': !t.completed,
            'recurrence': t.recurrence ?? {'type': 'none'}
          });
        }
      }
      await _refreshAll();
    } catch (e) {
      setState(() => message = 'Toggle failed: $e');
    }
  }

  Future<void> _deleteTodo(Todo t) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: Text('Delete ${t.kind ?? 'todo'}?'),
        content: Text(t.title),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Delete')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      if (t.kind == 'event') {
        await api.deleteEvent(t.id);
      } else if (t.kind == 'habit') {
        await api.deleteHabit(t.id);
      } else {
        await api.deleteTodo(t.id);
      }
      await _refreshAll();
    } catch (e) {
      setState(() => message = 'Delete failed: $e');
    }
  }

  Future<void> _openFabSheet() async {
    final titleCtrl = TextEditingController();
    final notesCtrl = TextEditingController();
    final dateCtrl = TextEditingController(text: anchor);
    final timeCtrl = TextEditingController();
    final intervalCtrl = TextEditingController(text: '1');
    String prio = 'medium';
    String recurType = 'none'; // none|daily|weekdays|weekly|every_n_days

    await showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      builder: (c) {
        return StatefulBuilder(builder: (c, setModalState) {
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
                  TextField(controller: timeCtrl, decoration: const InputDecoration(labelText: 'Time (HH:MM or empty)')),
                  const SizedBox(height: 8),
                  DropdownButtonFormField<String>(
                    value: prio,
                    decoration: const InputDecoration(labelText: 'Priority'),
                    items: const [
                      DropdownMenuItem(value: 'low', child: Text('low')),
                      DropdownMenuItem(value: 'medium', child: Text('medium')),
                      DropdownMenuItem(value: 'high', child: Text('high')),
                    ],
                    onChanged: (v) => setModalState(() => prio = v ?? 'medium'),
                  ),
                  const SizedBox(height: 8),
                  DropdownButtonFormField<String>(
                    value: recurType,
                    decoration: const InputDecoration(labelText: 'Recurrence'),
                    items: const [
                      DropdownMenuItem(value: 'none', child: Text('None')),
                      DropdownMenuItem(value: 'daily', child: Text('Daily')),
                      DropdownMenuItem(value: 'weekdays', child: Text('Weekdays (Mon–Fri)')),
                      DropdownMenuItem(value: 'weekly', child: Text('Weekly (by anchor)')),
                      DropdownMenuItem(value: 'every_n_days', child: Text('Every N days')),
                    ],
                    onChanged: (v) => setModalState(() => recurType = v ?? 'none'),
                  ),
                  if (recurType == 'every_n_days')
                    TextField(controller: intervalCtrl, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Every N days (>=1)')),
                  if (recurType == 'weekly' && dateCtrl.text.trim().isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 6),
                      child: Text('Repeats weekly on the same weekday as anchor ${dateCtrl.text.trim()}', style: const TextStyle(fontSize: 12, color: Colors.black54)),
                    ),
                  const SizedBox(height: 12),
                  Align(
                    alignment: Alignment.centerRight,
                    child: FilledButton(
                      onPressed: () async {
                        final title = titleCtrl.text.trim();
                        if (title.isEmpty) return;
                        final sched = dateCtrl.text.trim();
                        final time = timeCtrl.text.trim();
                        final data = <String, dynamic>{
                          'title': title,
                          'notes': notesCtrl.text,
                          'scheduledFor': sched.isEmpty ? null : sched,
                          'priority': prio,
                        };
                        if (time.isNotEmpty) data['timeOfDay'] = time;
                        if (recurType == 'none') {
                          data['recurrence'] = {'type': 'none'};
                        } else {
                          final rec = <String, dynamic>{'type': recurType};
                          if (recurType == 'every_n_days') {
                            final n = int.tryParse(intervalCtrl.text.trim());
                            if (n != null && n >= 1) rec['intervalDays'] = n;
                          }
                          data['recurrence'] = rec;
                        }
                        await api.createTodo(data);
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
        });
      },
    );
  }

  Future<void> _openEventSheet() async {
    final titleCtrl = TextEditingController();
    final notesCtrl = TextEditingController();
    final dateCtrl = TextEditingController(text: anchor);
    final startCtrl = TextEditingController();
    final endCtrl = TextEditingController();
    final locationCtrl = TextEditingController();
    String prio = 'medium';
    String recurType = 'none';
    final intervalCtrl = TextEditingController(text: '1');
    await showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      builder: (c) {
        return StatefulBuilder(builder: (c, setModalState) {
          return Padding(
            padding: EdgeInsets.only(bottom: MediaQuery.of(c).viewInsets.bottom),
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('Create event', style: TextStyle(fontWeight: FontWeight.w600)),
                  const SizedBox(height: 12),
                  TextField(controller: titleCtrl, decoration: const InputDecoration(labelText: 'Title')),
                  TextField(controller: notesCtrl, decoration: const InputDecoration(labelText: 'Notes')),
                  TextField(controller: dateCtrl, decoration: const InputDecoration(labelText: 'Date (YYYY-MM-DD)')),
                  Row(children: [
                    Expanded(child: TextField(controller: startCtrl, decoration: const InputDecoration(labelText: 'Start (HH:MM)'))),
                    const SizedBox(width: 8),
                    Expanded(child: TextField(controller: endCtrl, decoration: const InputDecoration(labelText: 'End (HH:MM)'))),
                  ]),
                  TextField(controller: locationCtrl, decoration: const InputDecoration(labelText: 'Location')),
                  const SizedBox(height: 8),
                  DropdownButtonFormField<String>(
                    value: prio,
                    decoration: const InputDecoration(labelText: 'Priority'),
                    items: const [
                      DropdownMenuItem(value: 'low', child: Text('low')),
                      DropdownMenuItem(value: 'medium', child: Text('medium')),
                      DropdownMenuItem(value: 'high', child: Text('high')),
                    ],
                    onChanged: (v) => setModalState(() => prio = v ?? 'medium'),
                  ),
                  const SizedBox(height: 8),
                  DropdownButtonFormField<String>(
                    value: recurType,
                    decoration: const InputDecoration(labelText: 'Recurrence'),
                    items: const [
                      DropdownMenuItem(value: 'none', child: Text('None')),
                      DropdownMenuItem(value: 'daily', child: Text('Daily')),
                      DropdownMenuItem(value: 'weekdays', child: Text('Weekdays (Mon–Fri)')),
                      DropdownMenuItem(value: 'weekly', child: Text('Weekly (by anchor)')),
                      DropdownMenuItem(value: 'every_n_days', child: Text('Every N days')),
                    ],
                    onChanged: (v) => setModalState(() => recurType = v ?? 'none'),
                  ),
                  if (recurType == 'every_n_days')
                    TextField(controller: intervalCtrl, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Every N days (>=1)')),
                  const SizedBox(height: 12),
                  Align(
                    alignment: Alignment.centerRight,
                    child: FilledButton(
                      onPressed: () async {
                        final title = titleCtrl.text.trim();
                        if (title.isEmpty) return;
                        final data = <String, dynamic>{
                          'title': title,
                          'notes': notesCtrl.text,
                          'scheduledFor': dateCtrl.text.trim().isEmpty ? null : dateCtrl.text.trim(),
                          'priority': prio,
                          'startTime': startCtrl.text.trim().isEmpty ? null : startCtrl.text.trim(),
                          'endTime': endCtrl.text.trim().isEmpty ? null : endCtrl.text.trim(),
                          'location': locationCtrl.text.trim().isEmpty ? null : locationCtrl.text.trim(),
                          'recurrence': recurType == 'none' ? {'type':'none'} : (recurType == 'every_n_days'
                            ? {'type':'every_n_days','intervalDays': int.tryParse(intervalCtrl.text.trim())}
                            : {'type': recurType}),
                        };
                        await api.createEvent(data);
                        if (context.mounted) Navigator.pop(c);
                        await _refreshAll();
                      },
                      child: const Text('Create'),
                    ),
                  ),
                ],
              ),
            ),
          );
        });
      },
    );
  }

  Future<void> _openHabitSheet() async {
    final titleCtrl = TextEditingController();
    final notesCtrl = TextEditingController();
    final dateCtrl = TextEditingController(text: anchor);
    final timeCtrl = TextEditingController();
    String prio = 'medium';
    String recurType = 'daily'; // habits must be repeating; default daily
    final intervalCtrl = TextEditingController(text: '1');
    await showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      builder: (c) {
        return StatefulBuilder(builder: (c, setModalState) {
          return Padding(
            padding: EdgeInsets.only(bottom: MediaQuery.of(c).viewInsets.bottom),
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('Create habit', style: TextStyle(fontWeight: FontWeight.w600)),
                  const SizedBox(height: 12),
                  TextField(controller: titleCtrl, decoration: const InputDecoration(labelText: 'Title')),
                  TextField(controller: notesCtrl, decoration: const InputDecoration(labelText: 'Notes')),
                  TextField(controller: dateCtrl, decoration: const InputDecoration(labelText: 'Anchor date (YYYY-MM-DD)')),
                  TextField(controller: timeCtrl, decoration: const InputDecoration(labelText: 'Time (HH:MM or empty)')),
                  const SizedBox(height: 8),
                  DropdownButtonFormField<String>(
                    value: prio,
                    decoration: const InputDecoration(labelText: 'Priority'),
                    items: const [
                      DropdownMenuItem(value: 'low', child: Text('low')),
                      DropdownMenuItem(value: 'medium', child: Text('medium')),
                      DropdownMenuItem(value: 'high', child: Text('high')),
                    ],
                    onChanged: (v) => setModalState(() => prio = v ?? 'medium'),
                  ),
                  const SizedBox(height: 8),
                  DropdownButtonFormField<String>(
                    value: recurType,
                    decoration: const InputDecoration(labelText: 'Recurrence (habits must repeat)'),
                    items: const [
                      DropdownMenuItem(value: 'daily', child: Text('Daily')),
                      DropdownMenuItem(value: 'weekdays', child: Text('Weekdays (Mon–Fri)')),
                      DropdownMenuItem(value: 'weekly', child: Text('Weekly (by anchor)')),
                      DropdownMenuItem(value: 'every_n_days', child: Text('Every N days')),
                    ],
                    onChanged: (v) => setModalState(() => recurType = v ?? 'daily'),
                  ),
                  if (recurType == 'every_n_days')
                    TextField(controller: intervalCtrl, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Every N days (>=1)')),
                  const SizedBox(height: 12),
                  Align(
                    alignment: Alignment.centerRight,
                    child: FilledButton(
                      onPressed: () async {
                        final title = titleCtrl.text.trim();
                        if (title.isEmpty) return;
                        final sched = dateCtrl.text.trim();
                        final time = timeCtrl.text.trim();
                        final rec = <String, dynamic>{'type': recurType};
                        if (recurType == 'every_n_days') {
                          final n = int.tryParse(intervalCtrl.text.trim());
                          if (n != null && n >= 1) rec['intervalDays'] = n;
                        }
                        final data = <String, dynamic>{
                          'title': title,
                          'notes': notesCtrl.text,
                          'scheduledFor': sched.isEmpty ? null : sched,
                          'priority': prio,
                          'timeOfDay': time.isEmpty ? null : time,
                          'recurrence': rec,
                        };
                        await api.createHabit(data);
                        if (context.mounted) Navigator.pop(c);
                        await _refreshAll();
                      },
                      child: const Text('Create'),
                    ),
                  ),
                ],
              ),
            ),
          );
        });
      },
    );
  }

  Future<void> _editTodo(Todo t) async {
    final titleCtrl = TextEditingController(text: t.title);
    final notesCtrl = TextEditingController(text: t.notes);
    final dateCtrl = TextEditingController(text: t.scheduledFor ?? '');
    final timeCtrl = TextEditingController(text: t.timeOfDay ?? '');
    final intervalCtrl = TextEditingController(text: (t.recurrence != null && t.recurrence!['intervalDays'] != null) ? '${t.recurrence!['intervalDays']}' : '1');
    String prio = t.priority;
    String recurType = (t.recurrence != null && t.recurrence!['type'] is String) ? (t.recurrence!['type'] as String) : 'none';
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => StatefulBuilder(builder: (c, setDlgState) {
        return AlertDialog(
          title: const Text('Edit todo'),
          content: SizedBox(
            width: 420,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextField(controller: titleCtrl, decoration: const InputDecoration(labelText: 'Title')),
                TextField(controller: notesCtrl, decoration: const InputDecoration(labelText: 'Notes')),
                TextField(controller: dateCtrl, decoration: const InputDecoration(labelText: 'Scheduled (YYYY-MM-DD or empty)')),
                TextField(controller: timeCtrl, decoration: const InputDecoration(labelText: 'Time (HH:MM or empty)')),
                const SizedBox(height: 8),
                DropdownButtonFormField<String>(
                  value: prio,
                  decoration: const InputDecoration(labelText: 'Priority'),
                  items: const [
                    DropdownMenuItem(value: 'low', child: Text('low')),
                    DropdownMenuItem(value: 'medium', child: Text('medium')),
                    DropdownMenuItem(value: 'high', child: Text('high')),
                  ],
                  onChanged: (v) => setDlgState(() => prio = v ?? 'medium'),
                ),
                const SizedBox(height: 8),
                DropdownButtonFormField<String>(
                  value: recurType,
                  decoration: const InputDecoration(labelText: 'Recurrence'),
                  items: const [
                    DropdownMenuItem(value: 'none', child: Text('None')),
                    DropdownMenuItem(value: 'daily', child: Text('Daily')),
                    DropdownMenuItem(value: 'weekdays', child: Text('Weekdays (Mon–Fri)')),
                    DropdownMenuItem(value: 'weekly', child: Text('Weekly (by anchor)')),
                    DropdownMenuItem(value: 'every_n_days', child: Text('Every N days')),
                  ],
                  onChanged: (v) => setDlgState(() => recurType = v ?? 'none'),
                ),
                if (recurType == 'every_n_days')
                  TextField(controller: intervalCtrl, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Every N days (>=1)')),
                if (recurType == 'weekly' && dateCtrl.text.trim().isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: Text('Repeats weekly on the same weekday as anchor ${dateCtrl.text.trim()}', style: const TextStyle(fontSize: 12, color: Colors.black54)),
                  ),
              ],
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
            FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Save')),
          ],
        );
      }),
    );
    if (ok != true) return;

    final patch = <String, dynamic>{};
    if (titleCtrl.text != t.title) patch['title'] = titleCtrl.text;
    if (notesCtrl.text != t.notes) patch['notes'] = notesCtrl.text;
    final sched = dateCtrl.text.trim();
    final normalized = sched.isEmpty ? null : sched;
    if (normalized != (t.scheduledFor ?? '')) patch['scheduledFor'] = normalized;
    if (prio != t.priority) patch['priority'] = prio;
    final time = timeCtrl.text.trim();
    if ((time.isEmpty ? null : time) != (t.timeOfDay)) patch['timeOfDay'] = time.isEmpty ? null : time;
    // Recurrence
    final existingType = (t.recurrence != null && t.recurrence!['type'] is String) ? (t.recurrence!['type'] as String) : 'none';
    final existingN = (t.recurrence != null && t.recurrence!['intervalDays'] is int) ? (t.recurrence!['intervalDays'] as int) : null;
    if (recurType != existingType) {
      patch['recurrence'] = {'type': recurType};
      if (recurType == 'every_n_days') {
        final n = int.tryParse(intervalCtrl.text.trim());
        if (n != null && n >= 1) (patch['recurrence'] as Map<String, dynamic>)['intervalDays'] = n;
      }
    } else if (recurType == 'every_n_days') {
      final n = int.tryParse(intervalCtrl.text.trim());
      if (n != null && n >= 1 && n != existingN) {
        patch['recurrence'] = {'type': recurType, 'intervalDays': n};
      }
    }

    if (patch.isEmpty) return;
    try {
      if (!patch.containsKey('recurrence')) {
        patch['recurrence'] = t.recurrence ?? {'type': 'none'};
      }
      await api.updateTodo(t.id, patch);
      await _refreshAll();
    } catch (e) {
      setState(() => message = 'Edit failed: $e');
    }
  }

  Future<void> _editEvent(Todo t) async {
    final titleCtrl = TextEditingController(text: t.title);
    final notesCtrl = TextEditingController(text: t.notes);
    final dateCtrl = TextEditingController(text: t.scheduledFor ?? '');
    final startCtrl = TextEditingController(text: t.timeOfDay ?? '');
    final endCtrl = TextEditingController();
    final locationCtrl = TextEditingController();
    String prio = t.priority;
    String recurType = (t.recurrence != null && t.recurrence!['type'] is String) ? (t.recurrence!['type'] as String) : 'none';
    final intervalCtrl = TextEditingController(text: (t.recurrence != null && t.recurrence!['intervalDays'] != null) ? '${t.recurrence!['intervalDays']}' : '1');
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => StatefulBuilder(builder: (c, setDlgState) {
        return AlertDialog(
          title: const Text('Edit event'),
          content: SizedBox(
            width: 420,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextField(controller: titleCtrl, decoration: const InputDecoration(labelText: 'Title')),
                TextField(controller: notesCtrl, decoration: const InputDecoration(labelText: 'Notes')),
                TextField(controller: dateCtrl, decoration: const InputDecoration(labelText: 'Date (YYYY-MM-DD)')),
                Row(children: [
                  Expanded(child: TextField(controller: startCtrl, decoration: const InputDecoration(labelText: 'Start (HH:MM)'))),
                  const SizedBox(width: 8),
                  Expanded(child: TextField(controller: endCtrl, decoration: const InputDecoration(labelText: 'End (HH:MM)'))),
                ]),
                TextField(controller: locationCtrl, decoration: const InputDecoration(labelText: 'Location')),
                const SizedBox(height: 8),
                DropdownButtonFormField<String>(
                  value: prio,
                  decoration: const InputDecoration(labelText: 'Priority'),
                  items: const [
                    DropdownMenuItem(value: 'low', child: Text('low')),
                    DropdownMenuItem(value: 'medium', child: Text('medium')),
                    DropdownMenuItem(value: 'high', child: Text('high')),
                  ],
                  onChanged: (v) => setDlgState(() => prio = v ?? 'medium'),
                ),
                const SizedBox(height: 8),
                DropdownButtonFormField<String>(
                  value: recurType,
                  decoration: const InputDecoration(labelText: 'Recurrence'),
                  items: const [
                    DropdownMenuItem(value: 'none', child: Text('None')),
                    DropdownMenuItem(value: 'daily', child: Text('Daily')),
                    DropdownMenuItem(value: 'weekdays', child: Text('Weekdays (Mon–Fri)')),
                    DropdownMenuItem(value: 'weekly', child: Text('Weekly (by anchor)')),
                    DropdownMenuItem(value: 'every_n_days', child: Text('Every N days')),
                  ],
                  onChanged: (v) => setDlgState(() => recurType = v ?? 'none'),
                ),
                if (recurType == 'every_n_days')
                  TextField(controller: intervalCtrl, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Every N days (>=1)')),
              ],
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
            FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Save')),
          ],
        );
      }),
    );
    if (ok != true) return;
    final patch = <String, dynamic>{};
    if (titleCtrl.text != t.title) patch['title'] = titleCtrl.text;
    if (notesCtrl.text != t.notes) patch['notes'] = notesCtrl.text;
    final date = dateCtrl.text.trim();
    final normalized = date.isEmpty ? null : date;
    if (normalized != (t.scheduledFor ?? '')) patch['scheduledFor'] = normalized;
    if (prio != t.priority) patch['priority'] = prio;
    final start = startCtrl.text.trim();
    final end = endCtrl.text.trim();
    patch['startTime'] = start.isEmpty ? null : start;
    patch['endTime'] = end.isEmpty ? null : end;
    patch['location'] = locationCtrl.text.trim().isEmpty ? null : locationCtrl.text.trim();
    if (recurType != ((t.recurrence != null && t.recurrence!['type'] is String) ? (t.recurrence!['type'] as String) : 'none')) {
      patch['recurrence'] = recurType == 'none'
          ? {'type':'none'}
          : (recurType == 'every_n_days'
              ? {'type':'every_n_days','intervalDays': int.tryParse(intervalCtrl.text.trim())}
              : {'type': recurType});
    }
    try {
      await api.updateEvent(t.id, patch);
      await _refreshAll();
    } catch (e) {
      setState(() => message = 'Edit failed: $e');
    }
  }

  Future<void> _editHabit(Todo t) async {
    final titleCtrl = TextEditingController(text: t.title);
    final notesCtrl = TextEditingController(text: t.notes);
    final dateCtrl = TextEditingController(text: t.scheduledFor ?? '');
    final timeCtrl = TextEditingController(text: t.timeOfDay ?? '');
    final intervalCtrl = TextEditingController(text: (t.recurrence != null && t.recurrence!['intervalDays'] != null) ? '${t.recurrence!['intervalDays']}' : '1');
    String prio = t.priority;
    String recurType = (t.recurrence != null && t.recurrence!['type'] is String) ? (t.recurrence!['type'] as String) : 'daily';
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => StatefulBuilder(builder: (c, setDlgState) {
        return AlertDialog(
          title: const Text('Edit habit'),
          content: SizedBox(
            width: 420,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextField(controller: titleCtrl, decoration: const InputDecoration(labelText: 'Title')),
                TextField(controller: notesCtrl, decoration: const InputDecoration(labelText: 'Notes')),
                TextField(controller: dateCtrl, decoration: const InputDecoration(labelText: 'Anchor date (YYYY-MM-DD)')),
                TextField(controller: timeCtrl, decoration: const InputDecoration(labelText: 'Time (HH:MM or empty)')),
                const SizedBox(height: 8),
                DropdownButtonFormField<String>(
                  value: prio,
                  decoration: const InputDecoration(labelText: 'Priority'),
                  items: const [
                    DropdownMenuItem(value: 'low', child: Text('low')),
                    DropdownMenuItem(value: 'medium', child: Text('medium')),
                    DropdownMenuItem(value: 'high', child: Text('high')),
                  ],
                  onChanged: (v) => setDlgState(() => prio = v ?? 'medium'),
                ),
                const SizedBox(height: 8),
                DropdownButtonFormField<String>(
                  value: recurType,
                  decoration: const InputDecoration(labelText: 'Recurrence (habits must repeat)'),
                  items: const [
                    DropdownMenuItem(value: 'daily', child: Text('Daily')),
                    DropdownMenuItem(value: 'weekdays', child: Text('Weekdays (Mon–Fri)')),
                    DropdownMenuItem(value: 'weekly', child: Text('Weekly (by anchor)')),
                    DropdownMenuItem(value: 'every_n_days', child: Text('Every N days')),
                  ],
                  onChanged: (v) => setDlgState(() => recurType = v ?? 'daily'),
                ),
                if (recurType == 'every_n_days')
                  TextField(controller: intervalCtrl, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Every N days (>=1)')),
              ],
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
            FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Save')),
          ],
        );
      }),
    );
    if (ok != true) return;
    final patch = <String, dynamic>{};
    if (titleCtrl.text != t.title) patch['title'] = titleCtrl.text;
    if (notesCtrl.text != t.notes) patch['notes'] = notesCtrl.text;
    final date = dateCtrl.text.trim();
    final normalized = date.isEmpty ? null : date;
    if (normalized != (t.scheduledFor ?? '')) patch['scheduledFor'] = normalized;
    if (prio != t.priority) patch['priority'] = prio;
    final time = timeCtrl.text.trim();
    patch['timeOfDay'] = time.isEmpty ? null : time;
    // Recurrence
    final existingType = (t.recurrence != null && t.recurrence!['type'] is String) ? (t.recurrence!['type'] as String) : 'daily';
    if (recurType != existingType) {
      final rec = <String, dynamic>{'type': recurType};
      if (recurType == 'every_n_days') {
        final n = int.tryParse(intervalCtrl.text.trim());
        if (n != null && n >= 1) rec['intervalDays'] = n;
      }
      patch['recurrence'] = rec;
    }
    try {
      // server requires recurrence on habit updates
      if (!patch.containsKey('recurrence')) {
        patch['recurrence'] = t.recurrence ?? {'type': 'daily'};
      }
      await api.updateHabit(t.id, patch);
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
    // Insert a placeholder assistant bubble that we will update with streamed summary
    setState(() {
      assistantTranscript.add({'role': 'assistant', 'text': ''});
      assistantStreamingIndex = assistantTranscript.length - 1;
    });
    try {
      // Send last 3 turns and request streaming summary (server will fall back to JSON if not SSE)
      final recent = assistantTranscript.length <= 3 ? assistantTranscript : assistantTranscript.sublist(assistantTranscript.length - 3);
      final res = await api.assistantMessage(
        text,
        transcript: recent,
        streamSummary: true,
        onSummary: (s) {
          // Update placeholder bubble with latest streamed text
          if (!mounted) return;
          setState(() {
            if (assistantStreamingIndex != null &&
                assistantStreamingIndex! >= 0 &&
                assistantStreamingIndex! < assistantTranscript.length) {
              assistantTranscript[assistantStreamingIndex!] = {'role': 'assistant', 'text': s};
            }
          });
        },
        onClarify: (q, options) {
          if (!mounted) return;
          setState(() {
            // Replace placeholder with clarify question if emitted
            if (assistantStreamingIndex != null &&
                assistantStreamingIndex! >= 0 &&
                assistantStreamingIndex! < assistantTranscript.length) {
              assistantTranscript[assistantStreamingIndex!] = {'role': 'assistant', 'text': q};
            } else {
              assistantTranscript.add({'role': 'assistant', 'text': q});
            }
            _pendingClarifyQuestion = q;
            _pendingClarifyOptions = options;
            _clarifySelectedIds.clear();
            _clarifySelectedDate = null;
            _clarifySelectedPriority = null;
          });
        },
        priorClarify: (_pendingClarifyQuestion == null)
            ? null
            : {
                'question': _pendingClarifyQuestion,
                if (_clarifySelectedIds.isNotEmpty || _clarifySelectedDate != null || _clarifySelectedPriority != null)
                  'selection': {
                    if (_clarifySelectedIds.isNotEmpty) 'ids': _clarifySelectedIds.toList(),
                    if (_clarifySelectedDate != null) 'date': _clarifySelectedDate,
                    if (_clarifySelectedPriority != null) 'priority': _clarifySelectedPriority,
                  }
              },
        onStage: (st) {
          if (!mounted) return;
          setState(() { _progressStage = st; });
        },
        onOps: (ops, version, validCount, invalidCount) {
          if (!mounted) return;
          setState(() {
            // Replace operations immediately; preserve checked state for matching ops by (op,id)
            final prior = assistantOps;
            final priorChecked = assistantOpsChecked;
            assistantOps = ops.map((e) => AnnotatedOp.fromJson(e)).toList();
            // Build a quick map by key
            String kOp(dynamic x) {
              try {
                final m = (x is AnnotatedOp) ? x.op : LlmOperation.fromJson(Map<String, dynamic>.from((x as Map<String, dynamic>)['op'] as Map));
                final id = m.id == null ? '' : '#${m.id}';
                return '${m.op}$id';
              } catch (_) { return ''; }
            }
            final prevMap = <String, bool>{};
            for (var i = 0; i < prior.length; i++) { prevMap[kOp(prior[i])] = (i < priorChecked.length ? priorChecked[i] : true); }
            assistantOpsChecked = List<bool>.generate(assistantOps.length, (i) {
              final key = kOp(assistantOps[i]);
              final preserved = prevMap[key] ?? assistantOps[i].errors.isEmpty;
              return preserved && assistantOps[i].errors.isEmpty;
            });
          });
        },
      );
      final reply = (res['text'] as String?) ?? '';
      final opsRaw = res['operations'] as List<dynamic>?;
      final ops = opsRaw == null
          ? <AnnotatedOp>[]
          : opsRaw.map((e) => AnnotatedOp.fromJson(e as Map<String, dynamic>)).toList();
      setState(() {
        if (reply.trim().isNotEmpty) {
          if (assistantStreamingIndex != null &&
              assistantStreamingIndex! >= 0 &&
              assistantStreamingIndex! < assistantTranscript.length) {
            assistantTranscript[assistantStreamingIndex!] = {'role': 'assistant', 'text': reply};
          } else {
            assistantTranscript.add({'role': 'assistant', 'text': reply});
          }
        }
        assistantStreamingIndex = null;
        // Preserve any user selections made during streaming by reconciling with the final ops
        final prior = assistantOps;
        final priorChecked = assistantOpsChecked;
        assistantOps = ops;
        String kOp(dynamic x) {
          try {
            final m = (x is AnnotatedOp) ? x.op : AnnotatedOp.fromJson(Map<String, dynamic>.from(x as Map<String, dynamic>)).op;
            final id = m.id == null ? '' : '#${m.id}';
            return '${m.op}$id';
          } catch (_) { return ''; }
        }
        final prevMap = <String, bool>{};
        for (var i = 0; i < prior.length; i++) {
          prevMap[kOp(prior[i])] = (i < priorChecked.length ? priorChecked[i] : true);
        }
        assistantOpsChecked = List<bool>.generate(assistantOps.length, (i) {
          final key = kOp(assistantOps[i]);
          final preserved = prevMap[key] ?? assistantOps[i].errors.isEmpty;
          return preserved && assistantOps[i].errors.isEmpty;
        });
        assistantShowDiff = false;
        _pendingClarifyQuestion = null;
        _pendingClarifyOptions = const [];
        _clarifySelectedIds.clear();
        _clarifySelectedDate = null;
        _clarifySelectedPriority = null;
        _progressStage = '';
      });
    } catch (e) {
      setState(() {
        final errText = 'Sorry, I could not process that. (${e.toString()})';
        if (assistantStreamingIndex != null &&
            assistantStreamingIndex! >= 0 &&
            assistantStreamingIndex! < assistantTranscript.length) {
          assistantTranscript[assistantStreamingIndex!] = {'role': 'assistant', 'text': errText};
        } else {
          assistantTranscript.add({'role': 'assistant', 'text': errText});
        }
        assistantStreamingIndex = null;
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
      // Dry-run before apply to surface warnings
      try {
        final preview = await api.dryRunOperations(selectedOps);
        final warnings = (preview['warnings'] as List<dynamic>?)?.map((e) => e.toString()).toList() ?? const <String>[];
        if (warnings.isNotEmpty) {
          final ok = await showDialog<bool>(
            context: context,
            builder: (c) => AlertDialog(
              title: const Text('Review changes'),
              content: SizedBox(
                width: 440,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('Warnings:'),
                    const SizedBox(height: 6),
                    ...warnings.map((w) => Padding(padding: const EdgeInsets.only(bottom: 4), child: Text('• $w'))),
                  ],
                ),
              ),
              actions: [
                TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
                FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Apply anyway')),
              ],
            ),
          );
          if (ok != true) return;
        }
      } catch (_) {
        // Ignore dry-run failures; continue to apply
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
    // Sort within each date by timeOfDay ascending, nulls first
    for (final e in sorted.entries) {
      e.value.sort((a, b) {
        final at = a.timeOfDay ?? '';
        final bt = b.timeOfDay ?? '';
        if (at.isEmpty && bt.isEmpty) return 0;
        if (at.isEmpty) return -1;
        if (bt.isEmpty) return 1;
        return at.compareTo(bt);
      });
    }
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
                                onKeyEvent: (node, event) {
                                  if (!_searchFocus.hasFocus) return KeyEventResult.ignored;
                                  if (event is! KeyDownEvent) return KeyEventResult.ignored;
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
                                    if (list.isEmpty) {
                                      return KeyEventResult.handled;
                                    }
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
                                    fillColor: Colors.white.withValues(alpha: 0.9),
                                    border: OutlineInputBorder(
                                      borderRadius: BorderRadius.circular(24),
                                      borderSide: BorderSide(color: Theme.of(context).colorScheme.outline.withValues(alpha: 0.4)),
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
                          if (k == 'goals') {
                            setState(() { mainView = MainView.goals; });
                            return;
                          }
                          final sl = _smartListFromKey(k);
                          if (sl == SmartList.today) {
                            setState(() {
                              selected = sl; mainView = MainView.tasks;
                              view = View.day;
                              anchor = ymd(DateTime.now());
                            });
                            await _refreshAll();
                          } else if (sl == SmartList.scheduled) {
                            setState(() {
                              selected = sl; mainView = MainView.tasks;
                              view = View.week;
                            });
                            await _refreshAll();
                          } else {
                            setState(() {
                              selected = sl; mainView = MainView.tasks;
                            });
                          }
                        },
                        showCompleted: showCompleted,
                        onToggleShowCompleted: (v) {
                          setState(() => showCompleted = v);
                          _refreshAll();
                        },
                        counters: sidebarCounts,
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
                                        (mainView == MainView.tasks) ? _buildMainList() : _buildGoalsView(),
                                        Positioned(
                                          right: 16,
                                          bottom: 16,
                                          child: fab.FabActions(
                                            onCreateTodo: _openFabSheet,
                                            onCreateEvent: _openEventSheet,
                                            onCreateHabit: _openHabitSheet,
                                          ),
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
                                    model: _assistantModel,
                                    showDiff: assistantShowDiff,
                                    onToggleDiff: () => setState(() => assistantShowDiff = !assistantShowDiff),
                                    onToggleOperation: (i, v) => setState(() => assistantOpsChecked[i] = v),
                                    onApplySelected: _applyAssistantOps,
                                    onDiscard: () => setState(() { assistantOps = []; assistantOpsChecked = []; assistantShowDiff = false; }),
                                    inputController: assistantCtrl,
                                    onSend: _sendAssistantMessage,
                                    opLabel: (op) => _opLabel((op as AnnotatedOp).op),
                                    onClearChat: () => setState(() {
                                      assistantTranscript.clear();
                                      assistantOps = [];
                                      assistantOpsChecked = [];
                                      assistantShowDiff = false;
                                    }),
                                    clarifyQuestion: _pendingClarifyQuestion,
                                    clarifyOptions: _pendingClarifyOptions,
                                    onToggleClarifyId: (id) => setState(() {
                                      if (_clarifySelectedIds.contains(id)) _clarifySelectedIds.remove(id);
                                      else _clarifySelectedIds.add(id);
                                    }),
                                     onSelectClarifyDate: (d) => setState(() { _clarifySelectedDate = d; }),
                                     onSelectClarifyPriority: (p) => setState(() { _clarifySelectedPriority = p; }),
                                     progressStage: _progressStage,
                                     todayYmd: ymd(DateTime.now()),
                                      selectedClarifyIds: _clarifySelectedIds,
                                      selectedClarifyDate: _clarifySelectedDate,
                                      selectedClarifyPriority: _clarifySelectedPriority,
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
    if (view == View.month) {
      return Column(
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
            child: Row(
              children: [
                Expanded(
                  child: Wrap(spacing: 8, runSpacing: 6, children: [
                    _filterChip('All', _kindFilter.length == 3, () { setState(() { _kindFilter = <String>{'todo','event','habit'}; }); _refreshAll(); }),
                    _filterChip('Todos', _kindFilter.contains('todo') && _kindFilter.length == 1, () { setState(() { _kindFilter = <String>{'todo'}; }); _refreshAll(); }),
                    _filterChip('Events', _kindFilter.contains('event') && _kindFilter.length == 1, () { setState(() { _kindFilter = <String>{'event'}; }); _refreshAll(); }),
                    _filterChip('Habits', _kindFilter.contains('habit') && _kindFilter.length == 1, () { setState(() { _kindFilter = <String>{'habit'}; }); _refreshAll(); }),
                  ]),
                ),
                IconButton(icon: const Icon(Icons.chevron_left), tooltip: 'Previous', onPressed: _goPrev),
                TextButton(onPressed: _goToToday, child: const Text('Today')),
                IconButton(icon: const Icon(Icons.chevron_right), tooltip: 'Next', onPressed: _goNext),
              ],
            ),
          ),
          Expanded(child: _buildMonthGrid(grouped)),
        ],
      );
    }
    return ListView(
      padding: const EdgeInsets.all(12),
      children: [
        if (view == View.day || view == View.week || view == View.month)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
            child: Row(
              children: [
                Expanded(
                  child: Wrap(spacing: 8, runSpacing: 6, children: [
                    _filterChip('All', _kindFilter.length == 3, () { setState(() { _kindFilter = <String>{'todo','event','habit'}; }); _refreshAll(); }),
                    _filterChip('Todos', _kindFilter.contains('todo') && _kindFilter.length == 1, () { setState(() { _kindFilter = <String>{'todo'}; }); _refreshAll(); }),
                    _filterChip('Events', _kindFilter.contains('event') && _kindFilter.length == 1, () { setState(() { _kindFilter = <String>{'event'}; }); _refreshAll(); }),
                    _filterChip('Habits', _kindFilter.contains('habit') && _kindFilter.length == 1, () { setState(() { _kindFilter = <String>{'habit'}; }); _refreshAll(); }),
                  ]),
                ),
                IconButton(icon: const Icon(Icons.chevron_left), tooltip: 'Previous', onPressed: _goPrev),
                TextButton(onPressed: _goToToday, child: const Text('Today')),
                IconButton(icon: const Icon(Icons.chevron_right), tooltip: 'Next', onPressed: _goNext),
              ],
            ),
          ),
        if (view == View.week) _buildWeekdayHeader(),
        for (final entry in grouped.entries) ...[
          Builder(builder: (context) {
            final isTodayHeader = entry.key == ymd(DateTime.now());
            final label = isTodayHeader ? '${entry.key}  (Today)' : entry.key;
            return Container(
              margin: const EdgeInsets.only(top: 8, bottom: 2),
              padding: const EdgeInsets.symmetric(vertical: 6, horizontal: 8),
              decoration: BoxDecoration(
                color: isTodayHeader ? Theme.of(context).colorScheme.primary.withValues(alpha: 0.06) : null,
                border: Border(
                  left: BorderSide(color: isTodayHeader ? Theme.of(context).colorScheme.primary : Colors.transparent, width: 3),
                ),
              ),
              child: Text(
                label,
                style: TextStyle(fontWeight: FontWeight.w600, color: isTodayHeader ? Theme.of(context).colorScheme.primary : null),
              ),
            );
          }),
          ...entry.value.map(_buildRow),
        ]
      ],
    );
  }

  Widget _buildWeekdayHeader() {
    try {
      final a = parseYmd(anchor);
      // compute Monday of this week
      final monday = a.subtract(Duration(days: (a.weekday + 6) % 7));
      final days = List<DateTime>.generate(7, (i) => monday.add(Duration(days: i)));
      final labels = const ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
      final today = ymd(DateTime.now());
      return Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
        child: Row(
          children: List.generate(7, (i) {
            final d = days[i];
            final isToday = ymd(d) == today;
            return Expanded(
              child: Column(
                children: [
                  Text(labels[i], style: const TextStyle(fontWeight: FontWeight.w600)),
                  const SizedBox(height: 2),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                    decoration: isToday
                        ? BoxDecoration(
                            color: Theme.of(context).colorScheme.primary.withValues(alpha: 0.08),
                            borderRadius: BorderRadius.circular(999),
                            border: Border.all(color: Theme.of(context).colorScheme.primary),
                          )
                        : null,
                    child: Text('${d.day}', style: TextStyle(color: isToday ? Theme.of(context).colorScheme.primary : Colors.black87)),
                  ),
                ],
              ),
            );
          }),
        ),
      );
    } catch (_) {
      return const SizedBox.shrink();
    }
  }

  Widget _buildMonthGrid(Map<String, List<Todo>> groupedByDate) {
    final a = parseYmd(anchor);
    final firstOfMonth = DateTime(a.year, a.month, 1);
    final lastOfMonth = DateTime(a.year, a.month + 1, 0);
    // Compute Monday on/before first, Sunday on/after last
    DateTime start = firstOfMonth;
    while (start.weekday != DateTime.monday) {
      start = start.subtract(const Duration(days: 1));
    }
    DateTime end = lastOfMonth;
    while (end.weekday != DateTime.sunday) {
      end = end.add(const Duration(days: 1));
    }
    final days = <DateTime>[];
    for (DateTime d = start; d.isBefore(end.add(const Duration(days: 1))); d = d.add(const Duration(days: 1))) {
      days.add(d);
    }
    final weeks = <List<DateTime>>[];
    for (int i = 0; i < days.length; i += 7) {
      weeks.add(days.sublist(i, i + 7));
    }
    final weekdayLabels = const ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
    return Column(
      children: [
        // Weekday header (sticky)
        Material(
          elevation: 1,
          color: Theme.of(context).scaffoldBackgroundColor,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            child: Row(
              children: [
                for (final w in weekdayLabels)
                  Expanded(child: Text(w, style: const TextStyle(fontWeight: FontWeight.w600), textAlign: TextAlign.center)),
              ],
            ),
          ),
        ),
        const Divider(height: 1),
        Expanded(
          child: ListView.builder(
            padding: const EdgeInsets.all(0),
            itemCount: weeks.length,
            itemBuilder: (context, wi) {
              final week = weeks[wi];
              return Row(
                children: [
                  for (final d in week)
                    Expanded(child: _monthCell(d, groupedByDate, d.month == a.month)),
                ],
              );
            },
          ),
        ),
      ],
    );
  }

  Widget _monthCell(DateTime d, Map<String, List<Todo>> groupedByDate, bool inMonth) {
    final ymdStr = ymd(d);
    final items = (groupedByDate[ymdStr] ?? const <Todo>[]);
    // sort by timeOfDay (nulls first)
    final sorted = items.toList()
      ..sort((a, b) {
        final at = a.timeOfDay ?? '';
        final bt = b.timeOfDay ?? '';
        if (at.isEmpty && bt.isEmpty) return 0;
        if (at.isEmpty) return -1;
        if (bt.isEmpty) return 1;
        return at.compareTo(bt);
      });
    final maxToShow = 3;
    final more = sorted.length > maxToShow ? (sorted.length - maxToShow) : 0;
    final isToday = ymdStr == ymd(DateTime.now());
    return Container(
      decoration: isToday
          ? BoxDecoration(
              border: Border.all(color: Theme.of(context).colorScheme.primary, width: 2),
              borderRadius: BorderRadius.circular(4),
            )
          : const BoxDecoration(),
      child: InkWell(
        onTap: () => _goToDate(ymdStr),
        child: Container(
          height: _monthCellHeight(),
          decoration: BoxDecoration(
            border: Border(
              right: BorderSide(color: Colors.grey.shade300),
              bottom: BorderSide(color: Colors.grey.shade300),
            ),
            color: inMonth ? null : Colors.grey.shade50,
          ),
          padding: const EdgeInsets.all(6),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Text('${d.day}', style: TextStyle(fontWeight: FontWeight.w600, color: inMonth ? Colors.black : Colors.black54)),
                ],
              ),
              const SizedBox(height: 4),
              for (int i = 0; i < sorted.length && i < maxToShow; i++) _monthItemChip(sorted[i]),
              if (more > 0)
                Padding(
                  padding: const EdgeInsets.only(top: 2),
                  child: GestureDetector(
                    onTap: () => _goToDate(ymdStr),
                    child: const Text('+more', style: TextStyle(fontSize: 11, color: Colors.black54)),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _monthItemChip(Todo t) {
    final time = t.timeOfDay;
    final label = (time == null || time.isEmpty) ? t.title : '$time ${t.title}';
    final bg = t.kind == 'event' ? const Color(0xFFEEF2FF) : (t.kind == 'habit' ? const Color(0xFFEFF7E6) : const Color(0xFFFFF4E5));
    final fg = Colors.black87;
    return Container(
      margin: const EdgeInsets.only(bottom: 2),
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(6), border: Border.all(color: Colors.black12)),
      child: Text(label, style: TextStyle(fontSize: 11, color: fg), overflow: TextOverflow.ellipsis),
    );
  }

  double _monthCellHeight() {
    // Try to fit ~5 weeks visible without scroll overflow; compute from viewport height
    try {
      final h = MediaQuery.of(context).size.height;
      // subtract rough header + app bars (~200px), divide remaining by 6 rows max
      final usable = (h - 200).clamp(240, 1200);
      final perRow = usable / 6.0;
      // clamp to a reasonable min/max
      return perRow.clamp(100, 180);
    } catch (_) {
      return 120;
    }
  }

  void _goToDate(String y) async {
    setState(() {
      view = View.day;
      anchor = y;
      _pendingScrollYmd = y;
    });
    await _refreshAll();
  }

  void _goToToday() async {
    setState(() {
      anchor = ymd(DateTime.now());
    });
    await _refreshAll();
  }

  void _maybeScrollToPendingDate() {
    if (_pendingScrollYmd == null) return;
    if (view != View.day) { _pendingScrollYmd = null; return; }
    // Find first item in scheduled matching the target date
    final target = _pendingScrollYmd;
    final idx = scheduled.indexWhere((t) => t.scheduledFor == target);
    if (idx == -1) { _pendingScrollYmd = null; return; }
    final t = scheduled[idx];
    // Compute row key id the same way as in _buildRow
    final keyId = (t.masterId != null && t.scheduledFor != null)
        ? Object.hashAll([t.masterId, t.scheduledFor])
        : t.id;
    final key = _rowKeys[keyId];
    if (key == null) { _pendingScrollYmd = null; return; }
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      try {
        if (key.currentContext != null) {
          await Scrollable.ensureVisible(key.currentContext!, duration: const Duration(milliseconds: 300));
        }
      } catch (_) {}
      _pendingScrollYmd = null;
    });
  }

  void _goPrev() async {
    final a = parseYmd(anchor);
    DateTime next;
    if (view == View.day) next = a.subtract(const Duration(days: 1));
    else if (view == View.week) next = a.subtract(const Duration(days: 7));
    else next = DateTime(a.year, a.month - 1, a.day);
    setState(() { anchor = ymd(next); });
    await _refreshAll();
  }

  void _goNext() async {
    final a = parseYmd(anchor);
    DateTime next;
    if (view == View.day) next = a.add(const Duration(days: 1));
    else if (view == View.week) next = a.add(const Duration(days: 7));
    else next = DateTime(a.year, a.month + 1, a.day);
    setState(() { anchor = ymd(next); });
    await _refreshAll();
  }

  // --- Goals minimal UI ---
  Widget _buildGoalsView() {
    return FutureBuilder<List<dynamic>>(
      future: api.listGoals(),
      builder: (context, snap) {
        if (snap.connectionState != ConnectionState.done) {
          return const Center(child: CircularProgressIndicator());
        }
        if (snap.hasError) {
          return Center(child: Text('Load failed: ${snap.error}'));
        }
        final raw = snap.data ?? const <dynamic>[];
        final goals = raw.map((e) => Map<String, dynamic>.from(e as Map)).toList();
        goals.sort((a, b) => (a['status'] as String).compareTo(b['status'] as String));
        final grouped = <String, List<Map<String, dynamic>>>{};
        for (final g in goals) {
          final s = (g['status'] as String?) ?? 'active';
          grouped.putIfAbsent(s, () => <Map<String, dynamic>>[]).add(g);
        }
        return ListView(
          padding: const EdgeInsets.all(12),
          children: [
            Row(
              children: [
                const Expanded(child: Text('Goals', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 16))),
                FilledButton(onPressed: _openCreateGoalDialog, child: const Text('New Goal')),
              ],
            ),
            const SizedBox(height: 8),
            for (final entry in grouped.entries) ...[
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 6),
                child: Text(entry.key, style: const TextStyle(fontWeight: FontWeight.w600)),
              ),
              ...entry.value.map((g) => _goalRow(g)),
            ]
          ],
        );
      },
    );
  }

  Widget _goalRow(Map<String, dynamic> g) {
    return Card(
      child: ListTile(
        title: Text(g['title'] as String? ?? ''),
        subtitle: (g['notes'] as String?)?.isNotEmpty == true ? Text(g['notes'] as String) : null,
        trailing: IconButton(icon: const Icon(Icons.chevron_right), onPressed: () => _openGoalDetail(g['id'] as int)),
      ),
    );
  }

  Future<void> _openGoalDetail(int id) async {
    try {
      final goal = await api.getGoal(id, includeItems: true, includeChildren: true);
      if (!mounted || goal == null) return;
      final addTodoCtrl = TextEditingController();
      final addEventCtrl = TextEditingController();
      final addChildCtrl = TextEditingController();
      await showDialog<void>(
        context: context,
        builder: (c) => AlertDialog(
          title: Text(goal['title'] as String? ?? ''),
          content: SizedBox(
            width: 520,
            child: SingleChildScrollView(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if ((goal['notes'] as String?)?.isNotEmpty == true) Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(goal['notes'] as String)),
                  Text('Status: ${(goal['status'] as String?) ?? 'active'}'),
                  const SizedBox(height: 12),
                  const Text('Items'),
                  const SizedBox(height: 6),
                  ...(goal['items'] != null && goal['items']['todos'] is List
                      ? (goal['items']['todos'] as List)
                          .map<Map<String, dynamic>>((e) => Map<String, dynamic>.from(e as Map))
                          .map((t) => Row(
                                children: [
                                  const Icon(Icons.check_circle_outline, size: 14),
                                  const SizedBox(width: 6),
                                  Expanded(child: Text(t['title'] as String? ?? '')),
                                  IconButton(
                                    icon: const Icon(Icons.link_off, size: 16),
                                    onPressed: () async {
                                      await api.removeGoalTodoItem(id, t['id'] as int);
                                      Navigator.pop(c);
                                      _openGoalDetail(id);
                                    },
                                  )
                                ],
                              ))
                          .toList()
                      : const <Widget>[]),
                  ...(goal['items'] != null && goal['items']['events'] is List
                      ? (goal['items']['events'] as List)
                          .map<Map<String, dynamic>>((e) => Map<String, dynamic>.from(e as Map))
                          .map((ev) => Row(
                                children: [
                                  const Icon(Icons.event, size: 14),
                                  const SizedBox(width: 6),
                                  Expanded(child: Text(ev['title'] as String? ?? '')),
                                  IconButton(
                                    icon: const Icon(Icons.link_off, size: 16),
                                    onPressed: () async {
                                      await api.removeGoalEventItem(id, ev['id'] as int);
                                      Navigator.pop(c);
                                      _openGoalDetail(id);
                                    },
                                  )
                                ],
                              ))
                          .toList()
                      : const <Widget>[]),
                  const SizedBox(height: 12),
                  const Text('Children'),
                  const SizedBox(height: 6),
                  ...(goal['children'] is List
                      ? (goal['children'] as List)
                          .map<int>((e) => (e as int))
                          .map((cid) => Row(
                                children: [
                                  const Icon(Icons.flag, size: 14),
                                  const SizedBox(width: 6),
                                  Expanded(child: Text('Goal #$cid')),
                                  IconButton(
                                    icon: const Icon(Icons.link_off, size: 16),
                                    onPressed: () async {
                                      await api.removeGoalChild(id, cid);
                                      Navigator.pop(c);
                                      _openGoalDetail(id);
                                    },
                                  )
                                ],
                              ))
                          .toList()
                      : const <Widget>[]),
                  const SizedBox(height: 12),
                  const Divider(height: 1),
                  const SizedBox(height: 8),
                  const Text('Link items (IDs, comma-separated)'),
                  const SizedBox(height: 6),
                  Row(children: [
                    Expanded(child: TextField(controller: addTodoCtrl, decoration: const InputDecoration(labelText: 'Todo IDs'))),
                    const SizedBox(width: 8),
                    Expanded(child: TextField(controller: addEventCtrl, decoration: const InputDecoration(labelText: 'Event IDs'))),
                    const SizedBox(width: 8),
                    FilledButton(
                      onPressed: () async {
                        try {
                          final todos = addTodoCtrl.text.split(',').map((s) => int.tryParse(s.trim())).whereType<int>().toList();
                          final events = addEventCtrl.text.split(',').map((s) => int.tryParse(s.trim())).whereType<int>().toList();
                          await api.addGoalItems(id, todos: todos.isEmpty ? null : todos, events: events.isEmpty ? null : events);
                          Navigator.pop(c);
                          _openGoalDetail(id);
                        } catch (e) {
                          if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Link failed: $e')));
                        }
                      },
                      child: const Text('Add'),
                    ),
                  ]),
                  const SizedBox(height: 12),
                  const Text('Add child (Goal ID)'),
                  const SizedBox(height: 6),
                  Row(children: [
                    Expanded(child: TextField(controller: addChildCtrl, decoration: const InputDecoration(labelText: 'Child goal ID'))),
                    const SizedBox(width: 8),
                    FilledButton(
                      onPressed: () async {
                        final cid = int.tryParse(addChildCtrl.text.trim());
                        if (cid == null) return;
                        try {
                          await api.addGoalChild(id, cid);
                          Navigator.pop(c);
                          _openGoalDetail(id);
                        } catch (e) {
                          if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Add child failed: $e')));
                        }
                      },
                      child: const Text('Add Child'),
                    ),
                  ]),
                ],
              ),
            ),
          ),
          actions: [
            TextButton(onPressed: () async { Navigator.pop(c); await _openEditGoalDialog(goal); }, child: const Text('Edit')),
            TextButton(
              onPressed: () async {
                try { await api.deleteGoal(id); Navigator.pop(c); setState(() {}); } catch (e) { if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Delete failed: $e'))); }
              },
              child: const Text('Delete'),
            ),
            TextButton(onPressed: () => Navigator.pop(c), child: const Text('Close')),
          ],
        ),
      );
    } catch (e) {
      setState(() => message = 'Load goal failed: $e');
    }
  }

  Future<void> _openCreateGoalDialog() async {
    final titleCtrl = TextEditingController();
    final notesCtrl = TextEditingController();
    String status = 'active';
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => StatefulBuilder(builder: (c, setDlgState) {
        return AlertDialog(
          title: const Text('Create goal'),
          content: SizedBox(
            width: 420,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextField(controller: titleCtrl, decoration: const InputDecoration(labelText: 'Title')),
                TextField(controller: notesCtrl, decoration: const InputDecoration(labelText: 'Notes')),
                DropdownButtonFormField<String>(
                  value: status,
                  decoration: const InputDecoration(labelText: 'Status'),
                  items: const [
                    DropdownMenuItem(value: 'active', child: Text('Active')),
                    DropdownMenuItem(value: 'completed', child: Text('Completed')),
                    DropdownMenuItem(value: 'archived', child: Text('Archived')),
                  ],
                  onChanged: (v) => setDlgState(() => status = v ?? 'active'),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
            FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Create')),
          ],
        );
      }),
    );
    if (ok != true) return;
    try {
      await api.createGoal({ 'title': titleCtrl.text.trim(), 'notes': notesCtrl.text, 'status': status });
      setState(() {});
    } catch (e) {
      setState(() => message = 'Create goal failed: $e');
    }
  }

  Future<void> _openEditGoalDialog(Map<String, dynamic> goal) async {
    final titleCtrl = TextEditingController(text: goal['title'] as String? ?? '');
    final notesCtrl = TextEditingController(text: goal['notes'] as String? ?? '');
    String status = (goal['status'] as String?) ?? 'active';
    final id = goal['id'] as int;
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => StatefulBuilder(builder: (c, setDlgState) {
        return AlertDialog(
          title: const Text('Edit goal'),
          content: SizedBox(
            width: 420,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextField(controller: titleCtrl, decoration: const InputDecoration(labelText: 'Title')),
                TextField(controller: notesCtrl, decoration: const InputDecoration(labelText: 'Notes')),
                DropdownButtonFormField<String>(
                  value: status,
                  decoration: const InputDecoration(labelText: 'Status'),
                  items: const [
                    DropdownMenuItem(value: 'active', child: Text('Active')),
                    DropdownMenuItem(value: 'completed', child: Text('Completed')),
                    DropdownMenuItem(value: 'archived', child: Text('Archived')),
                  ],
                  onChanged: (v) => setDlgState(() => status = v ?? 'active'),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
            FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Save')),
          ],
        );
      }),
    );
    if (ok != true) return;
    try {
      await api.updateGoal(id, { 'title': titleCtrl.text.trim(), 'notes': notesCtrl.text, 'status': status });
      setState(() {});
    } catch (e) {
      setState(() => message = 'Update goal failed: $e');
    }
  }

  Widget _filterChip(String label, bool selected, VoidCallback onTap) {
    return InkWell(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(
          color: selected ? Theme.of(context).colorScheme.primary.withValues(alpha: 0.1) : Colors.grey.shade100,
          borderRadius: BorderRadius.circular(999),
          border: Border.all(color: selected ? Theme.of(context).colorScheme.primary : Colors.grey.shade300),
        ),
        child: Text(label, style: TextStyle(color: selected ? Theme.of(context).colorScheme.primary : Colors.black87, fontSize: 12)),
      ),
    );
  }

  

  Widget _buildRow(Todo t) {
    // Determine overdue: only in Today context, timed tasks, not completed, and time < now
    bool isOverdue = false;
    try {
      if (!t.completed && t.scheduledFor != null && t.timeOfDay != null) {
        final today = ymd(DateTime.now());
        if (selected == SmartList.today && t.scheduledFor == today) {
          final parts = (t.timeOfDay ?? '').split(':');
          if (parts.length == 2) {
            final now = DateTime.now();
            final hh = int.tryParse(parts[0]) ?? 0;
            final mm = int.tryParse(parts[1]) ?? 0;
            final when = DateTime(now.year, now.month, now.day, hh, mm);
            isOverdue = now.isAfter(when);
          }
        }
      }
    } catch (_) {}
    final like = row.TodoLike(
      id: t.id,
      title: t.title,
      notes: t.notes,
      kind: t.kind,
      timeOfDay: t.timeOfDay,
      priority: t.priority,
      completed: t.completed,
      overdue: isOverdue,
    );
    final keyId = t.masterId != null && t.scheduledFor != null ? Object.hashAll([t.masterId, t.scheduledFor]) : t.id;
    final key = _rowKeys.putIfAbsent(keyId, () => GlobalKey());
    return KeyedSubtree(
      key: key,
      child: row.TodoRow(
        todo: like,
        onToggleCompleted: () => _toggleCompleted(t),
        onEdit: () => (t.kind == 'event') ? _editEvent(t) : (t.kind == 'habit') ? _editHabit(t) : _editTodo(t),
        onDelete: () => _deleteTodo(t),
        highlighted: _highlightedId == t.id,
      ),
    );
  }
}
