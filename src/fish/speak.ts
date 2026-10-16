import type { ProviderRequestOptions } from '@earendil-works/pi-ai';
import type { AudioFormat } from '../audio.ts';
import { chunkSeconds } from '../audio.ts';
import { VoiceRequestError } from '../errors.ts';
import type { SpeechModel } from '../models.ts';
import {
  applyPayload,
  asVoiceError,
  endpoint,
  isRecord,
  requestSignal,
  stringField,
} from '../openai/wire.ts';
import { type SpeechEvent, SpeechEventStream, type SpeechInput } from '../speech.ts';
import { type AudioCounters, priceAudio } from '../usage.ts';
import {
  awaitOpen,
  connectSocket,
  fishHeaders,
  messageBytes,
  type PackValue,
  pack,
  sameFormat,
  socketUrl,
  speechFormatName,
  unpack,
} from './wire.ts';

interface SpeechState {
  opened: boolean;
  started: boolean;
  done: boolean;
  failed: boolean;
  heard: boolean;
  outputSeconds: number;
  characters: number;
}

function languageCode(language: string | undefined): string | undefined {
  if (language === undefined) return undefined;
  if (language.trim() === '') return undefined;
  return language;
}

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

function speechBody(
  text: string,
  voice: string,
  language: string | undefined,
  format: AudioFormat
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    text,
    reference_id: voice,
    format: speechFormatName(format),
    sample_rate: format.sampleRate,
    latency: 'normal',
  };
  const code = languageCode(language);
  if (code !== undefined) body.language = code;
  return body;
}

function startFrame(voice: string, language: string | undefined, format: AudioFormat): PackValue {
  const request: { [key: string]: PackValue } = {
    text: '',
    format: speechFormatName(format),
    reference_id: voice,
    sample_rate: format.sampleRate,
    latency: 'balanced',
  };
  const code = languageCode(language);
  if (code !== undefined) request.language = code;
  return { event: 'start', request };
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
  const message = stringField(parsed, 'message');
  if (message === undefined) return text;
  return message;
}

async function fishFetch(
  model: SpeechModel<string>,
  options: ProviderRequestOptions | undefined,
  url: string,
  body: string
): Promise<Response> {
  const headers = fishHeaders(model, options);
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

function sendFrame(socket: WebSocket, value: PackValue): void {
  const packed = pack(value);
  const copy = new ArrayBuffer(packed.byteLength);
  new Uint8Array(copy).set(packed);
  socket.send(copy);
}

export function speakFish(
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
    if (model.textStreaming && typeof input.text !== 'string') {
      await streamSpeech(model, input.text, input.voice, input.language, format, options, stream);
      return;
    }
    const text = await readText(input.text, options?.signal);
    await postSpeech(model, text, input.voice, input.language, format, options, stream);
  } catch (error) {
    const voice = asVoiceError(error);
    stream.push({ type: 'error', reason: voice.reason, error: voice.error });
  }
}

