// ignore: avoid_web_libraries_in_flutter
import 'dart:html' as html;

typedef CloseFn = void Function();

CloseFn startSse({
  required String uri,
  required void Function(String event, String data) onEvent,
  required void Function() onDone,
  required void Function() onError,
}) {
  final es = html.EventSource(uri);
  void handleMessage(html.MessageEvent ev, String eventName) {
    try { onEvent(eventName, ev.data as String); } catch (_) {}
  }
  es.addEventListener('clarify', (e) => handleMessage(e as html.MessageEvent, 'clarify'));
  es.addEventListener('stage', (e) => handleMessage(e as html.MessageEvent, 'stage'));
  es.addEventListener('ops', (e) => handleMessage(e as html.MessageEvent, 'ops'));
  es.addEventListener('summary', (e) => handleMessage(e as html.MessageEvent, 'summary'));
  es.addEventListener('result', (e) => handleMessage(e as html.MessageEvent, 'result'));
  es.addEventListener('done', (_) { try { es.close(); } catch (_) {} onDone(); });
  es.addEventListener('error', (_) { try { es.close(); } catch (_) {} onError(); });
  return () { try { es.close(); } catch (_) {} };
}


