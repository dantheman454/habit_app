## Client Architecture (Flutter Web)

Entry files: `apps/web/flutter_app/lib/main.dart`, `apps/web/flutter_app/lib/api.dart`

### State Management and Data Flow

#### Core State Structure

```dart
class _HomePageState extends State<HomePage> {
  // Header state
  String anchor = ymd(DateTime.now());
  ViewMode view = ViewMode.day;
  bool showCompleted = false;

  // Search state
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
  String _searchScope = 'all'; // 'all', 'task', 'event'
  String? _searchContext; // null for 'all', or 'personal', 'work', 'school'
  String _searchStatusTask = 'pending'; // 'pending', 'completed', 'skipped'
  bool? _searchCompleted; // null for 'all', true for completed, false for incomplete
  
  // Navigation state
  MainView mainView = MainView.tasks;
  String? _goalsStatusFilter; // null=all | 'active'|'completed'|'archived'
  String? selectedContext; // 'school', 'personal', 'work', null for 'all'
  
  // Data collections
  List<Task> scheduled = [];           // Unified schedule items
  List<Task> scheduledAllTime = [];    // All scheduled tasks for counts
  List<Task> searchResults = [];       // Search results
  Map<int, Map<String, dynamic>> habitStatsById = {}; // Habit stats for current range
  Map<String, Map<String, dynamic>> _itemGoalByKey = {}; // Goal badges mapping
  
  // Unified schedule filters (chips)
  Set<String> _kindFilter = <String>{'task', 'event'};
  
  // UI state
  bool loading = false;
  String? message;
  bool assistantCollapsed = true;
  
  // Assistant state
  final TextEditingController assistantCtrl = TextEditingController();
  final List<Map<String, String>> assistantTranscript = [];
  List<AnnotatedOp> assistantOps = [];
  List<bool> assistantOpsChecked = [];
  bool assistantSending = false;
  bool assistantShowDiff = false;
  int? assistantStreamingIndex;
  
  // Clarification state
  String? _pendingClarifyQuestion;
  List<Map<String, dynamic>> _pendingClarifyOptions = const [];
  final Set<int> _clarifySelectedIds = <int>{};
  String? _clarifySelectedDate;
  String _progressStage = '';
  String? _lastCorrelationId;
  int _progressValid = 0;
  int _progressInvalid = 0;
  DateTime? _progressStart;
  
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
  
  final TextEditingController _qaGoalTitle = TextEditingController();
  final TextEditingController _qaGoalNotes = TextEditingController();
  final TextEditingController _qaGoalCurrent = TextEditingController();
  final TextEditingController _qaGoalTarget = TextEditingController();
  final TextEditingController _qaGoalUnit = TextEditingController();
  String _qaGoalStatus = 'active';
  bool _addingQuick = false;
  
  // FAB dialog state
  String? _qaSelectedContext;
  String? _qaSelectedRecurrence;
}
```
- **Location**: `apps/web/flutter_app/lib/main.dart`

#### Enums and Constants

```dart
enum ViewMode { day, week, month }
enum MainView { tasks, habits, goals }
enum SmartList { today, all }
enum AppTab { tasks, events, habits, goals }

// Date range calculation
Map<String, String> rangeForView(DateTime anchor, ViewMode view) {
  final from = anchor;
  DateTime to;
  
  switch (view) {
    case ViewMode.day:
      to = anchor.add(Duration(days: 1));
      break;
    case ViewMode.week:
      to = anchor.add(Duration(days: 7));
      break;
    case ViewMode.month:
      to = DateTime(anchor.year, anchor.month + 1, anchor.day);
      break;
  }
  
  return {
    'from': ymd(from),
    'to': ymd(to),
  };
}

String ymd(DateTime d) =>
    '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';
```

### Data Loading Patterns

#### Primary Data Loading

