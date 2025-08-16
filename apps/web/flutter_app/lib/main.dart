import 'package:flutter/material.dart';
import 'dart:async';
import 'widgets/assistant_panel.dart';
import 'widgets/sidebar.dart' as sb;
import 'widgets/todo_row.dart' as row;
import 'widgets/habits_tracker.dart' as ht;
import 'widgets/tabs_header.dart' as th;
import 'api.dart' as api;
import 'package:dio/dio.dart';
import 'package:flutter/services.dart';
import 'dart:math' as math;
import 'dart:ui' as ui;
import 'util/storage.dart' as storage;

// --- Test hooks and injectable API (local single-user context) ---
class TestHooks {
  static bool skipRefresh = false;
}

var createTodoFn = api.createTodo;
var createEventFn = api.createEvent;
var createHabitFn = api.createHabit;
var createGoalFn = api.createGoal;
void main() {
  runApp(const App());
}

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
  return DateTime(
    int.parse(parts[0]),
    int.parse(parts[1]),
    int.parse(parts[2]),
  );
}

class DateRange {
  final String from;
  final String to;
  const DateRange({required this.from, required this.to});
}

enum View { day, week, month }

enum SmartList { today, scheduled, all, backlog }

enum MainView { tasks, habits, goals }

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
        visualDensity: VisualDensity.compact,
        listTileTheme: const ListTileThemeData(
          dense: true,
          visualDensity: VisualDensity.compact,
        ),
        filledButtonTheme: FilledButtonThemeData(
          style: FilledButton.styleFrom(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          ),
        ),
        outlinedButtonTheme: OutlinedButtonThemeData(
          style: OutlinedButton.styleFrom(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
          ),
        ),
        checkboxTheme: const CheckboxThemeData(
          visualDensity: VisualDensity.compact,
        ),
      ),
      home: const HomePage(),
    );
  }
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
  String? _priorityFilter; // null=all | 'low'|'medium'|'high'
  String? _goalsStatusFilter; // null=all | 'active'|'completed'|'archived'

  // Data
  List<Todo> scheduled = [];
  List<Todo> scheduledAllTime = [];
  List<Todo> backlog = [];
  List<Todo> searchResults = [];
  Map<String, int> sidebarCounts = {};
  // Habit stats for current range (by habit id)
  Map<int, Map<String, dynamic>> habitStatsById = {};
  // Goal badges mapping: key `${kind}:${masterOrId}` -> { goalId, title }
  Map<String, Map<String, dynamic>> _itemGoalByKey = {};
  // Habits narrow-view state
  int? _selectedHabitId;
  int _habitFocusCol = 0; // 0..6

  // Unified schedule filters (chips)
  Set<String> _kindFilter = <String>{
    'todo',
    'event',
    'habit',
  }; // All by default

  bool loading = false;
  String? message;
  // Assistant model label and collapse state
  String _assistantModel = '';
  bool assistantCollapsed = true;

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

  // Quick-add controllers
  final TextEditingController _qaTodoTitle = TextEditingController();
  final TextEditingController _qaTodoTime = TextEditingController();
  String _qaTodoPriority = 'medium';
  final TextEditingController _qaEventTitle = TextEditingController();
  final TextEditingController _qaEventStart = TextEditingController();
  final TextEditingController _qaEventEnd = TextEditingController();
  final TextEditingController _qaEventLocation = TextEditingController();
  String _qaEventPriority = 'medium';
  final TextEditingController _qaHabitTitle = TextEditingController();
  final TextEditingController _qaHabitTime = TextEditingController();
  String _qaHabitPriority = 'medium';
  // Goals inline quick-add controllers
  final TextEditingController _qaGoalTitle = TextEditingController();
  final TextEditingController _qaGoalNotes = TextEditingController();
  final TextEditingController _qaGoalCurrent = TextEditingController();
  final TextEditingController _qaGoalTarget = TextEditingController();
  final TextEditingController _qaGoalUnit = TextEditingController();
  String _qaGoalStatus = 'active';
  bool _addingQuick = false;
  bool _enterSubmitting = false; // transient flag for immediate Enter disable
  bool _mustPaintDisabledOnce = false; // ensure disabled for at least one frame

  @override
  void initState() {
    super.initState();
    // Restore persisted main tab if available
    try {
      final saved = storage.getItem('mainTab') ?? '';
      if (saved == 'events') {
        mainView = MainView.tasks;
        _kindFilter = <String>{'event'};
      } else if (saved == 'todos') {
        mainView = MainView.tasks;
        _kindFilter = <String>{'todo'};
      } else if (saved == 'habits') {
        mainView = MainView.habits;
        _kindFilter = <String>{'habit'};
      } else if (saved == 'goals') {
        mainView = MainView.goals;
      }
    } catch (_) {}
    if (!TestHooks.skipRefresh) {
      _refreshAll();
      _loadAssistantModel();
    } else {
      setState(() => loading = false);
    }
  }

  Widget _quickAddInline() {
    // Decide which inline form to show based on current tab
    final isGoals = (mainView == MainView.goals);
    final isHabits = (mainView == MainView.habits);
    final isEvents =
        (!isHabits &&
        !isGoals &&
        _kindFilter.length == 1 &&
        _kindFilter.contains('event'));
    // Default to todos when in tasks view and not events
    final isTodos = (!isHabits && !isGoals && !isEvents);

    if (isTodos) {
      return Row(
        children: [
          SizedBox(
            width: 260,
            child: Focus(
              onKeyEvent: (node, event) {
                if (event is KeyDownEvent &&
                    event.logicalKey == LogicalKeyboardKey.enter) {
                  setState(() {
                    _enterSubmitting = true;
                  });
                  WidgetsBinding.instance.addPostFrameCallback((_) {
                    if (!mounted) return;
                    _submitQuickAddTodo().whenComplete(() {
                      if (mounted)
                        setState(() {
                          _enterSubmitting = false;
                        });
                    });
                  });
                  return KeyEventResult.handled;
                }
                return KeyEventResult.ignored;
              },
              child: TextField(
                key: const Key('qa_todo_title'),
                controller: _qaTodoTitle,
                decoration: const InputDecoration(labelText: 'Title *'),
                textInputAction: TextInputAction.done,
                onSubmitted: (_) => _submitQuickAddTodo(),
                onEditingComplete: _submitQuickAddTodo,
              ),
            ),
          ),
          const SizedBox(width: 8),
          SizedBox(
            width: 120,
            child: TextField(
              key: const Key('qa_todo_time'),
              controller: _qaTodoTime,
              decoration: const InputDecoration(labelText: 'Time'),
            ),
          ),
          const SizedBox(width: 8),
          DropdownButton<String>(
            value: _qaTodoPriority,
            items: const [
              DropdownMenuItem(value: 'low', child: Text('Low')),
              DropdownMenuItem(value: 'medium', child: Text('Medium')),
              DropdownMenuItem(value: 'high', child: Text('High')),
            ],
            onChanged: (v) => setState(() => _qaTodoPriority = v ?? 'medium'),
          ),
          const SizedBox(width: 8),
          FilledButton(
            onPressed:
                (_addingQuick || _enterSubmitting || _mustPaintDisabledOnce)
                ? null
                : _submitQuickAddTodo,
            child: const Text('Add'),
          ),
        ],
      );
    }
    if (isEvents) {
      return Row(
        children: [
          SizedBox(
            width: 240,
            child: TextField(
              key: const Key('qa_event_title'),
              controller: _qaEventTitle,
              decoration: const InputDecoration(labelText: 'Title'),
              textInputAction: TextInputAction.done,
              onSubmitted: (_) => _submitQuickAddEvent(),
              onEditingComplete: _submitQuickAddEvent,
            ),
          ),
          const SizedBox(width: 8),
          SizedBox(
            width: 110,
            child: TextField(
              key: const Key('qa_event_start'),
              controller: _qaEventStart,
              decoration: const InputDecoration(labelText: 'Start'),
            ),
          ),
          const SizedBox(width: 8),
          SizedBox(
            width: 110,
            child: TextField(
              key: const Key('qa_event_end'),
              controller: _qaEventEnd,
              decoration: const InputDecoration(labelText: 'End'),
            ),
          ),
          const SizedBox(width: 8),
          SizedBox(
            width: 160,
            child: TextField(
              key: const Key('qa_event_location'),
              controller: _qaEventLocation,
              decoration: const InputDecoration(labelText: 'Location'),
            ),
          ),
          const SizedBox(width: 8),
          DropdownButton<String>(
            value: _qaEventPriority,
            items: const [
              DropdownMenuItem(value: 'low', child: Text('Low')),
              DropdownMenuItem(value: 'medium', child: Text('Medium')),
              DropdownMenuItem(value: 'high', child: Text('High')),
            ],
            onChanged: (v) => setState(() => _qaEventPriority = v ?? 'medium'),
          ),
          const SizedBox(width: 8),
          FilledButton(
            onPressed: _addingQuick ? null : _submitQuickAddEvent,
            child: const Text('Add'),
          ),
        ],
      );
    }
    if (isHabits) {
      return Row(
        children: [
          SizedBox(
            width: 260,
            child: TextField(
              key: const Key('qa_habit_title'),
              controller: _qaHabitTitle,
              decoration: const InputDecoration(labelText: 'Title *'),
              textInputAction: TextInputAction.done,
              onSubmitted: (_) => _submitQuickAddHabit(),
              onEditingComplete: _submitQuickAddHabit,
            ),
          ),
          const SizedBox(width: 8),
          SizedBox(
            width: 120,
            child: TextField(
              key: const Key('qa_habit_time'),
              controller: _qaHabitTime,
              decoration: const InputDecoration(labelText: 'Time'),
            ),
          ),
          const SizedBox(width: 8),
          DropdownButton<String>(
            value: _qaHabitPriority,
            items: const [
              DropdownMenuItem(value: 'low', child: Text('Low')),
              DropdownMenuItem(value: 'medium', child: Text('Medium')),
              DropdownMenuItem(value: 'high', child: Text('High')),
            ],
            onChanged: (v) => setState(() => _qaHabitPriority = v ?? 'medium'),
          ),
          const SizedBox(width: 8),
          FilledButton(
            onPressed: _addingQuick ? null : _submitQuickAddHabit,
            child: const Text('Add'),
          ),
        ],
      );
    }
    // Default fallback: show Todos quick-add so there is always a visible form
    return Row(
      children: [
        SizedBox(
          width: 260,
          child: TextField(
            key: const Key('qa_todo_title'),
            controller: _qaTodoTitle,
            decoration: const InputDecoration(labelText: 'Title *'),
            textInputAction: TextInputAction.done,
            onSubmitted: (_) => _submitQuickAddTodo(),
            onEditingComplete: _submitQuickAddTodo,
          ),
        ),
        const SizedBox(width: 8),
        SizedBox(
          width: 120,
          child: TextField(
            key: const Key('qa_todo_time'),
            controller: _qaTodoTime,
            decoration: const InputDecoration(labelText: 'Time'),
          ),
        ),
        const SizedBox(width: 8),
        DropdownButton<String>(
          value: _qaTodoPriority,
          items: const [
            DropdownMenuItem(value: 'low', child: Text('Low')),
            DropdownMenuItem(value: 'medium', child: Text('Medium')),
            DropdownMenuItem(value: 'high', child: Text('High')),
          ],
          onChanged: (v) => setState(() => _qaTodoPriority = v ?? 'medium'),
        ),
        const SizedBox(width: 8),
        FilledButton(
          onPressed:
              (_addingQuick || _enterSubmitting || _mustPaintDisabledOnce)
              ? null
              : _submitQuickAddTodo,
          child: const Text('Add'),
        ),
      ],
    );
  }

  bool _isValidTime(String s) {
    if (s.trim().isEmpty) return true; // optional
    final parts = s.trim().split(':');
    if (parts.length != 2) return false;
    final h = int.tryParse(parts[0]);
    final m = int.tryParse(parts[1]);
    if (h == null || m == null) return false;
    if (h < 0 || h > 23) return false;
    if (m < 0 || m > 59) return false;
    return true;
  }

  Future<void> _submitQuickAddTodo() async {
    if (_addingQuick) return;
    final title = _qaTodoTitle.text.trim();
    final time = _qaTodoTime.text.trim();
    if (title.isEmpty) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('Please enter a title.')));
      return;
    }
    if (!_isValidTime(time)) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Use 24‑hour time, e.g. 09:00.')),
      );
      return;
    }
    setState(() => _addingQuick = true);
    // Request a frame so disabled state is paint-visible on next pump (no timers)
    WidgetsBinding.instance.scheduleFrame();
    // Guarantee one disabled paint
    setState(() {
      _mustPaintDisabledOnce = true;
    });
    try {
      // No extra timers; proceed to API
      final created = await createTodoFn({
        'title': title,
        'scheduledFor': anchor,
        'timeOfDay': time.isEmpty ? null : time,
        'priority': _qaTodoPriority,
        'recurrence': {'type': 'none'},
      });
      setState(() {
        _qaTodoTitle.clear();
        _qaTodoTime.clear();
        _qaTodoPriority = 'medium';
      });
      if (!TestHooks.skipRefresh) {
        try {
          scheduled.insert(0, Todo.fromJson(created));
        } catch (_) {}
      }
      if (!TestHooks.skipRefresh) await _refreshAll();
    } catch (e) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text('Create failed: $e')));
    } finally {
      if (mounted)
        setState(() {
          _mustPaintDisabledOnce = false;
        });
      if (mounted) setState(() => _addingQuick = false);
    }
  }

  Future<void> _submitQuickAddEvent() async {
    if (_addingQuick) return;
    final title = _qaEventTitle.text.trim();
    final start = _qaEventStart.text.trim();
    final end = _qaEventEnd.text.trim();
    final location = _qaEventLocation.text.trim();
    if (title.isEmpty) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('Please enter a title.')));
      return;
    }
    if (!_isValidTime(start) || !_isValidTime(end)) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Use 24‑hour time, e.g. 09:00.')),
      );
      return;
    }
    setState(() => _addingQuick = true);
    WidgetsBinding.instance.addPostFrameCallback((_) {});
    await Future<void>.delayed(Duration.zero);
    try {
      await Future<void>.delayed(const Duration(milliseconds: 1));
      await createEventFn({
        'title': title,
        'scheduledFor': anchor,
        'startTime': start.isEmpty ? null : start,
        'endTime': end.isEmpty ? null : end,
        'location': location.isEmpty ? null : location,
        'priority': _qaEventPriority,
        'recurrence': {'type': 'none'},
      });
      setState(() {
        _qaEventTitle.clear();
        _qaEventStart.clear();
        _qaEventEnd.clear();
        _qaEventLocation.clear();
        _qaEventPriority = 'medium';
      });
      if (!TestHooks.skipRefresh) await _refreshAll();
    } catch (e) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text('Create failed: $e')));
    } finally {
      await Future<void>.delayed(const Duration(milliseconds: 16));
      if (mounted) setState(() => _addingQuick = false);
    }
  }

  Future<void> _submitQuickAddHabit() async {
    if (_addingQuick) return;
    final title = _qaHabitTitle.text.trim();
    final time = _qaHabitTime.text.trim();
    if (title.isEmpty) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('Please enter a title.')));
      return;
    }
    if (!_isValidTime(time)) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Use 24‑hour time, e.g. 09:00.')),
      );
      return;
    }
    setState(() => _addingQuick = true);
    WidgetsBinding.instance.addPostFrameCallback((_) {});
    await Future<void>.delayed(Duration.zero);
    try {
      await Future<void>.delayed(const Duration(milliseconds: 1));
      await createHabitFn({
        'title': title,
        'scheduledFor': anchor,
        'timeOfDay': time.isEmpty ? null : time,
        'priority': _qaHabitPriority,
        'recurrence': {'type': 'daily'},
      });
      setState(() {
        _qaHabitTitle.clear();
        _qaHabitTime.clear();
        _qaHabitPriority = 'medium';
      });
      if (!TestHooks.skipRefresh) await _refreshAll();
    } catch (e) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text('Create failed: $e')));
    } finally {
      await Future<void>.delayed(const Duration(milliseconds: 16));
      if (mounted) setState(() => _addingQuick = false);
    }
  }

  Future<void> _submitQuickAddGoal() async {
    if (_addingQuick) return;
    final title = _qaGoalTitle.text.trim();
    final notes = _qaGoalNotes.text.trim();
    final cpv = double.tryParse(_qaGoalCurrent.text.trim());
    final tpv = double.tryParse(_qaGoalTarget.text.trim());
    final unit = _qaGoalUnit.text.trim();
    if (title.isEmpty) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('Please enter a title.')));
      return;
    }
    setState(() => _addingQuick = true);
    WidgetsBinding.instance.addPostFrameCallback((_) {});
    await Future<void>.delayed(Duration.zero);
    try {
      await Future<void>.delayed(const Duration(milliseconds: 1));
      await createGoalFn({
        'title': title,
        if (notes.isNotEmpty) 'notes': notes,
        'status': _qaGoalStatus,
        if (cpv != null) 'currentProgressValue': cpv,
        if (tpv != null) 'targetProgressValue': tpv,
        if (unit.isNotEmpty) 'progressUnit': unit,
      });
      setState(() {
        _qaGoalTitle.clear();
        _qaGoalNotes.clear();
        _qaGoalCurrent.clear();
        _qaGoalTarget.clear();
        _qaGoalUnit.clear();
        _qaGoalStatus = 'active';
      });
      setState(() {});
    } catch (e) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text('Create failed: $e')));
    } finally {
      await Future<void>.delayed(const Duration(milliseconds: 16));
      if (mounted) setState(() => _addingQuick = false);
    }
  }

  Future<void> _quickAddTodo() async {}

  Future<void> _quickAddEvent() async {}

  Future<void> _quickAddHabit() async {}

  Widget _tabChip(String label, bool selected, VoidCallback onTap, {Key? key}) {
    return InkWell(
      key: key,
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(
          color: selected
              ? Colors.white.withOpacity(0.2)
              : Colors.white.withOpacity(0.08),
          borderRadius: BorderRadius.circular(999),
          border: Border.all(
            color: selected ? Colors.white : Colors.white.withOpacity(0.5),
          ),
        ),
        child: Text(
          label,
          style: const TextStyle(
            color: Colors.white,
            fontSize: 12,
            fontWeight: FontWeight.w600,
          ),
        ),
      ),
    );
  }

  @override
  void dispose() {
    _searchDebounce?.cancel();
    assistantCtrl.dispose();

    searchCtrl.dispose();
    _searchFocus.dispose();
    _removeSearchOverlay();
    _qaTodoTitle.dispose();
    _qaTodoTime.dispose();
    _qaEventTitle.dispose();
    _qaEventStart.dispose();
    _qaEventEnd.dispose();
    _qaEventLocation.dispose();
    _qaHabitTitle.dispose();
    _qaHabitTime.dispose();
    super.dispose();
  }

  Future<void> _refreshAll() async {
    setState(() => loading = true);
    try {
      final r = rangeForView(anchor, view);
      // Day/Week/Month: use unified schedule for Tasks and Habits
      List<Todo> sList;
      if (view == View.day || view == View.week || view == View.month) {
        // Select kinds based on current tab
        final kinds = (mainView == MainView.habits)
            ? <String>['habit']
            : (_kindFilter.isEmpty
                  ? ['todo', 'event', 'habit']
                  : _kindFilter.toList());
        final raw = await api.fetchSchedule(
          from: r.from,
          to: r.to,
          kinds: kinds,
          completed: showCompleted ? null : false,
          priority: _priorityFilter,
        );
        sList = raw
            .map((e) => Todo.fromJson(Map<String, dynamic>.from(e as Map)))
            .toList();
        // Load habit stats for the same range to display streak badges
        try {
          final habitsRaw = await api.listHabits(from: r.from, to: r.to);
          final Map<int, Map<String, dynamic>> statsMap = {};
          for (final h in habitsRaw) {
            final m = Map<String, dynamic>.from(h as Map);
            final hid = (m['id'] as int?);
            if (hid != null) {
              final int current = (m['currentStreak'] is int)
                  ? (m['currentStreak'] as int)
                  : 0;
              final int longest = (m['longestStreak'] is int)
                  ? (m['longestStreak'] as int)
                  : 0;
              final List<dynamic> heat = (m['weekHeatmap'] is List<dynamic>)
                  ? (m['weekHeatmap'] as List<dynamic>)
                  : const [];
              statsMap[hid] = {
                'currentStreak': current,
                'longestStreak': longest,
                'weekHeatmap': heat,
              };
            }
          }
          habitStatsById = statsMap;
        } catch (_) {
          // Non-fatal; stats not critical for schedule rendering
          habitStatsById = {};
        }
      } else {
        final scheduledRaw = await api.fetchScheduled(
          from: r.from,
          to: r.to,
          completed: showCompleted ? null : false,
        );
        sList = scheduledRaw
            .map((e) => Todo.fromJson(e as Map<String, dynamic>))
            .toList();
      }
      final scheduledAllRaw = await api.fetchScheduledAllTime(
        completed: showCompleted ? null : false,
        priority: _priorityFilter,
      );
      final backlogRaw = await api.fetchBacklog(priority: _priorityFilter);
      final sAllList = scheduledAllRaw
          .map((e) => Todo.fromJson(e as Map<String, dynamic>))
          .toList();
      var bList = backlogRaw
          .map((e) => Todo.fromJson(e as Map<String, dynamic>))
          .toList();
      if (!showCompleted) {
        bList = bList.where((t) => !t.completed).toList();
      }
      // Completed filter already applied above; priority now requested server-side
      // Sidebar counters are scoped by active tab context only
      final nowYmd = ymd(DateTime.now());
      int todayCount;
      int scheduledCount;
      int backlogCount = bList.length;
      int flaggedCount;
      int allCount;
      if (mainView == MainView.habits) {
        todayCount = sList
            .where((t) => t.kind == 'habit' && t.scheduledFor == nowYmd)
            .length;
        scheduledCount = sList.where((t) => t.kind == 'habit').length;
        flaggedCount = sList
            .where((t) => t.kind == 'habit' && t.priority == 'high')
            .length;
        allCount =
            scheduledCount +
            backlogCount; // backlog currently excludes habits; acceptable for tab-scoped count
      } else if (mainView == MainView.tasks) {
        todayCount = sList
            .where(
              (t) =>
                  (t.kind == null || t.kind == 'todo' || t.kind == 'event') &&
                  t.scheduledFor == nowYmd,
            )
            .length;
        scheduledCount = sList
            .where(
              (t) => (t.kind == null || t.kind == 'todo' || t.kind == 'event'),
            )
            .length;
        flaggedCount = [...sAllList, ...bList]
            .where(
              (t) =>
                  (t.kind == null || t.kind == 'todo' || t.kind == 'event') &&
                  t.priority == 'high',
            )
            .length;
        allCount =
            sAllList
                .where(
                  (t) =>
                      (t.kind == null || t.kind == 'todo' || t.kind == 'event'),
                )
                .length +
            backlogCount;
      } else {
        // goals tab
        todayCount = 0;
        scheduledCount = 0;
        flaggedCount = 0;
        allCount = 0;
      }
      final counts = <String, int>{
        'today': todayCount,
        'scheduled': scheduledCount,
        'all': allCount,
        'backlog': backlogCount,
      };
      setState(() {
        scheduled = sList;
        scheduledAllTime = sAllList;
        backlog = bList;
        sidebarCounts = counts;
        message = null;
      });
      // Load goal badges (non-blocking)
      _loadGoalBadges();
      _maybeScrollToPendingDate();
    } catch (e) {
      setState(() => message = 'Load failed: $e');
    } finally {
      setState(() => loading = false);
    }
  }

  Future<void> _loadGoalBadges() async {
    try {
      final goals = await api.listGoals();
      final Map<String, Map<String, dynamic>> map = {};
      for (final g in goals) {
        final gm = Map<String, dynamic>.from(g as Map);
        final gid = gm['id'] as int?;
        if (gid == null) continue;
        final detail = await api.getGoal(
          gid,
          includeItems: true,
          includeChildren: false,
        );
        if (detail == null) continue;
        final title = (detail['title'] as String?) ?? '';
        // Todos
        if (detail['items'] is Map && detail['items']['todos'] is List) {
          for (final t in (detail['items']['todos'] as List)) {
            final tm = Map<String, dynamic>.from(t as Map);
            final id = tm['id'] as int?;
            if (id != null) {
              map['todo:$id'] = {'goalId': gid, 'title': title};
            }
          }
        }
        // Events
        if (detail['items'] is Map && detail['items']['events'] is List) {
          for (final ev in (detail['items']['events'] as List)) {
            final em = Map<String, dynamic>.from(ev as Map);
            final id = em['id'] as int?;
            if (id != null) {
              map['event:$id'] = {'goalId': gid, 'title': title};
            }
          }
        }
      }
      if (mounted)
        setState(() {
          _itemGoalByKey = map;
        });
    } catch (_) {
      // Non-blocking
    }
  }

  Future<void> _loadAssistantModel() async {
    try {
      final m = await api.fetchAssistantModel();
      if (!mounted) return;
      setState(() {
        _assistantModel = m;
      });
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
      try {
        _searchCancelToken?.cancel('replaced');
      } catch (_) {}
      _searchCancelToken = CancelToken();
      setState(() => _searching = true);
      final list = await api.searchTodos(
        q,
        completed: showCompleted ? null : false,
        cancelToken: _searchCancelToken,
      );
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
    _searchDebounce = Timer(
      const Duration(milliseconds: 250),
      () => _runSearch(v),
    );
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
    _searchOverlay = OverlayEntry(
      builder: (context) {
        final theme = Theme.of(context);
        final results = searchResults.take(7).toList();
        return Positioned.fill(
          child: GestureDetector(
            behavior: HitTestBehavior.translucent,
            onTap: _removeSearchOverlay,
            child: Stack(
              children: [
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
                              border: Border.all(
                                color: theme.colorScheme.outline.withOpacity(
                                  0.35,
                                ),
                              ),
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
                                    child: Center(
                                      child: SizedBox(
                                        width: 16,
                                        height: 16,
                                        child: CircularProgressIndicator(
                                          strokeWidth: 2,
                                        ),
                                      ),
                                    ),
                                  )
                                : ListView.separated(
                                    padding: const EdgeInsets.symmetric(
                                      vertical: 6,
                                    ),
                                    shrinkWrap: true,
                                    itemBuilder: (c, i) {
                                      final t = results[i];
                                      final selected = i == _searchHoverIndex;
                                      return InkWell(
                                        onTap: () =>
                                            _selectSearchResult(t as Todo),
                                        onHover: (h) => setState(
                                          () => _searchHoverIndex = h
                                              ? i
                                              : _searchHoverIndex,
                                        ),
                                        child: Container(
                                          color: selected
                                              ? theme.colorScheme.primary
                                                    .withOpacity(0.08)
                                              : Colors.transparent,
                                          padding: const EdgeInsets.symmetric(
                                            horizontal: 12,
                                            vertical: 8,
                                          ),
                                          child: Row(
                                            children: [
                                              Expanded(
                                                child: Column(
                                                  crossAxisAlignment:
                                                      CrossAxisAlignment.start,
                                                  children: [
                                                    Text(
                                                      (t as Todo).title,
                                                      maxLines: 1,
                                                      overflow:
                                                          TextOverflow.ellipsis,
                                                    ),
                                                    const SizedBox(height: 4),
                                                    Wrap(
                                                      spacing: 6,
                                                      runSpacing: 4,
                                                      children: [
                                                        _chip(
                                                          (t.scheduledFor ??
                                                              'unscheduled'),
                                                        ),
                                                        _chip(
                                                          'prio ${t.priority}',
                                                        ),
                                                      ],
                                                    ),
                                                  ],
                                                ),
                                              ),
                                            ],
                                          ),
                                        ),
                                      );
                                    },
                                    separatorBuilder: (_, __) => Divider(
                                      height: 1,
                                      color: theme.colorScheme.outline
                                          .withOpacity(0.2),
                                    ),
                                    itemCount: results.length,
                                  ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
    Overlay.of(context, debugRequiredFor: widget).insert(_searchOverlay!);
  }

  void _removeSearchOverlay() {
    try {
      _searchOverlay?.remove();
    } catch (_) {}
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
      child: Text(
        text,
        style: const TextStyle(fontSize: 12, color: Colors.black87),
      ),
    );
  }

  Future<void> _selectSearchResult(Todo t) async {
    _removeSearchOverlay();
    _searchFocus.unfocus();
    searchCtrl.clear();
    setState(() {
      searchResults = [];
      _searchHoverIndex = -1;
    });
    // Determine list membership
    final isScheduled = t.scheduledFor != null;
    final targetList = isScheduled
        ? SmartList.all
        : SmartList.all; // Ensure visibility regardless
    if (selected != targetList) {
      setState(() => selected = targetList);
      await _refreshAll();
      await Future.delayed(Duration.zero);
    }
    final key = _rowKeys[t.id];
    if (key != null && key.currentContext != null) {
      await Scrollable.ensureVisible(
        key.currentContext!,
        duration: const Duration(milliseconds: 250),
      );
      setState(() => _highlightedId = t.id);
      await Future.delayed(const Duration(seconds: 1));
      if (mounted && _highlightedId == t.id)
        setState(() => _highlightedId = null);
    }
  }

  Future<void> _toggleCompleted(Todo t) async {
    try {
      if (t.kind == 'event') {
        if (t.masterId != null && t.scheduledFor != null) {
          await api.toggleEventOccurrence(
            t.masterId!,
            t.scheduledFor!,
            !t.completed,
          );
        } else {
          await api.updateEvent(t.id, {'completed': !t.completed});
        }
      } else if (t.kind == 'habit') {
        if (t.masterId != null && t.scheduledFor != null) {
          await api.toggleHabitOccurrence(
            t.masterId!,
            t.scheduledFor!,
            !t.completed,
          );
        } else {
          await api.updateHabit(t.id, {
            'completed': !t.completed,
            if (t.recurrence != null) 'recurrence': t.recurrence,
          });
        }
      } else {
        if (t.masterId != null && t.scheduledFor != null) {
          await api.updateOccurrence(
            t.masterId!,
            t.scheduledFor!,
            !t.completed,
          );
        } else {
          await api.updateTodo(t.id, {
            'completed': !t.completed,
            'recurrence': t.recurrence ?? {'type': 'none'},
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
          TextButton(
            onPressed: () => Navigator.pop(c, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(c, true),
            child: const Text('Delete'),
          ),
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

  // Deprecated FAB/event/habit sheets removed; inline quick-add is the single add surface
  Future<void> _openFabSheet() async {}
  Future<void> _openEventSheet() async {}
  Future<void> _openHabitSheet() async {}

  Future<void> _editHabit(Todo t) async {
    final titleCtrl = TextEditingController(text: t.title);
    final notesCtrl = TextEditingController(text: t.notes);
    final dateCtrl = TextEditingController(text: t.scheduledFor ?? '');
    final timeCtrl = TextEditingController(text: t.timeOfDay ?? '');
    final todoSearchCtrl = TextEditingController();
    final eventSearchCtrl = TextEditingController();
    final intervalCtrl = TextEditingController(
      text: (t.recurrence != null && t.recurrence!['intervalDays'] != null)
          ? '${t.recurrence!['intervalDays']}'
          : '1',
    );
    String prio = t.priority;
    String recurType = (t.recurrence != null && t.recurrence!['type'] is String)
        ? (t.recurrence!['type'] as String)
        : 'daily';
    // Link pickers for edit: allow adding/removing
    final selectedTodoIds = <int>{};
    final selectedEventIds = <int>{};
    List<Map<String, dynamic>> allTodos = [];
    List<Map<String, dynamic>> allEvents = [];

    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => StatefulBuilder(
        builder: (c, setDlgState) {
          Future<void> _loadLinkables() async {
            try {
              final tds = await api.fetchScheduledAllTime();
              final evs = await api.listEvents();
              setDlgState(() {
                allTodos = tds
                    .map((x) => Map<String, dynamic>.from(x as Map))
                    .toList();
                allEvents = evs
                    .map((x) => Map<String, dynamic>.from(x as Map))
                    .toList();
              });
            } catch (_) {}
          }

          if (allTodos.isEmpty && allEvents.isEmpty) {
            _loadLinkables();
          }
          return AlertDialog(
            title: const Text('Edit habit'),
            content: SizedBox(
              width: 480,
              child: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    TextField(
                      controller: titleCtrl,
                      decoration: const InputDecoration(labelText: 'Title'),
                    ),
                    TextField(
                      controller: notesCtrl,
                      decoration: const InputDecoration(labelText: 'Notes'),
                    ),
                    TextField(
                      controller: dateCtrl,
                      decoration: const InputDecoration(
                        labelText: 'Anchor date (YYYY-MM-DD)',
                      ),
                    ),
                    TextField(
                      controller: timeCtrl,
                      decoration: const InputDecoration(
                        labelText: 'Time (HH:MM or empty)',
                      ),
                    ),
                    const SizedBox(height: 8),
                    DropdownButtonFormField<String>(
                      value: prio,
                      decoration: const InputDecoration(labelText: 'Priority'),
                      items: const [
                        DropdownMenuItem(value: 'low', child: Text('low')),
                        DropdownMenuItem(
                          value: 'medium',
                          child: Text('medium'),
                        ),
                        DropdownMenuItem(value: 'high', child: Text('high')),
                      ],
                      onChanged: (v) => setDlgState(() => prio = v ?? 'medium'),
                    ),
                    const SizedBox(height: 8),
                    DropdownButtonFormField<String>(
                      value: recurType,
                      decoration: const InputDecoration(
                        labelText: 'Recurrence (habits must repeat)',
                      ),
                      items: const [
                        DropdownMenuItem(value: 'daily', child: Text('Daily')),
                        DropdownMenuItem(
                          value: 'weekdays',
                          child: Text('Weekdays (Mon–Fri)'),
                        ),
                        DropdownMenuItem(
                          value: 'weekly',
                          child: Text('Weekly (by anchor)'),
                        ),
                        DropdownMenuItem(
                          value: 'every_n_days',
                          child: Text('Every N days'),
                        ),
                      ],
                      onChanged: (v) =>
                          setDlgState(() => recurType = v ?? 'daily'),
                    ),
                    if (recurType == 'every_n_days')
                      TextField(
                        controller: intervalCtrl,
                        keyboardType: TextInputType.number,
                        decoration: const InputDecoration(
                          labelText: 'Every N days (>=1)',
                        ),
                      ),
                    const SizedBox(height: 12),
                    const Text(
                      'Link existing todos (optional)',
                      style: TextStyle(fontWeight: FontWeight.w600),
                    ),
                    const SizedBox(height: 4),
                    TextField(
                      controller: todoSearchCtrl,
                      decoration: const InputDecoration(
                        prefixIcon: Icon(Icons.search),
                        hintText: 'Filter todos...',
                      ),
                      onChanged: (_) => setDlgState(() {}),
                    ),
                    const SizedBox(height: 6),
                    Container(
                      constraints: const BoxConstraints(maxHeight: 120),
                      decoration: BoxDecoration(
                        border: Border.all(color: Colors.grey.shade300),
                        borderRadius: BorderRadius.circular(6),
                      ),
                      child: ListView(
                        children: [
                          for (final x in allTodos.where((it) {
                            final q = todoSearchCtrl.text.trim().toLowerCase();
                            if (q.isEmpty) return true;
                            final title = (it['title'] ?? '').toString();
                            return title.toLowerCase().contains(q);
                          }))
                            CheckboxListTile(
                              dense: true,
                              value: selectedTodoIds.contains(x['id'] as int),
                              onChanged: (v) => setDlgState(() {
                                final id = x['id'] as int;
                                if (v == true)
                                  selectedTodoIds.add(id);
                                else
                                  selectedTodoIds.remove(id);
                              }),
                              title: Text('#${x['id']}  ${x['title'] ?? ''}'),
                            ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 8),
                    const Text(
                      'Link existing events (optional)',
                      style: TextStyle(fontWeight: FontWeight.w600),
                    ),
                    const SizedBox(height: 4),
                    TextField(
                      controller: eventSearchCtrl,
                      decoration: const InputDecoration(
                        prefixIcon: Icon(Icons.search),
                        hintText: 'Filter events...',
                      ),
                      onChanged: (_) => setDlgState(() {}),
                    ),
                    const SizedBox(height: 6),
                    Container(
                      constraints: const BoxConstraints(maxHeight: 120),
                      decoration: BoxDecoration(
                        border: Border.all(color: Colors.grey.shade300),
                        borderRadius: BorderRadius.circular(6),
                      ),
                      child: ListView(
                        children: [
                          for (final e in allEvents.where((it) {
                            final q = eventSearchCtrl.text.trim().toLowerCase();
                            if (q.isEmpty) return true;
                            final title = (it['title'] ?? '').toString();
                            return title.toLowerCase().contains(q);
                          }))
                            CheckboxListTile(
                              dense: true,
                              value: selectedEventIds.contains(e['id'] as int),
                              onChanged: (v) => setDlgState(() {
                                final id = e['id'] as int;
                                if (v == true)
                                  selectedEventIds.add(id);
                                else
                                  selectedEventIds.remove(id);
                              }),
                              title: Text('#${e['id']}  ${e['title'] ?? ''}'),
                            ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(c, false),
                child: const Text('Cancel'),
              ),
              FilledButton(
                onPressed: () => Navigator.pop(c, true),
                child: const Text('Save'),
              ),
            ],
          );
        },
      ),
    );
    if (ok != true) return;

    final patch = <String, dynamic>{};
    if (titleCtrl.text != t.title) patch['title'] = titleCtrl.text;
    if (notesCtrl.text != t.notes) patch['notes'] = notesCtrl.text;
    final sched = dateCtrl.text.trim();
    final normalized = sched.isEmpty ? null : sched;
    if (normalized != (t.scheduledFor ?? ''))
      patch['scheduledFor'] = normalized;
    if (prio != t.priority) patch['priority'] = prio;
    final time = timeCtrl.text.trim();
    if ((time.isEmpty ? null : time) != (t.timeOfDay))
      patch['timeOfDay'] = time.isEmpty ? null : time;
    // Recurrence
    final existingType =
        (t.recurrence != null && t.recurrence!['type'] is String)
        ? (t.recurrence!['type'] as String)
        : 'daily';
    final existingN =
        (t.recurrence != null && t.recurrence!['intervalDays'] is int)
        ? (t.recurrence!['intervalDays'] as int)
        : null;
    if (recurType != existingType) {
      patch['recurrence'] = {'type': recurType};
      if (recurType == 'every_n_days') {
        final n = int.tryParse(intervalCtrl.text.trim());
        if (n != null && n >= 1)
          (patch['recurrence'] as Map<String, dynamic>)['intervalDays'] = n;
      }
    } else if (recurType == 'every_n_days') {
      final n = int.tryParse(intervalCtrl.text.trim());
      if (n != null && n >= 1 && n != existingN) {
        patch['recurrence'] = {'type': recurType, 'intervalDays': n};
      }
    }

    try {
      await api.updateHabit(t.id, patch);
      // Apply linking
      if (selectedTodoIds.isNotEmpty || selectedEventIds.isNotEmpty) {
        await api.linkHabitItems(
          t.id,
          todos: selectedTodoIds.toList(),
          events: selectedEventIds.toList(),
        );
      }
      await _refreshAll();
    } catch (e) {
      setState(() => message = 'Edit failed: $e');
    }
  }

  Future<void> _editTodo(Todo t) async {
    final titleCtrl = TextEditingController(text: t.title);
    final notesCtrl = TextEditingController(text: t.notes);
    final dateCtrl = TextEditingController(text: t.scheduledFor ?? '');
    final timeCtrl = TextEditingController(text: t.timeOfDay ?? '');
    final intervalCtrl = TextEditingController(
      text: (t.recurrence != null && t.recurrence!['intervalDays'] != null)
          ? '${t.recurrence!['intervalDays']}'
          : '1',
    );
    String prio = t.priority;
    String recurType = (t.recurrence != null && t.recurrence!['type'] is String)
        ? (t.recurrence!['type'] as String)
        : 'none';
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => StatefulBuilder(
        builder: (c, setDlgState) {
          return AlertDialog(
            title: const Text('Edit todo'),
            content: SizedBox(
              width: 420,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  TextField(
                    controller: titleCtrl,
                    decoration: const InputDecoration(labelText: 'Title'),
                  ),
                  TextField(
                    controller: notesCtrl,
                    decoration: const InputDecoration(labelText: 'Notes'),
                  ),
                  TextField(
                    controller: dateCtrl,
                    decoration: const InputDecoration(
                      labelText: 'Scheduled (YYYY-MM-DD or empty)',
                    ),
                  ),
                  TextField(
                    controller: timeCtrl,
                    decoration: const InputDecoration(
                      labelText: 'Time (HH:MM or empty)',
                    ),
                  ),
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
                      DropdownMenuItem(
                        value: 'weekdays',
                        child: Text('Weekdays (Mon–Fri)'),
                      ),
                      DropdownMenuItem(
                        value: 'weekly',
                        child: Text('Weekly (by anchor)'),
                      ),
                      DropdownMenuItem(
                        value: 'every_n_days',
                        child: Text('Every N days'),
                      ),
                    ],
                    onChanged: (v) =>
                        setDlgState(() => recurType = v ?? 'none'),
                  ),
                  if (recurType == 'every_n_days')
                    TextField(
                      controller: intervalCtrl,
                      keyboardType: TextInputType.number,
                      decoration: const InputDecoration(
                        labelText: 'Every N days (>=1)',
                      ),
                    ),
                  if (recurType == 'weekly' && dateCtrl.text.trim().isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 6),
                      child: Text(
                        'Repeats weekly on the same weekday as anchor ${dateCtrl.text.trim()}',
                        style: const TextStyle(
                          fontSize: 12,
                          color: Colors.black54,
                        ),
                      ),
                    ),
                ],
              ),
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(c, false),
                child: const Text('Cancel'),
              ),
              FilledButton(
                onPressed: () => Navigator.pop(c, true),
                child: const Text('Save'),
              ),
            ],
          );
        },
      ),
    );
    if (ok != true) return;

    final patch = <String, dynamic>{};
    if (titleCtrl.text != t.title) patch['title'] = titleCtrl.text;
    if (notesCtrl.text != t.notes) patch['notes'] = notesCtrl.text;
    final sched = dateCtrl.text.trim();
    final normalized = sched.isEmpty ? null : sched;
    if (normalized != (t.scheduledFor ?? ''))
      patch['scheduledFor'] = normalized;
    if (prio != t.priority) patch['priority'] = prio;
    final time = timeCtrl.text.trim();
    if ((time.isEmpty ? null : time) != (t.timeOfDay))
      patch['timeOfDay'] = time.isEmpty ? null : time;
    // Recurrence
    final existingType =
        (t.recurrence != null && t.recurrence!['type'] is String)
        ? (t.recurrence!['type'] as String)
        : 'none';
    final existingN =
        (t.recurrence != null && t.recurrence!['intervalDays'] is int)
        ? (t.recurrence!['intervalDays'] as int)
        : null;
    if (recurType != existingType) {
      patch['recurrence'] = {'type': recurType};
      if (recurType == 'every_n_days') {
        final n = int.tryParse(intervalCtrl.text.trim());
        if (n != null && n >= 1)
          (patch['recurrence'] as Map<String, dynamic>)['intervalDays'] = n;
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
    String recurType = (t.recurrence != null && t.recurrence!['type'] is String)
        ? (t.recurrence!['type'] as String)
        : 'none';
    final intervalCtrl = TextEditingController(
      text: (t.recurrence != null && t.recurrence!['intervalDays'] != null)
          ? '${t.recurrence!['intervalDays']}'
          : '1',
    );
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => StatefulBuilder(
        builder: (c, setDlgState) {
          return AlertDialog(
            title: const Text('Edit event'),
            content: SizedBox(
              width: 420,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  TextField(
                    controller: titleCtrl,
                    decoration: const InputDecoration(labelText: 'Title'),
                  ),
                  TextField(
                    controller: notesCtrl,
                    decoration: const InputDecoration(labelText: 'Notes'),
                  ),
                  TextField(
                    controller: dateCtrl,
                    decoration: const InputDecoration(
                      labelText: 'Date (YYYY-MM-DD)',
                    ),
                  ),
                  Row(
                    children: [
                      Expanded(
                        child: TextField(
                          controller: startCtrl,
                          decoration: const InputDecoration(
                            labelText: 'Start (HH:MM)',
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: TextField(
                          controller: endCtrl,
                          decoration: const InputDecoration(
                            labelText: 'End (HH:MM, optional)',
                          ),
                        ),
                      ),
                    ],
                  ),
                  TextField(
                    controller: locationCtrl,
                    decoration: const InputDecoration(labelText: 'Location'),
                  ),
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
                      DropdownMenuItem(
                        value: 'weekdays',
                        child: Text('Weekdays (Mon–Fri)'),
                      ),
                      DropdownMenuItem(
                        value: 'weekly',
                        child: Text('Weekly (by anchor)'),
                      ),
                      DropdownMenuItem(
                        value: 'every_n_days',
                        child: Text('Every N days'),
                      ),
                    ],
                    onChanged: (v) =>
                        setDlgState(() => recurType = v ?? 'none'),
                  ),
                  if (recurType == 'every_n_days')
                    TextField(
                      controller: intervalCtrl,
                      keyboardType: TextInputType.number,
                      decoration: const InputDecoration(
                        labelText: 'Every N days (>=1)',
                      ),
                    ),
                ],
              ),
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(c, false),
                child: const Text('Cancel'),
              ),
              FilledButton(
                onPressed: () => Navigator.pop(c, true),
                child: const Text('Save'),
              ),
            ],
          );
        },
      ),
    );
    if (ok != true) return;
    final patch = <String, dynamic>{};
    if (titleCtrl.text != t.title) patch['title'] = titleCtrl.text;
    if (notesCtrl.text != t.notes) patch['notes'] = notesCtrl.text;
    final date = dateCtrl.text.trim();
    final normalized = date.isEmpty ? null : date;
    if (normalized != (t.scheduledFor ?? ''))
      patch['scheduledFor'] = normalized;
    if (prio != t.priority) patch['priority'] = prio;
    final start = startCtrl.text.trim();
    final end = endCtrl.text.trim();
    patch['startTime'] = start.isEmpty ? null : start;
    patch['endTime'] = end.isEmpty ? null : end;
    patch['location'] = locationCtrl.text.trim().isEmpty
        ? null
        : locationCtrl.text.trim();
    if (recurType !=
        ((t.recurrence != null && t.recurrence!['type'] is String)
            ? (t.recurrence!['type'] as String)
            : 'none')) {
      patch['recurrence'] = recurType == 'none'
          ? {'type': 'none'}
          : (recurType == 'every_n_days'
                ? {
                    'type': 'every_n_days',
                    'intervalDays': int.tryParse(intervalCtrl.text.trim()),
                  }
                : {'type': recurType});
    }
    try {
      await api.updateEvent(t.id, patch);
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
      final recent = assistantTranscript.length <= 3
          ? assistantTranscript
          : assistantTranscript.sublist(assistantTranscript.length - 3);
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
              assistantTranscript[assistantStreamingIndex!] = {
                'role': 'assistant',
                'text': s,
              };
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
              assistantTranscript[assistantStreamingIndex!] = {
                'role': 'assistant',
                'text': q,
              };
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
                if (_clarifySelectedIds.isNotEmpty ||
                    _clarifySelectedDate != null ||
                    _clarifySelectedPriority != null)
                  'selection': {
                    if (_clarifySelectedIds.isNotEmpty)
                      'ids': _clarifySelectedIds.toList(),
                    if (_clarifySelectedDate != null)
                      'date': _clarifySelectedDate,
                    if (_clarifySelectedPriority != null)
                      'priority': _clarifySelectedPriority,
                  },
              },
        onStage: (st) {
          if (!mounted) return;
          setState(() {
            _progressStage = st;
          });
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
                final m = (x is AnnotatedOp)
                    ? x.op
                    : LlmOperation.fromJson(
                        Map<String, dynamic>.from(
                          (x as Map<String, dynamic>)['op'] as Map,
                        ),
                      );
                final id = m.id == null ? '' : '#${m.id}';
                return '${m.op}$id';
              } catch (_) {
                return '';
              }
            }

            final prevMap = <String, bool>{};
            for (var i = 0; i < prior.length; i++) {
              prevMap[kOp(prior[i])] = (i < priorChecked.length
                  ? priorChecked[i]
                  : true);
            }
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
          : opsRaw
                .map((e) => AnnotatedOp.fromJson(e as Map<String, dynamic>))
                .toList();
      setState(() {
        if (reply.trim().isNotEmpty) {
          if (assistantStreamingIndex != null &&
              assistantStreamingIndex! >= 0 &&
              assistantStreamingIndex! < assistantTranscript.length) {
            assistantTranscript[assistantStreamingIndex!] = {
              'role': 'assistant',
              'text': reply,
            };
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
            final m = (x is AnnotatedOp)
                ? x.op
                : AnnotatedOp.fromJson(
                    Map<String, dynamic>.from(x as Map<String, dynamic>),
                  ).op;
            final id = m.id == null ? '' : '#${m.id}';
            return '${m.op}$id';
          } catch (_) {
            return '';
          }
        }

        final prevMap = <String, bool>{};
        for (var i = 0; i < prior.length; i++) {
          prevMap[kOp(prior[i])] = (i < priorChecked.length
              ? priorChecked[i]
              : true);
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
          assistantTranscript[assistantStreamingIndex!] = {
            'role': 'assistant',
            'text': errText,
          };
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
        final warnings =
            (preview['warnings'] as List<dynamic>?)
                ?.map((e) => e.toString())
                .toList() ??
            const <String>[];
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
                    ...warnings.map(
                      (w) => Padding(
                        padding: const EdgeInsets.only(bottom: 4),
                        child: Text('• $w'),
                      ),
                    ),
                  ],
                ),
              ),
              actions: [
                TextButton(
                  onPressed: () => Navigator.pop(c, false),
                  child: const Text('Cancel'),
                ),
                FilledButton(
                  onPressed: () => Navigator.pop(c, true),
                  child: const Text('Apply anyway'),
                ),
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
        message =
            'Applied: c=${summary['created']}, u=${summary['updated']}, d=${summary['deleted']}, done=${summary['completed']}';
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
    final sorted = Map.fromEntries(
      map.entries.toList()..sort((a, b) => a.key.compareTo(b.key)),
    );
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
              // Unified header spanning entire app width
              Container(
                color: Theme.of(context).colorScheme.surface,
                padding: const EdgeInsets.symmetric(horizontal: 0, vertical: 0),
                child: SizedBox(
                  height: 112,
                  child: Row(
                    children: [
                      // Reserve space visually aligned with left sidebar width
                      const SizedBox(width: 220),
                      // Full-height divider aligning with body split (left of main tasks)
                      VerticalDivider(
                        width: 1,
                        thickness: 1,
                        color: Theme.of(context).colorScheme.outline,
                      ),
                      // Left: Tab segmented control + center: Search box (responsive)
                      Expanded(
                        child: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            // Tabs row
                            Padding(
                              padding: const EdgeInsets.only(top: 6, bottom: 6),
                              child: th.TabsHeader(
                                selected: () {
                                  if (mainView == MainView.goals)
                                    return th.AppTab.goals;
                                  if (mainView == MainView.habits)
                                    return th.AppTab.habits;
                                  if (_kindFilter.length == 1 &&
                                      _kindFilter.contains('event'))
                                    return th.AppTab.events;
                                  return th.AppTab.todos;
                                }(),
                                onChanged: (tab) async {
                                  if (tab == th.AppTab.goals) {
                                    setState(() {
                                      mainView = MainView.goals;
                                    });
                                    try {
                                      storage.setItem('mainTab', 'goals');
                                    } catch (_) {}
                                    return;
                                  }
                                  if (tab == th.AppTab.habits) {
                                    setState(() {
                                      mainView = MainView.habits;
                                      _kindFilter = <String>{'habit'};
                                    });
                                    try {
                                      storage.setItem('mainTab', 'habits');
                                    } catch (_) {}
                                    await _refreshAll();
                                    return;
                                  }
                                  if (tab == th.AppTab.events) {
                                    setState(() {
                                      mainView = MainView.tasks;
                                      _kindFilter = <String>{'event'};
                                    });
                                    try {
                                      storage.setItem('mainTab', 'events');
                                    } catch (_) {}
                                    await _refreshAll();
                                    return;
                                  }
                                  // default: todos
                                  setState(() {
                                    mainView = MainView.tasks;
                                    _kindFilter = <String>{'todo'};
                                  });
                                  try {
                                    storage.setItem('mainTab', 'todos');
                                  } catch (_) {}
                                  await _refreshAll();
                                },
                              ),
                            ),
                            // Search line
                            Center(
                              child: ConstrainedBox(
                                constraints: const BoxConstraints(
                                  minWidth: 320,
                                  maxWidth: 560,
                                ),
                                child: CompositedTransformTarget(
                                  link: _searchLink,
                                  child: Focus(
                                    focusNode: _searchFocus,
                                    onFocusChange: (f) {
                                      if (!f)
                                        _removeSearchOverlay();
                                      else
                                        _showSearchOverlayIfNeeded();
                                    },
                                    onKeyEvent: (node, event) {
                                      if (!_searchFocus.hasFocus)
                                        return KeyEventResult.ignored;
                                      if (event is! KeyDownEvent)
                                        return KeyEventResult.ignored;
                                      final len = math.min(
                                        searchResults.length,
                                        7,
                                      );
                                      if (event.logicalKey ==
                                          LogicalKeyboardKey.arrowDown) {
                                        setState(() {
                                          _searchHoverIndex = len == 0
                                              ? -1
                                              : (_searchHoverIndex + 1) % len;
                                        });
                                        _showSearchOverlayIfNeeded();
                                        return KeyEventResult.handled;
                                      } else if (event.logicalKey ==
                                          LogicalKeyboardKey.arrowUp) {
                                        setState(() {
                                          _searchHoverIndex = len == 0
                                              ? -1
                                              : (_searchHoverIndex - 1 + len) %
                                                    len;
                                        });
                                        _showSearchOverlayIfNeeded();
                                        return KeyEventResult.handled;
                                      } else if (event.logicalKey ==
                                          LogicalKeyboardKey.enter) {
                                        final list = searchResults
                                            .take(7)
                                            .toList();
                                        if (list.isEmpty) {
                                          return KeyEventResult.handled;
                                        }
                                        final idx =
                                            _searchHoverIndex >= 0 &&
                                                _searchHoverIndex < list.length
                                            ? _searchHoverIndex
                                            : 0;
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
                                        fillColor: Theme.of(
                                          context,
                                        ).colorScheme.surfaceContainerHigh,
                                        border: OutlineInputBorder(
                                          borderRadius: BorderRadius.circular(
                                            24,
                                          ),
                                          borderSide: BorderSide(
                                            color: Theme.of(context)
                                                .colorScheme
                                                .outline
                                                .withOpacity(0.4),
                                          ),
                                        ),
                                        focusedBorder: OutlineInputBorder(
                                          borderRadius: BorderRadius.circular(
                                            24,
                                          ),
                                          borderSide: BorderSide(
                                            color: Theme.of(
                                              context,
                                            ).colorScheme.primary,
                                            width: 2,
                                          ),
                                        ),
                                        suffixIcon: Row(
                                          mainAxisSize: MainAxisSize.min,
                                          children: [
                                            if (_searching)
                                              SizedBox(
                                                width: 16,
                                                height: 16,
                                                child: Padding(
                                                  padding: EdgeInsets.all(8),
                                                  child:
                                                      CircularProgressIndicator(
                                                        strokeWidth: 2,
                                                      ),
                                                ),
                                              ),
                                            if (searchCtrl.text.isNotEmpty)
                                              IconButton(
                                                icon: const Icon(Icons.clear),
                                                onPressed: () {
                                                  searchCtrl.clear();
                                                  setState(() {
                                                    searchResults = [];
                                                    _searchHoverIndex = -1;
                                                  });
                                                  _removeSearchOverlay();
                                                },
                                              ),
                                          ],
                                        ),
                                      ),
                                      onChanged: (v) {
                                        _onSearchChanged(v);
                                        _showSearchOverlayIfNeeded();
                                      },
                                    ),
                                  ),
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                      // Full-height divider aligning with body split (right of main tasks / left of assistant)
                      VerticalDivider(
                        width: 1,
                        thickness: 1,
                        color: Theme.of(context).colorScheme.outline,
                      ),
                      // Header right: navigation + view controls + assistant toggle
                      Flexible(
                        child: SingleChildScrollView(
                          scrollDirection: Axis.horizontal,
                          child: Row(
                            mainAxisAlignment: MainAxisAlignment.end,
                            children: [
                              IconButton(
                                icon: const Icon(Icons.chevron_left),
                                tooltip: 'Previous',
                                onPressed: _goPrev,
                              ),
                              TextButton(
                                onPressed: _goToToday,
                                child: const Text('Today'),
                              ),
                              IconButton(
                                icon: const Icon(Icons.chevron_right),
                                tooltip: 'Next',
                                onPressed: _goNext,
                              ),
                              const SizedBox(width: 12),
                              if (mainView != MainView.goals)
                                SegmentedButton<View>(
                                  segments: const [
                                    ButtonSegment(
                                      value: View.day,
                                      label: Text('Day'),
                                    ),
                                    ButtonSegment(
                                      value: View.week,
                                      label: Text('Week'),
                                    ),
                                    ButtonSegment(
                                      value: View.month,
                                      label: Text('Month'),
                                    ),
                                  ],
                                  selected: {view},
                                  onSelectionChanged: (s) async {
                                    setState(() {
                                      view = s.first;
                                    });
                                    await _refreshAll();
                                  },
                                ),
                              const SizedBox(width: 12),
                              TextButton.icon(
                                onPressed: () => setState(
                                  () =>
                                      assistantCollapsed = !assistantCollapsed,
                                ),
                                icon: const Icon(
                                  Icons.smart_toy_outlined,
                                  size: 18,
                                ),
                                label: showAssistantText
                                    ? Text(
                                        assistantCollapsed
                                            ? 'Show Assistant'
                                            : 'Hide Assistant',
                                      )
                                    : const SizedBox.shrink(),
                              ),
                            ],
                          ),
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
                            setState(() {
                              mainView = MainView.goals;
                            });
                            return;
                          } else if (k == 'habits') {
                            setState(() {
                              mainView = MainView.habits;
                            });
                            await _refreshAll();
                            return;
                          }
                          final sl = _smartListFromKey(k);
                          if (sl == SmartList.today) {
                            setState(() {
                              selected = sl;
                              mainView = MainView.tasks;
                              view = View.day;
                              anchor = ymd(DateTime.now());
                            });
                            await _refreshAll();
                          } else if (sl == SmartList.scheduled) {
                            setState(() {
                              selected = sl;
                              mainView = MainView.tasks;
                              view = View.week;
                            });
                            await _refreshAll();
                          } else {
                            setState(() {
                              selected = sl;
                              mainView = MainView.tasks;
                            });
                            await _refreshAll();
                          }
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
                              padding: const EdgeInsets.symmetric(
                                horizontal: 12,
                                vertical: 6,
                              ),
                              child: Align(
                                alignment: Alignment.centerLeft,
                                child: Text(
                                  message!,
                                  style: const TextStyle(
                                    color: Colors.redAccent,
                                  ),
                                ),
                              ),
                            ),
                          Expanded(
                            child: Row(
                              children: [
                                // Main content
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: [
                                      Expanded(
                                        child: Stack(
                                          children: [
                                            (mainView == MainView.tasks)
                                                ? _buildMainList()
                                                : (mainView == MainView.habits
                                                      ? _buildHabitsList()
                                                      : _buildGoalsView()),
                                          ],
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                                const VerticalDivider(width: 1),
                                // Assistant panel (collapsible)
                                if (!assistantCollapsed)
                                  SizedBox(
                                    width: 360,
                                    child: AssistantPanel(
                                      transcript: assistantTranscript,
                                      operations: assistantOps,
                                      operationsChecked: assistantOpsChecked,
                                      sending: assistantSending,
                                      model: _assistantModel,
                                      showDiff: assistantShowDiff,
                                      onToggleDiff: () => setState(
                                        () => assistantShowDiff =
                                            !assistantShowDiff,
                                      ),
                                      onToggleOperation: (i, v) => setState(
                                        () => assistantOpsChecked[i] = v,
                                      ),
                                      onApplySelected: _applyAssistantOps,
                                      onDiscard: () => setState(() {
                                        assistantOps = [];
                                        assistantOpsChecked = [];
                                        assistantShowDiff = false;
                                      }),
                                      inputController: assistantCtrl,
                                      onSend: _sendAssistantMessage,
                                      opLabel: (op) =>
                                          _opLabel((op as AnnotatedOp).op),
                                      onClearChat: () => setState(() {
                                        assistantTranscript.clear();
                                        assistantOps = [];
                                        assistantOpsChecked = [];
                                        assistantShowDiff = false;
                                      }),
                                      clarifyQuestion: _pendingClarifyQuestion,
                                      clarifyOptions: _pendingClarifyOptions,
                                      onToggleClarifyId: (id) => setState(() {
                                        if (_clarifySelectedIds.contains(id))
                                          _clarifySelectedIds.remove(id);
                                        else
                                          _clarifySelectedIds.add(id);
                                      }),
                                      onSelectClarifyDate: (d) => setState(() {
                                        _clarifySelectedDate = d;
                                      }),
                                      onSelectClarifyPriority: (p) =>
                                          setState(() {
                                            _clarifySelectedPriority = p;
                                          }),
                                      progressStage: _progressStage,
                                      todayYmd: ymd(DateTime.now()),
                                      selectedClarifyIds: _clarifySelectedIds,
                                      selectedClarifyDate: _clarifySelectedDate,
                                      selectedClarifyPriority:
                                          _clarifySelectedPriority,
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
                  child: Wrap(
                    spacing: 8,
                    runSpacing: 6,
                    children: [
                      // Inline quick-add per tab
                      if (mainView == MainView.tasks) ...[
                        _quickAddInline(),
                        const SizedBox(width: 12),
                        SegmentedButton<String>(
                          segments: const [
                            ButtonSegment(value: 'all', label: Text('All')),
                            ButtonSegment(value: 'low', label: Text('Low')),
                            ButtonSegment(
                              value: 'medium',
                              label: Text('Medium'),
                            ),
                            ButtonSegment(value: 'high', label: Text('High')),
                          ],
                          selected: <String>{(_priorityFilter ?? 'all')},
                          onSelectionChanged: (s) {
                            setState(() {
                              _priorityFilter = (s.first == 'all')
                                  ? null
                                  : s.first;
                            });
                            _refreshAll();
                          },
                          style: const ButtonStyle(
                            visualDensity: VisualDensity.compact,
                          ),
                        ),
                        const SizedBox(width: 12),
                        Row(
                          children: [
                            const Text('Show Completed'),
                            Switch(
                              value: showCompleted,
                              onChanged: (v) {
                                setState(() => showCompleted = v);
                                _refreshAll();
                              },
                            ),
                          ],
                        ),
                      ],
                    ],
                  ),
                ),
                // Duplicate navigation controls removed; rely on header controls only
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
                  child: Wrap(
                    spacing: 8,
                    runSpacing: 6,
                    children: [
                      if (mainView == MainView.tasks) ...[
                        _quickAddInline(),
                        const SizedBox(width: 12),
                        SegmentedButton<String>(
                          segments: const [
                            ButtonSegment(value: 'all', label: Text('All')),
                            ButtonSegment(value: 'low', label: Text('Low')),
                            ButtonSegment(
                              value: 'medium',
                              label: Text('Medium'),
                            ),
                            ButtonSegment(value: 'high', label: Text('High')),
                          ],
                          selected: <String>{(_priorityFilter ?? 'all')},
                          onSelectionChanged: (s) {
                            setState(() {
                              _priorityFilter = (s.first == 'all')
                                  ? null
                                  : s.first;
                            });
                            _refreshAll();
                          },
                          style: const ButtonStyle(
                            visualDensity: VisualDensity.compact,
                          ),
                        ),
                        const SizedBox(width: 12),
                        Row(
                          children: [
                            const Text('Show Completed'),
                            Switch(
                              value: showCompleted,
                              onChanged: (v) {
                                setState(() => showCompleted = v);
                                _refreshAll();
                              },
                            ),
                          ],
                        ),
                      ],
                    ],
                  ),
                ),
                // Duplicate navigation controls removed; rely on header controls only
              ],
            ),
          ),
        if (view == View.week) _buildWeekdayHeader(),
        for (final entry in grouped.entries) ...[
          Builder(
            builder: (context) {
              final isTodayHeader = entry.key == ymd(DateTime.now());
              final label = isTodayHeader ? '${entry.key}  (Today)' : entry.key;
              return Container(
                margin: const EdgeInsets.only(top: 8, bottom: 2),
                padding: const EdgeInsets.symmetric(vertical: 6, horizontal: 8),
                decoration: BoxDecoration(
                  color: isTodayHeader
                      ? Theme.of(context).colorScheme.primary.withOpacity(0.06)
                      : null,
                  border: Border(
                    left: BorderSide(
                      color: isTodayHeader
                          ? Theme.of(context).colorScheme.primary
                          : Colors.transparent,
                      width: 3,
                    ),
                  ),
                ),
                child: Text(
                  label,
                  style: TextStyle(
                    fontWeight: FontWeight.w600,
                    color: isTodayHeader
                        ? Theme.of(context).colorScheme.primary
                        : null,
                  ),
                ),
              );
            },
          ),
          ...entry.value.map(_buildRow),
        ],
      ],
    );
  }

  Widget _buildWeekdayHeader() {
    try {
      final a = parseYmd(anchor);
      // compute Monday of this week
      final monday = a.subtract(Duration(days: (a.weekday + 6) % 7));
      final days = List<DateTime>.generate(
        7,
        (i) => monday.add(Duration(days: i)),
      );
      final labels = const ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
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
                  Text(
                    labels[i],
                    style: const TextStyle(fontWeight: FontWeight.w600),
                  ),
                  const SizedBox(height: 2),
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 6,
                      vertical: 2,
                    ),
                    decoration: isToday
                        ? BoxDecoration(
                            color: Theme.of(
                              context,
                            ).colorScheme.primary.withOpacity(0.08),
                            borderRadius: BorderRadius.circular(999),
                            border: Border.all(
                              color: Theme.of(context).colorScheme.primary,
                            ),
                          )
                        : null,
                    child: Text(
                      '${d.day}',
                      style: TextStyle(
                        color: isToday
                            ? Theme.of(context).colorScheme.primary
                            : Colors.black87,
                      ),
                    ),
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
    for (
      DateTime d = start;
      d.isBefore(end.add(const Duration(days: 1)));
      d = d.add(const Duration(days: 1))
    ) {
      days.add(d);
    }
    final weeks = <List<DateTime>>[];
    for (int i = 0; i < days.length; i += 7) {
      weeks.add(days.sublist(i, i + 7));
    }
    final weekdayLabels = const [
      'Mon',
      'Tue',
      'Wed',
      'Thu',
      'Fri',
      'Sat',
      'Sun',
    ];
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
                  Expanded(
                    child: Text(
                      w,
                      style: const TextStyle(fontWeight: FontWeight.w600),
                      textAlign: TextAlign.center,
                    ),
                  ),
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
                    Expanded(
                      child: _monthCell(d, groupedByDate, d.month == a.month),
                    ),
                ],
              );
            },
          ),
        ),
      ],
    );
  }

  Widget _monthCell(
    DateTime d,
    Map<String, List<Todo>> groupedByDate,
    bool inMonth,
  ) {
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
              border: Border.all(
                color: Theme.of(context).colorScheme.primary,
                width: 2,
              ),
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
                  Text(
                    '${d.day}',
                    style: TextStyle(
                      fontWeight: FontWeight.w600,
                      color: inMonth ? Colors.black : Colors.black54,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 4),
              for (int i = 0; i < sorted.length && i < maxToShow; i++)
                _monthItemChip(sorted[i]),
              if (more > 0)
                Padding(
                  padding: const EdgeInsets.only(top: 2),
                  child: GestureDetector(
                    onTap: () => _goToDate(ymdStr),
                    child: const Text(
                      '+more',
                      style: TextStyle(fontSize: 11, color: Colors.black54),
                    ),
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
    final bg = t.kind == 'event'
        ? const Color(0xFFEEF2FF)
        : (t.kind == 'habit'
              ? const Color(0xFFEFF7E6)
              : const Color(0xFFFFF4E5));
    final fg = Colors.black87;
    return Container(
      margin: const EdgeInsets.only(bottom: 2),
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(6),
        border: Border.all(color: Colors.black12),
      ),
      child: Text(
        label,
        style: TextStyle(fontSize: 11, color: fg),
        overflow: TextOverflow.ellipsis,
      ),
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
    if (view != View.day) {
      _pendingScrollYmd = null;
      return;
    }
    // Find first item in scheduled matching the target date
    final target = _pendingScrollYmd;
    final idx = scheduled.indexWhere((t) => t.scheduledFor == target);
    if (idx == -1) {
      _pendingScrollYmd = null;
      return;
    }
    final t = scheduled[idx];
    // Compute row key id the same way as in _buildRow
    final keyId = (t.masterId != null && t.scheduledFor != null)
        ? Object.hashAll([t.masterId, t.scheduledFor])
        : t.id;
    final key = _rowKeys[keyId];
    if (key == null) {
      _pendingScrollYmd = null;
      return;
    }
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      try {
        if (key.currentContext != null) {
          await Scrollable.ensureVisible(
            key.currentContext!,
            duration: const Duration(milliseconds: 300),
          );
        }
      } catch (_) {}
      _pendingScrollYmd = null;
    });
  }

  void _goPrev() async {
    final a = parseYmd(anchor);
    DateTime next;
    if (view == View.day)
      next = a.subtract(const Duration(days: 1));
    else if (view == View.week)
      next = a.subtract(const Duration(days: 7));
    else
      next = DateTime(a.year, a.month - 1, a.day);
    setState(() {
      anchor = ymd(next);
    });
    await _refreshAll();
  }

  void _goNext() async {
    final a = parseYmd(anchor);
    DateTime next;
    if (view == View.day)
      next = a.add(const Duration(days: 1));
    else if (view == View.week)
      next = a.add(const Duration(days: 7));
    else
      next = DateTime(a.year, a.month + 1, a.day);
    setState(() {
      anchor = ymd(next);
    });
    await _refreshAll();
  }

  // --- Goals minimal UI ---
  Widget _buildGoalsView() {
    // Always show quick-add for Goals at top
    final goalsQuickAddHeader = Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
      child: Row(
        children: [
          const Expanded(
            child: Text(
              'Goals',
              style: TextStyle(fontWeight: FontWeight.w600, fontSize: 16),
            ),
          ),
          SizedBox(
            width: 240,
            child: TextField(
              key: const Key('qa_goal_title'),
              controller: _qaGoalTitle,
              decoration: const InputDecoration(labelText: 'Title *'),
              textInputAction: TextInputAction.done,
              onSubmitted: (_) => _submitQuickAddGoal(),
              onEditingComplete: _submitQuickAddGoal,
            ),
          ),
          const SizedBox(width: 8),
          DropdownButton<String>(
            value: _qaGoalStatus,
            items: const [
              DropdownMenuItem(value: 'active', child: Text('Active')),
              DropdownMenuItem(value: 'completed', child: Text('Completed')),
              DropdownMenuItem(value: 'archived', child: Text('Archived')),
            ],
            onChanged: (v) => setState(() => _qaGoalStatus = v ?? 'active'),
          ),
          const SizedBox(width: 8),
          SizedBox(
            width: 180,
            child: TextField(
              key: const Key('qa_goal_notes'),
              controller: _qaGoalNotes,
              decoration: const InputDecoration(labelText: 'Notes'),
            ),
          ),
          const SizedBox(width: 8),
          SizedBox(
            width: 80,
            child: TextField(
              key: const Key('qa_goal_current'),
              controller: _qaGoalCurrent,
              decoration: const InputDecoration(labelText: 'Current'),
            ),
          ),
          const SizedBox(width: 8),
          SizedBox(
            width: 80,
            child: TextField(
              key: const Key('qa_goal_target'),
              controller: _qaGoalTarget,
              decoration: const InputDecoration(labelText: 'Target'),
            ),
          ),
          const SizedBox(width: 8),
          SizedBox(
            width: 80,
            child: TextField(
              key: const Key('qa_goal_unit'),
              controller: _qaGoalUnit,
              decoration: const InputDecoration(labelText: 'Unit'),
            ),
          ),
          const SizedBox(width: 8),
          FilledButton(
            onPressed: _addingQuick ? null : _submitQuickAddGoal,
            child: const Text('Add'),
          ),
        ],
      ),
    );

    return Column(
      children: [
        goalsQuickAddHeader,
        Expanded(
          child: FutureBuilder<List<dynamic>>(
            future: api.listGoals(status: _goalsStatusFilter),
            builder: (context, snap) {
              if (snap.connectionState != ConnectionState.done) {
                return const Center(child: CircularProgressIndicator());
              }
              if (snap.hasError) {
                return Center(child: Text('Load failed: ${snap.error}'));
              }
              final raw = snap.data ?? const <dynamic>[];
              final goals = raw
                  .map((e) => Map<String, dynamic>.from(e as Map))
                  .toList();
              goals.sort((a, b) => (a['id'] as int).compareTo(b['id'] as int));
              return ListView(
                padding: const EdgeInsets.all(12),
                children: [
                  const SizedBox(height: 8),
                  Builder(
                    builder: (context) {
                      int all = goals.length;
                      int active = goals
                          .where((g) => (g['status'] as String?) == 'active')
                          .length;
                      int completed = goals
                          .where((g) => (g['status'] as String?) == 'completed')
                          .length;
                      int archived = goals
                          .where((g) => (g['status'] as String?) == 'archived')
                          .length;
                      return Wrap(
                        spacing: 8,
                        runSpacing: 6,
                        children: [
                          _filterChip(
                            'All $all',
                            _goalsStatusFilter == null,
                            () {
                              setState(() {
                                _goalsStatusFilter = null;
                              });
                            },
                          ),
                          _filterChip(
                            'Active $active',
                            _goalsStatusFilter == 'active',
                            () {
                              setState(() {
                                _goalsStatusFilter =
                                    (_goalsStatusFilter == 'active')
                                    ? null
                                    : 'active';
                              });
                            },
                          ),
                          _filterChip(
                            'Completed $completed',
                            _goalsStatusFilter == 'completed',
                            () {
                              setState(() {
                                _goalsStatusFilter =
                                    (_goalsStatusFilter == 'completed')
                                    ? null
                                    : 'completed';
                              });
                            },
                          ),
                          _filterChip(
                            'Archived $archived',
                            _goalsStatusFilter == 'archived',
                            () {
                              setState(() {
                                _goalsStatusFilter =
                                    (_goalsStatusFilter == 'archived')
                                    ? null
                                    : 'archived';
                              });
                            },
                          ),
                        ],
                      );
                    },
                  ),
                  const SizedBox(height: 8),
                  ...goals.map((g) => _goalRow(g)).toList(),
                ],
              );
            },
          ),
        ),
      ],
    );
  }

  Widget _goalRow(Map<String, dynamic> g) {
    final status = (g['status'] as String?) ?? 'active';
    final cpv = (g['currentProgressValue'] as num?)?.toDouble();
    final tpv = (g['targetProgressValue'] as num?)?.toDouble();
    final unit = (g['progressUnit'] as String?) ?? '';
    String progressText = '';
    if (tpv != null) {
      final cur = cpv ?? 0;
      progressText = unit.isNotEmpty
          ? '${cur.toStringAsFixed(cur.truncateToDouble() == cur ? 0 : 1)} / ${tpv.toStringAsFixed(tpv.truncateToDouble() == tpv ? 0 : 1)} $unit'
          : '${cur.toStringAsFixed(cur.truncateToDouble() == cur ? 0 : 1)} / ${tpv.toStringAsFixed(tpv.truncateToDouble() == tpv ? 0 : 1)}';
    }
    return Card(
      child: ListTile(
        title: Row(
          children: [
            _statusPill(status),
            const SizedBox(width: 6),
            Expanded(child: Text(g['title'] as String? ?? '')),
          ],
        ),
        subtitle: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if ((g['notes'] as String?)?.isNotEmpty == true)
              Text(g['notes'] as String),
            if (progressText.isNotEmpty)
              Text(
                progressText,
                style: TextStyle(color: Colors.grey.shade700, fontSize: 12),
              ),
          ],
        ),
        trailing: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            PopupMenuButton<String>(
              tooltip: 'Change status',
              onSelected: (v) async {
                try {
                  await api.updateGoal(g['id'] as int, {'status': v});
                  setState(() {});
                } catch (_) {}
              },
              itemBuilder: (c) => const [
                PopupMenuItem(value: 'active', child: Text('Active')),
                PopupMenuItem(value: 'completed', child: Text('Completed')),
                PopupMenuItem(value: 'archived', child: Text('Archived')),
              ],
              child: const Icon(Icons.more_vert),
            ),
            IconButton(
              icon: const Icon(Icons.chevron_right),
              onPressed: () => _openGoalDetail(g['id'] as int),
            ),
          ],
        ),
      ),
    );
  }

  Widget _statusPill(String s) {
    Color bg;
    Color fg;
    switch (s) {
      case 'completed':
        bg = const Color(0xFFD3F9D8);
        fg = const Color(0xFF205B2A);
        break;
      case 'archived':
        bg = const Color(0xFFE9ECEF);
        fg = const Color(0xFF495057);
        break;
      default:
        bg = const Color(0xFFE7F5FF);
        fg = const Color(0xFF17496E);
        break;
    }
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(s, style: TextStyle(color: fg, fontSize: 11)),
    );
  }

  Future<void> _openGoalDetail(int id) async {
    try {
      final goal = await api.getGoal(
        id,
        includeItems: true,
        includeChildren: true,
      );
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
                  if ((goal['notes'] as String?)?.isNotEmpty == true)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: Text(goal['notes'] as String),
                    ),
                  Text('Status: ${(goal['status'] as String?) ?? 'active'}'),
                  const SizedBox(height: 12),
                  const Text('Items'),
                  const SizedBox(height: 6),
                  ...(goal['items'] != null && goal['items']['todos'] is List
                      ? (goal['items']['todos'] as List)
                            .map<Map<String, dynamic>>(
                              (e) => Map<String, dynamic>.from(e as Map),
                            )
                            .map(
                              (t) => Row(
                                children: [
                                  const Icon(
                                    Icons.check_circle_outline,
                                    size: 14,
                                  ),
                                  const SizedBox(width: 6),
                                  Expanded(
                                    child: Text(t['title'] as String? ?? ''),
                                  ),
                                  IconButton(
                                    icon: const Icon(Icons.link_off, size: 16),
                                    onPressed: () async {
                                      await api.removeGoalTodoItem(
                                        id,
                                        t['id'] as int,
                                      );
                                      Navigator.pop(c);
                                      _openGoalDetail(id);
                                    },
                                  ),
                                ],
                              ),
                            )
                            .toList()
                      : const <Widget>[]),
                  ...(goal['items'] != null && goal['items']['events'] is List
                      ? (goal['items']['events'] as List)
                            .map<Map<String, dynamic>>(
                              (e) => Map<String, dynamic>.from(e as Map),
                            )
                            .map(
                              (ev) => Row(
                                children: [
                                  const Icon(Icons.event, size: 14),
                                  const SizedBox(width: 6),
                                  Expanded(
                                    child: Text(ev['title'] as String? ?? ''),
                                  ),
                                  IconButton(
                                    icon: const Icon(Icons.link_off, size: 16),
                                    onPressed: () async {
                                      await api.removeGoalEventItem(
                                        id,
                                        ev['id'] as int,
                                      );
                                      Navigator.pop(c);
                                      _openGoalDetail(id);
                                    },
                                  ),
                                ],
                              ),
                            )
                            .toList()
                      : const <Widget>[]),
                  const SizedBox(height: 12),
                  const Text('Children'),
                  const SizedBox(height: 6),
                  ...(goal['children'] is List
                      ? (goal['children'] as List)
                            .map<int>((e) => (e as int))
                            .map(
                              (cid) => Row(
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
                                  ),
                                ],
                              ),
                            )
                            .toList()
                      : const <Widget>[]),
                  const SizedBox(height: 12),
                  const Divider(height: 1),
                  const SizedBox(height: 8),
                  const Text('Link items (IDs, comma-separated)'),
                  const SizedBox(height: 6),
                  Row(
                    children: [
                      Expanded(
                        child: TextField(
                          controller: addTodoCtrl,
                          decoration: const InputDecoration(
                            labelText: 'Todo IDs',
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: TextField(
                          controller: addEventCtrl,
                          decoration: const InputDecoration(
                            labelText: 'Event IDs',
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      FilledButton(
                        onPressed: () async {
                          try {
                            final todos = addTodoCtrl.text
                                .split(',')
                                .map((s) => int.tryParse(s.trim()))
                                .whereType<int>()
                                .toList();
                            final events = addEventCtrl.text
                                .split(',')
                                .map((s) => int.tryParse(s.trim()))
                                .whereType<int>()
                                .toList();
                            await api.addGoalItems(
                              id,
                              todos: todos.isEmpty ? null : todos,
                              events: events.isEmpty ? null : events,
                            );
                            Navigator.pop(c);
                            _openGoalDetail(id);
                          } catch (e) {
                            if (context.mounted)
                              ScaffoldMessenger.of(context).showSnackBar(
                                SnackBar(content: Text('Link failed: $e')),
                              );
                          }
                        },
                        child: const Text('Add'),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  const Text('Add child (Goal ID)'),
                  const SizedBox(height: 6),
                  Row(
                    children: [
                      Expanded(
                        child: TextField(
                          controller: addChildCtrl,
                          decoration: const InputDecoration(
                            labelText: 'Child goal ID',
                          ),
                        ),
                      ),
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
                            if (context.mounted)
                              ScaffoldMessenger.of(context).showSnackBar(
                                SnackBar(content: Text('Add child failed: $e')),
                              );
                          }
                        },
                        child: const Text('Add Child'),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () async {
                Navigator.pop(c);
                await _openEditGoalDialog(goal);
              },
              child: const Text('Edit'),
            ),
            TextButton(
              onPressed: () async {
                try {
                  await api.deleteGoal(id);
                  Navigator.pop(c);
                  setState(() {});
                } catch (e) {
                  if (context.mounted)
                    ScaffoldMessenger.of(context).showSnackBar(
                      SnackBar(content: Text('Delete failed: $e')),
                    );
                }
              },
              child: const Text('Delete'),
            ),
            TextButton(
              onPressed: () => Navigator.pop(c),
              child: const Text('Close'),
            ),
          ],
        ),
      );
    } catch (e) {
      setState(() => message = 'Load goal failed: $e');
    }
  }

  // Deprecated goal create dialog removed; use inline quick-add instead
  Future<void> _openCreateGoalDialog() async {}

  Future<void> _openEditGoalDialog(Map<String, dynamic> goal) async {
    final titleCtrl = TextEditingController(
      text: goal['title'] as String? ?? '',
    );
    final notesCtrl = TextEditingController(
      text: goal['notes'] as String? ?? '',
    );
    String status = (goal['status'] as String?) ?? 'active';
    final currentCtrl = TextEditingController(
      text: ((goal['currentProgressValue'] as num?)?.toString() ?? ''),
    );
    final targetCtrl = TextEditingController(
      text: ((goal['targetProgressValue'] as num?)?.toString() ?? ''),
    );
    final unitCtrl = TextEditingController(
      text: (goal['progressUnit'] as String?) ?? '',
    );
    final id = goal['id'] as int;
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => StatefulBuilder(
        builder: (c, setDlgState) {
          return AlertDialog(
            title: const Text('Edit goal'),
            content: SizedBox(
              width: 420,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  TextField(
                    controller: titleCtrl,
                    decoration: const InputDecoration(labelText: 'Title'),
                  ),
                  TextField(
                    controller: notesCtrl,
                    decoration: const InputDecoration(labelText: 'Notes'),
                  ),
                  Row(
                    children: [
                      Expanded(
                        child: TextField(
                          controller: currentCtrl,
                          decoration: const InputDecoration(
                            labelText: 'Current',
                          ),
                          keyboardType: TextInputType.number,
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: TextField(
                          controller: targetCtrl,
                          decoration: const InputDecoration(
                            labelText: 'Target',
                          ),
                          keyboardType: TextInputType.number,
                        ),
                      ),
                    ],
                  ),
                  TextField(
                    controller: unitCtrl,
                    decoration: const InputDecoration(
                      labelText: 'Unit (optional)',
                    ),
                  ),
                  DropdownButtonFormField<String>(
                    value: status,
                    decoration: const InputDecoration(labelText: 'Status'),
                    items: const [
                      DropdownMenuItem(value: 'active', child: Text('Active')),
                      DropdownMenuItem(
                        value: 'completed',
                        child: Text('Completed'),
                      ),
                      DropdownMenuItem(
                        value: 'archived',
                        child: Text('Archived'),
                      ),
                    ],
                    onChanged: (v) => setDlgState(() => status = v ?? 'active'),
                  ),
                ],
              ),
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(c, false),
                child: const Text('Cancel'),
              ),
              FilledButton(
                onPressed: () => Navigator.pop(c, true),
                child: const Text('Save'),
              ),
            ],
          );
        },
      ),
    );
    if (ok != true) return;
    try {
      final current = double.tryParse(currentCtrl.text.trim());
      final target = double.tryParse(targetCtrl.text.trim());
      final unit = unitCtrl.text.trim();
      await api.updateGoal(id, {
        'title': titleCtrl.text.trim(),
        'notes': notesCtrl.text,
        'status': status,
        'currentProgressValue': current,
        'targetProgressValue': target,
        'progressUnit': unit,
      });
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
          color: selected
              ? Theme.of(context).colorScheme.primary.withOpacity(0.1)
              : Colors.grey.shade100,
          borderRadius: BorderRadius.circular(999),
          border: Border.all(
            color: selected
                ? Theme.of(context).colorScheme.primary
                : Colors.grey.shade300,
          ),
        ),
        child: Text(
          label,
          style: TextStyle(
            color: selected
                ? Theme.of(context).colorScheme.primary
                : Colors.black87,
            fontSize: 12,
          ),
        ),
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
    // Build a small extra badge for habits with streaks if stats available
    Widget? extraBadge;
    if (t.kind == 'habit') {
      final stats = (t.masterId != null)
          ? habitStatsById[t.masterId!]
          : habitStatsById[t.id];
      final int current = (stats != null && stats['currentStreak'] is int)
          ? stats['currentStreak'] as int
          : 0;
      final int longest = (stats != null && stats['longestStreak'] is int)
          ? stats['longestStreak'] as int
          : 0;
      extraBadge = Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.surfaceContainerHigh,
          borderRadius: BorderRadius.circular(999),
          border: Border.all(color: Theme.of(context).colorScheme.outline),
        ),
        child: Text(
          '🔥 $current / $longest',
          style: TextStyle(
            fontSize: 11,
            color: Theme.of(context).colorScheme.onSurfaceVariant,
          ),
        ),
      );
    } else if (t.kind == 'todo' || t.kind == 'event' || t.kind == null) {
      final key = '${t.kind ?? 'todo'}:${t.masterId ?? t.id}';
      final info = _itemGoalByKey[key];
      if (info != null) {
        final goalTitle = (info['title'] as String?) ?? 'Goal';
        final goalId = info['goalId'] as int?;
        extraBadge = InkWell(
          onTap: (goalId == null) ? null : () => _openGoalDetail(goalId),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
            decoration: BoxDecoration(
              color: Colors.grey.shade100,
              borderRadius: BorderRadius.circular(999),
              border: Border.all(color: Colors.grey.shade300),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(
                  Icons.flag_outlined,
                  size: 12,
                  color: Colors.black54,
                ),
                const SizedBox(width: 4),
                Text(
                  goalTitle,
                  style: const TextStyle(fontSize: 11, color: Colors.black87),
                ),
              ],
            ),
          ),
        );
      }
    }
    final keyId = t.masterId != null && t.scheduledFor != null
        ? Object.hashAll([t.masterId, t.scheduledFor])
        : t.id;
    final key = _rowKeys.putIfAbsent(keyId, () => GlobalKey());
    return KeyedSubtree(
      key: key,
      child: row.TodoRow(
        todo: like,
        onToggleCompleted: () => _toggleCompleted(t),
        onEdit: () => (t.kind == 'event')
            ? _editEvent(t)
            : (t.kind == 'habit')
            ? _editHabit(t)
            : _editTodo(t),
        onDelete: () => _deleteTodo(t),
        highlighted: _highlightedId == t.id,
        extraBadge: extraBadge,
        onTitleEdited: (newTitle) async {
          try {
            if (t.kind == 'event') {
              await api.updateEvent(t.id, {
                'title': newTitle,
                'recurrence': t.recurrence ?? {'type': 'none'},
              });
            } else if (t.kind == 'habit') {
              await api.updateHabit(t.id, {
                'title': newTitle,
                'recurrence': t.recurrence ?? {'type': 'daily'},
              });
            } else {
              await api.updateTodo(t.id, {
                'title': newTitle,
                'recurrence': t.recurrence ?? {'type': 'none'},
              });
            }
            setState(() {
              t.title = newTitle;
            });
          } catch (_) {}
        },
        onPriorityEdited: (newPriority) async {
          try {
            if (t.kind == 'event') {
              await api.updateEvent(t.id, {
                'priority': newPriority,
                'recurrence': t.recurrence ?? {'type': 'none'},
              });
            } else if (t.kind == 'habit') {
              await api.updateHabit(t.id, {
                'priority': newPriority,
                'recurrence': t.recurrence ?? {'type': 'daily'},
              });
            } else {
              await api.updateTodo(t.id, {
                'priority': newPriority,
                'recurrence': t.recurrence ?? {'type': 'none'},
              });
            }
            setState(() {
              t.priority = newPriority;
            });
          } catch (_) {}
        },
        onTimeEdited: (newTime) async {
          try {
            if (t.kind == 'event') {
              // For events, map to startTime if only single time shown in list
              await api.updateEvent(t.id, {
                'startTime': newTime,
                'recurrence': t.recurrence ?? {'type': 'none'},
              });
              setState(() {
                t.timeOfDay = newTime;
              });
            } else if (t.kind == 'habit') {
              await api.updateHabit(t.id, {
                'timeOfDay': newTime,
                'recurrence': t.recurrence ?? {'type': 'daily'},
              });
              setState(() {
                t.timeOfDay = newTime;
              });
            } else {
              await api.updateTodo(t.id, {
                'timeOfDay': newTime,
                'recurrence': t.recurrence ?? {'type': 'none'},
              });
              setState(() {
                t.timeOfDay = newTime;
              });
            }
          } catch (_) {}
        },
      ),
    );
  }

  Widget _buildHabitsList() {
    // Always show quick-add for Habits at top
    final quickAddHeader = Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
      child: Row(
        children: [
          Expanded(
            child: Wrap(
              spacing: 8,
              runSpacing: 6,
              children: [_quickAddInline()],
            ),
          ),
        ],
      ),
    );

    // Build Mon-Sun range from current anchor week
    final a = parseYmd(anchor);
    final monday = a.subtract(Duration(days: (a.weekday + 6) % 7));
    final week = List<DateTime>.generate(
      7,
      (i) => monday.add(Duration(days: i)),
    );
    final weekY = week.map((d) => ymd(d)).toList();
    // Prepare habits
    final items = scheduled.where((t) => t.kind == 'habit').toList()
      ..sort((a, b) => (a.title).compareTo(b.title));
    final rows = items
        .map(
          (t) => ht.HabitRowData(
            id: t.masterId ?? t.id,
            title: t.title,
            priority: t.priority,
          ),
        )
        .toList();

    // Optimistic toggle helper
    Future<void> toggleHabit(int hid, String y, bool newCompleted) async {
      // Optimistic update of weekHeatmap and (if today) currentStreak
      final prev = Map<int, Map<String, dynamic>>.from(habitStatsById);
      try {
        final stats = Map<String, dynamic>.from(
          habitStatsById[hid] ?? const <String, dynamic>{},
        );
        final List<dynamic> heat = (stats['weekHeatmap'] is List)
            ? List<dynamic>.from(stats['weekHeatmap'] as List)
            : <dynamic>[];
        for (int i = 0; i < heat.length; i++) {
          final e = heat[i];
          if (e is Map && e['date'] == y) {
            heat[i] = {'date': y, 'completed': newCompleted};
            break;
          }
        }
        final todayY = ymd(DateTime.now());
        int current = (stats['currentStreak'] as int?) ?? 0;
        if (y == todayY)
          current = newCompleted
              ? (current + 1)
              : (current > 0 ? current - 1 : 0);
        final updated = {
          ...stats,
          'weekHeatmap': heat,
          'currentStreak': current,
        };
        setState(() {
          habitStatsById = {...habitStatsById, hid: updated};
        });
        await api.toggleHabitOccurrence(hid, y, newCompleted);
        // Optionally refresh to reconcile server state
        await _refreshAll();
      } catch (e) {
        setState(() {
          habitStatsById = prev;
        });
        if (mounted)
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Update failed. Reverted.')),
          );
      }
    }

    final isNarrow = MediaQuery.of(context).size.width < 1100;
    if (!isNarrow) {
      return Column(
        children: [
          quickAddHeader,
          Expanded(
            child: ht.HabitsTracker(
              habits: rows,
              weekYmd: weekY,
              statsById: habitStatsById.map((k, v) => MapEntry(k, v)),
              onToggle: (hid, y, newCompleted) =>
                  toggleHabit(hid, y, newCompleted),
            ),
          ),
        ],
      );
    }

    // Narrow layout: left list + right focus grid
    if (_selectedHabitId == null && rows.isNotEmpty)
      _selectedHabitId = rows.first.id;
    final selectedId = _selectedHabitId;
    final selectedStats = (selectedId != null)
        ? habitStatsById[selectedId]
        : null;
    final Set<String> completedSet = {
      if (selectedStats != null && selectedStats['weekHeatmap'] is List)
        ...((selectedStats['weekHeatmap'] as List)
            .where((e) => e is Map && e['completed'] == true)
            .map<String>((e) => (e as Map)['date'] as String)),
    };
    final todayY = ymd(DateTime.now());

    return Column(
      children: [
        quickAddHeader,
        Expanded(
          child: Row(
            children: [
              // Left list
              SizedBox(
                width: 260,
                child: ListView(
                  padding: const EdgeInsets.all(12),
                  children: rows.map((h) {
                    final isSel = h.id == selectedId;
                    final s = habitStatsById[h.id] ?? const <String, dynamic>{};
                    final current = (s['currentStreak'] as int?) ?? 0;
                    final longest = (s['longestStreak'] as int?) ?? 0;
                    return InkWell(
                      onTap: () => setState(() {
                        _selectedHabitId = h.id;
                      }),
                      child: Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 10,
                          vertical: 8,
                        ),
                        margin: const EdgeInsets.only(bottom: 8),
                        decoration: BoxDecoration(
                          border: Border.all(
                            color: isSel
                                ? Theme.of(context).colorScheme.primary
                                : Colors.grey.shade300,
                            width: isSel ? 2 : 1,
                          ),
                          borderRadius: BorderRadius.circular(6),
                        ),
                        child: Row(
                          children: [
                            _priorityBadge(h.priority),
                            const SizedBox(width: 6),
                            Expanded(
                              child: Text(
                                h.title,
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                            const SizedBox(width: 8),
                            Container(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 8,
                                vertical: 2,
                              ),
                              decoration: BoxDecoration(
                                color: const Color(0xFFEFF1F3),
                                borderRadius: BorderRadius.circular(999),
                                border: Border.all(
                                  color: const Color(0xFFCDD3D8),
                                ),
                              ),
                              child: Text(
                                '🔥 $current / $longest',
                                style: const TextStyle(
                                  fontSize: 11,
                                  color: Color(0xFF616975),
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                    );
                  }).toList(),
                ),
              ),
              const VerticalDivider(width: 1),
              // Right single-habit grid with keyboard nav
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      _buildWeekdayHeader(),
                      const Divider(height: 1),
                      const SizedBox(height: 8),
                      Focus(
                        autofocus: true,
                        onKeyEvent: (node, event) {
                          if (event is! KeyDownEvent)
                            return KeyEventResult.ignored;
                          if (event.logicalKey ==
                              LogicalKeyboardKey.arrowLeft) {
                            setState(() {
                              _habitFocusCol = (_habitFocusCol - 1).clamp(0, 6);
                            });
                            return KeyEventResult.handled;
                          }
                          if (event.logicalKey ==
                              LogicalKeyboardKey.arrowRight) {
                            setState(() {
                              _habitFocusCol = (_habitFocusCol + 1).clamp(0, 6);
                            });
                            return KeyEventResult.handled;
                          }
                          if (event.logicalKey == LogicalKeyboardKey.home) {
                            setState(() {
                              _habitFocusCol = 0;
                            });
                            return KeyEventResult.handled;
                          }
                          if (event.logicalKey == LogicalKeyboardKey.end) {
                            setState(() {
                              _habitFocusCol = 6;
                            });
                            return KeyEventResult.handled;
                          }
                          if (event.logicalKey == LogicalKeyboardKey.space) {
                            if (selectedId != null) {
                              final y = weekY[_habitFocusCol];
                              final newCompleted = !completedSet.contains(y);
                              toggleHabit(selectedId, y, newCompleted);
                            }
                            return KeyEventResult.handled;
                          }
                          return KeyEventResult.ignored;
                        },
                        child: Row(
                          children: [
                            for (int i = 0; i < 7; i++)
                              Padding(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 4,
                                ),
                                child: _habitDayCell(
                                  dateYmd: weekY[i],
                                  isToday: weekY[i] == todayY,
                                  completed: completedSet.contains(weekY[i]),
                                  focused: i == _habitFocusCol,
                                  onTap: (selectedId == null)
                                      ? null
                                      : () => toggleHabit(
                                          selectedId,
                                          weekY[i],
                                          !completedSet.contains(weekY[i]),
                                        ),
                                ),
                              ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _habitDayCell({
    required String dateYmd,
    required bool isToday,
    required bool completed,
    required bool focused,
    VoidCallback? onTap,
  }) {
    final bg = completed
        ? Theme.of(context).colorScheme.surfaceContainerHighest.withOpacity(0.8)
        : Colors.transparent;
    final borderColor = Theme.of(context).colorScheme.outlineVariant;
    return InkWell(
      onTap: onTap,
      child: Container(
        width: 36,
        height: 32,
        decoration: BoxDecoration(
          color: bg,
          borderRadius: BorderRadius.circular(6),
          border: Border.all(color: borderColor),
        ),
        child: Stack(
          children: [
            if (isToday)
              Container(
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(6),
                  border: Border.all(
                    color: Theme.of(
                      context,
                    ).colorScheme.primary.withOpacity(0.3),
                  ),
                ),
              ),
            if (focused)
              Container(
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(6),
                  border: Border.all(
                    color: Theme.of(
                      context,
                    ).colorScheme.primary.withOpacity(0.15),
                    width: 2,
                  ),
                ),
              ),
          ],
        ),
      ),
    );
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
        break;
    }
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(p, style: TextStyle(color: fg, fontSize: 12)),
    );
  }
}
