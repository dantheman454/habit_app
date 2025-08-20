import { test } from 'node:test';
import assert from 'node:assert';
import { 
  createHarmonyPrompt, 
  parseHarmonyResponse, 
  formatHarmonyForGPTOSS,
  getFinalResponse,
  getAnalysis,
  getCommentary
} from '../../apps/server/llm/harmony_utils.js';

test('createHarmonyPrompt - basic structure', () => {
  const prompt = createHarmonyPrompt({
    system: 'You are a helpful assistant.',
    developer: 'Follow these rules.',
    user: 'Hello world'
  });
  
  assert.deepStrictEqual(prompt, {
    system: 'You are a helpful assistant.',
    developer: 'Follow these rules.',
    user: 'Hello world'
  });
});

test('createHarmonyPrompt - with optional roles', () => {
  const prompt = createHarmonyPrompt({
    system: 'You are a helpful assistant.',
    developer: 'Follow these rules.',
    user: 'Hello world',
    assistant: 'Previous response',
    tool: 'Tool output'
  });
  
  assert.deepStrictEqual(prompt, {
    system: 'You are a helpful assistant.',
    developer: 'Follow these rules.',
    user: 'Hello world',
    assistant: 'Previous response',
    tool: 'Tool output'
  });
});

test('parseHarmonyResponse - string response', () => {
  const result = parseHarmonyResponse('Hello world');
  
  assert.deepStrictEqual(result, {
    analysis: '',
    final: 'Hello world',
    commentary: ''
  });
});

test('parseHarmonyResponse - JSON response with channels', () => {
  const jsonResponse = JSON.stringify({
    analysis: 'I need to think about this',
    final: 'The answer is 42',
    commentary: 'Using calculator tool'
  });
  
  const result = parseHarmonyResponse(jsonResponse);
  
  assert.deepStrictEqual(result, {
    analysis: 'I need to think about this',
    final: 'The answer is 42',
    commentary: 'Using calculator tool'
  });
});

test('parseHarmonyResponse - object response', () => {
  const objResponse = {
    analysis: 'Thinking...',
    final: 'Done!',
    commentary: 'Tool used'
  };
  
  const result = parseHarmonyResponse(objResponse);
  
  assert.deepStrictEqual(result, {
    analysis: 'Thinking...',
    final: 'Done!',
    commentary: 'Tool used'
  });
});

test('formatHarmonyForGPTOSS - basic format', () => {
  const harmonyPrompt = {
    system: 'You are a helpful assistant.',
    developer: 'Follow these rules.',
    user: 'Hello world'
  };
  
  const result = formatHarmonyForGPTOSS(harmonyPrompt);
  
  const expected = `[SYSTEM]
You are a helpful assistant.

[DEVELOPER]
Follow these rules.

[USER]
Hello world

[ASSISTANT]
`;
  
  assert.strictEqual(result, expected);
});

test('formatHarmonyForGPTOSS - with all roles', () => {
  const harmonyPrompt = {
    system: 'You are a helpful assistant.',
    developer: 'Follow these rules.',
    user: 'Hello world',
    assistant: 'Previous response',
    tool: 'Tool output'
  };
  
  const result = formatHarmonyForGPTOSS(harmonyPrompt);
  
  const expected = `[SYSTEM]
You are a helpful assistant.

[DEVELOPER]
Follow these rules.

[USER]
Hello world

[ASSISTANT]
Previous response

[TOOL]
Tool output

[ASSISTANT]
`;
  
  assert.strictEqual(result, expected);
});

test('getFinalResponse - extracts final channel', () => {
  const parsedResponse = {
    analysis: 'Thinking...',
    final: 'The answer is 42',
    commentary: 'Tool used'
  };
  
  const result = getFinalResponse(parsedResponse);
  assert.strictEqual(result, 'The answer is 42');
});

test('getAnalysis - extracts analysis channel', () => {
  const parsedResponse = {
    analysis: 'I need to think about this step by step',
    final: 'The answer is 42',
    commentary: 'Tool used'
  };
  
  const result = getAnalysis(parsedResponse);
  assert.strictEqual(result, 'I need to think about this step by step');
});

test('getCommentary - extracts commentary channel', () => {
  const parsedResponse = {
    analysis: 'Thinking...',
    final: 'The answer is 42',
    commentary: 'Using calculator tool for computation'
  };
  
  const result = getCommentary(parsedResponse);
  assert.strictEqual(result, 'Using calculator tool for computation');
});
