import type { JsonObject } from '@earendil-works/pi-ai';
import { VoiceRequestError } from './errors.ts';
import type { CustomLlm } from './hosted-agent.ts';

function bearer(headers: CustomLlm['headers']): string | undefined {
  if (headers === undefined) return undefined;
  const value = headers.Authorization ?? headers.authorization;
  if (typeof value !== 'string' || value.length === 0) return undefined;
  if (value.startsWith('Bearer ')) return value.slice('Bearer '.length);
  return value;
}

export function elevenLabsCustomLlm(llm: CustomLlm): JsonObject {
  const custom: JsonObject = {
    url: llm.baseUrl,
    model_id: llm.id,
    api_type: llm.api === 'openai-responses' ? 'responses' : 'chat_completions',
  };
  const headers = llm.headers;
  if (headers !== undefined && Object.keys(headers).length > 0) custom.request_headers = headers;
  return { llm: 'custom-llm', custom_llm: custom };
}

export function fishCustomLlm(llm: CustomLlm): JsonObject {
  if (llm.api === 'openai-responses') {
    throw new VoiceRequestError('error', 'fish custom llm accepts openai-completions only');
  }
  const custom: JsonObject = { base_url: llm.baseUrl, model: llm.id };
  const key = bearer(llm.headers);
  if (key !== undefined) custom.api_key = key;
  return { custom };
}
