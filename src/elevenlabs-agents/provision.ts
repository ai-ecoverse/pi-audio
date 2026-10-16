import type { JsonObject, ProviderRequestOptions, Tool } from '@earendil-works/pi-ai';
import { VoiceRequestError } from '../errors.ts';
import {
  type CustomLlm,
  type HostedAgent,
  type HostedAgentSpec,
  type HostedCache,
  hashHostedSpec,
  hostedCacheKey,
  memoryHostedCache,
} from '../hosted-agent.ts';
import type { RealtimeModel } from '../models.ts';

export interface ProvisionOptions extends ProviderRequestOptions {
  agentId?: string;
  now?: () => number;
  cache?: HostedCache;
}

const defaultCache = memoryHostedCache();

const clientEvents = [
  'conversation_initiation_metadata',
  'ping',
  'audio',
  'interruption',
  'user_transcript',
  'agent_response',
  'agent_response_correction',
  'client_tool_call',
  'vad_score',
  'agent_chat_response_part',
  'agent_response_complete',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asVoice(error: unknown): VoiceRequestError {
  if (error instanceof VoiceRequestError) return error;
  if (error instanceof Error && error.name === 'AbortError') {
    return new VoiceRequestError('aborted', 'session aborted');
  }
  if (error instanceof Error) return new VoiceRequestError('error', error.message);
  return new VoiceRequestError('error', String(error));
}

export function httpsOrigin(baseUrl: string): string {
  const url = new URL(baseUrl);
  let protocol = url.protocol;
  if (protocol === 'wss:') protocol = 'https:';
  if (protocol === 'ws:') protocol = 'http:';
  return `${protocol}//${url.host}`;
}

function mergedHeaders(
  options: ProvisionOptions,
  defaults: Record<string, string>
): Record<string, string> {
  const headers = { ...defaults };
  const extra = options.headers;
  if (extra === undefined) return headers;
  for (const [key, value] of Object.entries(extra)) {
    if (value === null) delete headers[key];
    else headers[key] = value;
  }
  return headers;
}

function apiKey(options: ProvisionOptions): string {
  const key = options.apiKey;
  if (typeof key === 'string' && key.length > 0) return key;
  throw new VoiceRequestError('error', 'missing realtime credential');
}

function timeoutSeconds(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return 20;
  return Math.min(120, Math.max(1, Math.round(timeoutMs / 1000)));
}

function clientTool(tool: Tool, timeoutMs: number | undefined): JsonObject {
  return {
    type: 'client',
    name: tool.name,
    description: tool.description,
    expects_response: true,
    response_timeout_secs: timeoutSeconds(timeoutMs),
    parameters: tool.parameters as unknown as JsonObject,
  };
}

function customLlmFields(llm: CustomLlm): JsonObject {
  const custom: JsonObject = {
    url: llm.baseUrl,
    model_id: llm.id,
    api_type: llm.api === 'openai-responses' ? 'responses' : 'chat_completions',
  };
  const headers = llm.headers;
  if (headers !== undefined && Object.keys(headers).length > 0) custom.request_headers = headers;
  return { llm: 'custom-llm', custom_llm: custom };
}

function promptFields(spec: HostedAgentSpec): JsonObject {
  const llm = typeof spec.llm === 'string' ? { llm: spec.llm } : customLlmFields(spec.llm);
  return {
    prompt: spec.instructions,
    tools: spec.tools.map((tool) => clientTool(tool, spec.clientToolTimeoutMs)),
    ...llm,
  };
}

export function agentBody(spec: HostedAgentSpec): JsonObject {
  const agent: JsonObject = { prompt: promptFields(spec) };
  if (spec.firstMessage !== undefined) agent.first_message = spec.firstMessage;
  return {
    name: spec.name,
    conversation_config: {
      agent,
      tts: { voice_id: spec.voice },
      conversation: { client_events: clientEvents },
    },
    platform_settings: {
      overrides: {
        conversation_config_override: {
          agent: { prompt: { prompt: true }, first_message: true },
          tts: { voice_id: true },
        },
        custom_llm_extra_body: true,
      },
    },
  };
}

async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    throw asVoice(error);
  }
  if (!response.ok) {
    throw new VoiceRequestError('error', `agent request failed (${response.status})`);
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch (error) {
    throw asVoice(error);
  }
  if (!isRecord(json)) throw new VoiceRequestError('error', 'agent response was not an object');
  return json;
}

function agentIdFrom(json: Record<string, unknown>, fallback: string | undefined): string {
  const id = json.agent_id;
  if (typeof id === 'string' && id.length > 0) return id;
  if (fallback !== undefined) return fallback;
  throw new VoiceRequestError('error', 'agent response had no agent_id');
}

export async function provisionAgent(
  model: RealtimeModel<string>,
  spec: HostedAgentSpec,
  options: ProvisionOptions = {}
): Promise<HostedAgent> {
  if (options.signal?.aborted === true) throw new VoiceRequestError('aborted', 'session aborted');
  const cache = options.cache ?? defaultCache;
  const now = options.now ?? Date.now;
  const key = hostedCacheKey(model.provider, spec.name);
  const hash = hashHostedSpec(spec);
  const cached = cache.get(key);
  if (cached !== undefined && cached.specHash === hash) return cached;
  const existing = cached?.agentId ?? options.agentId;
  const origin = httpsOrigin(model.baseUrl);
  const url =
    existing === undefined
      ? `${origin}/v1/convai/agents/create`
      : `${origin}/v1/convai/agents/${encodeURIComponent(existing)}`;
  const headers = mergedHeaders(options, {
    'Content-Type': 'application/json',
    'xi-api-key': apiKey(options),
  });
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const json = await requestJson(fetchImpl, url, {
    method: existing === undefined ? 'POST' : 'PATCH',
    headers,
    body: JSON.stringify(agentBody(spec)),
    signal: options.signal,
  });
  const agent: HostedAgent = {
    agentId: agentIdFrom(json, existing),
    specHash: hash,
    publishedAt: now(),
  };
  cache.set(key, agent);
  return agent;
}
