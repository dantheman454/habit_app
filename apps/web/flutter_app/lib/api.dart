import 'package:dio/dio.dart';
import 'dart:async';
import 'dart:html' as html; // For EventSource in Flutter Web
import 'dart:convert';

String _computeApiBase() {
  // Works when served by Express or running Flutter in Chrome
  final origin = Uri.base.origin;
  if (origin.contains('127.0.0.1:3000') || origin.contains('localhost:3000')) {
    return origin;
  }
  return 'http://127.0.0.1:3000';
}

final Dio api = Dio(BaseOptions(baseUrl: _computeApiBase()));

Future<String> fetchAssistantModel() async {
  final res = await api.get('/api/assistant/model');
  final data = Map<String, dynamic>.from(res.data as Map);
  final m = data['model'];
  return (m is String) ? m : '';
}

Future<List<dynamic>> fetchScheduled({required String from, required String to, bool? completed}) async {
  final res = await api.get('/api/todos', queryParameters: {
    'from': from,
    'to': to,
    if (completed != null) 'completed': completed.toString(),
  });
  return (res.data['todos'] as List<dynamic>);
}

Future<List<dynamic>> fetchScheduledAllTime({bool? completed}) async {
  final res = await api.get('/api/todos', queryParameters: {
    if (completed != null) 'completed': completed.toString(),
  });
  return (res.data['todos'] as List<dynamic>);
}

Future<List<dynamic>> fetchBacklog({bool? completed}) async {
  final res = await api.get('/api/todos/backlog');
  final items = (res.data['todos'] as List<dynamic>);
  if (completed == null) return items;
  return items.where((e) => (e as Map<String, dynamic>)['completed'] == completed).toList();
}

Future<List<dynamic>> searchTodos(String q, { bool? completed, CancelToken? cancelToken }) async {
  final res = await api.get('/api/todos/search', queryParameters: {
    'query': q,
    if (completed != null) 'completed': completed.toString(),
  }, cancelToken: cancelToken);
  return (res.data['todos'] as List<dynamic>);
}

Future<Map<String, dynamic>> createTodo(Map<String, dynamic> data) async {
  final res = await api.post('/api/todos', data: data);
  return Map<String, dynamic>.from(res.data['todo'] as Map);
}

Future<Map<String, dynamic>> updateTodo(int id, Map<String, dynamic> patch) async {
  final res = await api.patch('/api/todos/$id', data: patch);
  return Map<String, dynamic>.from(res.data['todo'] as Map);
}

Future<Map<String, dynamic>> updateOccurrence(int id, String occurrenceDate, bool completed) async {
  final res = await api.patch('/api/todos/$id/occurrence', data: {
    'occurrenceDate': occurrenceDate,
    'completed': completed,
  });
  return Map<String, dynamic>.from(res.data['todo'] as Map);
}

Future<void> deleteTodo(int id) async {
  await api.delete('/api/todos/$id');
}

