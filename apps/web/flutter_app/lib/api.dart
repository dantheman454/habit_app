import 'package:dio/dio.dart';
import 'dart:async';
import 'util/sse.dart' as sse;
import 'dart:convert';

String _computeApiBase() {
  // Prefer same-origin when the app is being served by the backend (LAN IP or HTTPS proxy).
  // Fallback to localhost:3000 when running Flutter dev server (non-3000 localhost origin).
  final uri = Uri.base;
  final origin = uri.origin;
  // If host is not a loopback OR port is 3000, use origin (covers LAN IP e.g. 10.x, and HTTPS proxy like habit.local).
  final isLoopback = uri.host == 'localhost' || uri.host == '127.0.0.1';
  if (!isLoopback || uri.port == 3000) {
    return origin;
  }
  // Otherwise (likely Flutter dev server on a random port), target the dev API.
  return 'http://127.0.0.1:3000';
}

final Dio api = Dio(BaseOptions(baseUrl: _computeApiBase()));

// Removed: fetchAssistantModel (endpoint deleted; badges removed)

Future<List<dynamic>> fetchScheduled({
  required String from,
  required String to,
  String? status, // 'pending' | 'completed' | 'skipped' (todos only)
  String? context, // 'school' | 'personal' | 'work' | null for 'all'
}) async {
  final res = await api.get(
    '/api/todos',
    queryParameters: {
      'from': from,
      'to': to,
      if (status != null) 'status': status,
      if (context != null) 'context': context,
    },
  );
  return (res.data['todos'] as List<dynamic>);
}

Future<List<dynamic>> fetchScheduledAllTime({
  String? status, // todos only
  String? context, // 'school' | 'personal' | 'work' | null for 'all'
}) async {
  final res = await api.get(
    '/api/todos',
    queryParameters: {
      if (status != null) 'status': status,
      if (context != null) 'context': context,
    },
  );
  return (res.data['todos'] as List<dynamic>);
}

// Removed: fetchBacklog (endpoint deleted)

Future<List<dynamic>> searchTodos(
  String q, {
  String? status, // todos only
  String? context, // 'school' | 'personal' | 'work' | null for 'all'
  CancelToken? cancelToken,
}) async {
  final res = await api.get(
    '/api/todos/search',
    queryParameters: {
      'query': q,
      if (status != null) 'status': status,
      if (context != null) 'context': context,
    },
    cancelToken: cancelToken,
  );
  return (res.data['todos'] as List<dynamic>);
}

// Unified search (server-side merge of todos + events; habits optional later)
Future<List<dynamic>> searchUnified(
  String q, {
  String scope = 'all', // 'todo' | 'event' | 'habit' | 'all'
  bool? completed, // applies to events/habits only
  String? statusTodo, // applies to todos only
  String? context, // 'school' | 'personal' | 'work' | null for 'all'
  CancelToken? cancelToken,
  int? limit,
}) async {
  final res = await api.get(
    '/api/search',
    queryParameters: {
      'q': q,
      if (scope.isNotEmpty) 'scope': scope,
      if (completed != null) 'completed': completed.toString(),
      if (statusTodo != null) 'status_todo': statusTodo,
      if (context != null) 'context': context,
      if (limit != null) 'limit': limit,
    },
    cancelToken: cancelToken,
  );
  return (res.data['items'] as List<dynamic>);
}

Future<Map<String, dynamic>> createTodo(Map<String, dynamic> data) async {
  final res = await api.post('/api/todos', data: data);
  return Map<String, dynamic>.from(res.data['todo']);
}

Future<Map<String, dynamic>> updateTodo(
  int id,
  Map<String, dynamic> patch,
) async {
  final res = await api.patch('/api/todos/$id', data: patch);
  return Map<String, dynamic>.from(res.data['todo']);
}

