import type { ProviderRequestOptions, Tool } from '@earendil-works/pi-ai';
import { VoiceRequestError } from './errors.ts';
import type { RealtimeModel } from './models.ts';
import type { RealtimeToken } from './realtime.ts';

export interface RealtimeConstraints {
  instructions?: string;
  tools?: Tool[];
  voice?: string;
  uses?: number;
  agentId?: string;
}

const openaiSecrets = 'https://api.openai.com/v1/realtime/client_secrets';
const xaiSecrets = 'https://api.x.ai/v1/realtime/client_secrets';
const geminiTokens = 'https://generativelanguage.googleapis.com/v1beta/auth_tokens';
const elevenSigned = 'https://api.elevenlabs.io/v1/convai/conversation/get-signed-url';
const elevenWebRtc = 'https://api.elevenlabs.io/v1/convai/conversation/token';
const fishSessions = 'https://api.fish.audio/v1/agent/sessions';
const fifteenMinutes = 15 * 60 * 1000;
const thirtyMinutes = 30 * 60 * 1000;
const oneMinute = 60 * 1000;
const xaiLifetimeSeconds = 300;

type Json = Record<string, unknown>;

interface MintCall {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  field: string;
  expires: (json: Json, fallback: number) => number;
  fallbackExpires: number;
}

function apiKey(options: ProviderRequestOptions): string {
  const key = options.apiKey;
  if (typeof key === 'string' && key.length > 0) return key;
  throw new VoiceRequestError('error', 'missing realtime credential');
}

function mergedHeaders(
  options: ProviderRequestOptions,
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

function omitUndefined(source: Json): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function functionTool(tool: Tool): Json {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as unknown,
  };
}

function declaration(tool: Tool): Json {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as unknown,
  };
}

function requiredAgent(constraints: RealtimeConstraints): string {
  const id = constraints.agentId;
  if (typeof id === 'string' && id.length > 0) return id;
  throw new VoiceRequestError('error', 'missing agent id');
}

function expiresAt(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function fromField(field: string): (json: Json, fallback: number) => number {
  return (json, fallback) => expiresAt(json[field], fallback);
}

function openaiBody(model: RealtimeModel<string>, constraints: RealtimeConstraints): Json {
  const session = omitUndefined({
    type: 'realtime',
    model: model.id,
    instructions: constraints.instructions,
    tools: constraints.tools?.map(functionTool),
  });
  if (constraints.voice !== undefined) session.audio = { output: { voice: constraints.voice } };
  return { session };
}

function geminiBody(
  model: RealtimeModel<string>,
  constraints: RealtimeConstraints,
  now: number
): Json {
  const instructions = constraints.instructions;
  const voice = constraints.voice;
  const tools = constraints.tools;
  const config = omitUndefined({
    responseModalities: ['AUDIO'],
    sessionResumption: {},
    systemInstruction: instructions === undefined ? undefined : { parts: [{ text: instructions }] },
    speechConfig:
      voice === undefined
        ? undefined
        : { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    tools: tools === undefined ? undefined : [{ functionDeclarations: tools.map(declaration) }],
  });
  return {
    uses: constraints.uses ?? 1,
    expireTime: new Date(now + thirtyMinutes).toISOString(),
    newSessionExpireTime: new Date(now + oneMinute).toISOString(),
    liveConnectConstraints: { model: `models/${model.id}`, config },
  };
}

function fishBody(constraints: RealtimeConstraints): Json {
  const overrides = omitUndefined({
    system_prompt: constraints.instructions,
    voice_id: constraints.voice,
  });
  return omitUndefined({
    agent_id: requiredAgent(constraints),
    overrides: Object.keys(overrides).length > 0 ? overrides : undefined,
  });
}

function webrtcOnly(model: RealtimeModel<string>): boolean {
  return model.transports.length === 1 && model.transports[0] === 'webrtc';
}

function elevenUrl(model: RealtimeModel<string>, constraints: RealtimeConstraints): string {
  const url = new URL(webrtcOnly(model) ? elevenWebRtc : elevenSigned);
  url.searchParams.set('agent_id', requiredAgent(constraints));
  return url.toString();
}

function mintCall(
  model: RealtimeModel<string>,
  constraints: RealtimeConstraints,
  options: ProviderRequestOptions,
  key: string,
  now: number
): MintCall {
  const jsonHeaders = { 'Content-Type': 'application/json' };
  switch (model.api) {
    case 'openai-realtime':
      return {
        url: openaiSecrets,
        method: 'POST',
        headers: mergedHeaders(options, { ...jsonHeaders, Authorization: `Bearer ${key}` }),
        body: JSON.stringify(openaiBody(model, constraints)),
        field: 'value',
        expires: fromField('expires_at'),
        fallbackExpires: now,
      };
    case 'xai-realtime':
      return {
        url: xaiSecrets,
        method: 'POST',
        headers: mergedHeaders(options, { ...jsonHeaders, Authorization: `Bearer ${key}` }),
        body: JSON.stringify({ expires_after: { seconds: xaiLifetimeSeconds } }),
        field: 'value',
        expires: fromField('expires_at'),
        fallbackExpires: now + xaiLifetimeSeconds * 1000,
      };
    case 'gemini-live':
      return {
        url: geminiTokens,
        method: 'POST',
        headers: mergedHeaders(options, { ...jsonHeaders, 'x-goog-api-key': key }),
        body: JSON.stringify(geminiBody(model, constraints, now)),
        field: 'name',
        expires: fromField('expireTime'),
        fallbackExpires: now + thirtyMinutes,
      };
    case 'elevenlabs-agents':
      return {
        url: elevenUrl(model, constraints),
        method: 'GET',
        headers: mergedHeaders(options, { 'xi-api-key': key }),
        field: webrtcOnly(model) ? 'token' : 'signed_url',
        expires: fromField('expires_at'),
        fallbackExpires: now + fifteenMinutes,
      };
    case 'fish-agents':
      return {
        url: fishSessions,
        method: 'POST',
        headers: mergedHeaders(options, { ...jsonHeaders, Authorization: `Bearer ${key}` }),
        body: JSON.stringify(fishBody(constraints)),
        field: 'token',
        expires: fromField('expires_at'),
        fallbackExpires: now,
      };
    default:
      throw new VoiceRequestError('error', 'unsupported realtime api');
  }
}

function readValue(json: unknown, field: string): string {
  if (typeof json !== 'object' || json === null) {
    throw new VoiceRequestError('error', 'mint failed (empty token)');
  }
  const value = (json as Json)[field];
  if (typeof value === 'string' && value.length > 0) return value;
  throw new VoiceRequestError('error', 'mint failed (empty token)');
}

export async function mintRealtimeToken(
  model: RealtimeModel<string>,
  constraints: RealtimeConstraints,
  options?: ProviderRequestOptions
): Promise<RealtimeToken> {
  const settings = options ?? {};
  const key = apiKey(settings);
  const now = Date.now();
  const call = mintCall(model, constraints, settings, key, now);
  const fetch = settings.fetch ?? globalThis.fetch;
  const response = await fetch(call.url, {
    method: call.method,
    headers: call.headers,
    body: call.body,
    signal: settings.signal,
  });
  if (!response.ok) throw new VoiceRequestError('error', `mint failed (${response.status})`);
  const json: unknown = await response.json();
  return {
    value: readValue(json, call.field),
    expiresAt: call.expires(json as Json, call.fallbackExpires),
    model: model.id,
  };
}
