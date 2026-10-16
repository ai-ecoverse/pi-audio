import type { ProviderRequestOptions } from '@earendil-works/pi-ai';
import type { AudioChunk, AudioSource } from '../audio.ts';
import { blankUsage } from '../blank-usage.ts';
import { VoiceRequestError } from '../errors.ts';
import { registerVoiceModel, type TranscriptionModel } from '../models.ts';
import { registerTranscriptionApiProvider } from '../registry.ts';
import {
  type AudioInput,
  type ListenOptions,
  type TranscriptionEvent,
  TranscriptionEventStream,
} from '../transcription.ts';
import { decodeBytes, errorMessage, modelKey, pcm, shareApi, zeroCost } from './shared.ts';

export interface FauxTranscriptionCue {
  at: number | 'end';
  events: TranscriptionEvent[];
}

export interface FauxTranscriptionOptions {
  api?: string;
  provider?: string;
  id?: string;
  name?: string;
  turnDetection?: TranscriptionModel<string>['turnDetection'];
  cues?: FauxTranscriptionCue[];
}

export interface FauxTranscriptionCall {
  kind: 'transcribe' | 'listen';
  input?: AudioInput;
  chunks: AudioChunk[];
}

export interface FauxTranscription {
  model: TranscriptionModel<string>;
  calls: FauxTranscriptionCall[];
  setCues(cues: FauxTranscriptionCue[] | undefined): void;
  unregister(): void;
}

interface TranscriptionState {
  model: TranscriptionModel<string>;
  cues?: FauxTranscriptionCue[];
  calls: FauxTranscriptionCall[];
}

const states = new Map<string, TranscriptionState>();
const apis = new Map<string, () => void>();

function requireState(model: TranscriptionModel<string>): TranscriptionState {
  const state = states.get(modelKey(model));
  if (!state) throw new Error(`Unknown faux transcription model ${model.provider}/${model.id}`);
  return state;
}

export function registerFauxTranscription(
  options: FauxTranscriptionOptions = {}
): FauxTranscription {
  const model: TranscriptionModel<string> = {
    id: options.id ?? 'faux-transcription',
    name: options.name ?? 'Faux transcription',
    api: options.api ?? 'faux-transcription',
    provider: options.provider ?? 'faux',
    baseUrl: 'http://localhost:0',
    type: 'transcription',
    streaming: true,
    turnDetection: options.turnDetection ?? 'vad',
    inputFormats: [pcm(16000)],
    languages: ['en'],
    diarization: false,
    cost: zeroCost,
  };
  const state: TranscriptionState = { model, cues: options.cues, calls: [] };
  states.set(modelKey(model), state);
  const unregisterModel = registerVoiceModel(model);
  const release = shareApi(
    apis,
    model.api,
    () =>
      registerTranscriptionApiProvider({
        api: model.api,
        transcribe: transcribeFaux,
        listen: listenFaux,
      }),
    () => [...states.values()].some((entry) => entry.model.api === model.api)
  );
  return {
    model,
    calls: state.calls,
    setCues(cues) {
      state.cues = cues;
    },
    unregister() {
      if (states.get(modelKey(model)) === state) states.delete(modelKey(model));
      unregisterModel();
      release();
    },
  };
}

async function transcribeFaux(
  model: TranscriptionModel<string>,
  input: AudioInput,
  options?: ProviderRequestOptions
) {
  if (options?.signal?.aborted) throw new VoiceRequestError('aborted', 'aborted');
  const state = requireState(model);
  state.calls.push({ kind: 'transcribe', input, chunks: [] });
  const text = 'url' in input ? input.url : decodeBytes(input.data);
  return { text, usage: blankUsage() };
}

function listenFaux(
  model: TranscriptionModel<string>,
  audio: AudioSource,
  options?: ListenOptions
): TranscriptionEventStream {
  const stream = new TranscriptionEventStream();
  let state: TranscriptionState;
  try {
    state = requireState(model);
  } catch (error) {
    stream.push({ type: 'error', reason: 'error', error: errorMessage(error) });
    return stream;
  }
  void pumpListen(state, audio, options, stream);
  return stream;
}

interface Pump {
  stream: TranscriptionEventStream;
  finished: boolean;
  turnText?: string;
  push(event: TranscriptionEvent): void;
}

function createPump(stream: TranscriptionEventStream): Pump {
  const pump: Pump = {
    stream,
    finished: false,
    push(event) {
      if (pump.finished) return;
      if (event.type === 'turn_end') pump.turnText = event.text;
      stream.push(event);
      if (event.type === 'done' || event.type === 'error') pump.finished = true;
    },
  };
  return pump;
}

function cuesAt(cues: FauxTranscriptionCue[], at: number | 'end'): TranscriptionEvent[] {
  return cues.filter((cue) => cue.at === at).flatMap((cue) => cue.events);
}

function endCues(cues: FauxTranscriptionCue[], count: number): TranscriptionEvent[] {
  return cues
    .filter((cue) => cue.at === 'end' || (typeof cue.at === 'number' && cue.at > count))
    .flatMap((cue) => cue.events);
}

function finishScript(
  pump: Pump,
  cues: FauxTranscriptionCue[] | undefined,
  text: string,
  at: number,
  count: number
) {
  if (pump.finished) return;
  if (cues) for (const event of endCues(cues, count)) pump.push(event);
  else {
    pump.push({ type: 'final', segmentId: '0', text });
    pump.push({ type: 'turn_end', text, at });
  }
  if (!pump.finished) {
    pump.push({
      type: 'done',
      transcript: { text: pump.turnText ?? text, usage: blankUsage() },
    });
  }
}

async function pumpListen(
  state: TranscriptionState,
  audio: AudioSource,
  options: ListenOptions | undefined,
  stream: TranscriptionEventStream
) {
  const pump = createPump(stream);
  const call: FauxTranscriptionCall = { kind: 'listen', chunks: [] };
  state.calls.push(call);
  let text = '';
  let at = 0;
  let count = 0;
  try {
    if (options?.signal?.aborted) {
      pump.push({ type: 'error', reason: 'aborted', error: 'aborted' });
      return;
    }
    for (const event of cuesAt(state.cues ?? [], 0)) pump.push(event);
    if (!pump.finished) {
      for await (const chunk of audio) {
        if (pump.finished || options?.signal?.aborted) break;
        call.chunks.push(chunk);
        count += 1;
        at = chunk.timestamp;
        text += decodeBytes(chunk.data);
        deliverChunk(pump, state.cues, chunk, count, text);
      }
    }
    if (options?.signal?.aborted && !pump.finished) {
      pump.push({ type: 'error', reason: 'aborted', error: 'aborted' });
      return;
    }
    finishScript(pump, state.cues, text, at, count);
  } catch (error) {
    pump.push({ type: 'error', reason: 'error', error: errorMessage(error) });
  }
}

function deliverChunk(
  pump: Pump,
  cues: FauxTranscriptionCue[] | undefined,
  chunk: AudioChunk,
  count: number,
  text: string
) {
  if (cues) {
    for (const event of cuesAt(cues, count)) pump.push(event);
    return;
  }
  if (count === 1) pump.push({ type: 'speech_start', at: chunk.timestamp });
  pump.push({ type: 'partial', segmentId: '0', text });
}