Future<Map<String, dynamic>> setTodoOccurrenceStatus(
  int id,
  String occurrenceDate,
  String status, // 'pending' | 'completed' | 'skipped'
) async {
  final res = await api.patch(
    '/api/todos/$id/occurrence',
    data: {'occurrenceDate': occurrenceDate, 'status': status},
  );
  return Map<String, dynamic>.from(res.data['todo']);
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
  Map<String, dynamic>? clientContext,
  void Function(String stage)? onStage,
  void Function(
    List<Map<String, dynamic>> operations,
    int version,
    int validCount,
    int invalidCount,
    List<Map<String, dynamic>> previews,
  )?
  onOps,
  void Function(String correlationId)? onTraceId,
}) async {
  if (!streamSummary) {
    final res = await api.post(
      '/api/assistant/message',
      data: {
        'message': message,
        'transcript': transcript,
        'options': {
          if (clientContext != null) 'client': clientContext,
        },
      },
    );
    final map = Map<String, dynamic>.from(res.data);
    // Surface correlationId on non-streaming path, if provided
    try {
      final cid = (map['correlationId'] as String?) ?? '';
      if (cid.isNotEmpty && onTraceId != null) onTraceId(cid);
    } catch (_) {}
    if (onClarify != null &&
        map['requiresClarification'] == true &&
        map['question'] is String) {
      onClarify(map['question'] as String, const <Map<String, dynamic>>[]);
    }
    // Surface ops and summary similar to SSE path when handlers provided
    try {
      if (onOps != null) {
        final opsRaw = map['operations'];
        final ops = (opsRaw is List)
            ? opsRaw.map((e) => Map<String, dynamic>.from(e)).toList()
            : const <Map<String, dynamic>>[];
        final validCount = ops.length;
        final invalidCount = (map['notes'] is Map && (map['notes']['errors'] is List))
            ? (map['notes']['errors'] as List).length
            : 0;
        final version = (map['version'] is int) ? map['version'] as int : 3;
        final previewsRaw = map['previews'];
        final previews = (previewsRaw is List)
            ? previewsRaw.map((e) => Map<String, dynamic>.from(e)).toList()
            : const <Map<String, dynamic>>[];
        onOps(ops, version, validCount, invalidCount, previews);
      }
    } catch (_) {}
    try {
      if (onSummary != null) {
        final text = (map['text'] as String?) ?? '';
        if (text.isNotEmpty) onSummary(text);
      }
    } catch (_) {}
    return map;
  }
  // Flutter Web: use EventSource via platform abstraction; non-web falls back to POST
  final uri = Uri.parse('${api.options.baseUrl}/api/assistant/message/stream')
      .replace(
        queryParameters: {
          'message': message,
          'transcript': transcript.isEmpty ? '[]' : jsonEncode(transcript),
          if (clientContext != null) 'context': jsonEncode(clientContext),
        },
      )
      .toString();

  final completer = Completer<Map<String, dynamic>>();
  try {
    Map<String, dynamic>? result;
    final close = sse.startSse(
      uri: uri,
  onEvent: (event, data) {
        try {
          final obj = jsonDecode(data) as Map<String, dynamic>;
          // Emit correlationId ASAP for any event that carries it
          try {
            final cid = (obj['correlationId'] as String?) ?? '';
            if (cid.isNotEmpty && onTraceId != null) onTraceId(cid);
          } catch (_) {}
          if (event == 'clarify') {
            if (onClarify != null) {
              final q = (obj['question'] as String?) ?? '';
        final optsRaw = obj['options'];
        final opts = (optsRaw is List)
          ? optsRaw.map((e) => Map<String, dynamic>.from(e)).toList()
          : const <Map<String, dynamic>>[];
              if (q.isNotEmpty) onClarify(q, opts);
            }
          } else if (event == 'stage') {
            if (onStage != null) {
              final st = (obj['stage'] as String?) ?? '';
              if (st.isNotEmpty) onStage(st);
            }
          } else if (event == 'ops') {
            if (onOps != null) {
              final opsRaw = obj['operations'];
              final version = (obj['version'] is int)
                  ? (obj['version'] as int)
                  : 1;
              final validCount = (obj['validCount'] is int)
                  ? (obj['validCount'] as int)
                  : 0;
              final invalidCount = (obj['invalidCount'] is int)
                  ? (obj['invalidCount'] as int)
                  : 0;
              final ops = (opsRaw is List)
                  ? opsRaw
                        .map((e) => Map<String, dynamic>.from(e))
                        .toList()
                  : const <Map<String, dynamic>>[];
              final previewsRaw = obj['previews'];
              final previews = (previewsRaw is List)
                  ? previewsRaw.map((e) => Map<String, dynamic>.from(e)).toList()
                  : const <Map<String, dynamic>>[];
              onOps(ops, version, validCount, invalidCount, previews);
            }
          } else if (event == 'summary') {
            if (onSummary != null) {
              final text = (obj['text'] as String?) ?? '';
              if (text.isNotEmpty) onSummary(text);
            }
          } else if (event == 'result') {
            result = Map<String, dynamic>.from(obj);
          }
        } catch (_) {}
      },
      onDone: () {
        completer.complete(result ?? {'text': '', 'operations': []});
      },
      onError: () async {
        // Fallback to non-streaming POST on SSE error
        try {
          final res = await api.post(
            '/api/assistant/message',
            data: {
              'message': message,
              'transcript': transcript,
              'options': {
                if (clientContext != null) 'client': clientContext,
              },
            },
          );
          final map = Map<String, dynamic>.from(res.data);
          try {
            final cid = (map['correlationId'] as String?) ?? '';
            if (cid.isNotEmpty && onTraceId != null) onTraceId(cid);
          } catch (_) {}
          // Ensure onOps is surfaced on POST fallback as well
          try {
            if (onOps != null) {
              final opsRaw = map['operations'];
              final ops = (opsRaw is List)
                  ? opsRaw.map((e) => Map<String, dynamic>.from(e)).toList()
                  : const <Map<String, dynamic>>[];
              final validCount = ops.length;
              final invalidCount = (map['notes'] is Map && (map['notes']['errors'] is List))
                  ? (map['notes']['errors'] as List).length
                  : 0;
              final version = (map['version'] is int) ? map['version'] as int : 3;
              final previewsRaw = map['previews'];
              final previews = (previewsRaw is List)
                  ? previewsRaw.map((e) => Map<String, dynamic>.from(e)).toList()
                  : const <Map<String, dynamic>>[];
              onOps(ops, version, validCount, invalidCount, previews);
            }
          } catch (_) {}
          completer.complete(map);
        } catch (e) {
          completer.completeError(Exception('sse_error'));
        }
      },
    );
    return completer.future.whenComplete(() {
      try {
        close();
      } catch (_) {}
    });
  } catch (_) {
    // Fallback to non-streaming on any error
    final res = await api.post(
      '/api/assistant/message',
      data: {
        'message': message,
        'transcript': transcript,
        'options': {if (clientContext != null) 'client': clientContext},
      },
    );
  final map = Map<String, dynamic>.from(res.data);
    try {
      final cid = (map['correlationId'] as String?) ?? '';
      if (cid.isNotEmpty && onTraceId != null) onTraceId(cid);
    } catch (_) {}
    return map;
  }
}

