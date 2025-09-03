import 'package:flutter/material.dart';
import 'dart:async';
import 'util/context_colors.dart';
import 'widgets/assistant_panel.dart';
import 'widgets/assistant_handle.dart';
import 'views/day_view.dart';
import 'views/week_view.dart';
import 'views/month_view.dart';
import 'widgets/task_row.dart' as row;

import 'widgets/fab_actions.dart';
import 'widgets/compact_subheader.dart';

import 'api.dart' as api;
import 'package:dio/dio.dart';
import 'package:flutter/services.dart';
import 'dart:math' as math;
import 'dart:ui' as ui;
import 'util/storage.dart' as storage;
import 'util/animation.dart';
import 'util/time_format.dart';
import 'widgets/time_field.dart';
import 'models.dart';

// --- Test hooks and injectable API (local single-user context) ---
class TestHooks {
  static bool skipRefresh = false;
}

var createTaskFn = (Map<String, dynamic> data) async {
  final res = await api.callMCPTool('create_task', data);
  try {
    final results = (res['results'] as List<dynamic>?);
    if (results != null && results.isNotEmpty) {
      final first = results.first as Map<String, dynamic>;
      final task = first['task'];
      if (task is Map) return Map<String, dynamic>.from(task);
    }
  } catch (_) {}
  throw Exception('create_task_failed');
};
var createEventFn = api.createEvent;

void main() {
  runApp(const App());
}

// ----- Models -----
class Task {
  final int id;
  String title;
  String notes;
  String? kind; // 'task'|'event' for unified schedule rows
  String? scheduledFor; // YYYY-MM-DD or null
  String? startTime; // canonical 24h HH:MM or null (for events)
  String? endTime; // canonical 24h HH:MM or null (for events)
  String? priority; // low|medium|high
  bool completed;
  String? status; // 'pending'|'completed'|'skipped' for tasks
  Map<String, dynamic>? recurrence; // {type,...}
  int? masterId; // present on expanded occurrences
  String? context; // 'school'|'personal'|'work'
  String? location; // for events
  final String createdAt;
  String updatedAt;

  Task({
    required this.id,
    required this.title,
    required this.notes,
    this.kind,
    required this.scheduledFor,
    this.startTime,
    this.endTime,
    this.priority,
    required this.completed,
    this.status,
    required this.recurrence,
    required this.masterId,
    required this.context,
    this.location,
    required this.createdAt,
    required this.updatedAt,
  });

  factory Task.fromJson(Map<String, dynamic> j) => Task(
    id: j['id'] as int,
    title: j['title'] as String? ?? '',
    notes: j['notes'] as String? ?? '',
    kind: j['kind'] as String?,
    scheduledFor: j['scheduledFor'] as String?,
    startTime: j['startTime'] as String?,
    endTime: j['endTime'] as String?,
    priority: j['priority'] as String?,
    completed: j['completed'] as bool? ?? false,
    status: j['status'] as String?,
    recurrence: j['recurrence'] as Map<String, dynamic>?,
    masterId: j['masterId'] as int?,
    context: j['context'] as String?,
    location: j['location'] as String?,
    createdAt: j['createdAt'] as String? ?? '',
    updatedAt: j['updatedAt'] as String? ?? '',
  );
}

class LlmOperation {
  final String op; // create|update|delete|complete
  // V3 shape support
  final String? kind; // task|event
  final String? action; // create|update|delete|complete|complete_occurrence
  final int? id;
  final String? title;
  final String? notes;
  final String? scheduledFor;
  final String? priority;
  final bool? completed;
  
  // Event-specific optional fields
  final String? startTime; // canonical 24h HH:MM
  final String? endTime; // canonical 24h HH:MM
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
    completed: j['completed'] as bool?,
    
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
    if (completed != null) 'completed': completed,
    
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
      if (raw is Map) {
        return LlmOperation.fromJson(Map<String, dynamic>.from(raw));
      }
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
  // Search filter state removed

  // Today highlight animation state
  bool _todayPulseActive = false;

  // Map of row keys for ensureVisible
  final Map<int, GlobalKey> _rowKeys = {};
  int? _pendingScrollKeyId; // row key target after navigation (occurrence-aware)
  int? _pendingScrollBaseId; // base id from search result for matching after refresh

  MainView mainView = MainView.tasks;

  // Context filter state
  String? selectedContext; // 'school', 'personal', 'work', null for 'all'

  // Data
  List<Task> scheduled = [];
  List<Task> scheduledAllTime = [];
  List<Task> searchResults = [];

  // Unified schedule filters (chips)
  // Default to show both tasks and events; tabs can filter to specific types.
  Set<String> _kindFilter = <String>{'task', 'event'};

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
  Map<String, Map<String, dynamic>> assistantOpPreviews = {};
  bool assistantShowDiff = false;
  // Thinking state for assistant responses
  String? assistantThinking;
  bool assistantShowThinking = false; // persisted
  int? assistantStreamingIndex;
  // Clarify flow removed; handled by conversational chat
  String _progressStage = '';
  String? _lastCorrelationId;
  int _progressValid = 0;
  int _progressInvalid = 0;
  DateTime? _progressStart;
  // Pending smooth-scroll target (YYYY-MM-DD) for Day view
  String? _pendingScrollYmd;

  // merged into the later initState below

  // Quick-add controllers
  final TextEditingController _qaTaskTitle = TextEditingController();
  final TextEditingController _qaTaskDate = TextEditingController();
  final TextEditingController _qaTaskNotes = TextEditingController();
  final TextEditingController _qaTaskInterval = TextEditingController();

