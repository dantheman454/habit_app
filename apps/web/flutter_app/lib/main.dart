import 'package:flutter/material.dart';
import 'dart:async';
import 'util/context_colors.dart';
import 'widgets/assistant_panel.dart';
import 'views/day_view.dart';
import 'views/week_view.dart';
import 'views/month_view.dart';
import 'package:flutter/gestures.dart';

import 'widgets/todo_row.dart' as row;
import 'widgets/habits_tracker.dart' as ht;

import 'widgets/fab_actions.dart';
import 'widgets/compact_subheader.dart';

import 'api.dart' as api;
import 'package:dio/dio.dart';
import 'package:flutter/services.dart';
import 'dart:math' as math;
import 'dart:ui' as ui;
import 'util/storage.dart' as storage;
import 'util/animation.dart';
import 'models.dart';

// --- Test hooks and injectable API (local single-user context) ---
class TestHooks {
  static bool skipRefresh = false;
}

var createTodoFn = (Map<String, dynamic> data) async {
  final res = await api.callMCPTool('create_todo', data);
  try {
    final results = (res['results'] as List<dynamic>?);
    if (results != null && results.isNotEmpty) {
      final first = results.first as Map<String, dynamic>;
      final todo = first['todo'];
      if (todo is Map) return Map<String, dynamic>.from(todo);
    }
  } catch (_) {}
  throw Exception('create_todo_failed');
};
var createEventFn = api.createEvent;
var createHabitFn = api.createHabit;
var createGoalFn = api.createGoal;
void main() {
  runApp(const App());
}

// Temporary feature flag to gate the new DayView integration (default off).
// Can be enabled at runtime via URL query: ?features=newday
// Feature flags removed: new Day/Week/Month views are now default paths

// ----- Models -----
class Todo {
  final int id;
  String title;
  String notes;
  String? kind; // 'todo'|'event'|'habit' for unified schedule rows
  String? scheduledFor; // YYYY-MM-DD or null
  String? timeOfDay; // HH:MM or null
  String? endTime; // HH:MM or null (for events)
  String? priority; // low|medium|high
  bool completed;
  String? status; // 'pending'|'completed'|'skipped' for todos
  Map<String, dynamic>? recurrence; // {type,...}
  int? masterId; // present on expanded occurrences
  String? context; // 'school'|'personal'|'work'
  final String createdAt;
  String updatedAt;

  Todo({
    required this.id,
    required this.title,
    required this.notes,
    this.kind,
    required this.scheduledFor,
    required this.timeOfDay,
    this.endTime,
    this.priority,
    required this.completed,
    this.status,
    required this.recurrence,
    required this.masterId,
    this.context,
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
    endTime: j['endTime'] as String?,
    priority: j['priority'] as String?,
    completed: j['completed'] as bool? ?? false,
    status: j['status'] as String?,
    recurrence: j['recurrence'] as Map<String, dynamic>?,
    masterId: j['masterId'] as int?,
    context: j['context'] as String?,
    createdAt: j['createdAt'] as String? ?? '',
    updatedAt: j['updatedAt'] as String? ?? '',
  );
}

class LlmOperation {
  final String op; // create|update|delete|complete
  // V3 shape support
  final String? kind; // todo|event|habit|goal
  final String? action; // create|update|delete|complete|complete_occurrence
  final int? id;
  final String? title;
  final String? notes;
  final String? scheduledFor;
  final String? priority;
  final bool? completed;
  final String? timeOfDay; // HH:MM or null
  // Event-specific optional fields
  final String? startTime; // HH:MM
  final String? endTime; // HH:MM
  final String? location;
  final Map<String, dynamic>? recurrence; // {type, intervalDays, until}
  // Occurrence completion support
  final String? occurrenceDate; // YYYY-MM-DD for complete_occurrence
  LlmOperation({
    required this.op,
    this.kind,
    this.action,
    this.id,
    this.title,
    this.notes,
    this.scheduledFor,
    this.priority,
    this.completed,
    this.timeOfDay,
    this.startTime,
    this.endTime,
    this.location,
    this.recurrence,
    this.occurrenceDate,
  });
  factory LlmOperation.fromJson(Map<String, dynamic> j) => LlmOperation(
    op: (() {
      final rawOp = j['op'];
      if (rawOp is String && rawOp.isNotEmpty) return rawOp;
      final k = j['kind'];
      final a = j['action'];
      if (a is String && a.isNotEmpty) {
        if (k is String && k.isNotEmpty) return '$k:$a';
        return a;
      }
      return 'op';
    })(),
    kind: (j['kind'] is String) ? j['kind'] as String : null,
    action: (j['action'] is String) ? j['action'] as String : null,
    id: j['id'] is int
        ? j['id'] as int
        : (j['id'] is String ? int.tryParse(j['id']) : null),
    title: j['title'] as String?,
    notes: j['notes'] as String?,
    scheduledFor: j['scheduledFor'] as String?,
    // priority removed
    completed: j['completed'] as bool?,
    timeOfDay: j['timeOfDay'] as String?,
    startTime: j['startTime'] as String?,
    endTime: j['endTime'] as String?,
    location: j['location'] as String?,
    recurrence: j['recurrence'] == null
        ? null
        : Map<String, dynamic>.from(j['recurrence']),
    occurrenceDate: j['occurrenceDate'] as String?,
  );
  Map<String, dynamic> toJson() => {
    'op': op,
    if (kind != null) 'kind': kind,
    if (action != null) 'action': action,
    if (id != null) 'id': id,
    if (title != null) 'title': title,
    if (notes != null) 'notes': notes,
    if (scheduledFor != null) 'scheduledFor': scheduledFor,
    // priority removed
    if (completed != null) 'completed': completed,
    if (timeOfDay != null) 'timeOfDay': timeOfDay,
    if (startTime != null) 'startTime': startTime,
    if (endTime != null) 'endTime': endTime,
    if (location != null) 'location': location,
    if (recurrence != null) 'recurrence': recurrence,
    if (occurrenceDate != null) 'occurrenceDate': occurrenceDate,
  };
}

class AnnotatedOp {
  final LlmOperation op;
  final List<String> errors;
  AnnotatedOp({required this.op, required this.errors});
  factory AnnotatedOp.fromJson(Map<String, dynamic> j) => AnnotatedOp(
    op: (() {
      final raw = j['op'];
      if (raw is Map)
        return LlmOperation.fromJson(Map<String, dynamic>.from(raw));
      // Some servers may send flat shape without wrapping under 'op'
      return LlmOperation.fromJson(j);
    })(),
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

class App extends StatelessWidget {
  const App({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Habitus',
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

class DateNavigation extends StatelessWidget {
  final VoidCallback onPrev;
  final VoidCallback onNext;
  final VoidCallback onToday;
  final String currentDate;

  const DateNavigation({
    super.key,
    required this.onPrev,
    required this.onNext,
    required this.onToday,
    required this.currentDate,
  });

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        IconButton(icon: const Icon(Icons.chevron_left), onPressed: onPrev),
        Text(currentDate, style: Theme.of(context).textTheme.titleMedium),
        IconButton(icon: const Icon(Icons.chevron_right), onPressed: onNext),
      ],
    );
  }
}

class FilterBar extends StatelessWidget {
  final ViewMode currentView;
  final void Function(ViewMode) onViewChanged;
  final VoidCallback? onDatePrev;
  final VoidCallback? onDateNext;
  final VoidCallback? onDateToday;
  final String currentDate;

  final String? selectedContext;
  final void Function(String?) onContextChanged;
  final bool showCompleted;
  final void Function(bool) onShowCompletedChanged;

  const FilterBar({
    super.key,
    required this.currentView,
    required this.onViewChanged,
    this.onDatePrev,
    this.onDateNext,
    this.onDateToday,
    required this.currentDate,

    required this.selectedContext,
    required this.onContextChanged,
    required this.showCompleted,
    required this.onShowCompletedChanged,
  });

  @override
  Widget build(BuildContext context) {
    return AnimatedContainer(
      duration: const Duration(milliseconds: 400),
      curve: Curves.easeOutCubic,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surfaceContainerLow,
        border: Border(
          bottom: BorderSide(
            color: Theme.of(context).colorScheme.outlineVariant,
            width: 1,
          ),
        ),
      ),
      child: Column(
        children: [
          // Primary filters row
          Row(
            children: [
              // View mode filters
              SegmentedButton<ViewMode>(
                segments: const [
                  ButtonSegment(value: ViewMode.day, label: Text('Day')),
                  ButtonSegment(value: ViewMode.week, label: Text('Week')),
                  ButtonSegment(value: ViewMode.month, label: Text('Month')),
                ],
                selected: {currentView},
                onSelectionChanged: (s) => onViewChanged(s.first),
              ),

              const SizedBox(width: 16),

              // Date navigation
              if (onDatePrev != null &&
                  onDateNext != null &&
                  onDateToday != null)
                DateNavigation(
                  onPrev: onDatePrev!,
                  onNext: onDateNext!,
                  onToday: onDateToday!,
                  currentDate: currentDate,
                ),

              const Spacer(),
            ],
          ),

          const SizedBox(height: 8),

          // Secondary filters row
          Row(
            children: [
              // Context filters
              _buildContextFilters(context),

              const Spacer(),

              // Show completed toggle
              Row(
                children: [
                  const Icon(Icons.check_circle_outline, size: 16),
                  const SizedBox(width: 8),
                  const Text('Show Completed'),
                  const SizedBox(width: 8),
                  Switch(
                    value: showCompleted,
                    onChanged: onShowCompletedChanged,
                  ),
                ],
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildContextFilters(BuildContext context) {
    return Wrap(
      spacing: 8,
      runSpacing: 4,
      children: [
        _buildContextChip('All', null, Icons.public, context),
        _buildContextChip('School', 'school', Icons.school, context),
        _buildContextChip('Personal', 'personal', Icons.person, context),
        _buildContextChip('Work', 'work', Icons.work, context),
      ],
    );
  }

  Widget _buildContextChip(
    String label,
    String? contextValue,
    IconData icon,
    BuildContext context,
  ) {
    final active = selectedContext == contextValue;
    final color = contextValue != null
        ? ContextColors.getContextColor(contextValue)
        : Colors.grey.shade600;
    return AnimatedScale(
      duration: const Duration(milliseconds: 200),
      scale: active ? 1.05 : 1.0,
      child: FilterChip(
        label: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              icon,
              size: 16,
              color: Colors.black87,
            ), // Always black for contrast
            const SizedBox(width: 4),
            Text(
              label,
              style: const TextStyle(color: Colors.black87),
            ), // Always black for contrast
          ],
        ),
        selected: active,
        onSelected: (_) => onContextChanged(contextValue),
        backgroundColor: ContextColors.getContextButtonColor(
          contextValue,
          false,
        ), // Always colored background
        selectedColor: ContextColors.getContextButtonColor(
          contextValue,
          true,
        ), // Full color when selected
        checkmarkColor: Colors.black87, // Black checkmark for contrast
      ),
    );
  }
}

DateRange rangeForView(String anchor, ViewMode view) {
  final a = parseYmd(anchor);
  if (view == ViewMode.day) {
    final s = ymd(a);
    return DateRange(from: s, to: s);
  } else if (view == ViewMode.week) {
    // NEW: Sunday-based calculation
    final weekday = a.weekday; // 1=Mon..7=Sun
    final sunday = a.subtract(
      Duration(days: weekday % 7),
    ); // Sunday = 7, so 7%7=0, Monday=1, so 1%7=1, etc.
    final saturday = sunday.add(const Duration(days: 6));
    return DateRange(from: ymd(sunday), to: ymd(saturday));
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
  ViewMode view = ViewMode.day;
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

  // Search filter state
  String _searchScope = 'all'; // 'all', 'todo', 'event', 'habit'
  String? _searchContext; // null for 'all', or 'personal', 'work', 'school'
  String _searchStatusTodo = 'pending'; // 'pending', 'completed', 'skipped'
  bool?
  _searchCompleted; // null for 'all', true for completed, false for incomplete

  // Today highlight animation state
  bool _todayPulseActive = false;

  // Map of row keys for ensureVisible
  final Map<int, GlobalKey> _rowKeys = {};

  MainView mainView = MainView.tasks;

  String? _goalsStatusFilter; // null=all | 'active'|'completed'|'archived'

  // Context filter state
  String? selectedContext; // 'school', 'personal', 'work', null for 'all'

  // Data
  List<Todo> scheduled = [];
  List<Todo> scheduledAllTime = [];
  List<Todo> searchResults = [];
  // Habit stats for current range (by habit id)
  Map<int, Map<String, dynamic>> habitStatsById = {};
  // Goal badges mapping: key `${kind}:${masterOrId}` -> { goalId, title }
  Map<String, Map<String, dynamic>> _itemGoalByKey = {};
  // Habits narrow-view state
  int? _selectedHabitId;
  int _habitFocusCol = 0; // 0..6

  // Unified schedule filters (chips)
  // Default to show both todos and events; tabs can filter to specific types.
  Set<String> _kindFilter = <String>{'todo', 'event'};

  bool loading = false;
  String? message;
  // Assistant collapse state
  bool assistantCollapsed = true;

  // Timeline scroll controller for DayView
  final ScrollController _timelineScrollController = ScrollController();

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
  String _progressStage = '';
  String? _lastCorrelationId;
  int _progressValid = 0;
  int _progressInvalid = 0;
  DateTime? _progressStart;
  // Pending smooth-scroll target (YYYY-MM-DD) for Day view
  String? _pendingScrollYmd;

  // Quick-add controllers
  final TextEditingController _qaTodoTitle = TextEditingController();
  final TextEditingController _qaTodoTime = TextEditingController();
  final TextEditingController _qaTodoDate = TextEditingController();
  final TextEditingController _qaTodoNotes = TextEditingController();
  final TextEditingController _qaTodoInterval = TextEditingController();

  final TextEditingController _qaEventTitle = TextEditingController();
  final TextEditingController _qaEventStart = TextEditingController();
  final TextEditingController _qaEventEnd = TextEditingController();
  final TextEditingController _qaEventLocation = TextEditingController();
  final TextEditingController _qaEventDate = TextEditingController();
  final TextEditingController _qaEventNotes = TextEditingController();
  final TextEditingController _qaEventInterval = TextEditingController();

  final TextEditingController _qaHabitTitle = TextEditingController();
  final TextEditingController _qaHabitTime = TextEditingController();

  // Goals inline quick-add controllers
  final TextEditingController _qaGoalTitle = TextEditingController();
  final TextEditingController _qaGoalNotes = TextEditingController();
  final TextEditingController _qaGoalCurrent = TextEditingController();
  final TextEditingController _qaGoalTarget = TextEditingController();
  final TextEditingController _qaGoalUnit = TextEditingController();
  String _qaGoalStatus = 'active';
  bool _addingQuick = false;

  // FAB dialog state variables
  String? _qaSelectedContext;
  String? _qaSelectedRecurrence;

  @override
  void initState() {
    super.initState();
    // Restore persisted main tab if available
    try {
      final saved = storage.getItem('mainTab') ?? '';
      if (saved == 'habits') {
        mainView = MainView.habits;
        _kindFilter = <String>{'habit'};
      } else if (saved == 'goals') {
        mainView = MainView.goals;
      } else {
        // Default to tasks view with both todos and events
        mainView = MainView.tasks;
        _kindFilter = <String>{'todo', 'event'};
      }
    } catch (_) {}
    if (!TestHooks.skipRefresh) {
      _refreshAll();
      // Model fetching removed
    } else {
      setState(() => loading = false);
    }

    // Initialize search context
    _searchContext = selectedContext;
  }

  Widget _quickAddHabitsInline() {
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
        const SizedBox(width: 8),
        FilledButton(
          onPressed: _addingQuick ? null : _submitQuickAddHabit,
          child: _addingQuick
              ? const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Text('Add'),
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
    final date = _qaTodoDate.text.trim();
    final time = _qaTodoTime.text.trim();
    final notes = _qaTodoNotes.text.trim();

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

    // Validate date format if provided
    if (date.isNotEmpty) {
      final dateRegex = RegExp(r'^\d{4}-\d{2}-\d{2}$');
      if (!dateRegex.hasMatch(date)) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Use date format YYYY-MM-DD, e.g. 2024-01-15.'),
          ),
        );
        return;
      }
    }

    setState(() => _addingQuick = true);
    // Request a frame so disabled state is paint-visible on next pump (no timers)
    WidgetsBinding.instance.scheduleFrame();
    try {
      // No extra timers; proceed to API
      final scheduledFor = date.isNotEmpty ? date : anchor;
      final recurrence = _qaSelectedRecurrence == 'none'
          ? {'type': 'none'}
          : _qaSelectedRecurrence == 'every_n_days'
          ? {
              'type': 'every_n_days',
              'intervalDays': int.tryParse(_qaTodoInterval.text.trim()) ?? 1,
            }
          : {'type': _qaSelectedRecurrence};

      final created = await createTodoFn({
        'title': title,
        'notes': notes,
        'scheduledFor': scheduledFor,
        'timeOfDay': time.isEmpty ? null : time,
        'recurrence': recurrence,
        'context': _qaSelectedContext ?? 'personal',
      });
      if (!mounted) return;
      setState(() {
        _qaTodoTitle.clear();
        _qaTodoTime.clear();
        _qaTodoDate.clear();
        _qaTodoNotes.clear();
        _qaTodoInterval.clear();
      });
      if (!TestHooks.skipRefresh) {
        try {
          scheduled.insert(0, Todo.fromJson(created));
        } catch (_) {}
      }
      if (!TestHooks.skipRefresh) await _refreshAll();
    } catch (e) {
      if (mounted) {
        // Enhanced error handling with technical details
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                const Text(
                  'Task Creation Failed',
                  style: TextStyle(fontWeight: FontWeight.bold),
                ),
                Text('Error: ${e.toString()}'),
                Text('Type: ${e.runtimeType}'),
                if (e is DioException) ...[
                  Text('Status: ${e.response?.statusCode ?? 'Unknown'}'),
                  if (e.response?.data != null)
                    Text('Response: ${e.response!.data}'),
                ],
              ],
            ),
            backgroundColor: Colors.red,
            duration: const Duration(seconds: 10),
            action: SnackBarAction(
              label: 'Copy Error',
              onPressed: () =>
                  Clipboard.setData(ClipboardData(text: e.toString())),
            ),
          ),
        );
      }
    } finally {
      if (mounted) {
        setState(() => _addingQuick = false);
      }
    }
  }

