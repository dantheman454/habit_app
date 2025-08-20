import { test } from 'node:test';
import assert from 'node:assert';
import { formatHarmonyForGPTOSS, parseHarmonyResponse } from '../../apps/server/llm/harmony_utils.js';

test('harmonyConvoLLM - prompt formatting works correctly', () => {
  const harmonyPrompt = {
    system: 'You are a helpful assistant.',
    developer: 'Follow these rules.',
    user: 'Hello world'
  };
  
  const formattedPrompt = formatHarmonyForGPTOSS(harmonyPrompt);
  
  // Verify the prompt was formatted correctly
  assert(formattedPrompt.includes('[SYSTEM]'));
  assert(formattedPrompt.includes('[DEVELOPER]'));
  assert(formattedPrompt.includes('[USER]'));
  assert(formattedPrompt.includes('[ASSISTANT]'));
  assert(formattedPrompt.includes('You are a helpful assistant.'));
  assert(formattedPrompt.includes('Follow these rules.'));
  assert(formattedPrompt.includes('Hello world'));
});

test('harmonyCodeLLM - prompt formatting works correctly', () => {
  const harmonyPrompt = {
    system: 'You are a code assistant.',
    developer: 'Write clean code.',
    user: 'Create a function'
  };
  
  const formattedPrompt = formatHarmonyForGPTOSS(harmonyPrompt);
  
  // Verify the prompt was formatted correctly
  assert(formattedPrompt.includes('[SYSTEM]'));
  assert(formattedPrompt.includes('[DEVELOPER]'));
  assert(formattedPrompt.includes('[USER]'));
  assert(formattedPrompt.includes('[ASSISTANT]'));
  assert(formattedPrompt.includes('You are a code assistant.'));
  assert(formattedPrompt.includes('Write clean code.'));
  assert(formattedPrompt.includes('Create a function'));
});

test('harmonyResponse - parsing works correctly', () => {
  const mockResponse = '{"analysis": "Thinking...", "final": "Hello! How can I help you?", "commentary": "Tool used"}';
  
  const parsedResponse = parseHarmonyResponse(mockResponse);
  
  assert.deepStrictEqual(parsedResponse, {
    analysis: 'Thinking...',
    final: 'Hello! How can I help you?',
    commentary: 'Tool used'
  });
});

test('harmonyResponse - handles string responses', () => {
  const mockResponse = 'Hello! How can I help you?';
  
  const parsedResponse = parseHarmonyResponse(mockResponse);
  
  assert.deepStrictEqual(parsedResponse, {
    analysis: '',
    final: 'Hello! How can I help you?',
    commentary: ''
  });
});

test('harmonyPrompt - with all optional roles', () => {
  const harmonyPrompt = {
    system: 'You are a helpful assistant.',
    developer: 'Follow these rules.',
    user: 'Hello world',
    assistant: 'Previous response',
    tool: 'Tool output'
  };
  
  const formattedPrompt = formatHarmonyForGPTOSS(harmonyPrompt);
  
  // Verify all roles are included
  assert(formattedPrompt.includes('[SYSTEM]'));
  assert(formattedPrompt.includes('[DEVELOPER]'));
  assert(formattedPrompt.includes('[USER]'));
  assert(formattedPrompt.includes('[ASSISTANT]'));
  assert(formattedPrompt.includes('[TOOL]'));
  assert(formattedPrompt.includes('Previous response'));
  assert(formattedPrompt.includes('Tool output'));
});
