import type { ProviderRequestOptions } from '@earendil-works/pi-ai';
import type { AudioFormat } from '../audio.ts';
import { chunkSeconds } from '../audio.ts';
import { decodeAudioBase64 } from '../convert.ts';
import type { SpeechModel } from '../models.ts';
import {
  applyPayload,
  asVoiceError,
  isRecord,
  requestSignal,
  stringField,
} from '../openai/wire.ts';
import { SpeechEventStream, type SpeechInput } from '../speech.ts';
import { type AudioCounters, priceAudio } from '../usage.ts';
import {
  auraEncoding,
  awaitOpen,
  connectSocket,
  errorText,
  messageBytes,
  resultOf,
  runUrl,
  sameFormat,
  session,
  workersAiSocket,
} from './wire.ts';

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

function liveSpeech(modelId: string, text: SpeechInput['text'], format: AudioFormat): boolean {
  if (modelId.includes('melotts')) return false;
  if (typeof text !== 'string') return true;
  return format.encoding !== 'mp3';
}

function speechBody(
  modelId: string,
  text: string,
  voice: string,
  format: AudioFormat,
  language: string | undefined
): Record<string, unknown> {
  if (modelId.includes('melotts')) {
    const body: Record<string, unknown> = { prompt: text, lang: 'en' };
    if (language !== undefined) body.lang = language;
    return body;
  }
  return {
    text,
    speaker: voice,
    encoding: auraEncoding(format),
    container: 'none',
    sample_rate: format.sampleRate,
  };
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

async function readSpeechBytes(response: Response): Promise<Uint8Array> {
  const type = response.headers.get('content-type') ?? '';
  if (type.includes('audio') || type.includes('octet-stream')) {
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength === 0) throw new Error('Speech response had no audio');
    return data;
  }
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text === '' ? undefined : JSON.parse(text);
  } catch {
    throw new Error('Speech response had no audio');
  }
  const result = resultOf(parsed);
  if (typeof result === 'string' && result !== '') return decodeAudioBase64(result);
  if (isRecord(result) && !Array.isArray(result)) {
    const audio = stringField(result, 'audio') ?? stringField(result, 'data');
    if (audio !== undefined && audio !== '') return decodeAudioBase64(audio);
  }
  throw new Error('Speech response had no audio');
}

async function postSpeech(
  model: SpeechModel<string>,
  body: unknown,
  options: ProviderRequestOptions | undefined
): Promise<Response> {
  const route = session(model, options);
  const headers = route.headers;
  headers['Content-Type'] = 'application/json';
  const fetchImpl = options?.fetch ?? globalThis.fetch;
  const response = await fetchImpl(runUrl(model.baseUrl, model.id, route.account), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: requestSignal(options),
  });
  if (options?.onResponse !== undefined) {
    await options.onResponse({ status: response.status, headers: {} }, model as never);
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(errorText(text, response.status));
  }
  return response;
}

function emitSpeech(
  stream: SpeechEventStream,
  model: SpeechModel<string>,
  text: string,
  format: AudioFormat,
  data: Uint8Array
) {
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

async function onSpeechMessage(
  data: unknown,
  audio: Uint8Array[],
  fail: (message: string) => void
) {
  const bytes = await messageBytes(data);
  if (bytes !== undefined) {
    if (bytes.byteLength > 0) audio.push(bytes);
    return;
  }
  if (typeof data !== 'string') throw new Error('Unsupported socket message');
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return;
  }
  if (!isRecord(parsed) || Array.isArray(parsed)) return;
  const kind = stringField(parsed, 'type');
  if (kind === 'Warning') {
    const description = stringField(parsed, 'description');
    if (description !== undefined) fail(description);
  }
}

async function sendLines(
  socket: WebSocket,
  text: SpeechInput['text'],
  signal: AbortSignal | undefined
): Promise<string> {
  if (typeof text === 'string') {
    socket.send(JSON.stringify({ type: 'Speak', text }));
    socket.send(JSON.stringify({ type: 'Flush' }));
    return text;
  }
  let combined = '';
  for await (const part of text) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    combined += part;
    socket.send(JSON.stringify({ type: 'Speak', text: part }));
    socket.send(JSON.stringify({ type: 'Flush' }));
  }
  return combined;
}

async function speakLive(
  model: SpeechModel<string>,
  input: SpeechInput,
  format: AudioFormat,
  options: ProviderRequestOptions | undefined,
  stream: SpeechEventStream
) {
  const route = session(model, options);
  const socket = connectSocket(
    workersAiSocket(route.account, route.gateway, model.id, ''),
    route.headers
  );
  const audio: Uint8Array[] = [];
  let failed: string | undefined;
  let chain = Promise.resolve();
  const closed = new Promise<void>((resolve) => {
    socket.addEventListener('close', () => resolve());
  });
  socket.addEventListener('message', (event) => {
    chain = chain
      .then(() =>
        onSpeechMessage(event.data, audio, (message) => {
          failed = message;
        })
      )
      .catch((error: unknown) => {
        failed = asVoiceError(error).error;
      });
  });
  await awaitOpen(socket, 'Cloudflare', (message) => {
    failed = message;
  });
  if (failed !== undefined) throw new Error(failed);
  const text = await sendLines(socket, input.text, options?.signal);
  socket.send(JSON.stringify({ type: 'Close' }));
  socket.close();
  await closed;
  await chain;
  if (failed !== undefined) throw new Error(failed);
  const data = concat(audio);
  if (data.byteLength === 0) throw new Error('Speech response had no audio');
  emitSpeech(stream, model, text, format, data);
}

async function speakRest(
  model: SpeechModel<string>,
  input: SpeechInput,
  format: AudioFormat,
  options: ProviderRequestOptions | undefined,
  stream: SpeechEventStream
) {
  const text = await readText(input.text, options?.signal);
  const payload = speechBody(model.id, text, input.voice, format, input.language);
  const body = await applyPayload(payload, model, options);
  if (!isRecord(body) || Array.isArray(body)) throw new Error('Speech payload was not JSON');
  const response = await postSpeech(model, body, options);
  emitSpeech(stream, model, text, format, await readSpeechBytes(response));
}

export function speakCloudflare(
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
    if (liveSpeech(model.id, input.text, format)) {
      await speakLive(model, input, format, options, stream);
      return;
    }
    await speakRest(model, input, format, options, stream);
  } catch (error) {
    const voice = asVoiceError(error);
    stream.push({ type: 'error', reason: voice.reason, error: voice.error });
  }
}