```dart
Future<void> _refreshAll() async {
  setState(() => loading = true);
  
  try {
    final range = rangeForView(parseYmd(anchor), view);
    
    // Load unified schedule for current view
    final scheduleResponse = await api.fetchSchedule(
      from: range['from']!,
      to: range['to']!,
      kinds: _kindFilter.toList(),
      completed: showCompleted,
      statusTask: showCompleted ? null : 'pending',
      context: selectedContext,
    );
    scheduled = (scheduleResponse as List<dynamic>).map((e) => Task.fromJson(e)).toList();
    
    // Load counts and backlog
    final allTimeResponse = await api.fetchScheduledAllTime(
      status: showCompleted ? null : 'pending',
      context: selectedContext,
    );
    scheduledAllTime = (allTimeResponse as List<dynamic>).map((e) => Task.fromJson(e)).toList();
    
    // Load habit stats when needed
    if (mainView == MainView.habits || _kindFilter.contains('habit')) {
      final habitsResponse = await api.listHabits(
        from: range['from'],
        to: range['to'],
        context: selectedContext,
      );
      // Process habit stats
      final habits = habitsResponse as List<dynamic>;
      habitStatsById.clear();
      for (final habit in habits) {
        habitStatsById[habit['id']] = {
          'currentStreak': habit['currentStreak'] ?? 0,
          'longestStreak': habit['longestStreak'] ?? 0,
          'weekHeatmap': habit['weekHeatmap'] ?? [],
        };
      }
    }
    
    // Load goal badges
    await _loadGoalBadges();
    
  } catch (e) {
    setState(() => message = 'Failed to load data: ${e.toString()}');
  } finally {
    setState(() => loading = false);
  }
}
```

#### Context-Aware Loading

```dart
// Context filtering affects all data loading
void _setContext(String? context) {
  setState(() {
    selectedContext = context;
  });
  _refreshAll(); // Reload all data with new context
}

// Show completed toggle affects filtering
void _setShowCompleted(bool show) {
  setState(() {
    showCompleted = show;
  });
  _refreshAll(); // Reload with new completion filter
}
```

### Search Implementation

#### Search Overlay Architecture

```dart
class SearchOverlay extends StatefulWidget {
  @override
  _SearchOverlayState createState() => _SearchOverlayState();
}

class _SearchOverlayState extends State<SearchOverlay> {
  final TextEditingController _controller = TextEditingController();
  final FocusNode _focusNode = FocusNode();
  CancelToken? _cancelToken;
  Timer? _debounceTimer;
  
  @override
  void initState() {
    super.initState();
    _controller.addListener(_onQueryChanged);
  }
  
  void _onQueryChanged() {
    _debounceTimer?.cancel();
    _debounceTimer = Timer(Duration(milliseconds: 250), () {
      _runSearch();
    });
  }
  
  Future<void> _runSearch() async {
    final query = _controller.text.trim();
    if (query.isEmpty) {
      setState(() => searchResults = []);
      return;
    }
    
    _cancelToken?.cancel();
    _cancelToken = CancelToken();
    
    try {
      final response = await api.searchUnified(
        query,
        scope: _searchScope,
        completed: _searchCompleted,
        statusTask: _searchStatusTask,
        context: _searchContext,
        limit: 30,
        cancelToken: _cancelToken,
      );
      
      setState(() {
        searchResults = (response as List<dynamic>).map((e) => Task.fromJson(e)).toList();
      });
    } catch (e) {
      if (e is! CancelException) {
        // Handle error
      }
    }
  }
}
```

#### Keyboard Navigation

```dart
Widget _buildSearchResults() {
  return ListView.builder(
    itemCount: searchResults.length.clamp(0, 7), // Show max 7 results
    itemBuilder: (context, index) {
      final item = searchResults[index];
      return ListTile(
        title: Text(item.title),
        subtitle: Text(_formatSearchResult(item)),
        onTap: () => _selectSearchResult(item),
        selected: index == _searchHoverIndex,
      );
    },
  );
}

void _selectSearchResult(Task item) {
  // Focus appropriate list and scroll to item
  _highlightedId = item.id;
  
  // Close search overlay
  _closeSearchOverlay();
}
```

### CRUD Operations

#### Task Operations

```dart
// Set status for repeating tasks
Future<void> _setTaskOccurrenceStatus(int taskId, String occurrenceDate, String status) async {
  try {
    await api.setTaskOccurrenceStatus(taskId, occurrenceDate, status);
    _refreshAll(); // Refresh to show updated state
  } catch (e) {
    _showError('Failed to update task: ${e.toString()}');
  }
}

// Update status for non-repeating tasks
Future<void> _updateTaskStatus(int taskId, String status) async {
  try {
    await api.updateTask(taskId, {'status': status});
    _refreshAll();
  } catch (e) {
    _showError('Failed to update task: ${e.toString()}');
  }
}

// Create new task
Future<void> _createTask(String title, {String? notes, String? scheduledFor, String? timeOfDay}) async {
  try {
    await api.createTask({
      'title': title,
      'notes': notes ?? '',
      'scheduledFor': scheduledFor,
      'timeOfDay': timeOfDay,
      'recurrence': {'type': 'none'}, // Default to non-repeating
      'context': selectedContext ?? 'personal',
    });
    _refreshAll();
  } catch (e) {
    _showError('Failed to create task: ${e.toString()}');
  }
}
```

