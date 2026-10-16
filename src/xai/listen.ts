import type { AudioChunk, AudioFormat } from '../audio.ts';
import { chunkSeconds } from '../audio.ts';
import type { TranscriptionModel } from '../models.ts';
import {
  asVoiceError,
  isRecord,
  numberField,
  requestHeaders,
  stringField,
} from '../openai/wire.ts';
import {
  type ListenOptions,
  type TranscriptionEvent,
  TranscriptionEventStream,
} from '../transcription.ts';
import { priceAudio } from '../usage.ts';
import {
  awaitOpen,
  connectSocket,
  copiedBytes,
  encodingName,
  messageText,
  sameFormat,
  socketUrl,
} from './wire.ts';

interface ListenState {
  turns: string[];
  segment: number;
  started: boolean;
  bytes: number;
  opened: boolean;
  ready: boolean;
  clientDone: boolean;
  failed: boolean;
  completed: boolean;
  duration: number | undefined;
  doneText: string | undefined;
}

function terms(options: ListenOptions | undefined): string[] {
  const vocabulary = options?.vocabulary;
  if (!vocabulary) return [];
  return vocabulary;
}

function sttUrl(
  model: TranscriptionModel<string>,
  format: AudioFormat,
  options: ListenOptions | undefined
): string {
  const url = socketUrl(model.baseUrl, 'stt');
  const params = new URLSearchParams();
  params.set('model', model.id);
  params.set('sample_rate', String(format.sampleRate));
  params.set('encoding', encodingName(format.encoding));
  params.set('interim_results', 'true');
  if (model.turnDetection === 'semantic') params.set('smart_turn', '0.5');
  if (model.diarization) params.set('diarize', 'true');
  if (options?.language) params.set('language', options.language);
  for (const term of terms(options)) params.append('keyterm', term);
  url.search = params.toString();
  return url.toString();
}

function chosenFormat(
  model: TranscriptionModel<string>,
  chunk: AudioChunk | undefined
): AudioFormat {
  const format = chunk === undefined ? model.inputFormats[0] : chunk.format;
  if (!format) throw new Error('No input format');
  encodingName(format.encoding);
  const known = model.inputFormats.some((item) => sameFormat(item, format));
  if (!known) throw new Error(`Unsupported audio format ${format.encoding}`);
  return format;
}

function textOr(event: Record<string, unknown>, key: string): string {
  const text = stringField(event, key);
  if (text === undefined) return '';
  return text;
}

function applyListen(
  event: Record<string, unknown>,
  state: ListenState,
  push: (event: TranscriptionEvent) => void
) {
  const type = stringField(event, 'type');
  if (type === 'transcript.created') {
    state.ready = true;
    return;
  }
  if (type === 'transcript.partial') {
    const spoken = textOr(event, 'text');
    if (!state.started) {
      state.started = true;
      const start = numberField(event, 'start');
      push({ type: 'speech_start', at: start === undefined ? 0 : start * 1000 });
    }
    if (event.is_final === true) {
      state.segment += 1;
      state.turns.push(spoken);
      const segmentId = String(state.segment);
      push({ type: 'final', segmentId, text: spoken });
      if (event.speech_final === true) push({ type: 'turn_end', text: spoken, at: 0 });
      return;
    }
    push({ type: 'partial', segmentId: String(state.segment), text: spoken });
    return;
  }
  if (type === 'transcript.done') {
    const text = stringField(event, 'text');
    state.doneText = text === undefined ? state.turns.join(' ') : text;
    const duration = numberField(event, 'duration');
    if (duration !== undefined) state.duration = duration;
    return;
  }
  if (type === 'error') {
    const message = stringField(event, 'message');
    state.failed = true;
    push({
      type: 'error',
      reason: 'error',
      error: message === undefined ? 'xAI transcription failed' : message,
    });
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
  const seconds = state.duration === undefined ? heard : state.duration;
  const text = state.doneText === undefined ? state.turns.join(' ') : state.doneText;
  push({
    type: 'done',
    transcript: { text, usage: priceAudio(model.audioCost, { inputSeconds: seconds }) },
  });
}

export function listenXAI(
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
    segment: 0,
    started: false,
    bytes: 0,
    opened: false,
    ready: false,
    clientDone: false,
    failed: false,
    completed: false,
    duration: undefined,
    doneText: undefined,
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
  const wake = () => {
    if (state.ready || state.failed) readyWait.resolve();
    if (state.failed || state.doneText !== undefined) doneWait.resolve();
  };
  try {
    if (options?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const iterator = audio[Symbol.asyncIterator]();
    const first = await iterator.next();
    const format = chosenFormat(model, first.done ? undefined : first.value);
    socket = connectSocket(sttUrl(model, format, options), requestHeaders(model, options));
    let incoming = Promise.resolve();
    socket.addEventListener('message', (event) => {
      incoming = incoming.then(() => onMessage(event.data, state, push, wake));
    });
    socket.addEventListener('close', () => {
      if (state.opened && !state.failed && !state.completed && !state.clientDone) {
        state.failed = true;
        push({ type: 'error', reason: 'error', error: 'xAI transcription socket closed' });
      }
      wake();
      if (state.clientDone) doneWait.resolve();
    });
    await awaitOpen(socket, 'xAI transcription', (message) => {
      state.failed = true;
      push({ type: 'error', reason: 'error', error: message });
      wake();
    });
    if (state.failed) return;
    state.opened = true;
    if (!state.ready) await readyWait.promise;
    if (state.failed) return;
    if (!first.done) sendChunk(socket, first.value, format, state);
    while (!state.failed) {
      if (options?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const next = await iterator.next();
      if (next.done) break;
      sendChunk(socket, next.value, format, state);
    }
    if (state.failed) return;
    state.clientDone = true;
    socket.send(JSON.stringify({ type: 'audio.done' }));
    if (state.doneText === undefined) await doneWait.promise;
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
  socket.send(copiedBytes(chunk.data));
}

async function onMessage(
  data: unknown,
  state: ListenState,
  push: (event: TranscriptionEvent) => void,
  wake: () => void
) {
  try {
    const parsed = JSON.parse(await messageText(data)) as unknown;
    if (!isRecord(parsed)) throw new Error('xAI transcription event was not JSON');
    applyListen(parsed, state, push);
    wake();
  } catch (error) {
    const voice = asVoiceError(error);
    state.failed = true;
    push({ type: 'error', reason: voice.reason, error: voice.error });
    wake();
  }
}