Future<Map<String, dynamic>> assistantMessage(
  String message, {
  List<Map<String, String>> transcript = const [],
  bool streamSummary = false,
  void Function(String text)? onSummary,
  void Function(String question, List<Map<String, dynamic>> options)? onClarify,
  Map<String, dynamic>? priorClarify,
  void Function(String stage)? onStage,
  void Function(List<Map<String, dynamic>> operations, int version, int validCount, int invalidCount)? onOps,
}) async {
  if (!streamSummary) {
    final res = await api.post('/api/assistant/message', data: {
      'message': message,
      'transcript': transcript,
      'options': {
        if (priorClarify != null) 'clarify': priorClarify,
      },
    });
    final map = Map<String, dynamic>.from(res.data as Map);
    if (onClarify != null && map['requiresClarification'] == true && map['question'] is String) {
      onClarify(map['question'] as String, const <Map<String, dynamic>>[]);
    }
    return map;
  }
  // Flutter Web: use EventSource against GET streaming endpoint
  final uri = Uri.parse('${api.options.baseUrl}/api/assistant/message/stream').replace(queryParameters: {
    'message': message,
    'transcript': transcript.isEmpty ? '[]' : jsonEncode(transcript),
    if (priorClarify != null) 'clarify': jsonEncode(priorClarify),
  }).toString();

  final completer = Completer<Map<String, dynamic>>();
  try {
    final es = html.EventSource(uri);
    Map<String, dynamic>? result;
    // Clarify listener with structured options
    es.addEventListener('clarify', (event) {
      try {
        final data = (event as html.MessageEvent).data as String;
        final obj = jsonDecode(data) as Map<String, dynamic>;
        final q = (obj['question'] as String?) ?? '';
        final optsRaw = obj['options'];
        final opts = (optsRaw is List)
            ? optsRaw.map((e) => Map<String, dynamic>.from(e as Map)).toList()
            : const <Map<String, dynamic>>[];
        if (onClarify != null && q.isNotEmpty) onClarify(q, opts);
      } catch (_) {}
    });
    // Stage listener
    es.addEventListener('stage', (event) {
      try {
        final data = (event as html.MessageEvent).data as String;
        final obj = jsonDecode(data) as Map<String, dynamic>;
        final st = (obj['stage'] as String?) ?? '';
        if (onStage != null && st.isNotEmpty) onStage(st);
      } catch (_) {}
    });
    // Ops listener (versioned)
    es.addEventListener('ops', (event) {
      try {
        final data = (event as html.MessageEvent).data as String;
        final obj = jsonDecode(data) as Map<String, dynamic>;
        final opsRaw = obj['operations'];
        final version = (obj['version'] is int) ? (obj['version'] as int) : 1;
        final validCount = (obj['validCount'] is int) ? (obj['validCount'] as int) : 0;
        final invalidCount = (obj['invalidCount'] is int) ? (obj['invalidCount'] as int) : 0;
        final ops = (opsRaw is List)
            ? opsRaw.map((e) => Map<String, dynamic>.from(e as Map)).toList()
            : const <Map<String, dynamic>>[];
        if (onOps != null) onOps(ops, version, validCount, invalidCount);
      } catch (_) {}
    });
    es.addEventListener('summary', (event) {
      try {
        final data = (event as html.MessageEvent).data as String;
        final obj = jsonDecode(data) as Map<String, dynamic>;
        final text = (obj['text'] as String?) ?? '';
        if (onSummary != null && text.isNotEmpty) {
          onSummary(text);
        }
      } catch (_) {}
    });
    es.addEventListener('result', (event) {
      try {
        final data = (event as html.MessageEvent).data as String;
        result = Map<String, dynamic>.from(jsonDecode(data) as Map);
      } catch (_) {}
    });
    es.addEventListener('done', (event) {
      es.close();
      completer.complete(result ?? {'text': '', 'operations': []});
    });
    es.addEventListener('error', (event) async {
      try { es.close(); } catch (_) {}
      if (!completer.isCompleted) {
        try {
          // Fallback to non-streaming POST on SSE error
          final res = await api.post('/api/assistant/message', data: {
            'message': message,
            'transcript': transcript,
            'options': { if (priorClarify != null) 'clarify': priorClarify },
          });
          completer.complete(Map<String, dynamic>.from(res.data as Map));
        } catch (e) {
          completer.completeError(Exception('sse_error'));
        }
      }
    });
  } catch (_) {
    // Fallback to non-streaming on any error
    final res = await api.post('/api/assistant/message', data: {
      'message': message,
      'transcript': transcript,
      'options': {},
    });
    return Map<String, dynamic>.from(res.data as Map);
  }
  return completer.future;
}

Future<Map<String, dynamic>> applyOperations(List<Map<String, dynamic>> ops) async {
  final res = await api.post('/api/llm/apply', data: {'operations': ops});
  return Map<String, dynamic>.from(res.data as Map);
}

Future<Map<String, dynamic>> dryRunOperations(List<Map<String, dynamic>> ops) async {
  final res = await api.post('/api/llm/dryrun', data: {'operations': ops});
  return Map<String, dynamic>.from(res.data as Map);
}

// --- Goals API ---
Future<List<dynamic>> listGoals({String? status}) async {
  final res = await api.get('/api/goals', queryParameters: {
    if (status != null) 'status': status,
  });
  return (res.data['goals'] as List<dynamic>);
}

Future<Map<String, dynamic>?> getGoal(int id, {bool includeItems = false, bool includeChildren = false}) async {
  final res = await api.get('/api/goals/$id', queryParameters: {
    if (includeItems) 'includeItems': 'true',
    if (includeChildren) 'includeChildren': 'true',
  });
  return (res.data['goal'] as Map?) == null ? null : Map<String, dynamic>.from(res.data['goal'] as Map);
}

Future<Map<String, dynamic>> createGoal(Map<String, dynamic> data) async {
  final res = await api.post('/api/goals', data: data);
  return Map<String, dynamic>.from(res.data['goal'] as Map);
}

Future<Map<String, dynamic>> updateGoal(int id, Map<String, dynamic> patch) async {
  final res = await api.patch('/api/goals/$id', data: patch);
  return Map<String, dynamic>.from(res.data['goal'] as Map);
}

