## Client Architecture (Flutter Web)

Entry files: `apps/web/flutter_app/lib/main.dart`, `apps/web/flutter_app/lib/api.dart`

### State Management and Data Flow

#### Core State Structure

```dart
class HabitAppState extends ChangeNotifier {
  // Navigation and view state
  ViewMode viewMode = ViewMode.day;
  MainView mainView = MainView.tasks;
  SmartList smartList = SmartList.today;
  DateTime anchor = DateTime.now();
  
  // Data collections
  List<dynamic> scheduled = [];           // Unified schedule items
  List<Todo> scheduledAllTime = [];       // All scheduled todos for counts
  List<Todo> backlog = [];               // Unscheduled todos
  List<Event> events = [];               // All events for "All" view
  List<Habit> habits = [];               // Habits with stats
  
  // UI state
  bool showCompleted = false;
  String selectedContext = 'personal';
  bool isLoading = false;
  String? errorMessage;
  
  // Assistant state
  List<Map<String, String>> assistantTranscript = [];
  bool assistantSending = false;
  int assistantStreamingIndex = -1;
  
  // Search state
  String searchQuery = '';
  List<dynamic> searchResults = [];
  bool searchActive = false;
}
```

#### Enums and Constants

```dart
enum ViewMode { day, week, month }
enum SmartList { today, all }
enum MainView { tasks, habits, goals }
enum AppTab { todos, events, habits, goals }

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
    'from': from.toIso8601String().split('T')[0],
    'to': to.toIso8601String().split('T')[0],
  };
}
```

### Data Loading Patterns

#### Primary Data Loading

```dart
Future<void> _refreshAll() async {
  isLoading = true;
  notifyListeners();
  
  try {
    final range = rangeForView(anchor, viewMode);
    
    // Load unified schedule for current view
    final scheduleResponse = await api.fetchSchedule(
      from: range['from']!,
      to: range['to']!,
      kinds: 'todo,event,habit',
      completed: showCompleted,
      statusTodo: showCompleted ? null : 'pending',
      context: selectedContext,
    );
    scheduled = scheduleResponse['items'] ?? [];
    
    // Load counts and backlog
    final allTimeResponse = await api.fetchScheduledAllTime(
      status: showCompleted ? null : 'pending',
      context: selectedContext,
    );
    scheduledAllTime = allTimeResponse['todos'] ?? [];
    
    final backlogResponse = await api.fetchBacklog(
      status: showCompleted ? null : 'pending',
      context: selectedContext,
    );
    backlog = backlogResponse['todos'] ?? [];
    
    // Load habit stats when needed
    if (mainView == MainView.habits || smartList == SmartList.all) {
      final habitsResponse = await api.listHabits(
        from: range['from'],
        to: range['to'],
        context: selectedContext,
      );
      habits = habitsResponse['habits'] ?? [];
    }
    
    // Load events for "All" view
    if (smartList == SmartList.all) {
      final eventsResponse = await api.listEvents(context: selectedContext);
      events = eventsResponse['events'] ?? [];
    }
    
  } catch (e) {
    errorMessage = 'Failed to load data: ${e.toString()}';
  } finally {
    isLoading = false;
    notifyListeners();
  }
}
```

#### Context-Aware Loading

```dart
// Context filtering affects all data loading
void setContext(String context) {
  selectedContext = context;
  _refreshAll(); // Reload all data with new context
}

// Show completed toggle affects filtering
void setShowCompleted(bool show) {
  showCompleted = show;
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
        scope: 'todo,event', // Exclude habits
        completed: showCompleted,
        statusTodo: showCompleted ? null : 'pending',
        limit: 30,
        cancelToken: _cancelToken,
      );
      
      setState(() {
        searchResults = response['items'] ?? [];
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
        title: Text(item['title']),
        subtitle: Text(_formatSearchResult(item)),
        onTap: () => _selectSearchResult(item),
        selected: index == _selectedIndex,
      );
    },
  );
}

void _selectSearchResult(dynamic item) {
  // Focus appropriate list and scroll to item
  final kind = item['kind'];
  final id = item['id'];
  
  switch (kind) {
    case 'todo':
      _focusTodoList(id);
      break;
    case 'event':
      _focusEventList(id);
      break;
  }
  
  // Close search overlay
  Navigator.of(context).pop();
}
```

### CRUD Operations

#### Todo Operations

