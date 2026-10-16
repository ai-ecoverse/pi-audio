import type { AudioChunk, AudioFormat } from '../audio.ts';
import { encodeAudioBase64 } from '../convert.ts';
import type { TranscriptionModel } from '../models.ts';
import {
  type ListenOptions,
  type TranscriptionEvent,
  TranscriptionEventStream,
} from '../transcription.ts';
import { priceAudio } from '../usage.ts';
import {
  asVoiceError,
  isRecord,
  numberField,
  realtimeUrl,
  requestHeaders,
  stringField,
} from './wire.ts';

interface TurnState {
  turns: string[];
  partial: string;
  segmentId: string;
  bytes: number;
  audioDone: boolean;
  failed: boolean;
  vad: boolean;
  speaking: boolean;
  committing: boolean;
  flushed: boolean;
  pending: Set<string>;
}

const DRAIN_TIMEOUT_MS = 10_000;

function inFlight(state: TurnState): boolean {
  return state.speaking || state.committing || state.pending.size > 0;
}

function settle(state: TurnState, item: string | undefined) {
  const key = item === undefined ? '0' : item;
  if (state.pending.has(key)) state.pending.delete(key);
  else {
    state.committing = false;
    state.speaking = false;
  }
}

function turnDetection(model: TranscriptionModel<string>): Record<string, unknown> | null {
  if (model.turnDetection === 'vad') return { type: 'server_vad' };
  if (model.turnDetection === 'semantic') return { type: 'semantic_vad' };
  return null;
}

function sessionBody(
  model: TranscriptionModel<string>,
  options: ListenOptions | undefined,
  format: AudioFormat
) {
  const transcription: Record<string, unknown> = { model: model.id };
  if (options?.language) {
    transcription.language = options.language;
    transcription.languages = [options.language];
  }
  if (options?.vocabulary && options.vocabulary.length > 0)
    transcription.keywords = options.vocabulary;
  return {
    type: 'session.update',
    session: {
      type: 'transcription',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: format.sampleRate },
          transcription,
          turn_detection: turnDetection(model),
        },
      },
    },
  };
}

function matches(chunk: AudioChunk, format: AudioFormat): boolean {
  return (
    chunk.format.encoding === format.encoding &&
    chunk.format.sampleRate === format.sampleRate &&
    chunk.format.channels === format.channels
  );
}

async function messageText(data: unknown): Promise<string> {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (data instanceof Uint8Array) return new TextDecoder().decode(data);
  if (typeof Blob !== 'undefined' && data instanceof Blob) return data.text();
  throw new Error('Unsupported realtime message');
}

function applyTurnEvent(
  type: string | undefined,
  event: Record<string, unknown>,
  state: TurnState,
  push: (event: TranscriptionEvent) => void
): boolean {
  if (type === 'input_audio_buffer.speech_started') {
    const at = numberField(event, 'audio_start_ms');
    state.speaking = true;
    push({ type: 'speech_start', at: at === undefined ? 0 : at });
    return true;
  }
  if (type === 'input_audio_buffer.speech_stopped') {
    state.speaking = false;
    return true;
  }
  if (type === 'input_audio_buffer.committed') {
    const item = stringField(event, 'item_id');
    state.speaking = false;
    state.committing = false;
    state.pending.add(item === undefined ? '0' : item);
    return true;
  }
  if (type === 'conversation.item.input_audio_transcription.failed') {
    settle(state, stringField(event, 'item_id'));
    return true;
  }
  return false;
}

function applyEvent(
  event: Record<string, unknown>,
  state: TurnState,
  push: (event: TranscriptionEvent) => void
) {
  const type = stringField(event, 'type');
  if (applyTurnEvent(type, event, state, push)) return;
  if (type === 'conversation.item.input_audio_transcription.delta') {
    const item = stringField(event, 'item_id');
    state.segmentId = item === undefined ? '0' : item;
    const delta = stringField(event, 'delta');
    state.partial += delta === undefined ? '' : delta;
    push({ type: 'partial', segmentId: state.segmentId, text: state.partial });
    return;
  }
  if (type === 'conversation.item.input_audio_transcription.completed') {
    const transcript = stringField(event, 'transcript');
    const text = transcript === undefined ? state.partial : transcript;
    settle(state, stringField(event, 'item_id'));
    state.turns.push(text);
    state.partial = '';
    push({ type: 'final', segmentId: state.segmentId, text });
    push({ type: 'turn_end', text, at: 0 });
    return;
  }
  if (type === 'error') {
    const detail = event.error;
    const message = isRecord(detail) ? stringField(detail, 'message') : undefined;
    const code = isRecord(detail) ? stringField(detail, 'code') : undefined;
    if (code === 'input_audio_buffer_commit_empty' && state.flushed && state.vad) {
      state.committing = false;
      return;
    }
    state.failed = true;
    push({
      type: 'error',
      reason: 'error',
      error: message === undefined ? 'Realtime transcription failed' : message,
    });
  }
}

