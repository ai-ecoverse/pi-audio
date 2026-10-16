import type { ProviderRequestOptions } from '@earendil-works/pi-ai';
import type { AudioFormat, CharAlignment } from '../audio.ts';
import { chunkSeconds } from '../audio.ts';
import { decodeAudioBase64 } from '../convert.ts';
import { VoiceRequestError } from '../errors.ts';
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
import { type SpeechEvent, SpeechEventStream, type SpeechInput } from '../speech.ts';
import { type AudioCounters, priceAudio } from '../usage.ts';
import {
  alignmentFrom,
  awaitOpen,
  connectSocket,
  messageText,
  outputFormatName,
  sameFormat,
  socketUrl,
  xiHeaders,
} from './wire.ts';

interface SpeechState {
  opened: boolean;
  started: boolean;
  done: boolean;
  failed: boolean;
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
  model: SpeechModel<string>,
  text: string,
  language: string | undefined
): Record<string, unknown> {
  const body: Record<string, unknown> = { text, model_id: model.id };
  const code = languageCode(language);
  if (code !== undefined && model.id !== 'eleven_multilingual_v2') body.language_code = code;
  return body;
}

function speechUrl(model: SpeechModel<string>, voice: string, format: AudioFormat): string {
  const url = socketUrl(model.baseUrl, `text-to-speech/${encodeURIComponent(voice)}/stream-input`);
  const params = new URLSearchParams();
  params.set('model_id', model.id);
  params.set('output_format', outputFormatName(format));
  params.set('sync_alignment', 'true');
  url.search = params.toString();
  return url.toString();
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

async function xiFetch(
  model: SpeechModel<string>,
  options: ProviderRequestOptions | undefined,
  url: string,
  body: string
): Promise<Response> {
  const headers = xiHeaders(model, options);
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
    throw new Error(text === '' ? `HTTP ${response.status}` : text);
  }
  return response;
}

export function speakElevenLabs(
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
      await streamSpeech(model, input.text, input.voice, format, options, stream);
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
  const payload = speechBody(model, text, language);
  const body = await applyPayload(payload, model, options);
  if (!isRecord(body)) throw new Error('Speech payload was not JSON');
  const query = `output_format=${outputFormatName(format)}`;
  const path = `text-to-speech/${encodeURIComponent(voice)}/with-timestamps?${query}`;
  const response = await xiFetch(
    model,
    options,
    endpoint(model.baseUrl, path),
    JSON.stringify(body)
  );
  const parsed = await readJson(response);
  if (!isRecord(parsed)) throw new Error('Speech response had no audio');
  const audio = stringField(parsed, 'audio_base64');
  if (audio === undefined) throw new Error('Speech response had no audio');
  const data = decodeAudioBase64(audio);
  const seconds = chunkSeconds({ data, format, timestamp: 0 });
  const meters: AudioCounters = { characters: text.length };
  if (seconds > 0) meters.outputSeconds = seconds;
  const alignment = alignmentFrom(parsed.alignment);
  stream.push({ type: 'start', format });
  stream.push({
    type: 'audio',
    chunk: { data, format, timestamp: 0 },
    span: { itemId: model.id, start: 0, end: text.length },
    ...(alignment ? { alignment } : {}),
  });
  stream.push({ type: 'done', usage: priceAudio(model.audioCost, meters) });
}

async function streamSpeech(
  model: SpeechModel<string>,
  text: AsyncIterable<string>,
  voice: string,
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
  const socket = connectSocket(speechUrl(model, voice, format), xiHeaders(model, options));
  let incoming = Promise.resolve();
  socket.addEventListener('message', (event) => {
    incoming = incoming.then(() => onMessage(event.data, model.id, format, state, push, wake));
  });
  socket.addEventListener('close', () => {
    if (state.opened && !state.done && !state.failed) {
      state.failed = true;
      push({ type: 'error', reason: 'error', error: 'ElevenLabs speech socket closed' });
    }
    wake();
  });
  try {
    await awaitOpen(socket, 'ElevenLabs speech', (message) => {
      state.failed = true;
      push({ type: 'error', reason: 'error', error: message });
      wake();
    });
    if (state.failed) return;
    state.opened = true;
    state.characters = await writeText(socket, text, options?.signal);
    if (state.failed) return;
    socket.send(JSON.stringify({ text: ' ', flush: true }));
    socket.send(JSON.stringify({ text: '' }));
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
  socket.send(
    JSON.stringify({
      text: ' ',
      generation_config: { chunk_length_schedule: [50, 120, 160, 290] },
    })
  );
  for await (const part of text) {
    if (signal?.aborted) throw new VoiceRequestError('aborted', 'aborted');
    combined += part;
    if (part === '') continue;
    const delta = part.endsWith(' ') ? part : `${part} `;
    socket.send(JSON.stringify({ text: delta }));
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
    if (!isRecord(parsed)) throw new Error('ElevenLabs speech event was not JSON');
    applySpeech(parsed, itemId, format, state, push);
    if (state.done || state.failed) wake();
  } catch (error) {
    const voice = asVoiceError(error);
    state.failed = true;
    push({ type: 'error', reason: voice.reason, error: voice.error });
    wake();
  }
}

function audioEvent(
  itemId: string,
  format: AudioFormat,
  data: Uint8Array,
  end: number,
  alignment: CharAlignment | undefined
): SpeechEvent {
  return {
    type: 'audio',
    chunk: { data, format, timestamp: 0 },
    span: { itemId, start: 0, end },
    ...(alignment ? { alignment } : {}),
  };
}

function applySpeech(
  event: Record<string, unknown>,
  itemId: string,
  format: AudioFormat,
  state: SpeechState,
  push: (event: SpeechEvent) => void
) {
  if ('error' in event) {
    const message = stringField(event, 'error');
    state.failed = true;
    push({
      type: 'error',
      reason: 'error',
      error: message === undefined ? 'ElevenLabs speech failed' : message,
    });
    return;
  }
  if (event.isFinal === true) {
    state.done = true;
    return;
  }
  const audio = stringField(event, 'audio');
  if (audio === undefined || audio === '') return;
  const data = decodeAudioBase64(audio);
  if (!state.started) {
    state.started = true;
    push({ type: 'start', format });
  }
  state.outputSeconds += chunkSeconds({ data, format, timestamp: 0 });
  push(audioEvent(itemId, format, data, state.characters, alignmentFrom(event.alignment)));
}
