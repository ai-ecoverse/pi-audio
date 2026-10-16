import type { AudioChunk, AudioFormat } from '../audio.ts';
import { chunkSeconds } from '../audio.ts';
import { encodeAudioBase64 } from '../convert.ts';
import type { TranscriptionModel } from '../models.ts';
import { asVoiceError, isRecord, numberField, stringField } from '../openai/wire.ts';
import {
  type ListenOptions,
  type TranscriptionEvent,
  TranscriptionEventStream,
  type TranscriptSegment,
} from '../transcription.ts';
import { priceAudio } from '../usage.ts';
import {
  awaitOpen,
  bearerHeaders,
  connectSocket,
  messageText,
  realtimeEncoding,
  sameFormat,
  socketUrl,
} from './wire.ts';

interface ListenState {
  turns: string[];
  segments: TranscriptSegment[];
  segment: number;
  started: boolean;
  bytes: number;
  opened: boolean;
  ready: boolean;
  clientDone: boolean;
  sawDone: boolean;
  failed: boolean;
  completed: boolean;
  partial: string;
  language: string | undefined;
}

function textOr(event: Record<string, unknown>): string {
  const text = stringField(event, 'text');
  if (text === undefined) return '';
  return text;
}

function secondsOf(word: Record<string, unknown>, key: string): number {
  const value = numberField(word, key);
  if (value === undefined) return 0;
  return value;
}

function segmentFrom(word: Record<string, unknown>): TranscriptSegment | undefined {
  const text = textOr(word);
  if (text === '') return undefined;
  const speaker = stringField(word, 'speaker_id');
  const segment: TranscriptSegment = {
    text,
    start: secondsOf(word, 'start'),
    end: secondsOf(word, 'end'),
  };
  if (speaker !== undefined) segment.speaker = speaker;
  return segment;
}

function listenError(event: Record<string, unknown>): string {
  const direct = stringField(event, 'error');
  if (direct !== undefined) return direct;
  const error = event.error;
  if (!isRecord(error)) return 'Mistral transcription failed';
  const message = error.message;
  if (typeof message === 'string') return message;
  if (isRecord(message)) {
    const detail = stringField(message, 'detail');
    if (detail !== undefined) return detail;
  }
  return 'Mistral transcription failed';
}

function spokenText(partial: string, doneText: string): string {
  if (partial !== '') return partial;
  return doneText;
}

function sttUrl(model: TranscriptionModel<string>, options: ListenOptions | undefined): string {
  const url = socketUrl(model.baseUrl, 'audio/transcriptions/realtime');
  const params = new URLSearchParams();
  params.set('model', model.id);
  if (options?.language) params.set('language', options.language);
  url.search = params.toString();
  return url.toString();
}

function chosenFormat(
  model: TranscriptionModel<string>,
  chunk: AudioChunk | undefined
): AudioFormat {
  const format = chunk === undefined ? model.inputFormats[0] : chunk.format;
  if (!format) throw new Error('No input format');
  realtimeEncoding(format);
  const known = model.inputFormats.some((item) => sameFormat(item, format));
  if (!known) throw new Error(`Unsupported audio format ${format.encoding}`);
  return format;
}

function addSegment(word: Record<string, unknown>, state: ListenState) {
  const segment = segmentFrom(word);
  if (segment) state.segments.push(segment);
}

function addSegments(value: unknown, state: ListenState) {
  if (!Array.isArray(value)) return;
  for (const word of value) {
    if (!isRecord(word)) continue;
    addSegment(word, state);
  }
}

function emitFinal(spoken: string, state: ListenState, push: (event: TranscriptionEvent) => void) {
  if (spoken === '') return;
  if (!state.started) {
    state.started = true;
    push({ type: 'speech_start', at: 0 });
  }
  const segmentId = String(state.segment);
  state.segment += 1;
  state.turns.push(spoken);
  push({ type: 'final', segmentId, text: spoken });
  state.started = false;
  push({ type: 'turn_end', text: spoken, at: 0 });
}

function applyListen(
  event: Record<string, unknown>,
  state: ListenState,
  push: (event: TranscriptionEvent) => void
) {
  const type = stringField(event, 'type');
  if (type === 'session.created' || type === 'session.updated') {
    state.ready = true;
    return;
  }
  if (type === 'transcription.text.delta') {
    state.partial += textOr(event);
    if (!state.started) {
      state.started = true;
      push({ type: 'speech_start', at: 0 });
    }
    push({ type: 'partial', segmentId: String(state.segment), text: state.partial });
    return;
  }
  if (type === 'transcription.segment') {
    addSegment(event, state);
    return;
  }
  if (type === 'transcription.done') {
    const language = stringField(event, 'language');
    if (language !== undefined) state.language = language;
    addSegments(event.segments, state);
    const spoken = spokenText(state.partial, textOr(event));
    state.partial = '';
    state.sawDone = true;
    emitFinal(spoken, state, push);
    return;
  }
  if (type === 'error') {
    state.failed = true;
    push({ type: 'error', reason: 'error', error: listenError(event) });
  }
}

