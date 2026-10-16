import type { ProviderRequestOptions } from '@earendil-works/pi-ai';
import { encodeAudioBase64 } from '../convert.ts';
import { VoiceRequestError } from '../errors.ts';

const boundary = 'pi-audio-boundary';

const mimeFiles: Record<string, { format: string; filename: string }> = {
  'audio/wav': { format: 'wav', filename: 'audio.wav' },
  'audio/wave': { format: 'wav', filename: 'audio.wav' },
  'audio/x-wav': { format: 'wav', filename: 'audio.wav' },
  'audio/mpeg': { format: 'mp3', filename: 'audio.mp3' },
  'audio/mp3': { format: 'mp3', filename: 'audio.mp3' },
  'audio/flac': { format: 'flac', filename: 'audio.flac' },
  'audio/ogg': { format: 'ogg', filename: 'audio.ogg' },
  'audio/opus': { format: 'ogg', filename: 'audio.ogg' },
  'audio/webm': { format: 'webm', filename: 'audio.webm' },
  'audio/mp4': { format: 'm4a', filename: 'audio.m4a' },
  'audio/m4a': { format: 'm4a', filename: 'audio.m4a' },
  'audio/aac': { format: 'aac', filename: 'audio.aac' },
  'audio/pcm': { format: 'pcm', filename: 'audio.pcm' },
};

export interface AudioFile {
  data: Uint8Array;
  mimeType: string;
  filename: string;
  format: string;
}

export interface JsonBody {
  [key: string]: unknown;
}

interface HeaderModel {
  provider: string;
  headers?: Record<string, string>;
}

export function isOpenRouter(model: { provider: string; baseUrl: string }): boolean {
  return model.provider === 'openrouter' || model.baseUrl.includes('openrouter.ai');
}

export function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}/${path}`;
}

export function realtimeUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/realtime`;
  url.search = 'intent=transcription';
  return url.toString();
}

export function audioFile(mimeType: string): { format: string; filename: string } {
  const found = mimeFiles[mimeType.toLowerCase()];
  if (!found) throw new Error(`Unsupported audio type ${mimeType}`);
  return found;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

export function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' ? value : undefined;
}

export function asVoiceError(error: unknown): { reason: 'aborted' | 'error'; error: string } {
  if (error instanceof VoiceRequestError) return { reason: error.reason, error: error.message };
  if (error instanceof Error && error.name === 'AbortError')
    return { reason: 'aborted', error: 'aborted' };
  if (error instanceof Error) return { reason: 'error', error: error.message };
  return { reason: 'error', error: String(error) };
}

function headerValue(
  headers: Record<string, string | null> | undefined,
  name: string
): string | undefined {
  if (!headers) return undefined;
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === expected && value !== null && value.trim() !== '') return value;
  }
  return undefined;
}

export function hasAuth(headers: Record<string, string | null> | undefined): boolean {
  return (
    headerValue(headers, 'authorization') !== undefined ||
    headerValue(headers, 'cf-aig-authorization') !== undefined
  );
}

export function requestHeaders(
  model: HeaderModel,
  options: ProviderRequestOptions | undefined
): Record<string, string> {
  const headers: Record<string, string> = { ...model.headers };
  const extra = options?.headers;
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value === null) delete headers[key];
      else headers[key] = value;
    }
  }
  if (!hasAuth(headers)) {
    const apiKey = options?.apiKey;
    if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

export function requestSignal(
  options: ProviderRequestOptions | undefined
): AbortSignal | undefined {
  const signals: AbortSignal[] = [];
  if (options?.signal) signals.push(options.signal);
  const timeout = options?.timeoutMs;
  if (timeout !== undefined && timeout > 0) signals.push(AbortSignal.timeout(timeout));
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

export function encodeMultipart(file: AudioFile, fields: Record<string, string>): Uint8Array {
  const chunks: Uint8Array[] = [];
  const encoder = new TextEncoder();
  const write = (value: string) => chunks.push(encoder.encode(value));
  write(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.mimeType}\r\n\r\n`
  );
  chunks.push(file.data);
  write('\r\n');
  for (const [name, value] of Object.entries(fields)) {
    write(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  }
  write(`--${boundary}--\r\n`);
  const body = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}

export function multipartType(): string {
  return `multipart/form-data; boundary=${boundary}`;
}

export async function readAudio(
  input: { data: Uint8Array; mimeType: string } | { url: string },
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined
): Promise<{ data: Uint8Array; mimeType: string }> {
  if (!('url' in input)) return { data: input.data, mimeType: input.mimeType };
  const response = await fetchImpl(input.url, { signal });
  if (!response.ok) throw new Error(`Audio URL failed: HTTP ${response.status}`);
  const mime = response.headers.get('content-type');
  const mimeType = mime === null || mime.trim() === '' ? 'audio/wav' : mime.split(';')[0].trim();
  return { data: new Uint8Array(await response.arrayBuffer()), mimeType };
}

export function audioPayload(file: AudioFile, openRouter: boolean, modelId: string): JsonBody {
  if (openRouter) {
    return {
      model: modelId,
      input_audio: { data: encodeAudioBase64(file.data), format: file.format },
    };
  }
  return { model: modelId, file };
}

export async function applyPayload(
  payload: unknown,
  model: unknown,
  options: ProviderRequestOptions | undefined
): Promise<unknown> {
  const hook = options?.onPayload as
    | ((body: unknown, voiceModel: unknown) => unknown | undefined | Promise<unknown | undefined>)
    | undefined;
  const replaced = await hook?.(payload, model);
  return replaced === undefined ? payload : replaced;
}

function headerRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

export async function voiceFetch(
  model: HeaderModel & { id: string },
  options: ProviderRequestOptions | undefined,
  url: string,
  body: BodyInit,
  contentType: string
): Promise<Response> {
  const headers = requestHeaders(model, options);
  headers['Content-Type'] = contentType;
  const fetchImpl = options?.fetch ?? globalThis.fetch;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers,
    body,
    signal: requestSignal(options),
  });
  await options?.onResponse?.(
    { status: response.status, headers: headerRecord(response.headers) },
    model as never
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text === '' ? `HTTP ${response.status}` : text);
  }
  return response;
}

export async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Transcription response was not JSON');
  }
}
