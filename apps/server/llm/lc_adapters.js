// LangChain-style adapters (no external deps): tools and strict parser.

/**
 * Build function-calling tools from OperationRegistry schemas.
 * Returns: [{ type:'function', function:{ name, description, parameters } }]
 */
export function buildOperationTools(operationRegistry) {
  const toolNames = [
    'task.create','task.update','task.delete','task.set_status',
    'event.create','event.update','event.delete'
  ];
  return toolNames.map((name) => {
    const [k, a] = name.split('.');
    const opType = `${k}_${a}`;
    const schema = operationRegistry?.getOperationSchema(opType) || { type: 'object', additionalProperties: true };
    return ({ type: 'function', function: { name, description: `Execute operation ${name}`, parameters: schema } });
  });
}

/**
 * Strict parser for tool-call JSON.
 * Expected input object: { tool_calls: [ { function: { name, arguments } } ], message?: string }
 * Returns a normalized object: { tool_calls: [...], message?: string, errors?: string[] }
 */
export function parseToolResponseStrict(input) {
  const result = { tool_calls: [], message: '', errors: [] };
  try {
    const obj = (typeof input === 'string') ? JSON.parse(input) : (input || {});
    if (obj && typeof obj === 'object') {
      if (Array.isArray(obj.tool_calls)) {
        for (const call of obj.tool_calls) {
          const fn = call && call.function;
          const name = fn && typeof fn.name === 'string' ? fn.name : null;
          const argsRaw = (fn && fn.arguments !== undefined) ? fn.arguments : (call && call.arguments);
          const hasArgs = argsRaw !== undefined;
          if (!name || !hasArgs) {
            result.errors.push('invalid_tool_call');
            continue;
          }
          let args = argsRaw;
          if (typeof argsRaw === 'string') {
            try { args = JSON.parse(argsRaw); } catch { args = {}; }
          }
          result.tool_calls.push({ function: { name, arguments: args } });
        }
      }
      if (typeof obj.message === 'string') {
        result.message = obj.message;
      }
    } else {
      result.errors.push('response_not_object');
    }
  } catch {
    // Parsing failure: return tolerant shape with no tool_calls
    result.errors.push('parse_error');
  }
  return result;
}