function finish(
  model: TranscriptionModel<string>,
  format: AudioFormat,
  state: ListenState,
  push: (event: TranscriptionEvent) => void
) {
  if (state.failed || state.completed) return;
  state.completed = true;
  const heard = chunkSeconds({ data: new Uint8Array(state.bytes), format, timestamp: 0 });
  push({
    type: 'done',
    transcript: {
      text: state.turns.join(' '),
      ...(state.language !== undefined ? { language: state.language } : {}),
      ...(state.segments.length > 0 ? { segments: state.segments } : {}),
      usage: priceAudio(model.audioCost, { inputSeconds: heard }),
    },
  });
}

export function listenMistral(
  model: TranscriptionModel<string>,
  audio: AsyncIterable<AudioChunk>,
  options?: ListenOptions
): TranscriptionEventStream {
  const stream = new TranscriptionEventStream();
  void pumpListen(model, audio, options, stream);
  return stream;
}

async function pumpListen(
  model: TranscriptionModel<string>,
  audio: AsyncIterable<AudioChunk>,
  options: ListenOptions | undefined,
  stream: TranscriptionEventStream
) {
  const state: ListenState = {
    turns: [],
    segments: [],
    segment: 0,
    started: false,
    bytes: 0,
    opened: false,
    ready: false,
    clientDone: false,
    sawDone: false,
    failed: false,
    completed: false,
    partial: '',
    language: undefined,
  };
  let settled = false;
  const push = (event: TranscriptionEvent) => {
    if (settled) return;
    if (event.type === 'done' || event.type === 'error') settled = true;
    stream.push(event);
  };
  let socket: WebSocket | undefined;
  const readyWait = Promise.withResolvers<void>();
  const doneWait = Promise.withResolvers<void>();
  const wake = (kind: string | undefined) => {
    if (state.ready || state.failed) readyWait.resolve();
    if (state.failed) doneWait.resolve();
    if (!state.clientDone) return;
    if (kind === 'transcription.done') doneWait.resolve();
    if (kind === 'close') doneWait.resolve();
  };
  try {
    if (options?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const iterator = audio[Symbol.asyncIterator]();
    const first = await iterator.next();
    const format = chosenFormat(model, first.done ? undefined : first.value);
    socket = connectSocket(sttUrl(model, options), bearerHeaders(model, options));
    let incoming = Promise.resolve();
    socket.addEventListener('message', (event) => {
      incoming = incoming.then(() => onMessage(event.data, state, push, wake));
    });
    socket.addEventListener('close', () => {
      if (state.opened && !state.failed && !state.completed && !state.clientDone) {
        state.failed = true;
        push({ type: 'error', reason: 'error', error: 'Mistral transcription socket closed' });
      }
      wake('close');
    });
    await awaitOpen(socket, 'Mistral transcription', (message) => {
      state.failed = true;
      push({ type: 'error', reason: 'error', error: message });
      wake('fail');
    });
    if (state.failed) return;
    state.opened = true;
    if (!state.ready) await readyWait.promise;
    if (state.failed) return;
    socket.send(
      JSON.stringify({
        type: 'session.update',
        session: {
          audio_format: { encoding: realtimeEncoding(format), sample_rate: format.sampleRate },
        },
      })
    );
    if (!first.done) sendChunk(socket, first.value, format, state);
    while (!state.failed) {
      if (options?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const next = await iterator.next();
      if (next.done) break;
      sendChunk(socket, next.value, format, state);
    }
    if (state.failed) return;
    socket.send(JSON.stringify({ type: 'input_audio.flush' }));
    socket.send(JSON.stringify({ type: 'input_audio.end' }));
    state.clientDone = true;
    if (state.sawDone) doneWait.resolve();
    await doneWait.promise;
    finish(model, format, state, push);
  } catch (error) {
    const voice = asVoiceError(error);
    state.failed = true;
    push({ type: 'error', reason: voice.reason, error: voice.error });
  } finally {
    socket?.close();
  }
}

function sendChunk(socket: WebSocket, chunk: AudioChunk, format: AudioFormat, state: ListenState) {
  if (!sameFormat(chunk.format, format)) {
    throw new Error(`Unsupported audio format ${chunk.format.encoding}`);
  }
  state.bytes += chunk.data.byteLength;
  socket.send(JSON.stringify({ type: 'input_audio.append', audio: encodeAudioBase64(chunk.data) }));
}

async function onMessage(
  data: unknown,
  state: ListenState,
  push: (event: TranscriptionEvent) => void,
  wake: (kind: string | undefined) => void
) {
  try {
    const parsed = JSON.parse(await messageText(data)) as unknown;
    if (!isRecord(parsed)) throw new Error('Mistral transcription event was not JSON');
    applyListen(parsed, state, push);
    wake(stringField(parsed, 'type'));
  } catch (error) {
    const voice = asVoiceError(error);
    state.failed = true;
    push({ type: 'error', reason: voice.reason, error: voice.error });
    wake('fail');
  }
}
