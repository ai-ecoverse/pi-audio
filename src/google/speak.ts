import type { ProviderRequestOptions } from '@earendil-works/pi-ai';
import type { AudioFormat } from '../audio.ts';
import { chunkSeconds } from '../audio.ts';
import { decodeAudioBase64 } from '../convert.ts';
import type { SpeechModel } from '../models.ts';
import {
  applyPayload,
  asVoiceError,
  endpoint,
  isRecord,
  readJson,
  requestSignal,
  stringField,
} from '../openai/wire.ts';
import { SpeechEventStream, type SpeechInput } from '../speech.ts';
import { type AudioCounters, priceAudio } from '../usage.ts';
import { googleHeaders, sameFormat, speechMime } from './wire.ts';

function resolveFormat(
  model: SpeechModel<string>,
  requested: AudioFormat | undefined
): AudioFormat {
  const fallback = model.outputFormats[0];
  if (!fallback) throw new Error('No output format');
  if (!requested) return fallback;
  const match = model.outputFormats.find((format) => sameFormat(format, requested));
  if (!match) throw new Error(`Unsupported speech format ${requested.encoding}`);
  return match;
}

function speechBody(text: string, voice: string, format: AudioFormat): Record<string, unknown> {
  return {
    contents: [{ role: 'user', parts: [{ text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      responseFormat: { audio: { mimeType: speechMime(format) } },
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
      },
    },
  };
}

async function readText(
  text: string | AsyncIterable<string>,
  signal: AbortSignal | undefined
): Promise<string> {
  if (typeof text === 'string') return text;
  let combined = '';
  for await (const part of text) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    combined += part;
  }
  return combined;
}

function errorText(text: string, status: number): string {
  if (text === '') return `HTTP ${status}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  if (!isRecord(parsed) || Array.isArray(parsed)) return text;
  const direct = stringField(parsed, 'message');
  if (direct !== undefined) return direct;
  const error = parsed.error;
  if (typeof error === 'string') return error;
  if (isRecord(error) && !Array.isArray(error)) {
    const nested = stringField(error, 'message');
    if (nested !== undefined) return nested;
  }
  return text;
}

function inlineData(part: Record<string, unknown>): string | undefined {
  const camel = part.inlineData;
  const snake = part.inline_data;
  const inline = isRecord(camel) && !Array.isArray(camel) ? camel : snake;
  if (!isRecord(inline) || Array.isArray(inline)) return undefined;
  return stringField(inline, 'data');
}

function audioParts(body: Record<string, unknown>): string[] {
  const candidates = body.candidates;
  if (!Array.isArray(candidates)) return [];
  const first = candidates[0];
  if (!isRecord(first) || Array.isArray(first)) return [];
  const content = first.content;
  if (!isRecord(content) || Array.isArray(content)) return [];
  const parts = content.parts;
  if (!Array.isArray(parts)) return [];
  const chunks: string[] = [];
  for (const part of parts) {
    if (!isRecord(part) || Array.isArray(part)) continue;
    const data = inlineData(part);
    if (data === undefined || data === '') continue;
    chunks.push(data);
  }
  return chunks;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function googleFetch(
  model: SpeechModel<string>,
  options: ProviderRequestOptions | undefined,
  url: string,
  body: string
): Promise<Response> {
  const headers = googleHeaders(model, options);
  headers['Content-Type'] = 'application/json';
  const fetchImpl = options?.fetch ?? globalThis.fetch;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers,
    body,
    signal: requestSignal(options),
  });
  await options?.onResponse?.({ status: response.status, headers: {} }, model as never);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(errorText(text, response.status));
  }
  return response;
}

export function speakGoogle(
  model: SpeechModel<string>,
  input: SpeechInput,
  options?: ProviderRequestOptions
): SpeechEventStream {
  const stream = new SpeechEventStream();
  void pumpSpeech(model, input, options, stream);
  return stream;
}

async function pumpSpeech(
  model: SpeechModel<string>,
  input: SpeechInput,
  options: ProviderRequestOptions | undefined,
  stream: SpeechEventStream
) {
  try {
    if (options?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const format = resolveFormat(model, input.format);
    const text = await readText(input.text, options?.signal);
    await postSpeech(model, text, input.voice, format, options, stream);
  } catch (error) {
    const voice = asVoiceError(error);
    stream.push({ type: 'error', reason: voice.reason, error: voice.error });
  }
}

async function postSpeech(
  model: SpeechModel<string>,
  text: string,
  voice: string,
  format: AudioFormat,
  options: ProviderRequestOptions | undefined,
  stream: SpeechEventStream
) {
  const payload = speechBody(text, voice, format);
  const body = await applyPayload(payload, model, options);
  if (!isRecord(body) || Array.isArray(body)) throw new Error('Speech payload was not JSON');
  const response = await googleFetch(
    model,
    options,
    endpoint(model.baseUrl, `models/${encodeURIComponent(model.id)}:generateContent`),
    JSON.stringify(body)
  );
  const parsed = await readJson(response);
  if (!isRecord(parsed) || Array.isArray(parsed)) throw new Error('Speech response had no audio');
  const encoded = audioParts(parsed);
  if (encoded.length === 0) throw new Error('Speech response had no audio');
  const data = concat(encoded.map((item) => decodeAudioBase64(item)));
  const seconds = chunkSeconds({ data, format, timestamp: 0 });
  const meters: AudioCounters = { characters: text.length };
  if (seconds > 0) meters.outputSeconds = seconds;
  stream.push({ type: 'start', format });
  stream.push({
    type: 'audio',
    chunk: { data, format, timestamp: 0 },
    span: { itemId: model.id, start: 0, end: text.length },
  });
  stream.push({ type: 'done', usage: priceAudio(model.audioCost, meters) });
}