#### Event Operations

```dart
// Toggle event completion
Future<void> _toggleEventOccurrence(int eventId, String occurrenceDate, bool completed) async {
  try {
    await api.toggleEventOccurrence(eventId, occurrenceDate, completed);
    _refreshAll();
  } catch (e) {
    _showError('Failed to update event: ${e.toString()}');
  }
}

// Create new event
Future<void> _createEvent(String title, {
  String? notes, 
  String? scheduledFor, 
  String? startTime, 
  String? endTime,
  String? location
}) async {
  try {
    await api.createEvent({
      'title': title,
      'notes': notes ?? '',
      'scheduledFor': scheduledFor,
      'startTime': startTime,
      'endTime': endTime,
      'location': location,
      'recurrence': {'type': 'none'},
      'context': selectedContext ?? 'personal',
    });
    _refreshAll();
  } catch (e) {
    _showError('Failed to create event: ${e.toString()}');
  }
}
```

#### Habit Operations

```dart
// Toggle habit completion
Future<void> _toggleHabitOccurrence(int habitId, String occurrenceDate, bool completed) async {
  try {
    await api.toggleHabitOccurrence(habitId, occurrenceDate, completed);
    _refreshAll(); // Refresh to update streak stats
  } catch (e) {
    _showError('Failed to update habit: ${e.toString()}');
  }
}

// Create new habit (must be repeating)
Future<void> _createHabit(String title, {
  String? notes, 
  String? scheduledFor, 
  String? timeOfDay,
  Map<String, dynamic>? recurrence
}) async {
  try {
    await api.createHabit({
      'title': title,
      'notes': notes ?? '',
      'scheduledFor': scheduledFor,
      'timeOfDay': timeOfDay,
      'recurrence': recurrence ?? {'type': 'daily'}, // Default to daily
      'context': selectedContext ?? 'personal',
    });
    _refreshAll();
  } catch (e) {
    _showError('Failed to create habit: ${e.toString()}');
  }
}
```

### Assistant Integration

#### SSE Stream Handling

```dart
Future<void> _sendAssistantMessage(String message) async {
  setState(() {
    assistantSending = true;
    assistantTranscript.add({'role': 'user', 'text': message});
    
    // Add placeholder assistant message
    assistantTranscript.add({'role': 'assistant', 'text': ''});
    assistantStreamingIndex = assistantTranscript.length - 1;
  });
  
  try {
    // Get last 3 turns for context
    final recent = assistantTranscript.length > 3 
      ? assistantTranscript.sublist(assistantTranscript.length - 3)
      : assistantTranscript;
    
    await api.assistantMessage(
      message,
      transcript: recent,
      streamSummary: true,
      onSummary: (text) {
        // Update placeholder message
        setState(() {
          assistantTranscript[assistantStreamingIndex!] = {
            'role': 'assistant', 
            'text': text
          };
        });
      },
      onClarify: (question, options) {
        // Show clarification UI
        _showClarificationDialog(question, options);
      },
      onStage: (stage) {
        // Update progress indicator
        setState(() => _progressStage = stage);
      },
      onOps: (operations, version, validCount, invalidCount) {
        // Show operations preview
        setState(() {
          assistantOps = operations.map((op) => AnnotatedOp.fromJson(op)).toList();
          assistantOpsChecked = List.filled(operations.length, true);
          _progressValid = validCount;
          _progressInvalid = invalidCount;
        });
      },
    );
  } catch (e) {
    _showError('Assistant error: ${e.toString()}');
  } finally {
    setState(() {
      assistantSending = false;
      assistantStreamingIndex = null;
    });
  }
}
```

#### SSE Implementation