export function listenOpenAI(
  model: TranscriptionModel<string>,
  audio: AsyncIterable<AudioChunk>,
  options?: ListenOptions
): TranscriptionEventStream {
  const stream = new TranscriptionEventStream();
  void pumpListen(model, audio, options, stream);
  return stream;
}

function openSocket(socket: WebSocket, fail: (message: string) => void): Promise<void> {
  return new Promise((resolve) => {
    let opened = false;
    socket.addEventListener('open', () => {
      opened = true;
      resolve();
    });
    socket.addEventListener('error', () => {
      fail('OpenAI realtime transcription socket failed');
      if (!opened) resolve();
    });
    socket.addEventListener('close', () => {
      if (!opened) {
        fail('OpenAI realtime transcription socket closed');
        resolve();
      }
    });
  });
}

async function pumpListen(
  model: TranscriptionModel<string>,
  audio: AsyncIterable<AudioChunk>,
  options: ListenOptions | undefined,
  stream: TranscriptionEventStream
) {
  const state: TurnState = {
    turns: [],
    partial: '',
    segmentId: '0',
    bytes: 0,
    audioDone: false,
    failed: false,
    vad: model.turnDetection !== 'none',
    speaking: false,
    committing: false,
    flushed: false,
    pending: new Set(),
  };
  let finished = false;
  const push = (event: TranscriptionEvent) => {
    if (finished) return;
    if (event.type === 'done' || event.type === 'error') finished = true;
    stream.push(event);
  };
  let socket: WebSocket | undefined;
  let wake: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => {
    wake = resolve;
  });
  try {
    if (options?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const format = model.inputFormats[0];
    if (!format) throw new Error('No input format');
    requestHeaders(model, options);
    const apiKey = options?.apiKey;
    if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);
    socket = new WebSocket(realtimeUrl(model.baseUrl), [
      'realtime',
      `openai-insecure-api-key.${apiKey}`,
    ]);
    const live = socket;
    const commit = () => {
      if (finished) return;
      state.committing = true;
      state.flushed = true;
      live.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    };
    let incoming = Promise.resolve();
    socket.addEventListener('message', (event) => {
      incoming = incoming.then(() => onMessage(event.data, state, push, wake, commit));
    });
    socket.addEventListener('close', () => wake?.());
    await openSocket(socket, (message) => {
      push({ type: 'error', reason: 'error', error: message });
      wake?.();
    });
    if (finished) return;
    socket.send(JSON.stringify(sessionBody(model, options, format)));
    for await (const chunk of audio) {
      if (finished) return;
      if (options?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      if (!matches(chunk, format))
        throw new Error(`Unsupported audio format ${chunk.format.encoding}`);
      state.bytes += chunk.data.length;
      socket.send(
        JSON.stringify({ type: 'input_audio_buffer.append', audio: encodeAudioBase64(chunk.data) })
      );
    }
    state.audioDone = true;
    if (!state.vad || state.speaking) commit();
    if (!finished && (inFlight(state) || state.turns.length === 0)) {
      const timeout = options?.drainTimeoutMs ?? DRAIN_TIMEOUT_MS;
      const timer = setTimeout(() => wake?.(), timeout);
      await wait;
      clearTimeout(timer);
    }
    if (finished) return;
    if (state.partial !== '') {
      const text = state.partial;
      state.turns.push(text);
      state.partial = '';
      push({ type: 'final', segmentId: state.segmentId, text });
      push({ type: 'turn_end', text, at: 0 });
    }
    const width = format.sampleRate * format.channels * 2;
    const inputSeconds = width > 0 ? state.bytes / width : 0;
    push({
      type: 'done',
      transcript: {
        text: state.turns.join(' '),
        usage: priceAudio(model.audioCost, { inputSeconds }),
      },
    });
  } catch (error) {
    const voice = asVoiceError(error);
    push({ type: 'error', reason: voice.reason, error: voice.error });
  } finally {
    socket?.close();
  }
}

async function onMessage(
  data: unknown,
  state: TurnState,
  push: (event: TranscriptionEvent) => void,
  wake: (() => void) | undefined,
  commit: () => void
) {
  try {
    const parsed = JSON.parse(await messageText(data)) as unknown;
    if (!isRecord(parsed)) throw new Error('Realtime transcription event was not JSON');
    applyEvent(parsed, state, push);
    if (state.audioDone && state.speaking && !state.committing) commit();
    if (state.failed || (state.audioDone && state.turns.length > 0 && !inFlight(state))) wake?.();
  } catch (error) {
    const voice = asVoiceError(error);
    state.failed = true;
    push({ type: 'error', reason: voice.reason, error: voice.error });
    wake?.();
  }
}
