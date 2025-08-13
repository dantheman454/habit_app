import 'package:dio/dio.dart';

String _computeApiBase() {
  // Works when served by Express or running Flutter in Chrome
  final origin = Uri.base.origin;
  if (origin.contains('127.0.0.1:3000') || origin.contains('localhost:3000')) {
    return origin;
  }
  return 'http://127.0.0.1:3000';
}

final Dio api = Dio(BaseOptions(baseUrl: _computeApiBase()));

Future<List<dynamic>> fetchScheduled({required String from, required String to, bool? completed}) async {
  final res = await api.get('/api/todos', queryParameters: {
    'from': from,
    'to': to,
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

Future<List<dynamic>> searchTodos(String q) async {
  final res = await api.get('/api/todos/search', queryParameters: {'query': q});
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

Future<void> deleteTodo(int id) async {
  await api.delete('/api/todos/$id');
}

Future<Map<String, dynamic>> assistantMessage(String message, {List<Map<String, String>> transcript = const [], bool streamSummary = false}) async {
  final res = await api.post('/api/assistant/message', data: {
    'message': message,
    'transcript': transcript,
    'options': {'streamSummary': streamSummary},
  });
  return Map<String, dynamic>.from(res.data as Map);
}

Future<Map<String, dynamic>> applyOperations(List<Map<String, dynamic>> ops) async {
  final res = await api.post('/api/llm/apply', data: {'operations': ops});
  return Map<String, dynamic>.from(res.data as Map);
}