```dart
CloseFn startSse({
  required String uri,
  required void Function(String event, String data) onEvent,
  required void Function() onDone,
  required void Function() onError,
}) {
  final es = html.EventSource(uri);
  void handleMessage(html.MessageEvent ev, String eventName) {
    try {
      final d = ev.data;
      final s = (d is String) ? d : (d == null ? '' : d.toString());
      onEvent(eventName, s);
    } catch (_) {}
  }

  es.addEventListener(
    'clarify',
    (e) => handleMessage(e as html.MessageEvent, 'clarify'),
  );
  es.addEventListener(
    'stage',
    (e) => handleMessage(e as html.MessageEvent, 'stage'),
  );
  es.addEventListener(
    'ops',
    (e) => handleMessage(e as html.MessageEvent, 'ops'),
  );
  es.addEventListener(
    'summary',
    (e) => handleMessage(e as html.MessageEvent, 'summary'),
  );
  es.addEventListener(
    'result',
    (e) => handleMessage(e as html.MessageEvent, 'result'),
  );
  es.addEventListener('done', (_) {
    try {
      es.close();
    } catch (_) {}
    onDone();
  });
  es.addEventListener('error', (_) {
    try {
      es.close();
    } catch (_) {}
    onError();
  });
  return () {
    try {
      es.close();
    } catch (_) {}
  };
}
```
- **Location**: `apps/web/flutter_app/lib/util/sse_impl_web.dart`

Notes:
- Server currently emits `stage`, `ops`, `summary`, `heartbeat`, and `done`. `clarify` and `result` listeners exist in the client for forward-compat but are not emitted by the current server flow.
- The assistant POST and SSE responses include a `correlationId` surfaced via `onTraceId` when provided. The `ops` event also includes `previews` used by the UI.

#### Clarification UI

```dart
void _showClarificationDialog(String question, List<Map<String, dynamic>> options) {
  setState(() {
    _pendingClarifyQuestion = question;
    _pendingClarifyOptions = options;
    _clarifySelectedIds.clear();
    _clarifySelectedDate = null;
  });
}

Widget _buildClarifySection() {
  if (_pendingClarifyQuestion == null) return SizedBox.shrink();
  
  return Container(
    child: Column(
      children: [
        Text(_pendingClarifyQuestion!),
        Wrap(
          spacing: 8,
          children: _pendingClarifyOptions.map((option) => FilterChip(
            label: Text('${option['title']} @${option['scheduledFor'] ?? 'unscheduled'}'),
            selected: _clarifySelectedIds.contains(option['id']),
            onSelected: (selected) {
              setState(() {
                if (selected) {
                  _clarifySelectedIds.add(option['id']);
                } else {
                  _clarifySelectedIds.remove(option['id']);
                }
              });
            },
          )).toList(),
        ),
        Row(
          children: [
            TextButton(
              onPressed: () {
                setState(() {
                  _pendingClarifyQuestion = null;
                  _pendingClarifyOptions = [];
                  _clarifySelectedIds.clear();
                });
              },
              child: Text('Cancel'),
            ),
            ElevatedButton(
              onPressed: () {
                _sendClarifiedMessage();
              },
              child: Text('Continue'),
            ),
          ],
        ),
      ],
    ),
  );
}
```

#### Operations Preview and Execution

```dart
Widget _buildOperationsPreview() {
  if (assistantOps.isEmpty) return SizedBox.shrink();
  
  return Column(
    children: [
      if (_progressInvalid > 0)
        Text('$_progressInvalid operations have errors', style: TextStyle(color: Colors.red)),
      ...assistantOps.asMap().entries.map((entry) {
        final index = entry.key;
        final op = entry.value;
        return CheckboxListTile(
          value: assistantOpsChecked[index],
          onChanged: (value) {
            setState(() {
              assistantOpsChecked[index] = value ?? true;
            });
          },
          title: Text('${op.op.action} ${op.op.kind} #${op.op.id}'),
          subtitle: Text(op.op.title ?? ''),
        );
      }).toList(),
      Row(
        children: [
          TextButton(
            onPressed: () {
              setState(() {
                assistantOps.clear();
                assistantOpsChecked.clear();
              });
            },
            child: Text('Cancel'),
          ),
          ElevatedButton(
            onPressed: () {
              _executeSelectedOperations();
            },
            child: Text('Apply Selected'),
          ),
        ],
      ),
    ],
  );
}

Future<void> _executeSelectedOperations() async {
  final selectedOps = <Map<String, dynamic>>[];
  for (int i = 0; i < assistantOps.length; i++) {
    if (assistantOpsChecked[i]) {
      selectedOps.add(assistantOps[i].op.toJson());
    }
  }
  
  try {
    final results = await api.applyOperationsMCP(selectedOps);
    
    // Check for errors
    final errors = results.where((r) => r['isError'] == true).toList();
    if (errors.isNotEmpty) {
      _showError('Some operations failed: ${errors.map((e) => e['content']).join(', ')}');
    }
    
    _refreshAll(); // Refresh to show changes
    setState(() {
      assistantOps.clear();
      assistantOpsChecked.clear();
    });
  } catch (e) {
    _showError('Failed to execute operations: ${e.toString()}');
  }
}
```