  final TextEditingController _qaEventTitle = TextEditingController();
  final TextEditingController _qaEventStart = TextEditingController();
  final TextEditingController _qaEventEnd = TextEditingController();
  final TextEditingController _qaEventLocation = TextEditingController();
  final TextEditingController _qaEventDate = TextEditingController();
  final TextEditingController _qaEventNotes = TextEditingController();
  final TextEditingController _qaEventInterval = TextEditingController();

  bool _addingQuick = false;

  // FAB dialog state variables
  String? _qaSelectedContext;
  String? _qaSelectedRecurrence;

  @override
  void initState() {
    super.initState();
    // Restore thinking toggle
    try {
      final v = storage.getItem('assistantShowThinking');
      if (v == '1') assistantShowThinking = true;
    } catch (_) {}
    // Restore persisted main tab if available
    try {
      final saved = storage.getItem('mainTab') ?? '';
      if (saved == 'goals') {
        mainView = MainView.tasks;
      } else {
        // Default to tasks view with both tasks and events
        mainView = MainView.tasks;
        _kindFilter = <String>{'task', 'event'};
      }
    } catch (_) {}
    if (!TestHooks.skipRefresh) {
      _refreshAll();
    } else {
      setState(() => loading = false);
    }

    // Search filters removed
  }

  // _isValidTime helper removed; tasks are all-day in current UI