// Legacy HTTP operation functions removed - now using MCP protocol

// --- Goals API ---
Future<List<dynamic>> listGoals({String? status}) async {
  final res = await api.get(
    '/api/goals',
    queryParameters: {if (status != null) 'status': status},
  );
  return (res.data['goals'] as List<dynamic>);
}

Future<Map<String, dynamic>?> getGoal(
  int id, {
  bool includeItems = false,
  bool includeChildren = false,
}) async {
  final res = await api.get(
    '/api/goals/$id',
    queryParameters: {
      if (includeItems) 'includeItems': 'true',
      if (includeChildren) 'includeChildren': 'true',
    },
  );
  return (res.data['goal'] as Map?) == null
      ? null
  : Map<String, dynamic>.from(res.data['goal']);
}

Future<Map<String, dynamic>> createGoal(Map<String, dynamic> data) async {
  final res = await api.post('/api/goals', data: data);
  return Map<String, dynamic>.from(res.data['goal']);
}

Future<Map<String, dynamic>> updateGoal(
  int id,
  Map<String, dynamic> patch,
) async {
  final res = await api.patch('/api/goals/$id', data: patch);
  return Map<String, dynamic>.from(res.data['goal']);
}

Future<void> deleteGoal(int id) async {
  await api.delete('/api/goals/$id');
}