### Presentation and Grouping

#### Unified Schedule Rendering

```dart
Widget _buildUnifiedSchedule() {
  // Group items by date
  final grouped = <String, List<Task>>{};
  for (final item in scheduled) {
    final date = item.scheduledFor ?? 'unscheduled';
    grouped.putIfAbsent(date, () => []).add(item);
  }
  
  // Sort dates
  final sortedDates = grouped.keys.toList()..sort((a, b) {
    if (a == 'unscheduled') return 1;
    if (b == 'unscheduled') return -1;
    return a.compareTo(b);
  });
  
  return ListView.builder(
    itemCount: sortedDates.length,
    itemBuilder: (context, index) {
      final date = sortedDates[index];
      final items = grouped[date]!;
      
      // Sort items within each date
      items.sort((a, b) => _compareItems(a, b));
      
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _buildDateHeader(date),
          ...items.map((item) => _buildScheduleItem(item)).toList(),
        ],
      );
    },
  );
}

int _compareItems(Task a, Task b) {
  // 1. Sort by time (nulls first)
  final timeA = a.timeOfDay;
  final timeB = b.timeOfDay;
  if (timeA == null && timeB != null) return -1;
  if (timeA != null && timeB == null) return 1;
  if (timeA != null && timeB != null) {
    final timeCompare = timeA.compareTo(timeB);
    if (timeCompare != 0) return timeCompare;
  }
  
  // 2. Sort by kind: event < task
  final kindOrder = {'event': 0, 'task': 1};
  final kindA = kindOrder[a.kind ?? 'task'] ?? 3;
  final kindB = kindOrder[b.kind ?? 'task'] ?? 3;
  if (kindA != kindB) return kindA.compareTo(kindB);
  
  // 3. Sort by ID
  return a.id.compareTo(b.id);
}
```

#### Habit Stats Display

```dart
Widget _buildHabitStats(int habitId) {
  final stats = habitStatsById[habitId];
  if (stats == null) return SizedBox.shrink();
  
  return Card(
    child: Padding(
      padding: EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              _buildStreakBadge('Current', stats['currentStreak'] ?? 0),
              SizedBox(width: 8),
              _buildStreakBadge('Longest', stats['longestStreak'] ?? 0),
            ],
          ),
          SizedBox(height: 8),
          _buildWeekHeatmap(stats['weekHeatmap'] ?? []),
        ],
      ),
    ),
  );
}

Widget _buildWeekHeatmap(List<dynamic> heatmap) {
  return Row(
    children: heatmap.map((day) {
      final completed = day['completed'] ?? false;
      return Container(
        width: 20,
        height: 20,
        margin: EdgeInsets.all(1),
        decoration: BoxDecoration(
          color: completed ? Colors.green : Colors.grey.shade300,
          borderRadius: BorderRadius.circular(2),
        ),
      );
    }).toList(),
  );
}
```

### Networking and Environment

#### API Client Configuration

```dart
class ApiClient {
  late final Dio _dio;
  
  ApiClient() {
    _dio = Dio(BaseOptions(
      baseUrl: _computeApiBase(),
      connectTimeout: Duration(seconds: 10),
      receiveTimeout: Duration(seconds: 30),
      headers: {
        'Content-Type': 'application/json',
      },
    ));
    
    // Add interceptors for error handling
    _dio.interceptors.add(InterceptorsWrapper(
      onError: (error, handler) {
        _handleApiError(error);
        handler.next(error);
      },
    ));
  }
  
  String _computeApiBase() {
    // Prefer Express origin for development
    if (kIsWeb) {
      final origin = window.location.origin;
      if (origin.contains('localhost') || origin.contains('127.0.0.1')) {
        return 'http://127.0.0.1:3000';
      }
      return origin;
    }
    return 'http://127.0.0.1:3000';
  }
  
  void _handleApiError(DioError error) {
    String message = 'Network error';
    
    if (error.response != null) {
      final data = error.response!.data;
      if (data is Map && data.containsKey('error')) {
        message = data['error'];
      } else {
        message = 'Server error: ${error.response!.statusCode}';
      }
    } else if (error.type == DioErrorType.connectTimeout) {
      message = 'Connection timeout';
    } else if (error.type == DioErrorType.receiveTimeout) {
      message = 'Request timeout';
    }
    
    // Show error to user
    _showError(message);
  }
}
```

