// Harmony prompting utilities for GPT-OSS models
// Provides structured prompt creation and response parsing

/**
 * Create a Harmony-formatted prompt with role separation
 * @param {Object} params - Prompt parameters
 * @param {string} params.system - System role content (global constraints/identity)
 * @param {string} params.developer - Developer role content (app-specific rules)
 * @param {string} params.user - User role content (input/context)
 * @param {string} [params.assistant] - Assistant role content (optional)
 * @param {string} [params.tool] - Tool role content (optional)
 * @returns {Object} Harmony prompt structure
 */
export function createHarmonyPrompt({ system, developer, user, assistant = null, tool = null }) {
  const prompt = {
    system,
    developer,
    user
  };
  
  if (assistant) prompt.assistant = assistant;
  if (tool) prompt.tool = tool;
  
  return prompt;
}

/**
 * Parse Harmony-formatted response to extract channels
 * @param {string|Object} response - Raw LLM response
 * @returns {Object} Parsed response with channels
 */
export function parseHarmonyResponse(response) {
  if (typeof response === 'string') {
    // Try to extract JSON from string response
    try {
      const parsed = JSON.parse(response);
      return {
        analysis: parsed.analysis || '',
        final: parsed.final || response,
        commentary: parsed.commentary || ''
      };
    } catch {
      // If not JSON, treat as final response
      return {
        analysis: '',
        final: response,
        commentary: ''
      };
    }
  }
  
  // If already an object, extract channels
  return {
    analysis: response.analysis || '',
    final: response.final || response,
    commentary: response.commentary || ''
  };
}

/**
 * Convert Harmony prompt to GPT-OSS format for Ollama API
 * @param {Object} harmonyPrompt - Harmony prompt structure
 * @returns {string} Formatted prompt for GPT-OSS
 */
export function formatHarmonyForGPTOSS(harmonyPrompt) {
  const { system, developer, user, assistant, tool } = harmonyPrompt;
  
  let prompt = `[SYSTEM]\n${system}\n\n`;
  
  if (developer) {
    prompt += `[DEVELOPER]\n${developer}\n\n`;
  }
  
  prompt += `[USER]\n${user}\n\n`;
  
  if (assistant) {
    prompt += `[ASSISTANT]\n${assistant}\n\n`;
  }
  
  if (tool) {
    prompt += `[TOOL]\n${tool}\n\n`;
  }
  
  prompt += `[ASSISTANT]\n`;
  
  return prompt;
}

/**
 * Extract the final response from Harmony channels
 * @param {Object} parsedResponse - Parsed Harmony response
 * @returns {string} Final response for user
 */
export function getFinalResponse(parsedResponse) {
  return parsedResponse.final || '';
}

/**
 * Extract analysis channel for debugging
 * @param {Object} parsedResponse - Parsed Harmony response  
 * @returns {string} Analysis content
 */
export function getAnalysis(parsedResponse) {
  return parsedResponse.analysis || '';
}

/**
 * Extract commentary channel for tool calls
 * @param {Object} parsedResponse - Parsed Harmony response
 * @returns {string} Commentary content
 */
export function getCommentary(parsedResponse) {
  return parsedResponse.commentary || '';
}