```dart
// Toggle completion for repeating todos
Future<void> toggleTodoOccurrence(int todoId, String occurrenceDate, String status) async {
  try {
    await api.setTodoOccurrenceStatus(todoId, occurrenceDate, status);
    _refreshAll(); // Refresh to show updated state
  } catch (e) {
    _showError('Failed to update todo: ${e.toString()}');
  }
}

// Toggle completion for non-repeating todos
Future<void> toggleTodoStatus(int todoId, String status) async {
  try {
    await api.updateTodo(todoId, {'status': status});
    _refreshAll();
  } catch (e) {
    _showError('Failed to update todo: ${e.toString()}');
  }
}

// Create new todo
Future<void> createTodo(String title, {String? notes, String? scheduledFor, String? timeOfDay}) async {
  try {
    await api.createTodo({
      'title': title,
      'notes': notes ?? '',
      'scheduledFor': scheduledFor,
      'timeOfDay': timeOfDay,
      'recurrence': {'type': 'none'}, // Default to non-repeating
      'context': selectedContext,
    });
    _refreshAll();
  } catch (e) {
    _showError('Failed to create todo: ${e.toString()}');
  }
}
```

#### Event Operations

```dart
// Toggle event completion
Future<void> toggleEventOccurrence(int eventId, String occurrenceDate, bool completed) async {
  try {
    await api.toggleEventOccurrence(eventId, occurrenceDate, completed);
    _refreshAll();
  } catch (e) {
    _showError('Failed to update event: ${e.toString()}');
  }
}

// Create new event
Future<void> createEvent(String title, {
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
      'context': selectedContext,
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
Future<void> toggleHabitOccurrence(int habitId, String occurrenceDate, bool completed) async {
  try {
    await api.toggleHabitOccurrence(habitId, occurrenceDate, completed);
    _refreshAll(); // Refresh to update streak stats
  } catch (e) {
    _showError('Failed to update habit: ${e.toString()}');
  }
}

// Create new habit (must be repeating)
Future<void> createHabit(String title, {
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
      'context': selectedContext,
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
  assistantSending = true;
  assistantTranscript.add({'role': 'user', 'text': message});
  
  // Add placeholder assistant message
  assistantTranscript.add({'role': 'assistant', 'text': ''});
  assistantStreamingIndex = assistantTranscript.length - 1;
  notifyListeners();
  
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
        assistantTranscript[assistantStreamingIndex] = {
          'role': 'assistant', 
          'text': text
        };
        notifyListeners();
      },
      onClarify: (question, options) {
        // Show clarification UI
        _showClarificationDialog(question, options);
      },
      onStage: (stage) {
        // Update progress indicator
        _updateAssistantStage(stage);
      },
      onOps: (operations, version, validCount, invalidCount) {
        // Show operations preview
        _showOperationsPreview(operations, validCount, invalidCount);
      },
    );
  } catch (e) {
    _showError('Assistant error: ${e.toString()}');
  } finally {
    assistantSending = false;
    assistantStreamingIndex = -1;
    notifyListeners();
  }
}
```

#### Clarification UI

```dart
void _showClarificationDialog(String question, List<Map<String, dynamic>> options) {
  showDialog(
    context: context,
    builder: (context) => AlertDialog(
      title: Text(question),
      content: Wrap(
        spacing: 8,
        children: options.map((option) => FilterChip(
          label: Text('${option['title']} @${option['scheduledFor'] ?? 'unscheduled'}'),
          selected: _selectedClarifyIds.contains(option['id']),
          onSelected: (selected) {
            setState(() {
              if (selected) {
                _selectedClarifyIds.add(option['id']);
              } else {
                _selectedClarifyIds.remove(option['id']);
              }
            });
          },
        )).toList(),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: Text('Cancel'),
        ),
        ElevatedButton(
          onPressed: () {
            Navigator.of(context).pop();
            _sendClarifiedMessage();
          },
          child: Text('Continue'),
        ),
      ],
    ),
  );
}
```

#### Operations Preview and Execution

