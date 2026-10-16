import type { AudioSource } from '../audio.ts';
import { chunkSeconds } from '../audio.ts';
import type { TranscriptionModel } from '../models.ts';
import { asVoiceError, isRecord, numberField, stringField } from '../openai/wire.ts';
import {
  type ListenOptions,
  type Transcript,
  type TranscriptionEvent,
  TranscriptionEventStream,
} from '../transcription.ts';
import { priceAudio } from '../usage.ts';
import {
  audioFrame,
  awaitOpen,
  connectSocket,
  listenQuery,
  messageBytes,
  session,
  workersAiSocket,
} from './wire.ts';

interface ListenState {
  events: TranscriptionEvent[];
  text: string;
}

function novaEvents(record: Record<string, unknown>, state: ListenState): void {
  if (stringField(record, 'type') === 'SpeechStarted') {
    const at = numberField(record, 'timestamp') ?? 0;
    state.events.push({ type: 'speech_start', at });
    return;
  }
  const transcript = novaTranscript(record);
  if (transcript !== undefined && transcript !== '') {
    const event: TranscriptionEvent =
      record.is_final === true
        ? { type: 'final', segmentId: '0', text: transcript }
        : { type: 'partial', segmentId: '0', text: transcript };
    state.events.push(event);
    state.text = transcript;
  }
  if (record.speech_final === true)
    state.events.push({ type: 'turn_end', text: state.text, at: 0 });
}

function novaTranscript(record: Record<string, unknown>): string | undefined {
  const channel = record.channel;
  if (!isRecord(channel) || Array.isArray(channel)) return undefined;
  const alternatives = channel.alternatives;
  if (!Array.isArray(alternatives)) return undefined;
  const first = alternatives[0];
  if (!isRecord(first) || Array.isArray(first)) return undefined;
  return stringField(first, 'transcript');
}

function fluxEvents(record: Record<string, unknown>, state: ListenState): void {
  const event = stringField(record, 'event');
  const at = numberField(record, 'audio_window_start') ?? 0;
  const transcript = stringField(record, 'transcript') ?? '';
  if (event === 'StartOfTurn') {
    state.events.push({ type: 'speech_start', at });
    return;
  }
  if (event === 'Update' || event === 'EagerEndOfTurn') {
    if (transcript !== '') state.events.push({ type: 'partial', segmentId: '0', text: transcript });
    return;
  }
  if (event === 'EndOfTurn') {
    if (transcript !== '') {
      state.events.push({ type: 'final', segmentId: '0', text: transcript });
      state.text = transcript;
    }
    state.events.push({ type: 'turn_end', text: state.text, at });
  }
}

async function onListenMessage(data: unknown, modelId: string, state: ListenState): Promise<void> {
  const bytes = await messageBytes(data);
  if (bytes !== undefined) return;
  if (typeof data !== 'string') throw new Error('Unsupported socket message');
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return;
  }
  if (!isRecord(parsed) || Array.isArray(parsed)) return;
  if (modelId.includes('/flux')) fluxEvents(parsed, state);
  else novaEvents(parsed, state);
}

function doneTranscript(
  model: TranscriptionModel<string>,
  text: string,
  seconds: number
): Transcript {
  const meters = seconds > 0 ? { inputSeconds: seconds } : {};
  return { text, usage: priceAudio(model.audioCost, meters) };
}

export function listenCloudflare(
  model: TranscriptionModel<string>,
  audio: AudioSource,
  options?: ListenOptions
): TranscriptionEventStream {
  const stream = new TranscriptionEventStream();
  void pumpListen(model, audio, options, stream);
  return stream;
}

async function pumpListen(
  model: TranscriptionModel<string>,
  audio: AudioSource,
  options: ListenOptions | undefined,
  stream: TranscriptionEventStream
) {
  let socket: WebSocket | undefined;
  try {
    if (!model.streaming) throw new Error('Model does not stream');
    if (options?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const format = model.inputFormats[0];
    if (!format) throw new Error('No input format');
    const route = session(model, options);
    const live = connectSocket(
      workersAiSocket(route.account, route.gateway, model.id, listenQuery(model.id, format)),
      route.headers
    );
    socket = live;
    const state: ListenState = { events: [], text: '' };
    let chain = Promise.resolve();
    let messageError: string | undefined;
    const closed = new Promise<void>((resolve) => {
      live.addEventListener('close', () => resolve());
    });
    live.addEventListener('message', (event) => {
      chain = chain
        .then(() => onListenMessage(event.data, model.id, state))
        .catch((error: unknown) => {
          messageError = asVoiceError(error).error;
        });
    });
    let failed: string | undefined;
    await awaitOpen(socket, 'Cloudflare', (message) => {
      failed = message;
    });
    if (failed !== undefined) throw new Error(failed);
    let seconds = 0;
    for await (const chunk of audio) {
      if (options?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      seconds += chunkSeconds(chunk);
      live.send(audioFrame(chunk.data));
    }
    live.close();
    await closed;
    await chain;
    if (messageError !== undefined) throw new Error(messageError);
    for (const event of state.events) stream.push(event);
    stream.push({ type: 'done', transcript: doneTranscript(model, state.text, seconds) });
  } catch (error) {
    if (socket !== undefined) socket.close();
    const voice = asVoiceError(error);
    stream.push({ type: 'error', reason: voice.reason, error: voice.error });
  }
}