  Future<void> _submitQuickAddTask({String? selectedContext}) async {
    if (_addingQuick) return;
    final title = _qaTaskTitle.text.trim();
    final date = _qaTaskDate.text.trim();
    // tasks are all-day; time string intentionally unused
    final notes = _qaTaskNotes.text.trim();

    if (title.isEmpty) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('Please enter a title.')));
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
              'intervalDays': int.tryParse(_qaTaskInterval.text.trim()) ?? 1,
            }
          : {'type': _qaSelectedRecurrence};

      final created = await createTaskFn({
        'title': title,
        'notes': notes,
        'scheduledFor': scheduledFor,
        'recurrence': recurrence,
        'context': selectedContext ?? _qaSelectedContext ?? 'personal',
      });
      if (!mounted) return;
      setState(() {
        _qaTaskTitle.clear();
        _qaTaskDate.clear();
        _qaTaskNotes.clear();
        _qaTaskInterval.clear();
      });
      if (!TestHooks.skipRefresh) {
        try {
          scheduled.insert(0, Task.fromJson(created));
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

  Future<void> _submitQuickAddEvent({String? selectedContext}) async {
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
    final parsedStart = AmericanTimeFormat.parseFlexible(start);
    final parsedEnd = AmericanTimeFormat.parseFlexible(end);
    if ((start.isNotEmpty && parsedStart == null) || (end.isNotEmpty && parsedEnd == null)) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Enter valid times, e.g., 1:00 PM.')),
      );
      return;
    }
    // Reject end-only input
    if (start.isEmpty && end.isNotEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Please enter a start time.')),
      );
      return;
    }

    // Validate start ≤ end time if both are provided
    // Default end = start + 1h when start set and end empty
    String? localEnd24 = parsedEnd;
    if ((parsedStart != null) && (end.trim().isEmpty)) {
      final res = AmericanTimeFormat.addOneHour(parsedStart);
      localEnd24 = res.hhmm;
      setState(() {
        _qaEventEnd.text = localEnd24!; // show canonical in controller; TimeField displays 12h
      });
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
        'startTime': parsedStart,
        'endTime': (parsedStart != null) ? localEnd24 : parsedEnd,
        'location': location.isEmpty ? null : location,
        'recurrence': recurrence,
        'context': selectedContext ?? _qaSelectedContext ?? 'personal',
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


  @override
  void dispose() {
    _searchDebounce?.cancel();
    assistantCtrl.dispose();

    searchCtrl.dispose();
    _searchFocus.dispose();
    _removeSearchOverlay();
    _qaTaskTitle.dispose();
    _qaTaskDate.dispose();
    _qaTaskNotes.dispose();
    _qaTaskInterval.dispose();
    _qaEventTitle.dispose();
    _qaEventStart.dispose();
    _qaEventEnd.dispose();
    _qaEventLocation.dispose();
    _qaEventDate.dispose();
    _qaEventNotes.dispose();
    _qaEventInterval.dispose();
    super.dispose();
  }

  Future<void> _refreshAll() async {
    setState(() => loading = true);
    try {
      final r = rangeForView(anchor, view);
      // Debug: ensure context is visible in dev logs
      // ignore: avoid_print
      print('[refresh] context=${selectedContext ?? 'all'} view=$view from=${r.from} to=${r.to}');
      // Day/Week/Month: use unified schedule for Tasks and Habits
      List<Task> sList;
      if (view == ViewMode.day ||
          view == ViewMode.week ||
          view == ViewMode.month) {
        // Only tasks/events remain
        final kinds = _kindFilter.toList();
        final raw = await api.fetchSchedule(
          from: r.from,
          to: r.to,
          kinds: kinds,
          completed: showCompleted ? null : false,
          statusTask: showCompleted ? null : 'pending',
          context: selectedContext,
        );
        sList = raw
            .map((e) => Task.fromJson(Map<String, dynamic>.from(e)))
            .toList();

      } else {
        final scheduledRaw = await api.fetchScheduled(
          from: r.from,
          to: r.to,
          status: showCompleted ? null : 'pending',
          context: selectedContext,
        );
        sList = scheduledRaw
            .map((e) => Task.fromJson(e as Map<String, dynamic>))
            .toList();
      }
      final scheduledAllRaw = await api.fetchScheduledAllTime(
        status: showCompleted ? null : 'pending',
        context: selectedContext,
      );
      // Load events data when needed for "All" or "Events" views
      List<Task> eventsAllList = const <Task>[];
      if (mainView == MainView.tasks &&
          (_kindFilter.contains('event') || _kindFilter.contains('task'))) {
        try {
          final evAllRaw = await api.listEvents(context: selectedContext);
          eventsAllList = evAllRaw
              .map((e) => Task.fromJson(Map<String, dynamic>.from(e)))
              .toList();
        } catch (_) {}
      }
      final sAllList = scheduledAllRaw
          .map((e) => Task.fromJson(e as Map<String, dynamic>))
          .toList();

      // counts map was unused; remove to satisfy analyzer while preserving computed components
      setState(() {
        scheduled = sList;
        // Combine tasks and events for "All" view, or use specific list for filtered views
        if (mainView == MainView.tasks &&
            _kindFilter.contains('task') &&
            _kindFilter.contains('event')) {
          // "All" view: combine tasks and events
          scheduledAllTime = [...sAllList, ...eventsAllList];
        } else if (mainView == MainView.tasks &&
            _kindFilter.contains('event')) {
          // "Events" view: events only
          scheduledAllTime = eventsAllList;
        } else {
          // "Tasks" view or other: tasks only
          scheduledAllTime = sAllList;
        }
        message = null;
      });
      
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
          'startTime': t.startTime,
          'endTime': t.endTime,
          'notes': t.notes,
          'completed': t.completed,
          'location': t.location,
          'context': t.context,
        });
      }
    }
    return list;
  }

  List<Map<String, dynamic>> _anchorTasksAsMaps() {
    final List<Map<String, dynamic>> list = [];
    for (final t in _currentList()) {
      if ((t.kind == 'task' || t.kind == null) && t.scheduledFor == anchor) {
        // Compute overdue only when viewing today's Day view
        bool isOverdue = false;
        try {
          final bool isResolved =
              ((t.status == 'completed') || (t.status == 'skipped'));
          if (!isResolved && t.scheduledFor != null) {
            final todayYmd = ymd(DateTime.now());
            final viewingToday = (anchor == todayYmd);
            if (viewingToday && t.scheduledFor == todayYmd) {
              final parts = ''.split(':');
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

  Future<void> _onSetTaskStatusOrOccurrence(int id, String status) async {
    try {
      final t = _currentList().firstWhere(
        (e) =>
            (e.kind == 'task' || e.kind == null) &&
            (e.id == id || e.masterId == id),
        orElse: () => throw Exception('task_not_found'),
      );
      if (t.masterId != null && t.scheduledFor != null) {
        await api.callMCPTool('set_task_status', {
          'id': t.masterId!,
          'status': status,
          'occurrenceDate': t.scheduledFor!,
        });
      } else {
        await api.callMCPTool('set_task_status', {
          'id': t.id,
          'status': status,
        });
      }
      // Search filter state removed; no-op update
      await _refreshAll();
    } catch (_) {}
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
      final raw = await api.searchUnified(
        q,
        cancelToken: _searchCancelToken,
        limit: 30,
      );
      final items = raw.map((e) => Task.fromJson(Map<String, dynamic>.from(e))).toList();
      // Client trusts server to enforce substring for q length >= 2
      final itemsFiltered = items;
      setState(() {
        searchResults = itemsFiltered;
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
      const Duration(milliseconds: 300),
      () => _runSearch(v),
    );
  }

  // Search filter functions removed

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
                                // Filters removed
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
                                    child: Builder(
                                      builder: (ctx) {
                                        final theme = Theme.of(ctx);
                                        // Group results by date, then type
                                        final Map<String, List<Task>> byDate =
                                            {};
                                        for (final t in results) {
                                          final k =
                                              (t.scheduledFor ?? 'unscheduled');
                                          (byDate[k] ??= <Task>[]).add(t);
                                        }
                                        final orderedDates =
                                            byDate.keys.toList()
                                          ..sort((a, b) => a.compareTo(b));
                                        final tiles = <Widget>[];
                                        for (final d in orderedDates) {
                                          tiles.add(
                                            Padding(
                                              padding:
                                                  const EdgeInsets.fromLTRB(
                                                    12,
                                                    8,
                                                    12,
                                                    6,
                                                  ),
                                            child: Text(
                                              d,
                                              style: TextStyle(
                                                fontWeight: FontWeight.w600,
                                                  color: theme
                                                      .colorScheme
                                                      .onSurfaceVariant,
                                              ),
                                            ),
                                            ),
                                          );
                                          final items = byDate[d]!;
                                          int rank(String? k) {
                                            switch (k) {
                                              case 'event':
                                                return 0;
                                              case 'task':
                                              case null:
                                                return 1;

                                              default:
                                                return 3;
                                            }
                                          }

                                          items.sort((a, b) {
                                            final r =
                                                rank(a.kind) - rank(b.kind);
                                            if (r != 0) return r;
                                            return a.title.compareTo(b.title);
                                          });
                                          for (
                                            var i = 0;
                                            i < items.length;
                                            i++
                                          ) {
                                            final t = items[i];
                                            final idx = results.indexOf(t);
                                            final selected =
                                                idx == _searchHoverIndex;
                                            tiles.add(
                                              InkWell(
                                                onTap: () =>
                                                    _selectSearchResult(t),
                                              onHover: (h) => setState(
                                                  () => _searchHoverIndex = h
                                                      ? idx
                                                      : _searchHoverIndex,
                                              ),
                                              child: Container(
                                                color: selected
                                                      ? theme
                                                            .colorScheme
                                                            .primary
                                                            .withAlpha(
                                                              (0.08 * 255)
                                                                  .round(),
                                                            )
                                                    : Colors.transparent,
                                                  padding:
                                                      const EdgeInsets.symmetric(
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
                                                            _highlightedText(
                                                              t.title,
                                                              searchCtrl.text,
                                                            ),
                                                            const SizedBox(
                                                              height: 4,
                                                            ),
                                                          Wrap(
                                                            spacing: 6,
                                                            runSpacing: 4,
                                                            children: [
                                                                _chip(
                                                                  (t.scheduledFor ??
                                                                      'unscheduled'),
                                                                ),
                                                                _buildKindChip(
                                                                  t.kind ??
                                                                      'task',
                                                                ),
                                                            ],
                                                          ),
                                                        ],
                                                      ),
                                                    ),
                                                  ],
                                                ),
                                              ),
                                              ),
                                            );
                                            if (i < items.length - 1) {
                                              tiles.add(
                                                Divider(
                                                height: 1,
                                                  color: theme
                                                      .colorScheme
                                                      .outline
                                                      .withAlpha(
                                                        (0.2 * 255).round(),
                                                      ),
                                                ),
                                              );
                                            }
                                          }
                                        }
                                        return ListView(
                                          padding: const EdgeInsets.symmetric(
                                            vertical: 6,
                                          ),
                                          shrinkWrap: true,
                                          children: tiles,
                                        );
                                      },
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

  Widget _highlightedText(String text, String query) {
    final q = query.trim();
    if (q.isEmpty) {
      return Text(text, maxLines: 1, overflow: TextOverflow.ellipsis);
    }
    final lower = text.toLowerCase();
    final idx = lower.indexOf(q.toLowerCase());
    if (idx < 0) {
      return Text(text, maxLines: 1, overflow: TextOverflow.ellipsis);
    }
    final before = text.substring(0, idx);
    final match = text.substring(idx, idx + q.length);
    final after = text.substring(idx + q.length);
    return RichText(
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      text: TextSpan(
        children: [
          TextSpan(
            text: before,
            style: const TextStyle(color: Colors.black87),
          ),
          TextSpan(
            text: match,
            style: const TextStyle(
              fontWeight: FontWeight.w700,
              color: Colors.black,
            ),
          ),
          TextSpan(
            text: after,
            style: const TextStyle(color: Colors.black87),
          ),
        ],
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
      case 'task':
        icon = Icons.task;
        color = Colors.blue;
        break;
      default:
        icon = Icons.circle;
        color = Colors.grey;
    }

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: color.withAlpha((0.1 * 255).round()),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(
          color: color.withAlpha((0.3 * 255).round()),
          width: 1,
        ),
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

  Future<void> _selectSearchResult(Task t) async {
    _removeSearchOverlay();
    try { await Navigator.of(context, rootNavigator: true).maybePop(); } catch (_) {}
    _searchFocus.unfocus();
    searchCtrl.clear();
    setState(() {
      searchResults = [];
      _searchHoverIndex = -1;
    });
    // Ensure correct kind visibility
    if (t.kind == 'event') {
      if (!(mainView == MainView.tasks && _kindFilter.contains('event'))) {
        setState(() {
          mainView = MainView.tasks;
          _kindFilter = <String>{'task', 'event'};
        });
        await _refreshAll();
      }
    } else {
      if (!(mainView == MainView.tasks && _kindFilter.contains('task'))) {
        setState(() {
          mainView = MainView.tasks;
          _kindFilter = <String>{'task', 'event'};
        });
        await _refreshAll();
      }
    }

    // Unscheduled: close, no navigation; show toast
    if (t.scheduledFor == null) {
      try {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Unscheduled item — nothing to navigate to')),
        );
      } catch (_) {}
      return;
    }

    // Compute target row key id (occurrence-aware) when possible
    final int? keyId = (t.masterId != null && t.scheduledFor != null)
        ? Object.hashAll([t.masterId, t.scheduledFor])
        : null;

    setState(() {
      view = ViewMode.day;
      anchor = t.scheduledFor!;
      _pendingScrollYmd = t.scheduledFor!;
      _pendingScrollKeyId = keyId; // may be null when selecting from search (no masterId provided)
      _pendingScrollBaseId = t.id; // use to find matching row after refresh
    });
    await _refreshAll();
  }

  Future<void> _toggleCompleted(Task t) async {
    try {
      if (t.kind == 'event') {
        // Event completion is not supported
        setState(() => message = 'Event completion is not supported.');
      } else {
        // task: use status model
        if (t.masterId != null && t.scheduledFor != null) {
          final next = (t.status == 'completed') ? 'pending' : 'completed';
          await api.callMCPTool('set_task_status', {
            'id': t.masterId!,
            'status': next,
            'occurrenceDate': t.scheduledFor!,
          });
        } else {
          final next = (t.status == 'completed') ? 'pending' : 'completed';
          await api.callMCPTool('set_task_status', {
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

  Future<void> _toggleSkip(Task t) async {
    try {
      if (t.kind != 'task') return;
      if (t.masterId != null && t.scheduledFor != null) {
        final next = (t.status == 'skipped') ? 'pending' : 'skipped';
        await api.callMCPTool('set_task_status', {
          'id': t.masterId!,
          'status': next,
          'occurrenceDate': t.scheduledFor!,
        });
      } else {
        final next = (t.status == 'skipped') ? 'pending' : 'skipped';
        await api.callMCPTool('set_task_status', {'id': t.id, 'status': next});
      }
      await _refreshAll();
    } catch (e) {
      setState(() => message = 'Skip failed: $e');
    }
  }

  Future<void> _deleteTask(Task t) async {
    // Keep method name for minimal change footprint but semantics are Task
    try {
      await api.deleteTask(t.id);
    } catch (_) {}
  }

  Future<void> _deleteItem(Task t) async {
    try {
      if (t.kind == 'event') {
        await api.deleteEvent(t.id);
      } else {
        await api.deleteTask(t.id);
      }
    } catch (_) {}
  }


  Future<void> _editTask(Task t) async {
    final titleCtrl = TextEditingController(text: t.title);
    final notesCtrl = TextEditingController(text: t.notes);
    final dateCtrl = TextEditingController(text: t.scheduledFor ?? '');
    // No time field for tasks in current UI
    final intervalCtrl = TextEditingController(
      text: (t.recurrence != null && t.recurrence!['intervalDays'] != null)
          ? '${t.recurrence!['intervalDays']}'
          : '1',
    );

    String recurType = (t.recurrence != null && t.recurrence!['type'] is String)
        ? (t.recurrence!['type'] as String)
        : 'none';
    String selectedContext = t.context ?? 'personal';
    final ok = await showDialog<dynamic>(
      context: context,
      builder: (c) => StatefulBuilder(
        builder: (c, setDlgState) {
          return AlertDialog(
            title: const Text('Edit task'),
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
                  // Tasks are all-day; no time input
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
        await api.deleteTask(t.id);
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
    final sched = dateCtrl.text.trim();
    final normalized = sched.isEmpty ? null : sched;
    if (normalized != (t.scheduledFor ?? '')) {
      patch['scheduledFor'] = normalized;
    }

    // tasks are all-day; ignore time field from editor
    // tasks are all-day; ignore time edits
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
              'Set an anchor date (YYYY-MM-DD) for repeating tasks.',
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
      await api.updateTask(t.id, patch);
      await _refreshAll();
    } catch (e) {
      setState(() => message = 'Edit failed: $e');
    }
  }

  Future<void> _editEvent(Task t) async {
    // For events, fetch the original event data to get endTime and location
    Map<String, dynamic>? originalEventData;
    if (t.kind == 'event') {
      try {
        final res = await api.api.get('/api/events/${t.id}');
        originalEventData = Map<String, dynamic>.from(res.data['event']);
      } catch (_) {
      }
      if (!mounted) {
        return;
      }
    }

    final titleCtrl = TextEditingController(text: t.title);
    final notesCtrl = TextEditingController(text: t.notes);
    final dateCtrl = TextEditingController(text: t.scheduledFor ?? '');
    final startCtrl = TextEditingController(
      text: originalEventData?['startTime'] ?? '',
    );
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
                        child: TimeField(controller: startCtrl, label: 'Start Time'),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: TimeField(controller: endCtrl, label: 'End Time'),
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
        await _deleteItem(t);
        await _refreshAll();
      } catch (e) {
        setState(() => message = 'Delete failed: $e');
      }
      return;
    }
    if (!mounted || ok != true) {
      return;
    }
    final patch = <String, dynamic>{};
    if (titleCtrl.text != t.title) patch['title'] = titleCtrl.text;
    if (notesCtrl.text != t.notes) patch['notes'] = notesCtrl.text;
    if (selectedContext != t.context) patch['context'] = selectedContext;
    final date = dateCtrl.text.trim();
    final normalized = date.isEmpty ? null : date;
    if (normalized != (t.scheduledFor ?? '')) {
      patch['scheduledFor'] = normalized;
    }

    final start = startCtrl.text.trim();
    final end = endCtrl.text.trim();
    final parsedStart = AmericanTimeFormat.parseFlexible(start);
    final parsedEnd = AmericanTimeFormat.parseFlexible(end);
    if ((start.isNotEmpty && parsedStart == null) || (end.isNotEmpty && parsedEnd == null)) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Enter valid times, e.g., 1:00 PM.')),
      );
      return;
    }
    // time rules
    if (start.isEmpty && end.isNotEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Please enter a start time.')),
      );
      return;
    }

    String currStart = (originalEventData?['startTime'] as String?) ?? '';
    String currEnd = (originalEventData?['endTime'] as String?) ?? '';
    String? nextStart = parsedStart;
    String? nextEnd = parsedEnd;

    if (start.isNotEmpty && end.isEmpty) {
      final res = AmericanTimeFormat.addOneHour(parsedStart!);
      nextEnd = res.hhmm;
    }
    if (start.isEmpty && end.isEmpty) {
      nextStart = null;
      nextEnd = null;
    }

    if (nextStart != currStart) patch['startTime'] = nextStart;
    if (nextEnd != currEnd) patch['endTime'] = nextEnd;
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
          final kinds = _kindFilter.contains('event')
                    ? <String>['event']
              : <String>['task'];
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
        // Clarify flow removed; Mr. Assister will ask follow-ups in chat

        onStage: (st) {
          if (!mounted) return;
          setState(() {
            _progressStage = st;
            _progressStart ??= DateTime.now();
          });
        },
        onOps: (ops, version, validCount, invalidCount, previews) {
          if (!mounted) return;
          setState(() {
            // Replace operations immediately; preserve checked state for matching ops by (op,id)
            final prior = assistantOps;
            final priorChecked = assistantOpsChecked;
            assistantOps = ops.map((e) => AnnotatedOp.fromJson(e)).toList();
            // Capture previews keyed by stable key from server
            assistantOpPreviews.clear();
            try {
              for (final p in previews) {
                final k = (p['key'] ?? '').toString();
                if (k.isNotEmpty) {
                  assistantOpPreviews[k] = Map<String, dynamic>.from(p);
                }
              }
            } catch (_) {}
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
        onThinking: (th) {
          if (!mounted) return;
          setState(() {
            assistantThinking = th;
          });
        },
      );
      final reply = (res['text'] as String?) ?? '';
      final corr = (res['correlationId'] as String?) ?? _lastCorrelationId;
      final thinking = res['thinking'] as String?;
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
        // Clear previews after final apply or leave for display until next turn; we keep until next send
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
        assistantThinking = thinking;
        assistantShowThinking = false;
        try {
          storage.setItem('assistantShowThinking', assistantShowThinking ? '1' : '0');
        } catch (_) {}
        // Clarify state removed
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

  Map<String, List<Task>> _groupByDate(List<Task> items) {
    final map = <String, List<Task>>{};
    for (final t in items) {
      final k = t.scheduledFor ?? 'unscheduled';
      map.putIfAbsent(k, () => []).add(t);
    }
    final sorted = Map.fromEntries(
      map.entries.toList()..sort((a, b) => a.key.compareTo(b.key)),
    );
    // Sort within each date by id ascending (tasks have no time)
    for (final e in sorted.entries) {
      e.value.sort((a, b) => a.id.compareTo(b.id));
    }
    return sorted;
  }

  List<Task> _currentList() {
    // Always return all scheduled items without type filtering
    return scheduled;
  }

  String? _getCurrentViewDate() {
    // Always return the anchor date
    return anchor;
  }

  void _showQuickAddTask() {
    // Reset state variables
    _qaSelectedContext = selectedContext ?? 'personal';
    _qaSelectedRecurrence = 'none';

    // Set default date to today
    _qaTaskDate.text = anchor;

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
                    controller: _qaTaskTitle,
                    decoration: const InputDecoration(labelText: 'Title *'),
                    autofocus: true,
                  ),
                  const SizedBox(height: 8),
                  Row(
                    children: [
                      Expanded(
                        child: TextField(
                          controller: _qaTaskDate,
                          decoration: const InputDecoration(
                            labelText: 'Date (YYYY-MM-DD)',
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      IconButton(
                        onPressed: () => _pickDate(_qaTaskDate),
                        icon: const Icon(Icons.calendar_today),
                        tooltip: 'Pick date',
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  // Tasks are all-day; no time input
                  const SizedBox(height: 8),
                  TextField(
                    controller: _qaTaskNotes,
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
                      controller: _qaTaskInterval,
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
                      await _submitQuickAddTask(
                        selectedContext: _qaSelectedContext,
                      );
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
                        child: TimeField(controller: _qaEventStart, label: 'Start Time'),
                      ),
                      const SizedBox(width: 8),
                    ],
                  ),
                  const SizedBox(height: 8),
                  Row(
                    children: [
                      Expanded(
                        child: TimeField(controller: _qaEventEnd, label: 'End Time'),
                      ),
                      const SizedBox(width: 8),
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
                      await _submitQuickAddEvent(
                        selectedContext: _qaSelectedContext,
                      );
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
                                      if (mainView == MainView.tasks)
                                        Column(
                                          crossAxisAlignment:
                                              CrossAxisAlignment.start,
                                          children: [
                                            // Moved segmented control into CompactSubheader.leadingControls
                                            CompactSubheader(
                                              dateLabel: anchor,
                                              onPrev: _goPrev,
                                              onNext: _goNext,
                                              onToday: _goToToday,
                                              selectedContext: selectedContext,
                                              onContextChanged:
                                                  (context) async {
                                                setState(() {
                                                  selectedContext = context;
                                                });
                                                await _refreshAll();
                                              },
                                              showCompleted: showCompleted,
                                              onShowCompletedChanged: (v) {
                                                setState(
                                                  () => showCompleted = v,
                                                );
                                                _refreshAll();
                                              },
                                              // New assistant/search wiring
                                              onToggleAssistant: () => setState(
                                                () => assistantCollapsed =
                                                    !assistantCollapsed,
                                              ),
                                              searchController: searchCtrl,
                                              searchFocus: _searchFocus,
                                              searchLink: _searchLink,
                                              searching: _searching,
                                              onSearchChanged: (v) {
                                                _onSearchChanged(v);
                                                _showSearchOverlayIfNeeded();
                                              },
                                              onSearchFocusChange: (f) {
                                                // Keep overlay open on focus loss; rely on outside tap or selection to close
                                                if (f) {
                                                  _showSearchOverlayIfNeeded();
                                                }
                                              },
                                              onSearchKeyEvent: (node, event) {
                                                if (!_searchFocus.hasFocus) {
                                                  return KeyEventResult.ignored;
                                                }
                                                if (event is! KeyDownEvent) {
                                                  return KeyEventResult.ignored;
                                                }
                                                final len = math.min(
                                                  searchResults.length,
                                                  7,
                                                );
                                                if (event.logicalKey ==
                                                    LogicalKeyboardKey
                                                        .arrowDown) {
                                                  setState(() {
                                                    _searchHoverIndex = len == 0
                                                        ? -1
                                                        : (_searchHoverIndex +
                                                                  1) %
                                                              len;
                                                  });
                                                  _showSearchOverlayIfNeeded();
                                                  return KeyEventResult.handled;
                                                } else if (event.logicalKey ==
                                                    LogicalKeyboardKey
                                                        .arrowUp) {
                                                  setState(() {
                                                    _searchHoverIndex = len == 0
                                                        ? -1
                                                        : (_searchHoverIndex -
                                                                  1 +
                                                                  len) %
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
                                                    return KeyEventResult
                                                        .handled;
                                                  }
                                                  final idx =
                                                      _searchHoverIndex >= 0 &&
                                                          _searchHoverIndex <
                                                              list.length
                                                      ? _searchHoverIndex
                                                      : 0;
                                                  _selectSearchResult(
                                                    list[idx],
                                                  );
                                                  return KeyEventResult.handled;
                                                } else if (event.logicalKey ==
                                                    LogicalKeyboardKey.escape) {
                                                  searchCtrl.clear();
                                                  setState(() {
                                                    searchResults = [];
                                                    _searchHoverIndex = -1;
                                                  });
                                                  _removeSearchOverlay();
                                                  return KeyEventResult.handled;
                                                }
                                                return KeyEventResult.ignored;
                                              },
                                              onSearchClear: () {
                                                searchCtrl.clear();
                                                setState(() {
                                                  searchResults = [];
                                                  _searchHoverIndex = -1;
                                                });
                                                _removeSearchOverlay();
                                              },
                                              leadingControls: Row(
                                                mainAxisSize: MainAxisSize.min,
                                                children: [
                                                  Padding(
                                                    padding: const EdgeInsets.symmetric(
                                                      horizontal: 16,
                                                      vertical: 8,
                                                    ),
                                                    child: SegmentedButton<ViewMode>(
                                                      segments: const [
                                                        ButtonSegment(value: ViewMode.day, label: Text('Day')),
                                                        ButtonSegment(value: ViewMode.week, label: Text('Week')),
                                                        ButtonSegment(value: ViewMode.month, label: Text('Month')),
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
                                                ],
                                              ),
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
                                                  '${mainView}_${view}_${anchor}_${selectedContext ?? 'all'}',
                                                ),
                                                child: _buildMainList(),
                                              ),
                                            ),
                                            Positioned(
                                              right: 16,
                                              bottom: 16,
                                              child: FabActions(
                                                onCreateTask: () =>
                                                    _showQuickAddTask(),
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
                                // Assistant area: handle + panel stacked
                                SizedBox(
                                  width: assistantCollapsed ? 36 : 396,
                                  child: Stack(
                                    alignment: Alignment.centerLeft,
                                    children: [
                                      // Handle (always visible), hugs the panel edge
                                      Positioned(
                                        left: 0,
                                        child: AssistantHandle(
                                          onTap: () => setState(
                                            () => assistantCollapsed =
                                                !assistantCollapsed,
                                          ),
                                          open: !assistantCollapsed,
                                          insidePanel: !assistantCollapsed,
                                        ),
                                      ),
                                      if (!assistantCollapsed)
                                        Positioned(
                                          left: 36,
                                          right: 0,
                                          top: 0,
                                          bottom: 0,
                                          child: SizedBox(
                                            width: 360,
                                            child: AssistantPanel(
                                              transcript: assistantTranscript,
                                              operations: assistantOps,
                                              operationsChecked:
                                                  assistantOpsChecked,
                                              sending: assistantSending,
                                              previewsByKey:
                                                  assistantOpPreviews,
                                              onToggleOperation: (i, v) =>
                                                  setState(
                                                    () =>
                                                        assistantOpsChecked[i] =
                                                            v,
                                                  ),
                                              onApplySelected:
                                                  _applyAssistantOps,
                                              onDiscard: () => setState(() {
                                                assistantOps = [];
                                                assistantOpsChecked = [];
                                                assistantOpPreviews.clear();
                                              }),
                                              inputController: assistantCtrl,
                                              onSend: _sendAssistantMessage,
                                              opLabel: (op) => _opLabel(
                                                (op as AnnotatedOp).op,
                                              ),
                                              onClearChat: () => setState(() {
                                                assistantTranscript.clear();
                                                assistantOps = [];
                                                assistantOpsChecked = [];
                                                assistantOpPreviews.clear();
                                              }),
                                              progressStage: _progressStage,
                                              progressValid: _progressValid,
                                              progressInvalid: _progressInvalid,
                                              progressStart: _progressStart,
                                              todayYmd: ymd(DateTime.now()),
                                              thinking: assistantThinking,
                                              showThinking:
                                                  assistantShowThinking,
                                              onToggleThinking: () => setState(
                                                () {
                                                  assistantShowThinking = !assistantShowThinking;
                                                  try {
                                                    storage.setItem('assistantShowThinking', assistantShowThinking ? '1' : '0');
                                                  } catch (_) {}
                                                },
                                              ),
                                            ),
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

    if (op.scheduledFor != null) {
      parts.add('@${op.scheduledFor}');
    }
    if (op.completed != null) {
      parts.add(op.completed! ? '[done]' : '[undone]');
    }
    return parts.join(' ');
  }

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
            'startTime': null,
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
          onSetTaskStatusOrOccurrence: _onSetTaskStatusOrOccurrence,
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

  Widget _buildMonthGrid(Map<String, List<Task>> groupedByDate) {
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
    Map<String, List<Task>> groupedByDate,
    bool inMonth,
  ) {
    final ymdStr = ymd(d);
    final items = (groupedByDate[ymdStr] ?? const <Task>[]);
    // sort by id (tasks have no time)
    final sorted = items.toList()..sort((a, b) => a.id.compareTo(b.id));
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

  Widget _monthItemChip(Task t) {
    final label = t.title;

    // Context-based colors
    final contextColor = t.context != null
        ? ContextColors.getContextColor(t.context)
        : Colors.grey.shade600;
    final Color bg = ContextColors.getContextBackgroundColor(t.context);
    final Color fg = Colors.black87;
    final Color border = contextColor.withAlpha((0.3 * 255).round());

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
      view = ViewMode.day;
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

  void _maybeScrollToPendingDate() {
    if (_pendingScrollYmd == null) return;
    if (view != ViewMode.day) {
      _pendingScrollYmd = null;
      _pendingScrollKeyId = null;
      _pendingScrollBaseId = null;
      return;
    }
    final target = _pendingScrollYmd;
    final idx = scheduled.indexWhere((t) => t.scheduledFor == target);
    if (idx == -1) {
      _pendingScrollYmd = null;
      _pendingScrollKeyId = null;
      _pendingScrollBaseId = null;
      return;
    }
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      try {
        final GlobalKey? key = (_pendingScrollKeyId != null) ? _rowKeys[_pendingScrollKeyId!] : null;
        if (key?.currentContext != null) {
          await Scrollable.ensureVisible(
            key!.currentContext!,
            duration: const Duration(milliseconds: 300),
          );
          // Attempt highlight
          try {
            final t = scheduled.firstWhere((e) => e.scheduledFor == target);
            setState(() => _highlightedId = t.id);
            await Future.delayed(const Duration(seconds: 1));
            if (mounted && _highlightedId == t.id) setState(() => _highlightedId = null);
          } catch (_) {}
        } else {
          // Try to find by base id (selected id or its master) for the target date
          final int? baseId = _pendingScrollBaseId;
          Task? match;
          if (baseId != null) {
            try {
              match = scheduled.firstWhere((e) => e.scheduledFor == target && (e.id == baseId || (e.masterId == baseId)));
            } catch (_) {}
          }
          final Task fallbackT = match ?? scheduled[idx];
          final fallbackId = (fallbackT.masterId != null && fallbackT.scheduledFor != null)
              ? Object.hashAll([fallbackT.masterId, fallbackT.scheduledFor])
              : fallbackT.id;
          final fk = _rowKeys[fallbackId];
          if (fk?.currentContext != null) {
            await Scrollable.ensureVisible(
              fk!.currentContext!,
              duration: const Duration(milliseconds: 300),
            );
            // Highlight the scrolled row
            setState(() => _highlightedId = fallbackT.id);
            await Future.delayed(const Duration(seconds: 1));
            if (mounted && _highlightedId == fallbackT.id) setState(() => _highlightedId = null);
          }
        }
      } catch (_) {}
      _pendingScrollYmd = null;
      _pendingScrollKeyId = null;
      _pendingScrollBaseId = null;
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
  

  Widget _buildRow(Task t) {
    // Determine overdue: only when viewing today's Day view, timed tasks, not completed, and time < now
    bool isOverdue = false;
    try {
      final bool isResolved = (t.kind == 'task')
          ? ((t.status == 'completed') || (t.status == 'skipped'))
          : t.completed;
      if (!isResolved && t.scheduledFor != null) {
        final todayYmd = ymd(DateTime.now());
        final viewingToday = (anchor == todayYmd);
        if (viewingToday && t.scheduledFor == todayYmd) {
          final parts = ''.split(':');
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
    final like = <String, dynamic>{
      'id': t.id,
      'title': t.title,
      'notes': t.notes,
      'kind': t.kind,
      'status': t.status,
      'completed': (t.kind == 'task') ? (t.status == 'completed') : t.completed,
      'overdue': isOverdue,
      'context': t.context,
    };
    // No extra badges for goals/habits after migration
    Widget? extraBadge;
    final keyId = t.masterId != null && t.scheduledFor != null
        ? Object.hashAll([t.masterId, t.scheduledFor])
        : t.id;
    final key = _rowKeys.putIfAbsent(keyId, () => GlobalKey());
    return KeyedSubtree(
      key: key,
      child: row.TaskRow(
        task: like,
        onToggleCompleted: () => _toggleCompleted(t),
        onToggleSkipped: (t.kind == 'task') ? () => _toggleSkip(t) : null,
        onEdit: () => (t.kind == 'event') ? _editEvent(t) : _editTask(t),
        onDelete: () => _deleteItem(t),
        highlighted: _highlightedId == t.id,
        extraBadge: extraBadge,
        onTitleEdited: (newTitle) async {
          try {
            if (t.kind == 'event') {
              await api.updateEvent(t.id, {
                'title': newTitle,
                'recurrence': t.recurrence ?? {'type': 'none'},
              });
            } else {
              await api.callMCPTool('update_task', {
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
              // For events, map to startTime; if no end, set end = start + 1h
              final parsed = AmericanTimeFormat.parseFlexible(newTime ?? '');
              if (parsed == null) {
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(content: Text('Enter valid time, e.g., 1:00 PM.')),
                );
                return;
              }
              final patch = <String, dynamic>{
                'startTime': parsed,
                'recurrence': t.recurrence ?? {'type': 'none'},
              };
              final hadEnd = ((t.endTime ?? '').toString().isNotEmpty);
              if (!hadEnd) {
                final res = AmericanTimeFormat.addOneHour(parsed);
                patch['endTime'] = res.hhmm;
              }
              await api.updateEvent(t.id, patch);
              setState(() {
                // no change to task fields here
              });
            } else {
              // tasks are all-day; ignore time edits
            }
          } catch (_) {}
        },
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
      _editTask(task);
    }
  }

  void _onDeleteTask(int taskId) {
    final task = scheduled.firstWhere(
      (t) => t.id == taskId,
      orElse: () => scheduledAllTime.firstWhere((t) => t.id == taskId),
    );
    _deleteTask(task);
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