```dart
void _showOperationsPreview(List<Map<String, dynamic>> operations, int validCount, int invalidCount) {
  showDialog(
    context: context,
    builder: (context) => AlertDialog(
      title: Text('Preview Changes'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (invalidCount > 0)
            Text('$invalidCount operations have errors', style: TextStyle(color: Colors.red)),
          ...operations.map((op) => _buildOperationTile(op)).toList(),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: Text('Cancel'),
        ),
        ElevatedButton(
          onPressed: () {
            Navigator.of(context).pop();
            _executeOperations(operations);
          },
          child: Text('Apply Selected'),
        ),
      ],
    ),
  );
}

Future<void> _executeOperations(List<Map<String, dynamic>> operations) async {
  try {
    final results = await api.applyOperationsMCP(operations);
    
    // Check for errors
    final errors = results.where((r) => r['isError'] == true).toList();
    if (errors.isNotEmpty) {
      _showError('Some operations failed: ${errors.map((e) => e['content']).join(', ')}');
    }
    
    _refreshAll(); // Refresh to show changes
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
  final grouped = <String, List<dynamic>>{};
  for (final item in scheduled) {
    final date = item['scheduledFor'] ?? 'unscheduled';
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

int _compareItems(dynamic a, dynamic b) {
  // 1. Sort by time (nulls first)
  final timeA = a['timeOfDay'] ?? a['startTime'];
  final timeB = b['timeOfDay'] ?? b['startTime'];
  if (timeA == null && timeB != null) return -1;
  if (timeA != null && timeB == null) return 1;
  if (timeA != null && timeB != null) {
    final timeCompare = timeA.compareTo(timeB);
    if (timeCompare != 0) return timeCompare;
  }
  
  // 2. Sort by kind: event < todo < habit
  final kindOrder = {'event': 0, 'todo': 1, 'habit': 2};
  final kindA = kindOrder[a['kind']] ?? 3;
  final kindB = kindOrder[b['kind']] ?? 3;
  if (kindA != kindB) return kindA.compareTo(kindB);
  
  // 3. Sort by ID
  return (a['id'] ?? 0).compareTo(b['id'] ?? 0);
}
```

#### Habit Stats Display

```dart
Widget _buildHabitStats(Habit habit) {
  return Card(
    child: Padding(
      padding: EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(habit.title, style: Theme.of(context).textTheme.titleMedium),
          SizedBox(height: 8),
          Row(
            children: [
              _buildStreakBadge('Current', habit.currentStreak),
              SizedBox(width: 8),
              _buildStreakBadge('Longest', habit.longestStreak),
            ],
          ),
          SizedBox(height: 8),
          _buildWeekHeatmap(habit.weekHeatmap),
        ],
      ),
    ),
  );
}

Widget _buildWeekHeatmap(List<Map<String, dynamic>> heatmap) {
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
        message = 'Server error: ${error.response!..statusCode}';
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

#### SSE Implementation

```dart
class SSEHandler {
  static Future<void> handleStream(
    String url,
    Map<String, Function> handlers,
  ) async {
    try {
      final response = await http.get(
        Uri.parse(url),
        headers: {'Accept': 'text/event-stream'},
      );
      
      if (response.statusCode != 200) {
        throw Exception('SSE request failed: ${response.statusCode}');
      }
      
      final lines = response.body.split('\n');
      for (final line in lines) {
        if (line.startsWith('event: ')) {
          final eventType = line.substring(7);
          final dataLine = lines[lines.indexOf(line) + 1];
          if (dataLine.startsWith('data: ')) {
            final data = dataLine.substring(6);
            _handleEvent(eventType, data, handlers);
          }
        }
      }
    } catch (e) {
      // Fallback to POST request
      await _fallbackToPost(url, handlers);
    }
  }
  
  static void _handleEvent(String eventType, String data, Map<String, Function> handlers) {
    final handler = handlers[eventType];
    if (handler != null) {
      try {
        final jsonData = jsonDecode(data);
        handler(jsonData);
      } catch (e) {
        print('Error parsing SSE data: $e');
      }
    }
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
class TodoItem extends StatelessWidget {
  const TodoItem({Key? key, required this.todo}) : super(key: key);
  
  final Todo todo;
  
  @override
  Widget build(BuildContext context) {
    return ListTile(
      title: Text(todo.title),
      subtitle: todo.notes.isNotEmpty ? Text(todo.notes) : null,
      trailing: _buildStatusIcon(todo.status),
      onTap: () => _onTodoTap(todo),
    );
  }
}

// Lazy loading for large lists
class LazyScheduleList extends StatefulWidget {
  @override
  _LazyScheduleListState createState() => _LazyScheduleListState();
}

class _LazyScheduleListState extends State<LazyScheduleList> {
  final List<dynamic> _items = [];
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
// Selective notifications
class OptimizedHabitAppState extends ChangeNotifier {
  void _notifyScheduledChanged() {
    notifyListeners();
  }
  
  void _notifyBacklogChanged() {
    notifyListeners();
  }
  
  void _notifyAssistantChanged() {
    notifyListeners();
  }
  
  // Only notify relevant listeners
  void updateScheduled(List<dynamic> newScheduled) {
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
        Text('View Mode: $viewMode'),
        Text('Main View: $mainView'),
        Text('Context: $selectedContext'),
        Text('Show Completed: $showCompleted'),
        Text('Scheduled Count: ${scheduled.length}'),
        Text('Backlog Count: ${backlog.length}'),
        ElevatedButton(
          onPressed: () => _refreshAll(),
          child: Text('Force Refresh'),
        ),
      ],
    );
  }
}
```