Future<void> deleteGoal(int id) async { await api.delete('/api/goals/$id'); }

Future<void> addGoalItems(int id, {List<int>? todos, List<int>? events}) async {
  await api.post('/api/goals/$id/items', data: {
    if (todos != null) 'todos': todos,
    if (events != null) 'events': events,
  });
}

Future<void> removeGoalTodoItem(int goalId, int todoId) async {
  await api.delete('/api/goals/$goalId/items/todo/$todoId');
}

Future<void> removeGoalEventItem(int goalId, int eventId) async {
  await api.delete('/api/goals/$goalId/items/event/$eventId');
}

Future<void> addGoalChild(int parentId, int childId) async {
  await api.post('/api/goals/$parentId/children', data: [childId]);
}

Future<void> removeGoalChild(int parentId, int childId) async {
  await api.delete('/api/goals/$parentId/children/$childId');
}

// --- Events API ---
Future<List<dynamic>> listEvents({String? from, String? to, String? priority, bool? completed}) async {
  final res = await api.get('/api/events', queryParameters: {
    if (from != null) 'from': from,
    if (to != null) 'to': to,
    if (priority != null) 'priority': priority,
    if (completed != null) 'completed': completed.toString(),
  });
  return (res.data['events'] as List<dynamic>);
}

Future<Map<String, dynamic>> createEvent(Map<String, dynamic> data) async {
  final res = await api.post('/api/events', data: data);
  return Map<String, dynamic>.from(res.data['event'] as Map);
}

Future<Map<String, dynamic>> updateEvent(int id, Map<String, dynamic> patch) async {
  final res = await api.patch('/api/events/$id', data: patch);
  return Map<String, dynamic>.from(res.data['event'] as Map);
}

Future<void> deleteEvent(int id) async { await api.delete('/api/events/$id'); }

Future<Map<String, dynamic>> toggleEventOccurrence(int id, String occurrenceDate, bool completed) async {
  final res = await api.patch('/api/events/$id/occurrence', data: {'occurrenceDate': occurrenceDate, 'completed': completed});
  return Map<String, dynamic>.from(res.data['event'] as Map);
}

Future<List<dynamic>> searchEvents(String q, { bool? completed, CancelToken? cancelToken }) async {
  final res = await api.get('/api/events/search', queryParameters: {
    'query': q,
    if (completed != null) 'completed': completed.toString(),
  }, cancelToken: cancelToken);
  return (res.data['events'] as List<dynamic>);
}

// --- Habits API ---
Future<List<dynamic>> listHabits({String? from, String? to, String? priority, bool? completed}) async {
  final res = await api.get('/api/habits', queryParameters: {
    if (from != null) 'from': from,
    if (to != null) 'to': to,
    if (priority != null) 'priority': priority,
    if (completed != null) 'completed': completed.toString(),
  });
  return (res.data['habits'] as List<dynamic>);
}

Future<Map<String, dynamic>> createHabit(Map<String, dynamic> data) async {
  final res = await api.post('/api/habits', data: data);
  return Map<String, dynamic>.from(res.data['habit'] as Map);
}

Future<Map<String, dynamic>> updateHabit(int id, Map<String, dynamic> patch) async {
  final res = await api.patch('/api/habits/$id', data: patch);
  return Map<String, dynamic>.from(res.data['habit'] as Map);
}

Future<void> deleteHabit(int id) async { await api.delete('/api/habits/$id'); }

Future<Map<String, dynamic>> toggleHabitOccurrence(int id, String occurrenceDate, bool completed) async {
  final res = await api.patch('/api/habits/$id/occurrence', data: {'occurrenceDate': occurrenceDate, 'completed': completed});
  return Map<String, dynamic>.from(res.data['habit'] as Map);
}

Future<List<dynamic>> searchHabits(String q, { bool? completed, CancelToken? cancelToken }) async {
  final res = await api.get('/api/habits/search', queryParameters: {
    'query': q,
    if (completed != null) 'completed': completed.toString(),
  }, cancelToken: cancelToken);
  return (res.data['habits'] as List<dynamic>);
}

// --- Unified schedule ---
Future<List<dynamic>> fetchSchedule({required String from, required String to, List<String>? kinds, bool? completed, String? priority}) async {
  final res = await api.get('/api/schedule', queryParameters: {
    'from': from,
    'to': to,
    if (kinds != null && kinds.isNotEmpty) 'kinds': kinds.join(','),
    if (completed != null) 'completed': completed.toString(),
    if (priority != null) 'priority': priority,
  });
  return (res.data['items'] as List<dynamic>);
}

