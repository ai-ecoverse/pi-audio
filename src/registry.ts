import type { ProviderRequestOptions } from '@earendil-works/pi-ai';
import type { AudioSource } from './audio.ts';
import { speakInSentences } from './chunk-speech.ts';
import { VoiceRequestError } from './errors.ts';
import type { RealtimeModel, SpeechModel, TranscriptionModel } from './models.ts';
import type {
  RealtimeApiProvider,
  RealtimeContext,
  RealtimeOptions,
  RealtimeSession,
} from './realtime.ts';
import type { SpeechApiProvider, SpeechEventStream, SpeechInput } from './speech.ts';
import type {
  AudioInput,
  ListenOptions,
  Transcript,
  TranscriptionApiProvider,
  TranscriptionEventStream,
} from './transcription.ts';
import { listenWithVad } from './vad-listen.ts';

interface TranscriptionEntry {
  provider: TranscriptionApiProvider;
}

interface SpeechEntry {
  provider: SpeechApiProvider;
}

interface RealtimeEntry {
  provider: RealtimeApiProvider;
}

const transcriptionApis = new Map<string, TranscriptionEntry>();
const speechApis = new Map<string, SpeechEntry>();
const realtimeApis = new Map<string, RealtimeEntry>();

function missing(api: string): Error {
  return new Error(`No API provider registered for api: ${api}`);
}

export function registerTranscriptionApiProvider(provider: TranscriptionApiProvider): () => void {
  const entry = { provider };
  transcriptionApis.set(provider.api, entry);
  return () => {
    if (transcriptionApis.get(provider.api) === entry) transcriptionApis.delete(provider.api);
  };
}

export function registerSpeechApiProvider(provider: SpeechApiProvider): () => void {
  const entry = { provider };
  speechApis.set(provider.api, entry);
  return () => {
    if (speechApis.get(provider.api) === entry) speechApis.delete(provider.api);
  };
}

export function registerRealtimeApiProvider(provider: RealtimeApiProvider): () => void {
  const entry = { provider };
  realtimeApis.set(provider.api, entry);
  return () => {
    if (realtimeApis.get(provider.api) === entry) realtimeApis.delete(provider.api);
  };
}

export function transcribe(
  model: TranscriptionModel<string>,
  input: AudioInput,
  options?: ProviderRequestOptions
): Promise<Transcript> {
  const transcribeModel = transcriptionApis.get(model.api)?.provider.transcribe;
  if (!transcribeModel) return Promise.reject(missing(model.api));
  return transcribeModel(model, input, options);
}

export function listen(
  model: TranscriptionModel<string>,
  audio: AudioSource,
  options?: ListenOptions
): TranscriptionEventStream {
  const listenModel = transcriptionApis.get(model.api)?.provider.listen;
  if (!listenModel) throw missing(model.api);
  if (model.turnDetection === 'none') return listenWithVad(listenModel, model, audio, options);
  return listenModel(model, audio, options);
}

export function speak(
  model: SpeechModel<string>,
  input: SpeechInput,
  options?: ProviderRequestOptions
): SpeechEventStream {
  const speakModel = speechApis.get(model.api)?.provider.speak;
  if (!speakModel) throw missing(model.api);
  if (!model.textStreaming) return speakInSentences(speakModel, model, input, options);
  return speakModel(model, input, options);
}

export function connectRealtime(
  model: RealtimeModel<string>,
  context: RealtimeContext,
  options?: RealtimeOptions
): Promise<RealtimeSession> {
  if (options?.transport !== undefined && !model.transports.includes(options.transport)) {
    return Promise.reject(
      new VoiceRequestError('error', `unsupported transport: ${options.transport}`)
    );
  }
  if (options?.resumeHandle !== undefined && !model.resumable) {
    return Promise.reject(new VoiceRequestError('error', 'session is not resumable'));
  }
  const connect = realtimeApis.get(model.api)?.provider.connect;
  if (!connect) return Promise.reject(missing(model.api));
  return connect(model, context, options);
}
