typedef CloseFn = void Function();

CloseFn startSse({
  required String uri,
  required void Function(String event, String data) onEvent,
  required void Function() onDone,
  required void Function() onError,
}) {
  // Not supported on non-web platforms
  // Immediately error so callers can fallback
  Future.microtask(onError);
  return () {};
}


