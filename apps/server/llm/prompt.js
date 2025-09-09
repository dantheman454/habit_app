// Model-agnostic prompt helpers and response parsing

/**
 * Create a neutral prompt string from roles.
 * Avoids provider-specific tokens (e.g., ChatML) so it works across models.
 */
export function createPrompt({ system = '', user = '', assistant = null } = {}) {
  let s = '';
  if (system) s += `System:\n${system}\n\n`;
  if (user) s += `User:\n${user}\n\n`;
  s += 'Assistant:';
  if (assistant) s += `\n${assistant}`;
  return s;
}

/**
 * Create a tool-oriented prompt by rendering a TOOL catalog and strict output rules.
 * Tools: [{ type: 'function', function: { name, description?, parameters } }]
 */
export function createToolPrompt({ system = '', user = '', tools = [] } = {}) {
  const toolsDoc = Array.isArray(tools)
    ? tools.map((t, i) => {
        const name = t?.function?.name || `tool_${i + 1}`;
        const params = t?.function?.parameters || { type: 'object', additionalProperties: true };
        return `- ${name}: parameters=${JSON.stringify(params)}`;
      }).join('\n')
    : '';

  const strict = [
    'STRICT OUTPUT:',
    '- Output MUST be a single JSON object, no prose, no code fences',
    '- Prefer and USE tool_calls whenever an action is possible (do not return errors)',
    '- Tasks are all-day (no time fields). For events use startTime/endTime.',
    '- If using tools, respond as: {"tool_calls":[{"id":"id1","function":{"name":"tool.name","arguments":{}}}],"message":"status"}',
    '- If not using tools, respond as: {"message":"final text"}',
    '- If you need to think, wrap thoughts in <think> tags and provide a clean final message',
  ].join('\n');

  const sys = [system, '', 'TOOLS:', toolsDoc, '', strict].filter(Boolean).join('\n');
  return createPrompt({ system: sys, user });
}

/**
 * Parse an Ollama /api/generate response (string or object) to a { final } shape.
 */
export function parseResponse(response) {
  if (typeof response === 'string') {
    try {
      const parsed = JSON.parse(response);
      if (parsed && typeof parsed === 'object') {
        return { final: parsed.response || parsed.final || response };
      }
    } catch {
      // not JSON, use raw
    }
    return { final: response };
  }
  if (response && typeof response === 'object') {
    return { final: response.response || response.final || '' };
  }
  return { final: '' };
}

/** Get plain text for UI surfaces. */
export function getFinalText(parsed) {
  return (parsed && typeof parsed === 'object' && typeof parsed.final === 'string') ? parsed.final : '';
}