#### Error Handling and User Feedback

```dart
void _showError(String message) {
  ScaffoldMessenger.of(context).showSnackBar(
    SnackBar(
      content: Text(message),
      backgroundColor: Colors.red,
      duration: Duration(seconds: 4),
      action: SnackBarAction(
        label: 'Dismiss',
        textColor: Colors.white,
        onPressed: () {
          ScaffoldMessenger.of(context).hideCurrentSnackBar();
        },
      ),
    ),
  );
}

void _showSuccess(String message) {
  ScaffoldMessenger.of(context).showSnackBar(
    SnackBar(
      content: Text(message),
      backgroundColor: Colors.green,
      duration: Duration(seconds: 2),
    ),
  );
}
```

### Performance Optimizations

#### Efficient Rendering

```dart
// Use const constructors where possible
class TaskItem extends StatelessWidget {
  const TaskItem({Key? key, required this.task}) : super(key: key);
  
  final Task task;
  
  @override
  Widget build(BuildContext context) {
    return ListTile(
      title: Text(task.title),
      subtitle: task.notes.isNotEmpty ? Text(task.notes) : null,
      trailing: _buildStatusIcon(task.status),
      onTap: () => _onTaskTap(task),
    );
  }
}

// Lazy loading for large lists
class LazyScheduleList extends StatefulWidget {
  @override
  _LazyScheduleListState createState() => _LazyScheduleListState();
}

class _LazyScheduleListState extends State<LazyScheduleList> {
  final List<Task> _items = [];
  bool _isLoading = false;
  int _page = 0;
  
  @override
  void initState() {
    super.initState();
    _loadMore();
  }
  
  Future<void> _loadMore() async {
    if (_isLoading) return;
    
    setState(() => _isLoading = true);
    
    try {
      final newItems = await _fetchPage(_page);
      setState(() {
        _items.addAll(newItems);
        _page++;
        _isLoading = false;
      });
    } catch (e) {
      setState(() => _isLoading = false);
      _showError('Failed to load more items');
    }
  }
}
```

#### State Management Optimization

```dart
// Selective state updates
class OptimizedHomePageState extends State<HomePage> {
  void _notifyScheduledChanged() {
    setState(() {});
  }
  
  void _notifySearchChanged() {
    setState(() {});
  }
  
  void _notifyAssistantChanged() {
    setState(() {});
  }
  
  // Only update relevant state
  void updateScheduled(List<Task> newScheduled) {
    scheduled = newScheduled;
    _notifyScheduledChanged();
  }
}
```

### Testing and Development

#### Test Hooks

```dart
class TestHooks {
  static bool skipRefresh = false;
  static bool mockNetworkErrors = false;
  static String? mockApiResponse;
  
  static void reset() {
    skipRefresh = false;
    mockNetworkErrors = false;
    mockApiResponse = null;
  }
}

// Use in development
if (kDebugMode && TestHooks.skipRefresh) {
  return; // Skip refresh for testing
}
```
- **Location**: `apps/web/flutter_app/lib/main.dart`

#### Development Tools

```dart
// Debug panel for development
class DebugPanel extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    if (!kDebugMode) return SizedBox.shrink();
    
    return ExpansionTile(
      title: Text('Debug Info'),
      children: [
        Text('View Mode: $view'),
        Text('Main View: $mainView'),
        Text('Context: $selectedContext'),
        Text('Show Completed: $showCompleted'),
        Text('Scheduled Count: ${scheduled.length}'),
        Text('Search Results Count: ${searchResults.length}'),
        ElevatedButton(
          onPressed: () => _refreshAll(),
          child: Text('Force Refresh'),
        ),
      ],
    );
  }
}
```