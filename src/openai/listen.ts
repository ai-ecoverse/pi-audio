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

function applyEvent(
  event: Record<string, unknown>,
  state: TurnState,
  push: (event: TranscriptionEvent) => void
) {
  const type = stringField(event, 'type');
  if (type === 'input_audio_buffer.speech_started') {
    const at = numberField(event, 'audio_start_ms');
    push({ type: 'speech_start', at: at === undefined ? 0 : at });
    return;
  }
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
    state.turns.push(text);
    state.partial = '';
    push({ type: 'final', segmentId: state.segmentId, text });
    push({ type: 'turn_end', text, at: 0 });
    return;
  }
  if (type === 'error') {
    const detail = event.error;
    const message = isRecord(detail) ? stringField(detail, 'message') : undefined;
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
    let incoming = Promise.resolve();
    socket.addEventListener('message', (event) => {
      incoming = incoming.then(() => onMessage(event.data, state, push, wake));
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
    if (model.turnDetection === 'none') {
      socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    }
    if (!finished && (model.turnDetection === 'none' || state.turns.length === 0)) await wait;
    if (finished) return;
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
  wake: (() => void) | undefined
) {
  try {
    const parsed = JSON.parse(await messageText(data)) as unknown;
    if (!isRecord(parsed)) throw new Error('Realtime transcription event was not JSON');
    applyEvent(parsed, state, push);
    if (state.failed || (state.audioDone && state.turns.length > 0)) wake?.();
  } catch (error) {
    const voice = asVoiceError(error);
    state.failed = true;
    push({ type: 'error', reason: voice.reason, error: voice.error });
    wake?.();
  }
}
