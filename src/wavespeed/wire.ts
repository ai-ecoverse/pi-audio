import type { ProviderRequestOptions } from '@earendil-works/pi-ai';
import {
  applyPayload,
  endpoint,
  isRecord,
  numberField,
  requestHeaders,
  requestSignal,
  stringField,
} from '../openai/wire.ts';

const terminal = new Set(['failed', 'cancelled', 'timeout', 'deleted']);

export function taskRecord(body: unknown): Record<string, unknown> {
  if (!isRecord(body) || Array.isArray(body)) throw new Error('WaveSpeed response was not JSON');
  const data = body.data;
  if (isRecord(data) && !Array.isArray(data)) return data;
  return body;
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
  const message = stringField(parsed, 'message');
  if (message !== undefined && message !== '') return message;
  return text;
}

export function isHttpUrl(value: string): boolean {
  if (value.startsWith('https://')) return true;
  if (value.startsWith('http://')) return true;
  return false;
}

export function outputText(output: unknown): string | undefined {
  if (typeof output === 'string') return output;
  if (!isRecord(output) || Array.isArray(output)) return undefined;
  return stringField(output, 'text') ?? stringField(output, 'transcript');
}

export function outputUrl(output: unknown): string | undefined {
  if (typeof output === 'string' && isHttpUrl(output)) return output;
  if (!isRecord(output) || Array.isArray(output)) return undefined;
  const url = stringField(output, 'url') ?? stringField(output, 'audio');
  if (url === undefined || !isHttpUrl(url)) return undefined;
  return url;
}

export function downloadUrl(body: unknown): string {
  const record = taskRecord(body);
  const url = stringField(record, 'download_url') ?? stringField(record, 'url');
  if (url === undefined || url === '') throw new Error('WaveSpeed upload had no url');
  return url;
}

export function durationSeconds(record: Record<string, unknown>): number {
  const direct = numberField(record, 'duration');
  if (direct !== undefined) return direct;
  return 0;
}

async function waveFetch(
  model: { provider: string; headers?: Record<string, string>; id: string },
  options: ProviderRequestOptions | undefined,
  url: string,
  body: BodyInit | undefined,
  contentType: string | undefined
): Promise<unknown> {
  const headers = requestHeaders(model, options);
  if (contentType !== undefined) headers['Content-Type'] = contentType;
  const fetchImpl = options?.fetch ?? globalThis.fetch;
  const response = await fetchImpl(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body,
    signal: requestSignal(options),
  });
  if (options?.onResponse !== undefined) {
    await options.onResponse({ status: response.status, headers: {} }, model as never);
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(errorText(text, response.status));
  }
  const text = await response.text();
  if (text === '') throw new Error('WaveSpeed response was not JSON');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('WaveSpeed response was not JSON');
  }
}

function failure(record: Record<string, unknown>, status: string): Error {
  const error = stringField(record, 'error');
  if (error === undefined || error === '') return new Error(`WaveSpeed ${status}`);
  return new Error(error);
}

export async function finishTask(
  model: { provider: string; baseUrl: string; headers?: Record<string, string>; id: string },
  options: ProviderRequestOptions | undefined,
  payload: unknown,
  rejected: string
): Promise<Record<string, unknown>> {
  const body = await applyPayload(payload, model, options);
  if (!isRecord(body) || Array.isArray(body)) throw new Error(rejected);
  let record = taskRecord(
    await waveFetch(
      model,
      options,
      endpoint(model.baseUrl, model.id),
      JSON.stringify(body),
      'application/json'
    )
  );
  for (let attempt = 0; attempt < 9; attempt += 1) {
    const status = stringField(record, 'status') ?? '';
    if (status === 'completed') return record;
    if (terminal.has(status)) throw failure(record, status);
    if (attempt === 8) break;
    const id = stringField(record, 'id');
    if (id === undefined || id === '') throw new Error('WaveSpeed prediction had no id');
    record = taskRecord(
      await waveFetch(
        model,
        options,
        endpoint(model.baseUrl, `predictions/${id}/result`),
        undefined,
        undefined
      )
    );
  }
  throw new Error('WaveSpeed prediction timed out');
}

export async function readHttp(
  model: { provider: string; headers?: Record<string, string>; id: string },
  options: ProviderRequestOptions | undefined,
  url: string
): Promise<Response> {
  const headers = requestHeaders(model, options);
  const fetchImpl = options?.fetch ?? globalThis.fetch;
  const response = await fetchImpl(url, { headers, signal: requestSignal(options) });
  if (!response.ok) throw new Error(errorText('', response.status));
  return response;
}

export { waveFetch };