  Future<void> _submitQuickAddEvent() async {
    if (_addingQuick) return;
    final title = _qaEventTitle.text.trim();
    final date = _qaEventDate.text.trim();
    final start = _qaEventStart.text.trim();
    final end = _qaEventEnd.text.trim();
    final location = _qaEventLocation.text.trim();
    final notes = _qaEventNotes.text.trim();

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

    // Validate start ≤ end time if both are provided
    if (start.isNotEmpty && end.isNotEmpty) {
      if (start.compareTo(end) > 0) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('End time must be after start time.')),
        );
        return;
      }
    }

    // Validate date format if provided
    if (date.isNotEmpty) {
      final dateRegex = RegExp(r'^\d{4}-\d{2}-\d{2}$');
      if (!dateRegex.hasMatch(date)) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Use date format YYYY-MM-DD, e.g. 2024-01-15.'),
          ),
        );
        return;
      }
    }

    setState(() => _addingQuick = true);
    WidgetsBinding.instance.addPostFrameCallback((_) {});
    await Future<void>.delayed(Duration.zero);
    try {
      await Future<void>.delayed(const Duration(milliseconds: 1));
      final scheduledFor = date.isNotEmpty ? date : anchor;
      final recurrence = _qaSelectedRecurrence == 'none'
          ? {'type': 'none'}
          : _qaSelectedRecurrence == 'every_n_days'
          ? {
              'type': 'every_n_days',
              'intervalDays': int.tryParse(_qaEventInterval.text.trim()) ?? 1,
            }
          : {'type': _qaSelectedRecurrence};

      await createEventFn({
        'title': title,
        'notes': notes,
        'scheduledFor': scheduledFor,
        'startTime': start.isEmpty ? null : start,
        'endTime': end.isEmpty ? null : end,
        'location': location.isEmpty ? null : location,
        'recurrence': recurrence,
        'context': _qaSelectedContext ?? 'personal',
      });
      if (!mounted) return;
      setState(() {
        _qaEventTitle.clear();
        _qaEventStart.clear();
        _qaEventEnd.clear();
        _qaEventLocation.clear();
        _qaEventDate.clear();
        _qaEventNotes.clear();
        _qaEventInterval.clear();
      });
      if (!TestHooks.skipRefresh) await _refreshAll();
    } catch (e) {
      if (mounted) {
        // Enhanced error handling with technical details
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                const Text(
                  'Event Creation Failed',
                  style: TextStyle(fontWeight: FontWeight.bold),
                ),
                Text('Error: ${e.toString()}'),
                Text('Type: ${e.runtimeType}'),
                if (e is DioException) ...[
                  Text('Status: ${e.response?.statusCode ?? 'Unknown'}'),
                  if (e.response?.data != null)
                    Text('Response: ${e.response!.data}'),
                ],
              ],
            ),
            backgroundColor: Colors.red,
            duration: const Duration(seconds: 10),
            action: SnackBarAction(
              label: 'Copy Error',
              onPressed: () =>
                  Clipboard.setData(ClipboardData(text: e.toString())),
            ),
          ),
        );
      }
    } finally {
      await Future<void>.delayed(const Duration(milliseconds: 16));
      if (mounted) {
        setState(() => _addingQuick = false);
      }
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
        'recurrence': {'type': 'daily'},
        'context': selectedContext ?? 'personal',
      });
      if (!mounted) return;
      setState(() {
        _qaHabitTitle.clear();
        _qaHabitTime.clear();
      });
      if (!TestHooks.skipRefresh) await _refreshAll();
    } catch (e) {
      if (mounted) {
        // Enhanced error handling with technical details
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                const Text(
                  'Habit Creation Failed',
                  style: TextStyle(fontWeight: FontWeight.bold),
                ),
                Text('Error: ${e.toString()}'),
                Text('Type: ${e.runtimeType}'),
                if (e is DioException) ...[
                  Text('Status: ${e.response?.statusCode ?? 'Unknown'}'),
                  if (e.response?.data != null)
                    Text('Response: ${e.response!.data}'),
                ],
              ],
            ),
            backgroundColor: Colors.red,
            duration: const Duration(seconds: 10),
            action: SnackBarAction(
              label: 'Copy Error',
              onPressed: () =>
                  Clipboard.setData(ClipboardData(text: e.toString())),
            ),
          ),
        );
      }
    } finally {
      await Future<void>.delayed(const Duration(milliseconds: 16));
      if (mounted) {
        setState(() => _addingQuick = false);
      }
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
      if (!mounted) return;
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
      if (mounted) {
        // Enhanced error handling with technical details
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                const Text(
                  'Goal Creation Failed',
                  style: TextStyle(fontWeight: FontWeight.bold),
                ),
                Text('Error: ${e.toString()}'),
                Text('Type: ${e.runtimeType}'),
                if (e is DioException) ...[
                  Text('Status: ${e.response?.statusCode ?? 'Unknown'}'),
                  if (e.response?.data != null)
                    Text('Response: ${e.response!.data}'),
                ],
              ],
            ),
            backgroundColor: Colors.red,
            duration: const Duration(seconds: 10),
            action: SnackBarAction(
              label: 'Copy Error',
              onPressed: () =>
                  Clipboard.setData(ClipboardData(text: e.toString())),
            ),
          ),
        );
      }
    } finally {
      await Future<void>.delayed(const Duration(milliseconds: 16));
      if (mounted) {
        setState(() => _addingQuick = false);
      }
    }
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
    _qaTodoDate.dispose();
    _qaTodoNotes.dispose();
    _qaTodoInterval.dispose();
    _qaEventTitle.dispose();
    _qaEventStart.dispose();
    _qaEventEnd.dispose();
    _qaEventLocation.dispose();
    _qaEventDate.dispose();
    _qaEventNotes.dispose();
    _qaEventInterval.dispose();
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
      if (view == ViewMode.day ||
          view == ViewMode.week ||
          view == ViewMode.month) {
        // Select kinds strictly by tab: tasks (todo or event) or habits
        final kinds = (mainView == MainView.habits)
            ? <String>['habit']
            : (_kindFilter.toList());
        final raw = await api.fetchSchedule(
          from: r.from,
          to: r.to,
          kinds: kinds,
          completed: showCompleted ? null : false,
          statusTodo: showCompleted ? null : 'pending',
          context: selectedContext,
        );
        sList = raw
            .map((e) => Todo.fromJson(Map<String, dynamic>.from(e)))
            .toList();

        // Load habit stats for the same range to display streak badges
        try {
          final habitsRaw = await api.listHabits(
            from: r.from,
            to: r.to,
            context: selectedContext,
          );
          final Map<int, Map<String, dynamic>> statsMap = {};
          for (final h in habitsRaw) {
            final m = Map<String, dynamic>.from(h);
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
          status: showCompleted ? null : 'pending',
          context: selectedContext,
        );
        sList = scheduledRaw
            .map((e) => Todo.fromJson(e as Map<String, dynamic>))
            .toList();
      }
      final scheduledAllRaw = await api.fetchScheduledAllTime(
        status: showCompleted ? null : 'pending',
        context: selectedContext,
      );
      // Load events data when needed for "All" or "Events" views
      List<Todo> eventsAllList = const <Todo>[];
      if (mainView == MainView.tasks &&
          (_kindFilter.contains('event') || _kindFilter.contains('todo'))) {
        try {
          final evAllRaw = await api.listEvents(context: selectedContext);
          eventsAllList = evAllRaw
              .map((e) => Todo.fromJson(Map<String, dynamic>.from(e)))
              .toList();
        } catch (_) {}
      }
      final sAllList = scheduledAllRaw
          .map((e) => Todo.fromJson(e as Map<String, dynamic>))
          .toList();
      // Completed filter already applied above; priority now requested server-side
      final nowYmd = ymd(DateTime.now());
      int todayCount;
      int allCount;
      if (mainView == MainView.habits) {
        todayCount = sList
            .where((t) => t.kind == 'habit' && t.scheduledFor == nowYmd)
            .length;
        allCount = sList.where((t) => t.kind == 'habit').length;
      } else if (mainView == MainView.tasks) {
        final bool eventsMode =
            _kindFilter.contains('event') && !_kindFilter.contains('todo');
        final bool todosMode =
            _kindFilter.contains('todo') && !_kindFilter.contains('event');

        todayCount = sList
            .where(
              (t) =>
                  (eventsMode
                      ? t.kind == 'event'
                      : (todosMode
                            ? (t.kind == 'todo' || t.kind == null)
                            : true)) &&
                  t.scheduledFor == nowYmd,
            )
            .length;

        if (eventsMode) {
          allCount = eventsAllList.length;
        } else if (todosMode) {
          allCount = sAllList
              .where((t) => (t.kind == null || t.kind == 'todo'))
              .length;
        } else {
          // All mode: combine counts
          allCount =
              sAllList
                  .where((t) => (t.kind == null || t.kind == 'todo'))
                  .length +
              eventsAllList.length;
        }
      } else {
        // goals tab
        todayCount = 0;
        allCount = 0;
      }
      // Calculate context counts (using unfiltered data for counts)
      int schoolCount = 0;
      int personalCount = 0;
      int workCount = 0;
      try {
        // Count items by context from all data (not filtered by selectedContext)
        for (final item in sAllList) {
          switch (item.context) {
            case 'school':
              schoolCount++;
              break;
            case 'personal':
              personalCount++;
              break;
            case 'work':
              workCount++;
              break;
          }
        }
      } catch (_) {
        // If context counting fails, use zeros
      }

      final counts = <String, int>{
        'today': todayCount,
        'all': allCount,
        'school': schoolCount,
        'personal': personalCount,
        'work': workCount,
      };
      setState(() {
        scheduled = sList;
        // Combine todos and events for "All" view, or use specific list for filtered views
        if (mainView == MainView.tasks &&
            _kindFilter.contains('todo') &&
            _kindFilter.contains('event')) {
          // "All" view: combine todos and events
          scheduledAllTime = [...sAllList, ...eventsAllList];
        } else if (mainView == MainView.tasks &&
            _kindFilter.contains('event')) {
          // "Events" view: events only
          scheduledAllTime = eventsAllList;
        } else {
          // "Tasks" view or other: todos only
          scheduledAllTime = sAllList;
        }
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

  // Helpers for gated DayView integration
  List<Map<String, dynamic>> _anchorEventsAsMaps() {
    final List<Map<String, dynamic>> list = [];
    for (final t in _currentList()) {
      if ((t.kind == 'event') && t.scheduledFor == anchor) {
        list.add({
          'id': t.id,
          'title': t.title,
          'scheduledFor': t.scheduledFor,
          'startTime': t.timeOfDay, // unified model uses timeOfDay for start
          'endTime': t.endTime,
          'notes': t.notes,
          'completed': t.completed,
          'location': null,
          'context': t.context,
        });
      }
    }
    return list;
  }

  List<Map<String, dynamic>> _anchorTasksAsMaps() {
    final List<Map<String, dynamic>> list = [];
    for (final t in _currentList()) {
      if ((t.kind == 'todo' || t.kind == null) && t.scheduledFor == anchor) {
        // Compute overdue only when viewing today's Day view
        bool isOverdue = false;
        try {
          final bool isResolved =
              ((t.status == 'completed') || (t.status == 'skipped'));
          if (!isResolved && t.scheduledFor != null && t.timeOfDay != null) {
            final todayYmd = ymd(DateTime.now());
            final viewingToday = (anchor == todayYmd);
            if (viewingToday && t.scheduledFor == todayYmd) {
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

        list.add({
          'id': t.id,
          'title': t.title,
          'scheduledFor': t.scheduledFor,
          'timeOfDay': t.timeOfDay,
          'completed': t.completed,
          'status': t.status,
          'notes': t.notes,
          'overdue': isOverdue,
          'context': t.context,
        });
      }
    }
    return list;
  }

  Future<void> _onSetTodoStatusOrOccurrenceNew(int id, String status) async {
    try {
      final t = _currentList().firstWhere(
        (e) =>
            (e.kind == 'todo' || e.kind == null) &&
            (e.id == id || e.masterId == id),
        orElse: () => throw Exception('todo_not_found'),
      );
      if (t.masterId != null && t.scheduledFor != null) {
        await api.callMCPTool('set_todo_status', {
          'id': t.masterId!,
          'status': status,
          'occurrenceDate': t.scheduledFor!,
        });
      } else {
        await api.callMCPTool('set_todo_status', {
          'id': t.id,
          'status': status,
        });
      }
      await _refreshAll();
    } catch (_) {}
  }

  Future<void> _loadGoalBadges() async {
    try {
      final goals = await api.listGoals();
      final Map<String, Map<String, dynamic>> map = {};
      for (final g in goals) {
        final gm = Map<String, dynamic>.from(g);
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
            final tm = Map<String, dynamic>.from(t);
            final id = tm['id'] as int?;
            if (id != null) {
              map['todo:$id'] = {'goalId': gid, 'title': title};
            }
          }
        }
        // Events
        if (detail['items'] is Map && detail['items']['events'] is List) {
          for (final ev in (detail['items']['events'] as List)) {
            final em = Map<String, dynamic>.from(ev);
            final id = em['id'] as int?;
            if (id != null) {
              map['event:$id'] = {'goalId': gid, 'title': title};
            }
          }
        }
      }
      if (mounted) {
        setState(() {
          _itemGoalByKey = map;
        });
      }
    } catch (_) {
      // Non-blocking
    }
  }

  // Removed: _loadAssistantModel (endpoint deleted; badges removed)

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
      final raw = await api.searchUnified(
        q,
        scope: _searchScope,
        completed: _searchCompleted ?? (showCompleted ? null : false),
        statusTodo: _searchStatusTodo,
        context: _searchContext,
        cancelToken: _searchCancelToken,
        limit: 30,
      );
      final items = raw.map((e) {
        final m = Map<String, dynamic>.from(e);
        // Normalize event times for unified rendering
        if ((m['kind'] as String?) == 'event' &&
            m['startTime'] != null &&
            m['timeOfDay'] == null) {
          m['timeOfDay'] = m['startTime'];
        }
        return Todo.fromJson(m);
      }).toList();
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

  // Search filter chip functions
  void _setSearchScope(String scope) {
    setState(() => _searchScope = scope);
    _runSearch(searchCtrl.text);
  }

  void _setSearchContext(String? context) {
    setState(() => _searchContext = context);
    // Sync context
    if (selectedContext != context) {
      selectedContext = context;
      _refreshAll();
    }
    _runSearch(searchCtrl.text);
  }

  void _setSearchStatusTodo(String status) {
    setState(() => _searchStatusTodo = status);
    _runSearch(searchCtrl.text);
  }

  void _setSearchCompleted(bool? completed) {
    setState(() => _searchCompleted = completed);
    _runSearch(searchCtrl.text);
  }

  void _resetSearchFilters() {
    setState(() {
      _searchScope = 'all';
      _searchContext = selectedContext;
      _searchStatusTodo = 'pending';
      _searchCompleted = null;
    });
    _runSearch(searchCtrl.text);
  }

  Widget _buildFilterChip(String label, bool selected, VoidCallback onTap) {
    return FilterChip(
      label: Text(label),
      selected: selected,
      onSelected: (_) => onTap(),
      backgroundColor: Colors.transparent,
      selectedColor: Theme.of(context).colorScheme.primaryContainer,
      checkmarkColor: Theme.of(context).colorScheme.onPrimaryContainer,
      labelStyle: TextStyle(
        color: selected
            ? Theme.of(context).colorScheme.onPrimaryContainer
            : Theme.of(context).colorScheme.onSurface,
      ),
    );
  }

  void _showSettingsDialog() {
    showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Settings'),
        content: const SizedBox(
          width: 400,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Application Settings',
                style: TextStyle(fontWeight: FontWeight.bold),
              ),
              SizedBox(height: 16),
              Text(
                'Settings dialog implemented. Additional settings can be added here.',
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('Close'),
          ),
        ],
      ),
    );
  }

  void _showSearchOverlayIfNeeded() {
    if (!_searchFocus.hasFocus || searchCtrl.text.trim().length < 2) {
      _removeSearchOverlay();
      return;
    }
    final existing = _searchOverlay;
    if (existing != null) {
      existing.markNeedsBuild();
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
                              color: Colors.white.withAlpha(
                                (0.72 * 255).round(),
                              ),
                              borderRadius: BorderRadius.circular(12),
                              border: Border.all(
                                color: theme.colorScheme.outline.withAlpha(
                                  (0.35 * 255).round(),
                                ),
                              ),
                              boxShadow: [
                                BoxShadow(
                                  color: Colors.black.withAlpha(
                                    (0.08 * 255).round(),
                                  ),
                                  blurRadius: 16,
                                  offset: const Offset(0, 8),
                                ),
                              ],
                            ),
                            child: Column(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                // Filter chips
                                Padding(
                                  padding: const EdgeInsets.all(12),
                                  child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: [
                                      // Scope chips
                                      Wrap(
                                        spacing: 6,
                                        runSpacing: 6,
                                        children: [
                                          _buildFilterChip(
                                            'All',
                                            _searchScope == 'all',
                                            () => _setSearchScope('all'),
                                          ),
                                          _buildFilterChip(
                                            'Todos',
                                            _searchScope == 'todo',
                                            () => _setSearchScope('todo'),
                                          ),
                                          _buildFilterChip(
                                            'Events',
                                            _searchScope == 'event',
                                            () => _setSearchScope('event'),
                                          ),
                                          _buildFilterChip(
                                            'Habits',
                                            _searchScope == 'habit',
                                            () => _setSearchScope('habit'),
                                          ),
                                        ],
                                      ),
                                      const SizedBox(height: 8),
                                      // Context chips
                                      Wrap(
                                        spacing: 6,
                                        runSpacing: 6,
                                        children: [
                                          _buildFilterChip(
                                            'All ctx',
                                            _searchContext == null,
                                            () => _setSearchContext(null),
                                          ),
                                          _buildFilterChip(
                                            'Personal',
                                            _searchContext == 'personal',
                                            () => _setSearchContext('personal'),
                                          ),
                                          _buildFilterChip(
                                            'Work',
                                            _searchContext == 'work',
                                            () => _setSearchContext('work'),
                                          ),
                                          _buildFilterChip(
                                            'School',
                                            _searchContext == 'school',
                                            () => _setSearchContext('school'),
                                          ),
                                        ],
                                      ),
                                      if (_searchScope == 'todo') ...[
                                        const SizedBox(height: 8),
                                        // Todo status chips (only when scope is todo)
                                        Wrap(
                                          spacing: 6,
                                          runSpacing: 6,
                                          children: [
                                            _buildFilterChip(
                                              'Pending',
                                              _searchStatusTodo == 'pending',
                                              () => _setSearchStatusTodo(
                                                'pending',
                                              ),
                                            ),
                                            _buildFilterChip(
                                              'Completed',
                                              _searchStatusTodo == 'completed',
                                              () => _setSearchStatusTodo(
                                                'completed',
                                              ),
                                            ),
                                            _buildFilterChip(
                                              'Skipped',
                                              _searchStatusTodo == 'skipped',
                                              () => _setSearchStatusTodo(
                                                'skipped',
                                              ),
                                            ),
                                          ],
                                        ),
                                      ],
                                      if (_searchScope == 'event' ||
                                          _searchScope == 'habit' ||
                                          _searchScope == 'all') ...[
                                        const SizedBox(height: 8),
                                        // Completed status chips (for events/habits)
                                        Wrap(
                                          spacing: 6,
                                          runSpacing: 6,
                                          children: [
                                            _buildFilterChip(
                                              'All',
                                              _searchCompleted == null,
                                              () => _setSearchCompleted(null),
                                            ),
                                            _buildFilterChip(
                                              'Completed',
                                              _searchCompleted == true,
                                              () => _setSearchCompleted(true),
                                            ),
                                            _buildFilterChip(
                                              'Incomplete',
                                              _searchCompleted == false,
                                              () => _setSearchCompleted(false),
                                            ),
                                          ],
                                        ),
                                      ],
                                      const SizedBox(height: 8),
                                      // Reset button
                                      TextButton(
                                        onPressed: _resetSearchFilters,
                                        child: const Text('Reset filters'),
                                      ),
                                    ],
                                  ),
                                ),
                                const Divider(height: 1),
                                // Results
                                if (_searching && results.isEmpty)
                                  const Padding(
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
                                else
                                  Flexible(
                                    child: ListView.separated(
                                      padding: const EdgeInsets.symmetric(
                                        vertical: 6,
                                      ),
                                      shrinkWrap: true,
                                      itemBuilder: (c, i) {
                                        final t = results[i];
                                        final selected = i == _searchHoverIndex;
                                        return InkWell(
                                          onTap: () => _selectSearchResult(t),
                                          onHover: (h) => setState(
                                            () => _searchHoverIndex = h
                                                ? i
                                                : _searchHoverIndex,
                                          ),
                                          child: Container(
                                            color: selected
                                                ? theme.colorScheme.primary
                                                      .withAlpha(
                                                        (0.08 * 255).round(),
                                                      )
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
                                                        CrossAxisAlignment
                                                            .start,
                                                    children: [
                                                      Text(
                                                        t.title,
                                                        maxLines: 1,
                                                        overflow: TextOverflow
                                                            .ellipsis,
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

                                                          _buildKindChip(
                                                            t.kind ?? 'todo',
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
                                            .withAlpha((0.2 * 255).round()),
                                      ),
                                      itemCount: results.length,
                                    ),
                                  ),
                              ],
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
    final entry = _searchOverlay;
    final overlay = Overlay.of(context, debugRequiredFor: widget);
    if (entry != null) {
      overlay.insert(entry);
    }
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

  Widget _buildKindChip(String kind) {
    IconData icon;
    Color color;

    switch (kind) {
      case 'event':
        icon = Icons.event;
        color = Colors.green;
        break;
      case 'todo':
        icon = Icons.task;
        color = Colors.blue;
        break;
      case 'habit':
        icon = Icons.repeat;
        color = Colors.purple;
        break;
      default:
        icon = Icons.circle;
        color = Colors.grey;
    }

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: color.withOpacity(0.1),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: color.withOpacity(0.3), width: 1),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 12, color: color),
          const SizedBox(width: 4),
          Text(
            kind.substring(0, 1).toUpperCase() + kind.substring(1),
            style: TextStyle(
              fontSize: 10,
              fontWeight: FontWeight.w500,
              color: color,
            ),
          ),
        ],
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
    // Ensure we're in tasks view and the item type is visible
    if (t.kind == 'event') {
      if (!(mainView == MainView.tasks && _kindFilter.contains('event'))) {
        setState(() {
          mainView = MainView.tasks;
          // Ensure events are visible (add to filter if not present)
          if (!_kindFilter.contains('event')) {
            _kindFilter = <String>{'todo', 'event'};
          }
        });
        await _refreshAll();
      }
    } else {
      // treat default as todo
      if (!(mainView == MainView.tasks && _kindFilter.contains('todo'))) {
        setState(() {
          mainView = MainView.tasks;
          // Ensure todos are visible (add to filter if not present)
          if (!_kindFilter.contains('todo')) {
            _kindFilter = <String>{'todo', 'event'};
          }
        });
        await _refreshAll();
      }
    }
    await Future.delayed(Duration.zero);
    final key = _rowKeys[t.id];
    if (key != null && key.currentContext != null) {
      await Scrollable.ensureVisible(
        key.currentContext!,
        duration: const Duration(milliseconds: 250),
      );
      setState(() => _highlightedId = t.id);
      await Future.delayed(const Duration(seconds: 1));
      if (mounted && _highlightedId == t.id) {
        setState(() => _highlightedId = null);
      }
    }
  }

  Future<void> _toggleCompleted(Todo t) async {
    try {
      if (t.kind == 'event') {
        // Event completion is not supported
        setState(() => message = 'Event completion is not supported.');
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
        // todo: use status model
        if (t.masterId != null && t.scheduledFor != null) {
          final next = (t.status == 'completed') ? 'pending' : 'completed';
          await api.callMCPTool('set_todo_status', {
            'id': t.masterId!,
            'status': next,
            'occurrenceDate': t.scheduledFor!,
          });
        } else {
          final next = (t.status == 'completed') ? 'pending' : 'completed';
          await api.callMCPTool('set_todo_status', {
            'id': t.id,
            'status': next,
          });
        }
      }
      await _refreshAll();
    } catch (e) {
      setState(() => message = 'Toggle failed: $e');
    }
  }

  Future<void> _toggleSkip(Todo t) async {
    try {
      if (t.kind != 'todo') return;
      if (t.masterId != null && t.scheduledFor != null) {
        final next = (t.status == 'skipped') ? 'pending' : 'skipped';
        await api.callMCPTool('set_todo_status', {
          'id': t.masterId!,
          'status': next,
          'occurrenceDate': t.scheduledFor!,
        });
      } else {
        final next = (t.status == 'skipped') ? 'pending' : 'skipped';
        await api.callMCPTool('set_todo_status', {'id': t.id, 'status': next});
      }
      await _refreshAll();
    } catch (e) {
      setState(() => message = 'Skip failed: $e');
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
    if (ok != true) {
      return;
    }
    try {
      if (t.kind == 'event') {
        await api.deleteEvent(t.id);
      } else if (t.kind == 'habit') {
        await api.deleteHabit(t.id);
      } else {
        await api.callMCPTool('delete_todo', {'id': t.id});
      }
      await _refreshAll();
    } catch (e) {
      setState(() => message = 'Delete failed: $e');
    }
  }

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
          Future<void> loadLinkables() async {
            try {
              final tds = await api.fetchScheduledAllTime();
              final evs = await api.listEvents();
              setDlgState(() {
                allTodos = tds
                    .map((x) => Map<String, dynamic>.from(x))
                    .toList();
                allEvents = evs
                    .map((x) => Map<String, dynamic>.from(x))
                    .toList();
              });
            } catch (_) {}
          }

          if (allTodos.isEmpty && allEvents.isEmpty) {
            loadLinkables();
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
                    const SizedBox.shrink(),
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
                                if (v == true) {
                                  selectedTodoIds.add(id);
                                } else {
                                  selectedTodoIds.remove(id);
                                }
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
                                if (v == true) {
                                  selectedEventIds.add(id);
                                } else {
                                  selectedEventIds.remove(id);
                                }
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
    if (ok != true) {
      return;
    }

    final patch = <String, dynamic>{};
    if (titleCtrl.text != t.title) {
      patch['title'] = titleCtrl.text;
    }
    if (notesCtrl.text != t.notes) {
      patch['notes'] = notesCtrl.text;
    }
    final sched = dateCtrl.text.trim();
    final normalized = sched.isEmpty ? null : sched;
    if (normalized != (t.scheduledFor ?? '')) {
      patch['scheduledFor'] = normalized;
    }
    // priority removed
    final time = timeCtrl.text.trim();
    if ((time.isEmpty ? null : time) != (t.timeOfDay)) {
      patch['timeOfDay'] = time.isEmpty ? null : time;
    }
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
        if (n != null && n >= 1) {
          (patch['recurrence'] as Map<String, dynamic>)['intervalDays'] = n;
        }
      }
    } else if (recurType == 'every_n_days') {
      final n = int.tryParse(intervalCtrl.text.trim());
      if (n != null && n >= 1 && n != existingN) {
        patch['recurrence'] = {'type': recurType, 'intervalDays': n};
      }
    }

    // If recurrence becomes repeating, require an anchor date
    final willRepeat = () {
      if (patch['recurrence'] is Map) {
        final Map rec = patch['recurrence'] as Map;
        return (rec['type'] != 'none');
      }
      return false;
    }();
    final nextAnchor = (patch.containsKey('scheduledFor'))
        ? (patch['scheduledFor'] as String?)
        : (t.scheduledFor);
    if (willRepeat && (nextAnchor == null || nextAnchor.trim().isEmpty)) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text(
              'Set an anchor date (YYYY-MM-DD) for repeating habits.',
            ),
          ),
        );
      }
      return;
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

    String recurType = (t.recurrence != null && t.recurrence!['type'] is String)
        ? (t.recurrence!['type'] as String)
        : 'none';
    String selectedContext = t.context ?? 'personal';
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
                      labelText: 'Scheduled (YYYY-MM-DD)',
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
                    value: selectedContext,
                    decoration: const InputDecoration(labelText: 'Context'),
                    items: const [
                      DropdownMenuItem(
                        value: 'personal',
                        child: Text('Personal'),
                      ),
                      DropdownMenuItem(value: 'work', child: Text('Work')),
                      DropdownMenuItem(value: 'school', child: Text('School')),
                    ],
                    onChanged: (v) =>
                        setDlgState(() => selectedContext = v ?? 'personal'),
                  ),
                  const SizedBox(height: 8),
                  const SizedBox.shrink(),
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
    if (selectedContext != t.context) patch['context'] = selectedContext;
    final sched = dateCtrl.text.trim();
    final normalized = sched.isEmpty ? null : sched;
    if (normalized != (t.scheduledFor ?? '')) {
      patch['scheduledFor'] = normalized;
    }
    // priority removed
    final time = timeCtrl.text.trim();
    if ((time.isEmpty ? null : time) != (t.timeOfDay)) {
      patch['timeOfDay'] = time.isEmpty ? null : time;
    }
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
        if (n != null && n >= 1) {
          (patch['recurrence'] as Map<String, dynamic>)['intervalDays'] = n;
        }
      }
    } else if (recurType == 'every_n_days') {
      final n = int.tryParse(intervalCtrl.text.trim());
      if (n != null && n >= 1 && n != existingN) {
        patch['recurrence'] = {'type': recurType, 'intervalDays': n};
      }
    }

    if (patch.isEmpty) return;
    // If recurrence becomes repeating, require anchor date
    final willRepeat = () {
      if (patch['recurrence'] is Map) {
        final Map rec = patch['recurrence'] as Map;
        return (rec['type'] != 'none');
      }
      return false;
    }();
    final nextAnchor = (patch.containsKey('scheduledFor'))
        ? (patch['scheduledFor'] as String?)
        : (t.scheduledFor);
    if (willRepeat && (nextAnchor == null || nextAnchor.trim().isEmpty)) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text(
              'Set an anchor date (YYYY-MM-DD) for repeating todos.',
            ),
          ),
        );
      }
      return;
    }
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
    // For events, fetch the original event data to get endTime and location
    Map<String, dynamic>? originalEventData;
    if (t.kind == 'event') {
      try {
        final res = await api.api.get('/api/events/${t.id}');
        originalEventData = Map<String, dynamic>.from(res.data['event']);
      } catch (e) {
        // If fetching fails, use the Todo data
        print('Failed to fetch original event data: $e');
      }
    }

    final titleCtrl = TextEditingController(text: t.title);
    final notesCtrl = TextEditingController(text: t.notes);
    final dateCtrl = TextEditingController(text: t.scheduledFor ?? '');
    final startCtrl = TextEditingController(text: t.timeOfDay ?? '');
    final endCtrl = TextEditingController(
      text: originalEventData?['endTime'] ?? '',
    );
    final locationCtrl = TextEditingController(
      text: originalEventData?['location'] ?? '',
    );
    String recurType = (t.recurrence != null && t.recurrence!['type'] is String)
        ? (t.recurrence!['type'] as String)
        : 'none';
    String selectedContext = t.context ?? 'personal';
    final intervalCtrl = TextEditingController(
      text: (t.recurrence != null && t.recurrence!['intervalDays'] != null)
          ? '${t.recurrence!['intervalDays']}'
          : '1',
    );
    final ok = await showDialog<dynamic>(
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
                    value: selectedContext,
                    decoration: const InputDecoration(labelText: 'Context'),
                    items: const [
                      DropdownMenuItem(
                        value: 'personal',
                        child: Text('Personal'),
                      ),
                      DropdownMenuItem(value: 'work', child: Text('Work')),
                      DropdownMenuItem(value: 'school', child: Text('School')),
                    ],
                    onChanged: (v) =>
                        setDlgState(() => selectedContext = v ?? 'personal'),
                  ),
                  const SizedBox(height: 8),
                  const SizedBox.shrink(),
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
              TextButton(
                onPressed: () => Navigator.pop(c, 'delete'),
                style: TextButton.styleFrom(foregroundColor: Colors.red),
                child: const Text('Delete'),
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
    if (ok == 'delete') {
      try {
        await _deleteTodo(t);
        await _refreshAll();
      } catch (e) {
        setState(() => message = 'Delete failed: $e');
      }
      return;
    }
    if (ok != true) return;
    final patch = <String, dynamic>{};
    if (titleCtrl.text != t.title) patch['title'] = titleCtrl.text;
    if (notesCtrl.text != t.notes) patch['notes'] = notesCtrl.text;
    if (selectedContext != t.context) patch['context'] = selectedContext;
    final date = dateCtrl.text.trim();
    final normalized = date.isEmpty ? null : date;
    if (normalized != (t.scheduledFor ?? '')) {
      patch['scheduledFor'] = normalized;
    }
    // priority removed
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
    // If recurrence becomes repeating, require anchor date
    final willRepeat = () {
      if (patch['recurrence'] is Map) {
        final Map rec = patch['recurrence'] as Map;
        return (rec['type'] != 'none');
      }
      return false;
    }();
    final nextAnchor = (patch.containsKey('scheduledFor'))
        ? (patch['scheduledFor'] as String?)
        : (t.scheduledFor);
    if (willRepeat && (nextAnchor == null || nextAnchor.trim().isEmpty)) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text(
              'Set an anchor date (YYYY-MM-DD) for repeating events.',
            ),
          ),
        );
      }
      return;
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
        clientContext: () {
          // Limit to current view as requested: derive range and kinds
          final dr = rangeForView(anchor, view);
          final kinds = (mainView == MainView.habits)
              ? <String>['habit']
              : (mainView == MainView.goals)
              ? <String>['goal']
              : (_kindFilter.contains('event')
                    ? <String>['event']
                    : <String>['todo']);
          return {
            'range': {'from': dr.from, 'to': dr.to},
            'kinds': kinds,
            'mainView': mainView.name,
            // New: include completion and search context to further scope planning
            'completed': showCompleted,
            if (searchCtrl.text.trim().isNotEmpty)
              'search': searchCtrl.text.trim(),
          };
        }(),
        onTraceId: (cid) {
          if (!mounted) return;
          if ((cid).trim().isEmpty) return;
          setState(() {
            _lastCorrelationId = cid;
          });
        },
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
          });
        },

        onStage: (st) {
          if (!mounted) return;
          setState(() {
            _progressStage = st;
            _progressStart ??= DateTime.now();
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
                          (x as Map<String, dynamic>)['op'],
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
            _progressValid = validCount;
            _progressInvalid = invalidCount;
          });
        },
      );
      final reply = (res['text'] as String?) ?? '';
      final corr = (res['correlationId'] as String?) ?? _lastCorrelationId;
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
        _lastCorrelationId = corr;
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
        _progressStage = '';
        _progressValid = 0;
        _progressInvalid = 0;
        _progressStart = null;
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
        final preview = await api.dryRunOperationsMCP(selectedOps);
        final warnings =
            (preview['warnings'] as List<dynamic>?)
                ?.map((e) => e.toString())
                .toList() ??
            const <String>[];
        if (warnings.isNotEmpty) {
          if (!mounted) return;
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
      final res = await api.applyOperationsMCP(
        selectedOps,
        correlationId: _lastCorrelationId,
      );
      final summary = res['summary'];
      if (mounted) {
        setState(() {
          message =
              'Applied: c=${summary['created']}, u=${summary['updated']}, d=${summary['deleted']}, done=${summary['completed']}';
          assistantOps = [];
          assistantOpsChecked = [];
          assistantShowDiff = false;
        });
      }
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
    // Always return all scheduled items without type filtering
    return scheduled;
  }

  String? _getCurrentViewDate() {
    // Always return the anchor date
    return anchor;
  }

  void _showQuickAddTodo() {
    // Reset state variables
    _qaSelectedContext = selectedContext ?? 'personal';
    _qaSelectedRecurrence = 'none';

    // Set default date to today
    _qaTodoDate.text = anchor;

    showDialog<void>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: const Text('Add Task'),
          content: SizedBox(
            width: 480,
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  TextField(
                    controller: _qaTodoTitle,
                    decoration: const InputDecoration(labelText: 'Title *'),
                    autofocus: true,
                  ),
                  const SizedBox(height: 8),
                  Row(
                    children: [
                      Expanded(
                        child: TextField(
                          controller: _qaTodoDate,
                          decoration: const InputDecoration(
                            labelText: 'Date (YYYY-MM-DD)',
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      IconButton(
                        onPressed: () => _pickDate(_qaTodoDate),
                        icon: const Icon(Icons.calendar_today),
                        tooltip: 'Pick date',
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  Row(
                    children: [
                      Expanded(
                        child: TextField(
                          controller: _qaTodoTime,
                          decoration: const InputDecoration(
                            labelText: 'Time (HH:MM)',
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      IconButton(
                        onPressed: () => _pickTime(_qaTodoTime),
                        icon: const Icon(Icons.access_time),
                        tooltip: 'Pick time',
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  TextField(
                    controller: _qaTodoNotes,
                    decoration: const InputDecoration(labelText: 'Notes'),
                    maxLines: 3,
                  ),
                  const SizedBox(height: 8),
                  DropdownButtonFormField<String>(
                    value: _qaSelectedContext,
                    decoration: const InputDecoration(labelText: 'Context'),
                    items: const [
                      DropdownMenuItem(
                        value: 'personal',
                        child: Text('Personal'),
                      ),
                      DropdownMenuItem(value: 'work', child: Text('Work')),
                      DropdownMenuItem(value: 'school', child: Text('School')),
                    ],
                    onChanged: (v) =>
                        setDialogState(() => _qaSelectedContext = v),
                  ),
                  const SizedBox(height: 8),
                  DropdownButtonFormField<String>(
                    value: _qaSelectedRecurrence,
                    decoration: const InputDecoration(labelText: 'Recurrence'),
                    items: const [
                      DropdownMenuItem(value: 'none', child: Text('None')),
                      DropdownMenuItem(value: 'daily', child: Text('Daily')),
                      DropdownMenuItem(
                        value: 'weekdays',
                        child: Text('Weekdays'),
                      ),
                      DropdownMenuItem(value: 'weekly', child: Text('Weekly')),
                      DropdownMenuItem(
                        value: 'every_n_days',
                        child: Text('Every N days'),
                      ),
                    ],
                    onChanged: (v) =>
                        setDialogState(() => _qaSelectedRecurrence = v),
                  ),
                  if (_qaSelectedRecurrence == 'every_n_days')
                    TextField(
                      controller: _qaTodoInterval,
                      keyboardType: TextInputType.number,
                      decoration: const InputDecoration(
                        labelText: 'Every N days (>=1)',
                      ),
                    ),
                ],
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(context).pop(),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: _addingQuick
                  ? null
                  : () async {
                      Navigator.of(context).pop();
                      await _submitQuickAddTodo();
                    },
              child: _addingQuick
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Text('Add'),
            ),
          ],
        ),
      ),
    );
  }

  void _showQuickAddEvent() {
    // Reset state variables
    _qaSelectedContext = selectedContext ?? 'personal';
    _qaSelectedRecurrence = 'none';

    // Set default date to today
    _qaEventDate.text = anchor;

    showDialog<void>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: const Text('Add Event'),
          content: SizedBox(
            width: 480,
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  TextField(
                    controller: _qaEventTitle,
                    decoration: const InputDecoration(labelText: 'Title *'),
                    autofocus: true,
                  ),
                  const SizedBox(height: 8),
                  Row(
                    children: [
                      Expanded(
                        child: TextField(
                          controller: _qaEventDate,
                          decoration: const InputDecoration(
                            labelText: 'Date (YYYY-MM-DD)',
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      IconButton(
                        onPressed: () => _pickDate(_qaEventDate),
                        icon: const Icon(Icons.calendar_today),
                        tooltip: 'Pick date',
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  Row(
                    children: [
                      Expanded(
                        child: TextField(
                          controller: _qaEventStart,
                          decoration: const InputDecoration(
                            labelText: 'Start Time (HH:MM)',
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      IconButton(
                        onPressed: () => _pickTime(_qaEventStart),
                        icon: const Icon(Icons.access_time),
                        tooltip: 'Pick start time',
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  Row(
                    children: [
                      Expanded(
                        child: TextField(
                          controller: _qaEventEnd,
                          decoration: const InputDecoration(
                            labelText: 'End Time (HH:MM)',
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      IconButton(
                        onPressed: () => _pickTime(_qaEventEnd),
                        icon: const Icon(Icons.access_time),
                        tooltip: 'Pick end time',
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  TextField(
                    controller: _qaEventLocation,
                    decoration: const InputDecoration(labelText: 'Location'),
                  ),
                  const SizedBox(height: 8),
                  TextField(
                    controller: _qaEventNotes,
                    decoration: const InputDecoration(labelText: 'Notes'),
                    maxLines: 3,
                  ),
                  const SizedBox(height: 8),
                  DropdownButtonFormField<String>(
                    value: _qaSelectedContext,
                    decoration: const InputDecoration(labelText: 'Context'),
                    items: const [
                      DropdownMenuItem(
                        value: 'personal',
                        child: Text('Personal'),
                      ),
                      DropdownMenuItem(value: 'work', child: Text('Work')),
                      DropdownMenuItem(value: 'school', child: Text('School')),
                    ],
                    onChanged: (v) =>
                        setDialogState(() => _qaSelectedContext = v),
                  ),
                  const SizedBox(height: 8),
                  DropdownButtonFormField<String>(
                    value: _qaSelectedRecurrence,
                    decoration: const InputDecoration(labelText: 'Recurrence'),
                    items: const [
                      DropdownMenuItem(value: 'none', child: Text('None')),
                      DropdownMenuItem(value: 'daily', child: Text('Daily')),
                      DropdownMenuItem(
                        value: 'weekdays',
                        child: Text('Weekdays'),
                      ),
                      DropdownMenuItem(value: 'weekly', child: Text('Weekly')),
                      DropdownMenuItem(
                        value: 'every_n_days',
                        child: Text('Every N days'),
                      ),
                    ],
                    onChanged: (v) =>
                        setDialogState(() => _qaSelectedRecurrence = v),
                  ),
                  if (_qaSelectedRecurrence == 'every_n_days')
                    TextField(
                      controller: _qaEventInterval,
                      keyboardType: TextInputType.number,
                      decoration: const InputDecoration(
                        labelText: 'Every N days (>=1)',
                      ),
                    ),
                ],
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(context).pop(),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: _addingQuick
                  ? null
                  : () async {
                      Navigator.of(context).pop();
                      await _submitQuickAddEvent();
                    },
              child: _addingQuick
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Text('Add'),
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final body = loading
        ? const Center(child: CircularProgressIndicator())
        : Column(
            children: [
              // Header with 3-section layout: Left (Logo), Center (Search), Right (Actions)
              Container(
                color: Theme.of(context).colorScheme.surface,
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 10,
                ),
                child: Row(
                  children: [
                    // Left: Logo
                    Expanded(
                      flex: 2,
                      child: Row(
                        children: [
                          Container(
                            padding: const EdgeInsets.all(16),
                            child: Row(
                              children: [
                                Icon(
                                  Icons.spa,
                                  size: 32,
                                  color: Theme.of(context).colorScheme.primary,
                                ),
                                const SizedBox(width: 8),
                                Text(
                                  'Habitus',
                                  style: TextStyle(
                                    fontSize: 24,
                                    fontWeight: FontWeight.w600,
                                    color: Theme.of(
                                      context,
                                    ).colorScheme.onSurface,
                                    letterSpacing: 0.2,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                    // Center: Search field (anchor for overlay)
                    Expanded(
                      flex: 3,
                      child: Center(
                        child: ConstrainedBox(
                          constraints: const BoxConstraints(maxWidth: 320),
                          child: CompositedTransformTarget(
                            link: _searchLink,
                            child: Focus(
                              focusNode: _searchFocus,
                              onFocusChange: (f) {
                                if (!f) {
                                  _removeSearchOverlay();
                                } else {
                                  _showSearchOverlayIfNeeded();
                                }
                              },
                              onKeyEvent: (node, event) {
                                if (!_searchFocus.hasFocus) {
                                  return KeyEventResult.ignored;
                                }
                                if (event is! KeyDownEvent) {
                                  return KeyEventResult.ignored;
                                }
                                final len = math.min(searchResults.length, 7);
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
                                        : (_searchHoverIndex - 1 + len) % len;
                                  });
                                  _showSearchOverlayIfNeeded();
                                  return KeyEventResult.handled;
                                } else if (event.logicalKey ==
                                    LogicalKeyboardKey.enter) {
                                  final list = searchResults.take(7).toList();
                                  if (list.isEmpty) {
                                    return KeyEventResult.handled;
                                  }
                                  final idx =
                                      _searchHoverIndex >= 0 &&
                                          _searchHoverIndex < list.length
                                      ? _searchHoverIndex
                                      : 0;
                                  _selectSearchResult(list[idx]);
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
                                    borderRadius: BorderRadius.circular(24),
                                    borderSide: BorderSide(
                                      color: Theme.of(context)
                                          .colorScheme
                                          .outline
                                          .withAlpha((0.4 * 255).round()),
                                    ),
                                  ),
                                  focusedBorder: OutlineInputBorder(
                                    borderRadius: BorderRadius.circular(24),
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
                                            child: CircularProgressIndicator(
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
                    ),
                    // Right: Quick actions
                    Expanded(
                      flex: 2,
                      child: Row(
                        mainAxisAlignment: MainAxisAlignment.end,
                        children: [
                          // Assistant toggle
                          IconButton(
                            icon: Icon(
                              assistantCollapsed
                                  ? Icons.smart_toy_outlined
                                  : Icons.smart_toy,
                            ),
                            onPressed: () => setState(
                              () => assistantCollapsed = !assistantCollapsed,
                            ),
                            tooltip: assistantCollapsed
                                ? 'Show Mr. Assister'
                                : 'Hide Mr. Assister',
                          ),
                        ],
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
                    // Main content area
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
                                      // Compact Subheader + View Mode
                                      if (mainView == MainView.tasks)
                                        Column(
                                          crossAxisAlignment:
                                              CrossAxisAlignment.start,
                                          children: [
                                            // View mode selector (Day/Week/Month)
                                            Padding(
                                              padding:
                                                  const EdgeInsets.symmetric(
                                                horizontal: 16,
                                                vertical: 8,
                                              ),
                                              child: SegmentedButton<ViewMode>(
                                                segments: const [
                                                  ButtonSegment(
                                                      value: ViewMode.day,
                                                      label: Text('Day')),
                                                  ButtonSegment(
                                                      value: ViewMode.week,
                                                      label: Text('Week')),
                                                  ButtonSegment(
                                                      value: ViewMode.month,
                                                      label: Text('Month')),
                                                ],
                                                selected: {view},
                                                onSelectionChanged: (s) async {
                                                  setState(() {
                                                    view = s.first;
                                                  });
                                                  await _refreshAll();
                                                },
                                              ),
                                            ),
                                            // Compact subheader (date, context chips, show completed)
                                            CompactSubheader(
                                              dateLabel: anchor,
                                              onPrev: _goPrev,
                                              onNext: _goNext,
                                              onToday: _goToToday,
                                              selectedContext: selectedContext,
                                              onContextChanged: (context) async {
                                                setState(() {
                                                  selectedContext = context;
                                                });
                                                await _refreshAll();
                                              },
                                              showCompleted: showCompleted,
                                              onShowCompletedChanged: (v) {
                                                setState(
                                                    () => showCompleted = v);
                                                _refreshAll();
                                              },
                                            ),
                                          ],
                                        ),
                                      Expanded(
                                        child: Stack(
                                          children: [
                                            AnimatedSwitcher(
                                              duration: AppAnim.medium,
                                              switchInCurve: AppAnim.easeOut,
                                              switchOutCurve: AppAnim.easeIn,
                                              child: KeyedSubtree(
                                                key: ValueKey(
                                                    '${mainView}_${view}_${anchor}_${selectedContext ?? 'all'}'),
                                                child: (mainView ==
                                                        MainView.tasks)
                                                    ? _buildMainList()
                                                    : (mainView ==
                                                            MainView.habits
                                                        ? _buildHabitsList()
                                                        : _buildGoalsView()),
                                              ),
                                            ),
                                            // FAB positioned at bottom right
                                            Positioned(
                                              right: 16,
                                              bottom: 16,
                                              child: FabActions(
                                                onCreateTodo: () =>
                                                    _showQuickAddTodo(),
                                                onCreateEvent: () =>
                                                    _showQuickAddEvent(),
                                                currentDate:
                                                    _getCurrentViewDate(),
                                              ),
                                            ),
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
                                        if (_clarifySelectedIds.contains(id)) {
                                          _clarifySelectedIds.remove(id);
                                        } else {
                                          _clarifySelectedIds.add(id);
                                        }
                                      }),
                                      onSelectClarifyDate: (d) => setState(() {
                                        _clarifySelectedDate = d;
                                      }),
                                      progressStage: _progressStage,
                                      progressValid: _progressValid,
                                      progressInvalid: _progressInvalid,
                                      progressStart: _progressStart,
                                      todayYmd: ymd(DateTime.now()),
                                      selectedClarifyIds: _clarifySelectedIds,
                                      selectedClarifyDate: _clarifySelectedDate,
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
    final parts = <String>[op.op];
    if (op.id != null) {
      parts.add('#${op.id}');
    }
    if (op.title != null) {
      parts.add('– ${op.title}');
    }
    // priority removed from label
    if (op.scheduledFor != null) {
      parts.add('@${op.scheduledFor}');
    }
    if (op.completed != null) {
      parts.add(op.completed! ? '[done]' : '[undone]');
    }
    return parts.join(' ');
  }

  // Import UI removed

  Widget _buildMainList() {
    final items = _currentList();
    final grouped = _groupByDate(items);

    if (view == ViewMode.month) {
      if (mainView == MainView.tasks) {
        // Build simple month grid data (6x7) around anchor
        final a = parseYmd(anchor);
        final firstOfMonth = DateTime(a.year, a.month, 1);
        final weekday = firstOfMonth.weekday % 7; // Sunday=0
        final gridStart = firstOfMonth.subtract(Duration(days: weekday));
        final days = List<String>.generate(
          42,
          (i) => ymd(gridStart.add(Duration(days: i))),
        );
        // Build maps
        final Map<String, List<Map<String, dynamic>>> evBy = {};
        final Map<String, List<Map<String, dynamic>>> tkBy = {};
        for (final t in _currentList()) {
          final y = t.scheduledFor ?? '';
          if (!days.contains(y)) continue;
          final isEvent = t.kind == 'event';
          final dst = isEvent
              ? (evBy[y] ??= <Map<String, dynamic>>[])
              : (tkBy[y] ??= <Map<String, dynamic>>[]);
          dst.add({
            'id': t.id,
            'title': t.title,
            'scheduledFor': t.scheduledFor,
            'timeOfDay': t.timeOfDay,
            'startTime': t.timeOfDay,
            'completed': t.completed,
            'context': t.context,
          });
        }
        return Padding(
          padding: const EdgeInsets.all(8.0),
          child: MonthView(
            gridYmd: days,
            eventsByDate: evBy,
            tasksByDate: tkBy,
            onPrev: _goPrev,
            onNext: _goNext,
            onToday: _goToToday,
            onOpenDay: (ymdStr) {
              setState(() {
                view = ViewMode.day;
                anchor = ymdStr;
              });
            },
          ),
        );
      }
      return _buildMonthGrid(grouped);
    }
    // Gated path for the new DayView (disabled by default)
    if (view == ViewMode.day && mainView == MainView.tasks) {
      return Padding(
        padding: const EdgeInsets.all(12),
        child: DayView(
          dateYmd: anchor,
          events: _anchorEventsAsMaps(),
          tasks: _anchorTasksAsMaps(),
          onSetTodoStatusOrOccurrence: _onSetTodoStatusOrOccurrenceNew,
          onEditTask: _onEditTask,
          onDeleteTask: _onDeleteTask,
          onEditEvent: _onEditEvent,
          scrollController: _timelineScrollController,
        ),
      );
    }

    // Gated path for new WeekView
    if (view == ViewMode.week && mainView == MainView.tasks) {
      // Compute Sunday..Saturday for current anchor
      final a = parseYmd(anchor);
      final sunday = a.subtract(Duration(days: a.weekday % 7));
      final days = List<String>.generate(
        7,
        (i) => ymd(sunday.add(Duration(days: i))),
      );
      // Build naive maps from scheduled list
      final Map<String, List<Map<String, dynamic>>> evBy = {};
      final Map<String, List<Map<String, dynamic>>> tkBy = {};
      for (final t in _currentList()) {
        final y = t.scheduledFor ?? '';
        if (!days.contains(y)) continue;
        final isEvent = t.kind == 'event';
        final dst = isEvent
            ? (evBy[y] ??= <Map<String, dynamic>>[])
            : (tkBy[y] ??= <Map<String, dynamic>>[]);
        dst.add({
          'id': t.id,
          'title': t.title,
          'scheduledFor': t.scheduledFor,
          'timeOfDay': t.timeOfDay,
          'completed': t.completed,
          'status': t.status,
          'context': t.context,
        });
      }
      return Padding(
        padding: const EdgeInsets.all(12),
        child: WeekView(
          weekYmd: days,
          eventsByDate: evBy,
          tasksByDate: tkBy,
          onOpenDay: (ymdStr) {
            setState(() {
              view = ViewMode.day;
              anchor = ymdStr;
            });
          },
        ),
      );
    }

    return AnimatedSwitcher(
      duration: const Duration(milliseconds: 400),
      transitionBuilder: (Widget child, Animation<double> animation) {
        return SlideTransition(
          position: Tween<Offset>(begin: const Offset(0, 0.1), end: Offset.zero)
              .animate(
                CurvedAnimation(parent: animation, curve: Curves.easeOutCubic),
              ),
          child: FadeTransition(opacity: animation, child: child),
        );
      },
      child: ListView(
        key: ValueKey('${view}_$selectedContext'),
        padding: const EdgeInsets.all(12),
        children: [
          if (view == ViewMode.week) _buildWeekdayHeader(),
          for (final entry in grouped.entries) ...[
            Builder(
              builder: (context) {
                final isTodayHeader = entry.key == ymd(DateTime.now());
                // Today label removed - just show the date
                final label = entry.key;
                return AnimatedContainer(
                  duration: Duration(
                    milliseconds: _todayPulseActive && isTodayHeader
                        ? 350
                        : 300,
                  ),
                  curve: _todayPulseActive && isTodayHeader
                      ? Curves.easeInOut
                      : Curves.easeOutCubic,
                  margin: const EdgeInsets.only(top: 8, bottom: 2),
                  padding: const EdgeInsets.symmetric(
                    vertical: 6,
                    horizontal: 8,
                  ),
                  decoration: BoxDecoration(
                    color: isTodayHeader
                        ? Theme.of(context).colorScheme.primary.withAlpha(
                            _todayPulseActive
                                ? (0.15 * 255).round()
                                : (0.06 * 255).round(),
                          )
                        : null,
                    border: Border(
                      left: BorderSide(
                        color: isTodayHeader
                            ? Theme.of(context).colorScheme.primary
                            : Colors.transparent,
                        width: _todayPulseActive && isTodayHeader ? 4 : 3,
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
            ...entry.value.map(
              (t) => AnimatedContainer(
                duration: const Duration(milliseconds: 300),
                curve: Curves.easeOutCubic,
                child: _buildRow(t),
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildWeekdayHeader() {
    try {
      final a = parseYmd(anchor);
      // NEW: compute Sunday of this week
      final sunday = a.subtract(Duration(days: a.weekday % 7));
      final days = List<DateTime>.generate(
        7,
        (i) => sunday.add(Duration(days: i)),
      );
      // NEW: Sunday-first labels
      final labels = const ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
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
                            color: Theme.of(context).colorScheme.primary
                                .withAlpha((0.08 * 255).round()),
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
    final monthName = '${_getMonthName(a.month)} ${a.year}';
    final firstOfMonth = DateTime(a.year, a.month, 1);
    final lastOfMonth = DateTime(a.year, a.month + 1, 0);
    // NEW: Compute Sunday on/before first, Saturday on/after last
    DateTime start = firstOfMonth;
    while (start.weekday != DateTime.sunday) {
      start = start.subtract(const Duration(days: 1));
    }
    DateTime end = lastOfMonth;
    while (end.weekday != DateTime.saturday) {
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
    // NEW: Sunday-first weekday labels
    final weekdayLabels = const [
      'Sun',
      'Mon',
      'Tue',
      'Wed',
      'Thu',
      'Fri',
      'Sat',
    ];
    return Column(
      children: [
        // Month header with navigation
        AnimatedContainer(
          duration: const Duration(milliseconds: 400),
          curve: Curves.easeOutCubic,
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: Theme.of(context).colorScheme.surfaceContainerLow,
            border: Border(
              bottom: BorderSide(
                color: Theme.of(context).colorScheme.outlineVariant,
                width: 1,
              ),
            ),
          ),
          child: Row(
            children: [
              IconButton(
                icon: const Icon(Icons.chevron_left),
                onPressed: _goPrev,
              ),
              Expanded(
                child: Text(
                  monthName,
                  style: Theme.of(context).textTheme.headlineSmall,
                  textAlign: TextAlign.center,
                ),
              ),
              IconButton(
                icon: const Icon(Icons.chevron_right),
                onPressed: _goNext,
              ),
            ],
          ),
        ),
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
    return AnimatedContainer(
      duration: const Duration(milliseconds: 300),
      curve: Curves.easeOutCubic,
      decoration: isToday
          ? BoxDecoration(
              border: Border.all(
                color: Theme.of(context).colorScheme.primary,
                width: 2,
              ),
              borderRadius: BorderRadius.circular(8),
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

    // Context-based colors
    final contextColor = t.context != null
        ? ContextColors.getContextColor(t.context)
        : Colors.grey.shade600;
    final Color bg =
        ContextColors.getContextBackgroundColor(t.context) ??
        Colors.grey.shade50;
    final Color fg = Colors.black87;
    final Color border = contextColor.withOpacity(0.3);

    return AnimatedContainer(
      duration: const Duration(milliseconds: 200),
      curve: Curves.easeOutCubic,
      margin: const EdgeInsets.only(bottom: 2),
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: border, width: 1),
      ),
      child: Text(
        label,
        style: TextStyle(fontSize: 11, color: fg, fontWeight: FontWeight.w500),
        overflow: TextOverflow.ellipsis,
      ),
    );
  }

  String _getMonthName(int month) {
    const monthNames = [
      'January',
      'February',
      'March',
      'April',
      'May',
      'June',
      'July',
      'August',
      'September',
      'October',
      'November',
      'December',
    ];
    return monthNames[month - 1];
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
      view = ViewMode.day;
      anchor = y;
      _pendingScrollYmd = y;
    });
    await _refreshAll();
  }

  void _goToToday() async {
    setState(() {
      anchor = ymd(DateTime.now());
      _todayPulseActive = true;
    });
    await _refreshAll();

    // Trigger pulse animation
    Future.delayed(const Duration(milliseconds: 100), () {
      if (mounted) {
        setState(() => _todayPulseActive = false);
      }
    });
  }

  // Date/Time picker helpers for quick-add forms
  Future<void> _pickDate(TextEditingController ctrl) async {
    final now = DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: now,
      firstDate: DateTime(now.year - 1),
      lastDate: DateTime(now.year + 2),
    );
    if (picked != null) {
      final y = picked.year.toString().padLeft(4, '0');
      final m = picked.month.toString().padLeft(2, '0');
      final d = picked.day.toString().padLeft(2, '0');
      ctrl.text = '$y-$m-$d';
    }
  }

  Future<void> _pickTime(TextEditingController ctrl) async {
    final picked = await showTimePicker(
      context: context,
      initialTime: TimeOfDay.now(),
    );
    if (picked != null) {
      final h = picked.hour.toString().padLeft(2, '0');
      final m = picked.minute.toString().padLeft(2, '0');
      ctrl.text = '$h:$m';
    }
  }

  void _maybeScrollToPendingDate() {
    if (_pendingScrollYmd == null) return;
    if (view != ViewMode.day) {
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
    if (view == ViewMode.day) {
      next = a.subtract(const Duration(days: 1));
    } else if (view == ViewMode.week) {
      next = a.subtract(const Duration(days: 7));
    } else {
      // Clamp day in month navigation to avoid invalid dates
      final prevMonth = DateTime(a.year, a.month - 1, 1);
      final lastPrev = DateTime(prevMonth.year, prevMonth.month + 1, 0).day;
      final day = a.day.clamp(1, lastPrev);
      next = DateTime(prevMonth.year, prevMonth.month, day);
    }
    setState(() {
      anchor = ymd(next);
    });
    await _refreshAll();
  }

  void _goNext() async {
    final a = parseYmd(anchor);
    DateTime next;
    if (view == ViewMode.day) {
      next = a.add(const Duration(days: 1));
    } else if (view == ViewMode.week) {
      next = a.add(const Duration(days: 7));
    } else {
      // Clamp day in month navigation to avoid invalid dates
      final nextMonth = DateTime(a.year, a.month + 1, 1);
      final lastNext = DateTime(nextMonth.year, nextMonth.month + 1, 0).day;
      final day = a.day.clamp(1, lastNext);
      next = DateTime(nextMonth.year, nextMonth.month, day);
    }
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
                  .map((e) => Map<String, dynamic>.from(e))
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
                  ...goals.map((g) => _goalRow(g)),
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
                              (e) => Map<String, dynamic>.from(e),
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
                                      if (!mounted) return;
                                      Navigator.of(context).pop();
                                      await _openGoalDetail(id);
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
                              (e) => Map<String, dynamic>.from(e),
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
                                      if (!mounted) return;
                                      Navigator.of(context).pop();
                                      await _openGoalDetail(id);
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
                                      if (!mounted) return;
                                      Navigator.of(context).pop();
                                      await _openGoalDetail(id);
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
                            if (!mounted) return;
                            Navigator.of(context).pop();
                            await _openGoalDetail(id);
                          } catch (e) {
                            if (mounted) {
                              ScaffoldMessenger.of(context).showSnackBar(
                                SnackBar(content: Text('Link failed: $e')),
                              );
                            }
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
                          if (cid == null) {
                            return;
                          }
                          try {
                            await api.addGoalChild(id, cid);
                            if (!mounted) return;
                            Navigator.of(context).pop();
                            await _openGoalDetail(id);
                          } catch (e) {
                            if (mounted) {
                              ScaffoldMessenger.of(context).showSnackBar(
                                SnackBar(content: Text('Add child failed: $e')),
                              );
                            }
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
                if (!mounted) return;
                Navigator.of(context).pop();
                await _openEditGoalDialog(goal);
              },
              child: const Text('Edit'),
            ),
            TextButton(
              onPressed: () async {
                try {
                  await api.deleteGoal(id);
                  if (!mounted) return;
                  Navigator.of(context).pop();
                  if (mounted) setState(() {});
                } catch (e) {
                  if (mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      SnackBar(content: Text('Delete failed: $e')),
                    );
                  }
                }
              },
              child: const Text('Delete'),
            ),
            TextButton(
              onPressed: () => Navigator.of(context).pop(),
              child: const Text('Close'),
            ),
          ],
        ),
      );
    } catch (e) {
      setState(() => message = 'Load goal failed: $e');
    }
  }

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
              ? Theme.of(
                  context,
                ).colorScheme.primary.withAlpha((0.1 * 255).round())
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
    // Determine overdue: only when viewing today's Day view, timed tasks, not completed, and time < now
    bool isOverdue = false;
    try {
      final bool isResolved = (t.kind == 'todo')
          ? ((t.status == 'completed') || (t.status == 'skipped'))
          : t.completed;
      if (!isResolved && t.scheduledFor != null && t.timeOfDay != null) {
        final todayYmd = ymd(DateTime.now());
        final viewingToday = (anchor == todayYmd);
        if (viewingToday && t.scheduledFor == todayYmd) {
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
      status: t.status,
      completed: (t.kind == 'todo') ? (t.status == 'completed') : t.completed,
      overdue: isOverdue,
      context: t.context,
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
        onToggleSkipped: (t.kind == 'todo') ? () => _toggleSkip(t) : null,
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
              await api.callMCPTool('update_todo', {
                'id': t.id,
                'title': newTitle,
                'recurrence': t.recurrence ?? {'type': 'none'},
              });
            }
            setState(() {
              t.title = newTitle;
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
              await api.callMCPTool('update_todo', {
                'id': t.id,
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
              children: [_quickAddHabitsInline()],
            ),
          ),
        ],
      ),
    );

    // Build Sun-Sat range from current anchor week
    final a = parseYmd(anchor);
    final sunday = a.subtract(Duration(days: a.weekday % 7));
    final week = List<DateTime>.generate(
      7,
      (i) => sunday.add(Duration(days: i)),
    );
    final weekY = week.map((d) => ymd(d)).toList();
    // Prepare habits
    final items = scheduled.where((t) => t.kind == 'habit').toList()
      ..sort((a, b) => (a.title).compareTo(b.title));
    final rows = items
        .map((t) => ht.HabitRowData(id: t.masterId ?? t.id, title: t.title))
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
        if (y == todayY) {
          current = newCompleted
              ? (current + 1)
              : (current > 0 ? current - 1 : 0);
        }
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
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('Update failed. Reverted.')),
          );
        }
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
    if (_selectedHabitId == null && rows.isNotEmpty) {
      _selectedHabitId = rows.first.id;
    }
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
                            const SizedBox(width: 0),
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
                          if (event is! KeyDownEvent) {
                            return KeyEventResult.ignored;
                          }
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
        ? Theme.of(
            context,
          ).colorScheme.surfaceContainerHighest.withAlpha((0.8 * 255).round())
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
                    ).colorScheme.primary.withAlpha((0.3 * 255).round()),
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
                    ).colorScheme.primary.withAlpha((0.15 * 255).round()),
                    width: 2,
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  // Helper functions for DayView task operations
  void _onEditTask(int taskId) {
    final task = scheduled.firstWhere(
      (t) => t.id == taskId,
      orElse: () => scheduledAllTime.firstWhere((t) => t.id == taskId),
    );
    if (task.kind == 'event') {
      _editEvent(task);
    } else {
      _editTodo(task);
    }
  }

  void _onDeleteTask(int taskId) {
    final task = scheduled.firstWhere(
      (t) => t.id == taskId,
      orElse: () => scheduledAllTime.firstWhere((t) => t.id == taskId),
    );
    _deleteTodo(task);
  }

  // Helper functions for DayView event operations
  void _onEditEvent(int eventId) {
    final event = scheduled.firstWhere(
      (t) => t.id == eventId,
      orElse: () => scheduledAllTime.firstWhere((t) => t.id == eventId),
    );
    _editEvent(event);
  }
}