Future<void> addGoalItems(int id, {List<int>? todos, List<int>? events}) async {
  await api.post(
    '/api/goals/$id/items',
    data: {
      if (todos != null) 'todos': todos,
      if (events != null) 'events': events,
    },
  );
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
Future<List<dynamic>> listEvents({
  String? from,
  String? to,
  bool? completed,
  String? context, // 'school' | 'personal' | 'work' | null for 'all'
}) async {
  final res = await api.get(
    '/api/events',
    queryParameters: {
      if (from != null) 'from': from,
      if (to != null) 'to': to,
      if (completed != null) 'completed': completed.toString(),
      if (context != null) 'context': context,
    },
  );
  return (res.data['events'] as List<dynamic>);
}

Future<Map<String, dynamic>> createEvent(Map<String, dynamic> data) async {
  final res = await api.post('/api/events', data: data);
  return Map<String, dynamic>.from(res.data['event']);
}

Future<Map<String, dynamic>> updateEvent(
  int id,
  Map<String, dynamic> patch,
) async {
  final res = await api.patch('/api/events/$id', data: patch);
  return Map<String, dynamic>.from(res.data['event']);
}

Future<void> deleteEvent(int id) async {
  await api.delete('/api/events/$id');
}

// Removed: toggleEventOccurrence (event completion not supported)

Future<List<dynamic>> searchEvents(
  String q, {
  bool? completed,
  String? context, // 'school' | 'personal' | 'work' | null for 'all'
  CancelToken? cancelToken,
}) async {
  final res = await api.get(
    '/api/events/search',
    queryParameters: {
      'query': q,
      if (completed != null) 'completed': completed.toString(),
      if (context != null) 'context': context,
    },
    cancelToken: cancelToken,
  );
  return (res.data['events'] as List<dynamic>);
}

// --- Habits API ---
Future<List<dynamic>> listHabits({
  String? from,
  String? to,
  bool? completed,
  String? context, // 'school' | 'personal' | 'work' | null for 'all'
}) async {
  final res = await api.get(
    '/api/habits',
    queryParameters: {
      if (from != null) 'from': from,
      if (to != null) 'to': to,
      if (completed != null) 'completed': completed.toString(),
      if (context != null) 'context': context,
    },
  );
  return (res.data['habits'] as List<dynamic>);
}

Future<Map<String, dynamic>> createHabit(Map<String, dynamic> data) async {
  final res = await api.post('/api/habits', data: data);
  return Map<String, dynamic>.from(res.data['habit']);
}

Future<Map<String, dynamic>> updateHabit(
  int id,
  Map<String, dynamic> patch,
) async {
  final res = await api.patch('/api/habits/$id', data: patch);
  return Map<String, dynamic>.from(res.data['habit']);
}

Future<void> deleteHabit(int id) async {
  await api.delete('/api/habits/$id');
}

Future<Map<String, dynamic>> toggleHabitOccurrence(
  int id,
  String occurrenceDate,
  bool completed,
) async {
  final res = await api.patch(
    '/api/habits/$id/occurrence',
    data: {'occurrenceDate': occurrenceDate, 'completed': completed},
  );
  return Map<String, dynamic>.from(res.data['habit']);
}

Future<List<dynamic>> searchHabits(
  String q, {
  bool? completed,
  String? context, // 'school' | 'personal' | 'work' | null for 'all'
  CancelToken? cancelToken,
}) async {
  final res = await api.get(
    '/api/habits/search',
    queryParameters: {
      'query': q,
      if (completed != null) 'completed': completed.toString(),
      if (context != null) 'context': context,
    },
    cancelToken: cancelToken,
  );
  return (res.data['habits'] as List<dynamic>);
}

Future<void> linkHabitItems(
  int habitId, {
  List<int>? todos,
  List<int>? events,
}) async {
  await api.post(
    '/api/habits/$habitId/items',
    data: {
      if (todos != null) 'todos': todos,
      if (events != null) 'events': events,
    },
  );
}

Future<void> unlinkHabitTodo(int habitId, int todoId) async {
  await api.delete('/api/habits/$habitId/items/todo/$todoId');
}

Future<void> unlinkHabitEvent(int habitId, int eventId) async {
  await api.delete('/api/habits/$habitId/items/event/$eventId');
}

// --- Unified schedule ---
Future<List<dynamic>> fetchSchedule({
  required String from,
  required String to,
  List<String>? kinds,
  bool? completed, // events/habits only
  String? statusTodo, // todos only
  String? context, // 'school' | 'personal' | 'work' | null for 'all'
}) async {
  final res = await api.get(
    '/api/schedule',
    queryParameters: {
      'from': from,
      'to': to,
      if (kinds != null && kinds.isNotEmpty) 'kinds': kinds.join(','),
      if (completed != null) 'completed': completed.toString(),
      if (statusTodo != null) 'status_todo': statusTodo,
      if (context != null) 'context': context,
    },
  );
  return (res.data['items'] as List<dynamic>);
}

// --- MCP Client Functions ---
Future<List<Map<String, dynamic>>> listMCPTools() async {
  final res = await api.get('/api/mcp/tools');
  return List<Map<String, dynamic>>.from(res.data['tools']);
}

Future<List<Map<String, dynamic>>> listMCPResources() async {
  final res = await api.get('/api/mcp/resources');
  return List<Map<String, dynamic>>.from(res.data['resources']);
}

Future<Map<String, dynamic>?> readMCPResource(String type, String name) async {
  try {
    final res = await api.get('/api/mcp/resources/$type/$name');
    return Map<String, dynamic>.from(res.data);
  } catch (e) {
    return null;
  }
}

Future<Map<String, dynamic>> callMCPTool(
  String name,
  Map<String, dynamic> arguments, {
  String? correlationId,
}) async {
  final res = await api.post(
    '/api/mcp/tools/call',
    data: {
      'name': name,
      'arguments': arguments,
    },
    options: Options(headers: {
      if (correlationId != null) 'x-correlation-id': correlationId,
    }),
  );
  return Map<String, dynamic>.from(res.data);
}

// Convert operations to MCP tool calls
Future<Map<String, dynamic>> applyOperationsMCP(
  List<Map<String, dynamic>> ops, {
  String? correlationId,
}) async {
  final results = <Map<String, dynamic>>[];
  int created = 0, updated = 0, deleted = 0, completed = 0;
  
  for (final op in ops) {
    try {
      final toolName = _operationToToolName(op);
      final args = _operationToToolArgs(op);
      
      final result = await callMCPTool(toolName, args, correlationId: correlationId);
      results.add(result);
      
      // Count operations
      if (op['action'] == 'create') {
        created++;
      } else if (op['action'] == 'update') {
        updated++;
      } else if (op['action'] == 'delete') {
        deleted++;
      } else if (op['action'] == 'complete' || op['action'] == 'complete_occurrence') {
        completed++;
      }
    } catch (e) {
      results.add({'error': e.toString()});
    }
  }
  
  return {
    'results': results,
    'summary': {
      'created': created,
      'updated': updated,
      'deleted': deleted,
      'completed': completed,
    }
  };
}

// Dry run operations using MCP tool validation
Future<Map<String, dynamic>> dryRunOperationsMCP(
  List<Map<String, dynamic>> ops,
) async {
  final warnings = <String>[];
  final tools = await listMCPTools();
  final toolMap = <String, Map<String, dynamic>>{};
  
  for (final tool in tools) {
    toolMap[tool['name']] = tool;
  }
  
  for (final op in ops) {
    final toolName = _operationToToolName(op);
    final args = _operationToToolArgs(op);
    
    // Check if tool exists
    if (!toolMap.containsKey(toolName)) {
      warnings.add('Unknown operation type: ${op['kind']} ${op['action']}');
      continue;
    }
    
    // Validate required fields
    final tool = toolMap[toolName]!;
    final schema = tool['inputSchema'] as Map<String, dynamic>?;
    if (schema != null) {
      final required = schema['required'] as List<dynamic>? ?? [];
      for (final field in required) {
        if (!args.containsKey(field)) {
          warnings.add('Missing required field: $field for ${op['kind']} ${op['action']}');
        }
      }
    }
  }
  
  return {
    'warnings': warnings,
    'valid': warnings.isEmpty,
  };
}

// Preview operations (client-side shim)
// Builds a lightweight preview payload expected by the UI:
// { affected: [ { op, before }, ... ] }
// Attempts to fetch current entity state for update/delete/complete ops; falls back to null.
Future<Map<String, dynamic>> previewOperations(
  List<Map<String, dynamic>> ops,
) async {
  final affected = <Map<String, dynamic>>[];

  for (final op in ops) {
    Map<String, dynamic>? before;
    try {
      final action = (op['action'] ?? op['op'] ?? '').toString();
      final kind = (op['kind'] ?? 'todo').toString();
      final dynamic idRaw = op['id'];
      final bool needsBefore =
          action == 'update' || action == 'delete' || action == 'complete' || action == 'set_status' || action == 'complete_occurrence';
      if (needsBefore && idRaw != null) {
        final int? id = (idRaw is int) ? idRaw : int.tryParse(idRaw.toString());
        if (id != null) {
          if (kind == 'event') {
            before = await _getEventById(id);
          } else if (kind == 'habit') {
            before = await _getHabitById(id);
          } else {
            before = await _getTodoById(id);
          }
        }
      }
    } catch (_) {}
    affected.add({'op': op, 'before': before});
  }

  return {'affected': affected};
}

// Helpers to fetch current entity state for preview
Future<Map<String, dynamic>?> _getTodoById(int id) async {
  try {
    final res = await api.get('/api/todos/$id');
    final m = (res.data['todo'] as Map?);
    return m == null ? null : Map<String, dynamic>.from(m);
  } catch (_) {
    return null;
  }
}

Future<Map<String, dynamic>?> _getEventById(int id) async {
  try {
    final res = await api.get('/api/events/$id');
    final m = (res.data['event'] as Map?);
    return m == null ? null : Map<String, dynamic>.from(m);
  } catch (_) {
    return null;
  }
}

Future<Map<String, dynamic>?> _getHabitById(int id) async {
  try {
    final res = await api.get('/api/habits/$id');
    final m = (res.data['habit'] as Map?);
    return m == null ? null : Map<String, dynamic>.from(m);
  } catch (_) {
    return null;
  }
}

String _operationToToolName(Map<String, dynamic> op) {
  final kind = op['kind'] ?? 'todo';
  final action = op['action'] ?? op['op'] ?? 'create';
  
  switch (action) {
    case 'create':
      return 'create_$kind';
    case 'update':
      return 'update_$kind';
    case 'delete':
      return 'delete_$kind';
    case 'complete':
      return 'complete_$kind';
    case 'complete_occurrence':
      return 'complete_${kind}_occurrence';
    case 'set_status':
      return 'set_${kind}_status';
    default:
      return 'create_$kind';
  }
}

Map<String, dynamic> _operationToToolArgs(Map<String, dynamic> op) {
  final args = <String, dynamic>{};
  
  // Copy all fields except kind and action
  for (final entry in op.entries) {
    if (entry.key != 'kind' && entry.key != 'action' && entry.key != 'op') {
      args[entry.key] = entry.value;
    }
  }
  
  return args;
}
