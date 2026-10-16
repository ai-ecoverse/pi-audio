import type { ProviderRequestOptions } from '@earendil-works/pi-ai';
import type { AudioFormat } from '../audio.ts';
import { chunkSeconds } from '../audio.ts';
import { decodeAudioBase64 } from '../convert.ts';
import { VoiceRequestError } from '../errors.ts';
import type { SpeechModel } from '../models.ts';
import {
  applyPayload,
  asVoiceError,
  endpoint,
  isRecord,
  requestHeaders,
  stringField,
  voiceFetch,
} from '../openai/wire.ts';
import { type SpeechEvent, SpeechEventStream, type SpeechInput } from '../speech.ts';
import { type AudioCounters, priceAudio } from '../usage.ts';
import { awaitOpen, codecName, connectSocket, messageText, sameFormat, socketUrl } from './wire.ts';

interface SpeechState {
  opened: boolean;
  started: boolean;
  done: boolean;
  failed: boolean;
  outputSeconds: number;
  characters: number;
}

function languageOf(language: string | undefined): string {
  if (language === undefined || language.trim() === '') return 'auto';
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

function outputFormat(format: AudioFormat): Record<string, number | string> {
  const body: Record<string, number | string> = {
    codec: codecName(format.encoding),
    sample_rate: format.sampleRate,
  };
  if (format.encoding === 'mp3') body.bit_rate = 128000;
  return body;
}

function ttsUrl(baseUrl: string, voice: string, language: string, format: AudioFormat): string {
  const url = socketUrl(baseUrl, 'tts');
  const params = new URLSearchParams();
  params.set('language', language);
  params.set('voice', voice);
  params.set('codec', codecName(format.encoding));
  params.set('sample_rate', String(format.sampleRate));
  if (format.encoding === 'mp3') params.set('bit_rate', '128000');
  url.search = params.toString();
  return url.toString();
}

export function speakXAI(
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
    const language = languageOf(input.language);
    if (typeof input.text === 'string') {
      await postSpeech(model, input.text, input.voice, language, format, options, stream);
      return;
    }
    await streamSpeech(model, input.text, input.voice, language, format, options, stream);
  } catch (error) {
    const voice = asVoiceError(error);
    stream.push({ type: 'error', reason: voice.reason, error: voice.error });
  }
}

async function postSpeech(
  model: SpeechModel<string>,
  text: string,
  voice: string,
  language: string,
  format: AudioFormat,
  options: ProviderRequestOptions | undefined,
  stream: SpeechEventStream
) {
  const payload = {
    text,
    voice_id: voice,
    language,
    output_format: outputFormat(format),
  };
  const body = await applyPayload(payload, model, options);
  if (!isRecord(body)) throw new Error('Speech payload was not JSON');
  const response = await voiceFetch(
    model,
    options,
    endpoint(model.baseUrl, 'tts'),
    JSON.stringify(body),
    'application/json'
  );
  const data = new Uint8Array(await response.arrayBuffer());
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
  language: string,
  format: AudioFormat,
  options: ProviderRequestOptions | undefined,
  stream: SpeechEventStream
) {
  const state: SpeechState = {
    opened: false,
    started: false,
    done: false,
    failed: false,
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
  const wake = () => {
    doneWait.resolve();
  };
  const headers = requestHeaders(model, options);
  const socket = connectSocket(ttsUrl(model.baseUrl, voice, language, format), headers);
  let incoming = Promise.resolve();
  socket.addEventListener('message', (event) => {
    incoming = incoming.then(() => onMessage(event.data, model.id, format, state, push, wake));
  });
  socket.addEventListener('close', () => {
    if (state.opened && !state.done && !state.failed) {
      state.failed = true;
      push({ type: 'error', reason: 'error', error: 'xAI speech socket closed' });
    }
    wake();
  });
  try {
    await awaitOpen(socket, 'xAI speech', (message) => {
      state.failed = true;
      push({ type: 'error', reason: 'error', error: message });
      wake();
    });
    if (state.failed) return;
    state.opened = true;
    state.characters = await writeText(socket, text, options?.signal);
    if (state.failed) return;
    socket.send(JSON.stringify({ type: 'text.done' }));
    if (!state.done) await doneWait.promise;
    if (state.failed) return;
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
    if (part !== '') socket.send(JSON.stringify({ type: 'text.delta', delta: part }));
  }
  return combined.length;
}

async function onMessage(
  data: unknown,
  itemId: string,
  format: AudioFormat,
  state: SpeechState,
  push: (event: SpeechEvent) => void,
  wake: () => void
) {
  try {
    const parsed = JSON.parse(await messageText(data)) as unknown;
    if (!isRecord(parsed)) throw new Error('xAI speech event was not JSON');
    applySpeech(parsed, itemId, format, state, push);
    if (state.done || state.failed) wake();
  } catch (error) {
    const voice = asVoiceError(error);
    state.failed = true;
    push({ type: 'error', reason: voice.reason, error: voice.error });
    wake();
  }
}

function applySpeech(
  event: Record<string, unknown>,
  itemId: string,
  format: AudioFormat,
  state: SpeechState,
  push: (event: SpeechEvent) => void
) {
  const type = stringField(event, 'type');
  if (type === 'audio.delta') {
    const delta = stringField(event, 'delta');
    const payload = delta === undefined ? '' : delta;
    const data = decodeAudioBase64(payload);
    if (!state.started) {
      state.started = true;
      push({ type: 'start', format });
    }
    state.outputSeconds += chunkSeconds({ data, format, timestamp: 0 });
    push({
      type: 'audio',
      chunk: { data, format, timestamp: 0 },
      span: { itemId, start: 0, end: state.characters },
    });
    return;
  }
  if (type === 'audio.done') {
    state.done = true;
    return;
  }
  if (type === 'error') {
    const message = stringField(event, 'message');
    state.failed = true;
    push({
      type: 'error',
      reason: 'error',
      error: message === undefined ? 'xAI speech failed' : message,
    });
  }
}
