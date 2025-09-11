/// Strip large or tool-call-like JSON blobs from assistant text to avoid
/// rendering raw JSON in chat bubbles. Conservative and single-purpose.
String stripJsonBlobs(String input) {
  if (input.isEmpty) return input;
  final s = input.trimLeft();
  // Heuristic 1: If starts with '{' and contains "tool_calls", drop entire text
  if (s.startsWith('{') && s.contains('"tool_calls"')) return '';
  // Heuristic 2: Remove any fenced code blocks that look like JSON
  final codeFence = RegExp(r"```[\s\S]*?```", multiLine: true);
  final withoutFences = s.replaceAll(codeFence, '');
  // Heuristic 3: If remaining text is excessively brace-heavy, likely a blob → trim
  final braceCount = RegExp(r"[{}]").allMatches(withoutFences).length;
  if (braceCount > 1000) return '';
  return withoutFences.trim();
}
