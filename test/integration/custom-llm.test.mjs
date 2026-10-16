import assert from 'node:assert/strict';
import { test } from 'node:test';
import { elevenLabsCustomLlm } from '@ai-ecoverse/pi-audio/elevenlabs-agents';
import { fishCustomLlm } from '@ai-ecoverse/pi-audio/fish-agents';

const completions = {
  id: 'brain',
  api: 'openai-completions',
  baseUrl: 'https://llm.example/v1',
  headers: { Authorization: 'Bearer secret' },
};

test('cascade subpaths export the custom llm mappers', () => {
  assert.match(
    import.meta.resolve('@ai-ecoverse/pi-audio/elevenlabs-agents'),
    /elevenlabs-agents\/index\.js$/
  );
  const eleven = elevenLabsCustomLlm(completions);
  assert.equal(eleven.custom_llm.api_type, 'chat_completions');
  assert.equal(eleven.custom_llm.request_headers.Authorization, 'Bearer secret');
  const fish = fishCustomLlm(completions);
  assert.deepEqual(fish.custom, {
    base_url: 'https://llm.example/v1',
    model: 'brain',
    api_key: 'secret',
  });
});
