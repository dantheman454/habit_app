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
