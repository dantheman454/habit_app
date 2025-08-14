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

Future<List<dynamic>> fetchScheduled({required String from, required String to, bool? completed, bool expand = true}) async {
  final res = await api.get('/api/todos', queryParameters: {
    'from': from,
    'to': to,
    if (completed != null) 'completed': completed.toString(),
    if (expand) 'expand': 'true',
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

Future<Map<String, dynamic>> assistantMessage(String message, {List<Map<String, String>> transcript = const [], bool streamSummary = false, String mode = 'plan'}) async {
  if (!streamSummary) {
    final res = await api.post('/api/assistant/message', data: {
      'message': message,
      'transcript': transcript,
      'options': {'streamSummary': false, 'mode': mode},
    });
    return Map<String, dynamic>.from(res.data as Map);
  }
  // Flutter Web: use EventSource against GET streaming endpoint
  final uri = Uri.parse('${api.options.baseUrl}/api/assistant/message/stream').replace(queryParameters: {
    'message': message,
    'transcript': transcript.isEmpty ? '[]' : jsonEncode(transcript),
    'mode': mode,
  }).toString();

  final completer = Completer<Map<String, dynamic>>();
  try {
    final es = html.EventSource(uri);
    Map<String, dynamic>? result;
    es.addEventListener('result', (event) {
      try {
        final data = (event as html.MessageEvent).data as String;
        result = Map<String, dynamic>.from(jsonDecode(data) as Map);
      } catch (_) {}
    });
    es.addEventListener('done', (_) {
      es.close();
      completer.complete(result ?? {'text': '', 'operations': []});
    });
    es.addEventListener('error', (_) {
      try { es.close(); } catch (_) {}
      if (!completer.isCompleted) completer.completeError(Exception('sse_error'));
    });
  } catch (_) {
    // Fallback to non-streaming on any error
    final res = await api.post('/api/assistant/message', data: {
      'message': message,
      'transcript': transcript,
      'options': {'streamSummary': false, 'mode': mode},
    });
    return Map<String, dynamic>.from(res.data as Map);
  }
  return completer.future;
}

Future<Map<String, dynamic>> applyOperations(List<Map<String, dynamic>> ops) async {
  final res = await api.post('/api/llm/apply', data: {'operations': ops});
  return Map<String, dynamic>.from(res.data as Map);
}


