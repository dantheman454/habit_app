// Robust JSON extractor for LLM outputs: finds first top-level JSON object/array
// and fixes trivial issues (code fences, leading/trailing noise).

export function extractFirstJson(text) {
  if (text == null) return null;
  let s = String(text);
  // strip code fences
  s = s.replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, ''));
  // find first { or [
  const i = Math.min(...['{', '['].map(ch => { const p = s.indexOf(ch); return p === -1 ? Number.POSITIVE_INFINITY : p; }));
  if (!Number.isFinite(i)) return null;
  s = s.slice(i);
  // walk to find a balanced JSON block
  const stack = [];
  let end = -1;
  for (let idx = 0; idx < s.length; idx++) {
    const c = s[idx];
    if (c === '{' || c === '[') stack.push(c);
    else if (c === '}' || c === ']') {
      const top = stack.pop();
      if ((top === '{' && c !== '}') || (top === '[' && c !== ']')) {
        // mismatch; continue scanning
      }
      if (stack.length === 0) { end = idx + 1; break; }
    }
  }
  if (end === -1) return null;
  const candidate = s.slice(0, end);
  try { return JSON.parse(candidate); } catch { return null; }
}

// Validate that a JSON response follows the strict tool_calls format
// { tool_calls: [ { function: { name: string, arguments: object|string } } ] }
export function validateToolCallsResponse(jsonResponse) {
  if (!jsonResponse || typeof jsonResponse !== 'object') {
    return { valid: false, error: 'Response is not a valid object' };
  }
  const arr = jsonResponse.tool_calls;
  if (!Array.isArray(arr)) {
    return { valid: false, error: 'Missing or invalid tool_calls array' };
  }
  for (const call of arr) {
    const fn = call && call.function;
    if (!fn || typeof fn !== 'object') {
      return { valid: false, error: 'Missing function in tool call' };
    }
    if (!fn.name || typeof fn.name !== 'string') {
      return { valid: false, error: 'Missing function.name in tool call' };
    }
    if (fn.arguments === undefined) {
      return { valid: false, error: 'Missing function.arguments in tool call' };
    }
  }
  return { valid: true };
}
