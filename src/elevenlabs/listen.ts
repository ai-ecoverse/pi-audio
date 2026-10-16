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
  connectSocket,
  messageText,
  sameFormat,
  socketUrl,
  sttAudioFormat,
  xiHeaders,
} from './wire.ts';

const failures = new Set([
  'error',
  'auth_error',
  'quota_exceeded',
  'commit_throttled',
  'unaccepted_terms',
  'rate_limited',
  'queue_overflow',
  'resource_exhausted',
  'session_time_limit_exceeded',
  'input_error',
  'invalid_request',
  'chunk_size_exceeded',
  'insufficient_audio_activity',
  'transcriber_error',
]);

interface ListenState {
  turns: string[];
  segments: TranscriptSegment[];
  segment: number;
  started: boolean;
  bytes: number;
  opened: boolean;
  ready: boolean;
  clientDone: boolean;
  failed: boolean;
  completed: boolean;
  lastCommit: string | undefined;
}

function terms(options: ListenOptions | undefined): string[] {
  const vocabulary = options?.vocabulary;
  if (!vocabulary) return [];
  return vocabulary;
}

function commitStrategy(model: TranscriptionModel<string>): string {
  if (model.turnDetection === 'semantic') return 'turn_prediction';
  if (model.turnDetection === 'vad') return 'vad';
  return 'manual';
}

function sttUrl(
  model: TranscriptionModel<string>,
  format: AudioFormat,
  options: ListenOptions | undefined
): string {
  const url = socketUrl(model.baseUrl, 'speech-to-text/realtime');
  const params = new URLSearchParams();
  params.set('model_id', model.id);
  params.set('audio_format', sttAudioFormat(format));
  params.set('commit_strategy', commitStrategy(model));
  params.set('include_timestamps', 'true');
  if (options?.language) params.set('language_code', options.language);
  for (const term of terms(options)) params.append('keyterms', term);
  url.search = params.toString();
  return url.toString();
}

function chosenFormat(
  model: TranscriptionModel<string>,
  chunk: AudioChunk | undefined
): AudioFormat {
  const format = chunk === undefined ? model.inputFormats[0] : chunk.format;
  if (!format) throw new Error('No input format');
  sttAudioFormat(format);
  const known = model.inputFormats.some((item) => sameFormat(item, format));
  if (!known) throw new Error(`Unsupported audio format ${format.encoding}`);
  return format;
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

function wordFrom(word: Record<string, unknown>): TranscriptSegment | undefined {
  if (stringField(word, 'type') === 'spacing') return undefined;
  const speaker = stringField(word, 'speaker_id');
  const segment: TranscriptSegment = {
    text: textOr(word),
    start: secondsOf(word, 'start'),
    end: secondsOf(word, 'end'),
  };
  if (speaker !== undefined) segment.speaker = speaker;
  return segment;
}

function wordsOf(event: Record<string, unknown>, state: ListenState) {
  if (!Array.isArray(event.words)) return;
  for (const word of event.words) {
    if (!isRecord(word)) continue;
    const segment = wordFrom(word);
    if (segment) state.segments.push(segment);
  }
}

function emitCommit(spoken: string, state: ListenState, push: (event: TranscriptionEvent) => void) {
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
  const type = stringField(event, 'message_type');
  if (type === 'session_started') {
    state.ready = true;
    return;
  }
  if (type === 'partial_transcript') {
    if (!state.started) {
      state.started = true;
      push({ type: 'speech_start', at: 0 });
    }
    push({ type: 'partial', segmentId: String(state.segment), text: textOr(event) });
    return;
  }
  if (type === 'committed_transcript') {
    const spoken = textOr(event);
    state.lastCommit = spoken;
    emitCommit(spoken, state, push);
    return;
  }
  if (type === 'committed_transcript_with_timestamps') {
    const spoken = textOr(event);
    wordsOf(event, state);
    if (state.lastCommit !== spoken) emitCommit(spoken, state, push);
    state.lastCommit = undefined;
    return;
  }
  if (type !== undefined && failures.has(type)) {
    const message = stringField(event, 'error');
    state.failed = true;
    push({
      type: 'error',
      reason: 'error',
      error: message === undefined ? 'ElevenLabs transcription failed' : message,
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
  push({
    type: 'done',
    transcript: {
      text: state.turns.join(' '),
      ...(state.segments.length > 0 ? { segments: state.segments } : {}),
      usage: priceAudio(model.audioCost, { inputSeconds: heard }),
    },
  });
}

export function listenElevenLabs(
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
    failed: false,
    completed: false,
    lastCommit: undefined,
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
    if (kind === 'committed_transcript' || kind === 'committed_transcript_with_timestamps') {
      doneWait.resolve();
    }
    if (kind === 'close') doneWait.resolve();
  };
  try {
    if (options?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const iterator = audio[Symbol.asyncIterator]();
    const first = await iterator.next();
    const format = chosenFormat(model, first.done ? undefined : first.value);
    socket = connectSocket(sttUrl(model, format, options), xiHeaders(model, options));
    let incoming = Promise.resolve();
    socket.addEventListener('message', (event) => {
      incoming = incoming.then(() => onMessage(event.data, state, push, wake));
    });
    socket.addEventListener('close', () => {
      if (state.opened && !state.failed && !state.completed && !state.clientDone) {
        state.failed = true;
        push({ type: 'error', reason: 'error', error: 'ElevenLabs transcription socket closed' });
      }
      wake('close');
    });
    await awaitOpen(socket, 'ElevenLabs transcription', (message) => {
      state.failed = true;
      push({ type: 'error', reason: 'error', error: message });
      wake('fail');
    });
    if (state.failed) return;
    state.opened = true;
    if (!state.ready) await readyWait.promise;
    if (state.failed) return;
    if (!first.done) sendChunk(socket, first.value, format, state, false);
    while (!state.failed) {
      if (options?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const next = await iterator.next();
      if (next.done) break;
      sendChunk(socket, next.value, format, state, false);
    }
    if (state.failed) return;
    sendChunk(socket, undefined, format, state, true);
    state.clientDone = true;
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

function sendChunk(
  socket: WebSocket,
  chunk: AudioChunk | undefined,
  format: AudioFormat,
  state: ListenState,
  commit: boolean
) {
  if (chunk && !sameFormat(chunk.format, format)) {
    throw new Error(`Unsupported audio format ${chunk.format.encoding}`);
  }
  const data = chunk ? chunk.data : new Uint8Array();
  state.bytes += data.byteLength;
  socket.send(
    JSON.stringify({
      message_type: 'input_audio_chunk',
      audio_base_64: encodeAudioBase64(data),
      commit,
      sample_rate: format.sampleRate,
    })
  );
}

async function onMessage(
  data: unknown,
  state: ListenState,
  push: (event: TranscriptionEvent) => void,
  wake: (kind: string | undefined) => void
) {
  try {
    const parsed = JSON.parse(await messageText(data)) as unknown;
    if (!isRecord(parsed)) throw new Error('ElevenLabs transcription event was not JSON');
    applyListen(parsed, state, push);
    wake(stringField(parsed, 'message_type'));
  } catch (error) {
    const voice = asVoiceError(error);
    state.failed = true;
    push({ type: 'error', reason: voice.reason, error: voice.error });
    wake('fail');
  }
}
