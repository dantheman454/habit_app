// Qwen ChatML prompting utilities
// Provides structured prompt creation and response parsing for Qwen models

/**
 * Create a Qwen ChatML-formatted prompt
 * @param {Object} params - Prompt parameters
 * @param {string} params.system - System role content
 * @param {string} params.user - User role content
 * @param {string} [params.assistant] - Assistant role content (optional)
 * @returns {string} ChatML formatted prompt
 */
export function createQwenPrompt({ system, user, assistant = null }) {
  let prompt = `<|im_start|>system\n${system}<|im_end|>\n`;
  prompt += `<|im_start|>user\n${user}<|im_end|>\n`;
  if (assistant) {
    prompt += `<|im_start|>assistant\n${assistant}<|im_end|>\n`;
  }
  prompt += `<|im_start|>assistant\n`;
  return prompt;
}

/**
 * Create a Qwen tool calling prompt structure
 * @param {Object} params - Tool prompt parameters
 * @param {string} params.system - System role content
 * @param {string} params.user - User role content
 * @param {Array} [params.tools] - Tools array for tool calling
 * @returns {Object} Tool calling prompt structure
 */
export function createQwenToolPrompt({ system, user, tools = [] }) {
  return {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    tools: tools,
    tool_choice: "auto"
  };
}

/**
 * Parse Qwen response to extract final content
 * @param {string|Object} response - Raw LLM response
 * @returns {Object} Parsed response with final content
 */
export function parseQwenResponse(response) {
  if (typeof response === 'string') {
    // Try to extract JSON from string response
    try {
      const parsed = JSON.parse(response);
      return {
        final: parsed.final || parsed.response || response
      };
    } catch {
      // If not JSON, treat as final response
      return {
        final: response
      };
    }
  }
  
  // If already an object, extract final content
  return {
    final: response.final || response.response || response
  };
}

/**
 * Extract the final response from Qwen response
 * @param {Object} parsedResponse - Parsed Qwen response
 * @returns {string} Final response for user
 */
export function getQwenFinalResponse(parsedResponse) {
  return parsedResponse.final || '';
}

/**
 * Convert legacy Harmony prompt to Qwen ChatML format
 * @param {Object} harmonyPrompt - Legacy Harmony prompt structure
 * @returns {string} ChatML formatted prompt
 */
export function convertHarmonyToQwen(harmonyPrompt) {
  const { system, developer, user, assistant } = harmonyPrompt;
  
  // Combine system and developer content
  const systemContent = developer ? `${system}\n\n${developer}` : system;
  
  return createQwenPrompt({
    system: systemContent,
    user,
    assistant
  });
}
