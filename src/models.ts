import type { BaseModel } from '@earendil-works/pi-ai';
import type { AudioFormat } from './audio.ts';
import type { RealtimeAudioCost, SpeechAudioCost, TranscriptionAudioCost } from './usage.ts';

export type KnownTranscriptionApi =
  | 'openai-transcriptions'
  | 'openai-realtime-transcription'
  | 'xai-stt'
  | 'elevenlabs-scribe'
  | 'mistral-transcriptions'
  | 'fish-asr'
  | 'cloudflare-ai-run'
  | 'wavespeed';

export type TranscriptionApi = KnownTranscriptionApi | (string & {});

export type KnownSpeechApi =
  | 'openai-speech'
  | 'xai-tts'
  | 'elevenlabs-tts'
  | 'mistral-speech'
  | 'fish-tts'
  | 'google-tts'
  | 'cloudflare-ai-run'
  | 'wavespeed';

export type SpeechApi = KnownSpeechApi | (string & {});

export type KnownRealtimeApi =
  | 'openai-realtime'
  | 'xai-realtime'
  | 'gemini-live'
  | 'elevenlabs-agents'
  | 'fish-agents';

export type RealtimeApi = KnownRealtimeApi | (string & {});

export type Delivery = 'interrupt' | 'when_idle' | 'silent';

export type DeliverySupport = 'native' | 'approximate' | 'unsupported';

export interface VoiceInfo {
  id: string;
  name: string;
  languages?: string[];
}

export interface TranscriptionModel<TApi extends TranscriptionApi>
  extends Omit<BaseModel<TApi>, 'input'> {
  type: 'transcription';
  streaming: boolean;
  turnDetection: 'none' | 'vad' | 'semantic';
  inputFormats: AudioFormat[];
  languages?: string[];
  diarization?: boolean;
  audioCost: TranscriptionAudioCost;
}

export interface SpeechModel<TApi extends SpeechApi> extends Omit<BaseModel<TApi>, 'input'> {
  type: 'speech';
  textStreaming: boolean;
  outputFormats: AudioFormat[];
  voices?: VoiceInfo[];
  cloning?: boolean;
  audioCost: SpeechAudioCost;
}

export interface RealtimeModel<TApi extends RealtimeApi> extends Omit<BaseModel<TApi>, 'input'> {
  type: 'realtime';
  transports: ('websocket' | 'webrtc')[];
  toolCalls: 'blocking' | 'async';
  inputFormat: AudioFormat;
  outputFormat: AudioFormat;
  video?: { maxFps: number };
  maxSessionMs?: number;
  resumable: boolean;
  ephemeralAuth: boolean;
  voices: VoiceInfo[];
  cascade?: { stt: string; llm: string; tts: string };
  provisioning: 'none' | 'agent';
  delivery: Record<Delivery, DeliverySupport>;
  truncation: 'client' | 'server' | 'none';
  liveToolUpdate: boolean;
  toolTimeoutMs?: { min: number; max: number };
  audioCost: RealtimeAudioCost;
}

declare module '@earendil-works/pi-ai' {
  interface ModelTypeMap {
    transcription: TranscriptionModel<TranscriptionApi>;
    speech: SpeechModel<SpeechApi>;
    realtime: RealtimeModel<RealtimeApi>;
  }
}

export type VoiceModel =
  | TranscriptionModel<TranscriptionApi>
  | SpeechModel<SpeechApi>
  | RealtimeModel<RealtimeApi>;

export type VoiceModelType = VoiceModel['type'];

const catalog = new Map<string, VoiceModel>();

function catalogKey(type: string, provider: string, id: string): string {
  return `${type}\0${provider}\0${id}`;
}

export function registerVoiceModel(model: VoiceModel): () => void {
  const key = catalogKey(model.type, model.provider, model.id);
  catalog.set(key, model);
  return () => {
    if (catalog.get(key) === model) catalog.delete(key);
  };
}

export function getVoiceModel<TType extends VoiceModelType>(
  type: TType,
  provider: string,
  id: string
): Extract<VoiceModel, { type: TType }> | undefined {
  return catalog.get(catalogKey(type, provider, id)) as
    | Extract<VoiceModel, { type: TType }>
    | undefined;
}

export function listVoiceModels<TType extends VoiceModelType>(
  type: TType,
  provider?: string
): Extract<VoiceModel, { type: TType }>[] {
  const found: Extract<VoiceModel, { type: TType }>[] = [];
  for (const model of catalog.values()) {
    if (model.type !== type) continue;
    if (provider !== undefined && model.provider !== provider) continue;
    found.push(model as Extract<VoiceModel, { type: TType }>);
  }
  return found;
}
