import type { JsonObject, ProviderRequestOptions, Tool } from '@earendil-works/pi-ai';
import { fishCustomLlm } from '../custom-llm.ts';
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
const toolName = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

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
  if (timeoutMs === undefined) return 30;
  return Math.min(120, Math.max(1, Math.round(timeoutMs / 1000)));
}

function argumentsOf(tool: Tool): JsonObject[] {
  const parameters = tool.parameters as unknown;
  if (!isRecord(parameters) || !isRecord(parameters.properties)) return [];
  const args: JsonObject[] = [];
  for (const [name, schema] of Object.entries(parameters.properties)) {
    const description =
      isRecord(schema) && typeof schema.description === 'string' ? schema.description : '';
    args.push({ name, description });
  }
  return args;
}

function clientTool(tool: Tool, timeoutMs: number | undefined): JsonObject {
  if (!toolName.test(tool.name)) {
    throw new VoiceRequestError('error', `invalid client tool name: ${tool.name}`);
  }
  return {
    tool_type: 'client',
    name: tool.name,
    description: tool.description,
    arguments: argumentsOf(tool),
    expects_response: true,
    timeout_seconds: timeoutSeconds(timeoutMs),
  };
}

function llmFields(llm: string | CustomLlm): JsonObject {
  if (typeof llm === 'string') return { model: llm };
  return fishCustomLlm(llm);
}

export function agentConfig(spec: HostedAgentSpec, toolIds: string[]): JsonObject {
  const prompt: JsonObject = { system_prompt: spec.instructions };
  if (spec.firstMessage !== undefined) prompt.first_message = spec.firstMessage;
  const config: JsonObject = {
    prompt,
    voice: { voice_id: spec.voice },
    llm: llmFields(spec.llm),
  };
  if (toolIds.length > 0) config.tools = { enabled: true, tool_ids: toolIds };
  return config;
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
  if (response.status === 204) return {};
  let json: unknown;
  try {
    json = await response.json();
  } catch (error) {
    throw asVoice(error);
  }
  if (!isRecord(json)) throw new VoiceRequestError('error', 'agent response was not an object');
  return json;
}

function textId(
  json: Record<string, unknown>,
  field: string,
  fallback: string | undefined
): string {
  const id = json[field];
  if (typeof id === 'string' && id.length > 0) return id;
  if (fallback !== undefined) return fallback;
  throw new VoiceRequestError('error', `agent response had no ${field}`);
}

async function createTools(
  origin: string,
  spec: HostedAgentSpec,
  options: ProvisionOptions,
  fetchImpl: typeof fetch
): Promise<string[]> {
  const ids: string[] = [];
  for (const tool of spec.tools) {
    const json = await requestJson(fetchImpl, `${origin}/v1/agent/tools`, {
      method: 'POST',
      headers: mergedHeaders(options, {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey(options)}`,
      }),
      body: JSON.stringify(clientTool(tool, spec.clientToolTimeoutMs)),
      signal: options.signal,
    });
    ids.push(textId(json, 'tool_id', undefined));
  }
  return ids;
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
  const origin = httpsOrigin(model.baseUrl);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const toolIds = await createTools(origin, spec, options, fetchImpl);
  const config = agentConfig(spec, toolIds);
  const existing = cached?.agentId ?? options.agentId;
  const headers = mergedHeaders(options, {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey(options)}`,
  });
  const url =
    existing === undefined
      ? `${origin}/v1/agent/agents`
      : `${origin}/v1/agent/agents/${encodeURIComponent(existing)}/config`;
  const json = await requestJson(fetchImpl, url, {
    method: existing === undefined ? 'POST' : 'PATCH',
    headers,
    body: JSON.stringify(existing === undefined ? { name: spec.name, config } : config),
    signal: options.signal,
  });
  const agentId = textId(json, 'agent_id', existing);
  await requestJson(fetchImpl, `${origin}/v1/agent/agents/${encodeURIComponent(agentId)}/publish`, {
    method: 'POST',
    headers: mergedHeaders(options, { Authorization: `Bearer ${apiKey(options)}` }),
    signal: options.signal,
  });
  const agent: HostedAgent = { agentId, specHash: hash, publishedAt: now() };
  cache.set(key, agent);
  return agent;
}
