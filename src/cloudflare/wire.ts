import type { ProviderRequestOptions } from '@earendil-works/pi-ai';
import type { AudioFormat } from '../audio.ts';
import { isRecord, requestHeaders, stringField } from '../openai/wire.ts';

const placeholder = '{account_id}';

const speechEncodings: Record<string, string> = {
  pcm16: 'linear16',
  mp3: 'mp3',
  flac: 'flac',
  mulaw: 'mulaw',
  alaw: 'alaw',
  opus: 'opus',
};

interface RouteModel {
  provider: string;
  baseUrl: string;
  headers?: Record<string, string>;
}

export interface CloudflareRoute {
  headers: Record<string, string>;
  account: string;
  gateway: string;
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === expected && value.trim() !== '') return value;
  }
  return undefined;
}

function takeHeader(headers: Record<string, string>, name: string): string | undefined {
  const expected = name.toLowerCase();
  let found: string | undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== expected) continue;
    if (found === undefined && value.trim() !== '') found = value.trim();
    delete headers[key];
  }
  return found;
}

function accountFromUrl(baseUrl: string): string | undefined {
  const match = /\/accounts\/([^/]+)\/ai\/run/.exec(baseUrl);
  const found = match?.[1];
  if (found === undefined || found === placeholder) return undefined;
  return found;
}

export function gatewayId(headers: Record<string, string>): string {
  const value = headerValue(headers, 'cf-aig-gateway-id');
  if (value === undefined) return 'default';
  return value.trim();
}

function stampGatewayAuth(headers: Record<string, string>): void {
  const gateway = headerValue(headers, 'cf-aig-authorization');
  const authorization = headerValue(headers, 'authorization');
  if (
    gateway === undefined &&
    authorization !== undefined &&
    authorization.toLowerCase().startsWith('bearer ')
  ) {
    headers['cf-aig-authorization'] = authorization.slice(authorization.indexOf(' ') + 1).trim();
    return;
  }
  if (gateway !== undefined && authorization === undefined)
    headers.Authorization = `Bearer ${gateway}`;
}

export function session(
  model: RouteModel,
  options: ProviderRequestOptions | undefined
): CloudflareRoute {
  const headers = requestHeaders(model, options);
  const fromHeader = takeHeader(headers, 'cf-account-id');
  const account = fromHeader ?? accountFromUrl(model.baseUrl);
  if (account === undefined) throw new Error('No Cloudflare account id');
  const gateway = gatewayId(headers);
  stampGatewayAuth(headers);
  return { headers, account, gateway };
}

export function runUrl(baseUrl: string, modelId: string, account: string): string {
  const base = baseUrl.replaceAll(placeholder, account).replace(/\/$/, '');
  return `${base}/${modelId}`;
}

export function workersAiSocket(
  account: string,
  gateway: string,
  modelId: string,
  query: string
): string {
  const extra = query === '' ? '' : `&${query}`;
  return `wss://gateway.ai.cloudflare.com/v1/${account}/${gateway}/workers-ai?model=${encodeURIComponent(modelId)}${extra}`;
}

export function auraEncoding(format: AudioFormat): string {
  const name = speechEncodings[format.encoding];
  if (!name) throw new Error(`Unsupported speech format ${format.encoding}`);
  return name;
}

export function listenQuery(modelId: string, format: AudioFormat): string {
  if (format.encoding !== 'pcm16' && format.encoding !== 'mulaw') {
    throw new Error(`Unsupported audio format ${format.encoding}`);
  }
  if (modelId.includes('/flux') && format.encoding !== 'pcm16') {
    throw new Error(`Unsupported audio format ${format.encoding}`);
  }
  const encoding = format.encoding === 'mulaw' ? 'mulaw' : 'linear16';
  const shared = `encoding=${encoding}&sample_rate=${format.sampleRate}`;
  if (modelId.includes('/flux')) return shared;
  return `${shared}&interim_results=true&vad_events=true`;
}

export function sameFormat(left: AudioFormat, right: AudioFormat): boolean {
  return (
    left.encoding === right.encoding &&
    left.sampleRate === right.sampleRate &&
    left.channels === right.channels
  );
}

export function connectSocket(url: string, headers: Record<string, string>): WebSocket {
  const Socket = WebSocket as unknown as new (
    address: string,
    init: { headers: Record<string, string> }
  ) => WebSocket;
  return new Socket(url, { headers });
}

export function awaitOpen(
  socket: WebSocket,
  label: string,
  fail: (message: string) => void
): Promise<void> {
  return new Promise((resolve) => {
    let opened = false;
    socket.addEventListener('open', () => {
      opened = true;
      resolve();
    });
    socket.addEventListener('error', () => {
      fail(`${label} socket failed`);
      if (!opened) resolve();
    });
    socket.addEventListener('close', () => {
      if (!opened) {
        fail(`${label} socket closed`);
        resolve();
      }
    });
  });
}

export function audioFrame(data: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy.buffer;
}

export async function messageBytes(data: unknown): Promise<Uint8Array | undefined> {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Uint8Array) return data;
  if (typeof Blob !== 'undefined' && data instanceof Blob)
    return new Uint8Array(await data.arrayBuffer());
  return undefined;
}

export function failureMessage(body: Record<string, unknown>, fallback: string): string {
  const errors = body.errors;
  if (!Array.isArray(errors)) return fallback;
  const first = errors[0];
  if (!isRecord(first) || Array.isArray(first)) return fallback;
  const message = stringField(first, 'message');
  if (message === undefined || message === '') return fallback;
  return message;
}

export function resultOf(body: unknown): unknown {
  if (!isRecord(body) || Array.isArray(body)) return body;
  if (body.success === false) throw new Error(failureMessage(body, 'Cloudflare request failed'));
  if (!Object.hasOwn(body, 'result')) return body;
  return body.result;
}

export function errorText(text: string, status: number): string {
  if (text === '') return `HTTP ${status}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  if (!isRecord(parsed) || Array.isArray(parsed)) return text;
  if (Array.isArray(parsed.errors)) return failureMessage(parsed, text);
  const message = stringField(parsed, 'message');
  if (message !== undefined) return message;
  return text;
}