async function postSpeech(
  model: SpeechModel<string>,
  text: string,
  voice: string,
  language: string | undefined,
  format: AudioFormat,
  options: ProviderRequestOptions | undefined,
  stream: SpeechEventStream
) {
  const payload = speechBody(text, voice, language, format);
  const body = await applyPayload(payload, model, options);
  if (!isRecord(body) || Array.isArray(body)) throw new Error('Speech payload was not JSON');
  const response = await fishFetch(
    model,
    options,
    endpoint(model.baseUrl, 'tts'),
    JSON.stringify(body)
  );
  const data = new Uint8Array(await response.arrayBuffer());
  if (data.byteLength === 0) throw new Error('Speech response had no audio');
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

async function streamSpeech(
  model: SpeechModel<string>,
  text: AsyncIterable<string>,
  voice: string,
  language: string | undefined,
  format: AudioFormat,
  options: ProviderRequestOptions | undefined,
  stream: SpeechEventStream
) {
  const state: SpeechState = {
    opened: false,
    started: false,
    done: false,
    failed: false,
    heard: false,
    outputSeconds: 0,
    characters: 0,
  };
  let settled = false;
  const push = (event: SpeechEvent) => {
    if (settled) return;
    if (event.type === 'done' || event.type === 'error') settled = true;
    stream.push(event);
  };
  const doneWait = Promise.withResolvers<void>();
  const wake = (kind: string | undefined) => {
    if (state.failed) doneWait.resolve();
    if (kind === 'finish' || kind === 'close') doneWait.resolve();
  };
  const url = socketUrl(model.baseUrl, 'tts/live');
  const socket = connectSocket(url.toString(), fishHeaders(model, options));
  let incoming = Promise.resolve();
  socket.addEventListener('message', (event) => {
    incoming = incoming.then(() => onMessage(event.data, model.id, format, state, push, wake));
  });
  socket.addEventListener('close', () => {
    if (state.opened && !state.done && !state.failed) {
      state.failed = true;
      push({ type: 'error', reason: 'error', error: 'Fish speech socket closed' });
    }
    wake('close');
  });
  try {
    await awaitOpen(socket, 'Fish speech', (message) => {
      state.failed = true;
      push({ type: 'error', reason: 'error', error: message });
      wake('close');
    });
    if (state.failed) return;
    state.opened = true;
    sendFrame(socket, startFrame(voice, language, format));
    state.characters = await writeText(socket, text, options?.signal);
    if (state.failed) return;
    sendFrame(socket, { event: 'flush' });
    sendFrame(socket, { event: 'stop' });
    if (!state.done) await doneWait.promise;
    if (state.failed) return;
    if (!state.heard) throw new Error('Speech response had no audio');
    const meters: AudioCounters = { characters: state.characters };
    if (state.outputSeconds > 0) meters.outputSeconds = state.outputSeconds;
    push({ type: 'done', usage: priceAudio(model.audioCost, meters) });
  } catch (error) {
    const voice = asVoiceError(error);
    state.failed = true;
    push({ type: 'error', reason: voice.reason, error: voice.error });
  } finally {
    socket.close();
  }
}

async function writeText(
  socket: WebSocket,
  text: AsyncIterable<string>,
  signal: AbortSignal | undefined
): Promise<number> {
  let combined = '';
  for await (const part of text) {
    if (signal?.aborted) throw new VoiceRequestError('aborted', 'aborted');
    combined += part;
    if (part === '') continue;
    sendFrame(socket, { event: 'text', text: part });
  }
  return combined.length;
}

async function onMessage(
  data: unknown,
  itemId: string,
  format: AudioFormat,
  state: SpeechState,
  push: (event: SpeechEvent) => void,
  wake: (kind: string | undefined) => void
) {
  try {
    const parsed = unpack(await messageBytes(data));
    if (!isRecord(parsed) || Array.isArray(parsed) || parsed instanceof Uint8Array) {
      throw new Error('Fish speech event was not a map');
    }
    const kind = stringField(parsed, 'event');
    applySpeech(parsed, kind, itemId, format, state, push);
    wake(kind);
  } catch (error) {
    const voice = asVoiceError(error);
    state.failed = true;
    push({ type: 'error', reason: voice.reason, error: voice.error });
    wake('close');
  }
}

function applySpeech(
  event: Record<string, unknown>,
  kind: string | undefined,
  itemId: string,
  format: AudioFormat,
  state: SpeechState,
  push: (event: SpeechEvent) => void
) {
  if (kind === 'error') {
    const message = stringField(event, 'message');
    state.failed = true;
    push({
      type: 'error',
      reason: 'error',
      error: message === undefined ? 'Fish speech failed' : message,
    });
    return;
  }
  if (kind === 'finish') {
    state.done = true;
    return;
  }
  if (kind !== 'audio') return;
  const audio = event.audio;
  if (!(audio instanceof Uint8Array) || audio.byteLength === 0) return;
  if (!state.started) {
    state.started = true;
    push({ type: 'start', format });
  }
  state.heard = true;
  state.outputSeconds += chunkSeconds({ data: audio, format, timestamp: 0 });
  push({
    type: 'audio',
    chunk: { data: audio, format, timestamp: 0 },
    span: { itemId, start: 0, end: state.characters },
  });
}
