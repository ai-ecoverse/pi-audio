import type { RealtimeModel } from '../models.ts';
import { registerVoiceModel } from '../models.ts';
import { registerRealtimeApiProvider } from '../registry.ts';
import { connectGeminiSession, type GeminiOptions, pcmFormat } from './session.ts';

const voices = [
  { id: 'Aoede', name: 'Aoede' },
  { id: 'Puck', name: 'Puck' },
  { id: 'Charon', name: 'Charon' },
  { id: 'Kore', name: 'Kore' },
  { id: 'Fenrir', name: 'Fenrir' },
  { id: 'Zephyr', name: 'Zephyr' },
];

const audioCost = { perInputMinute: 0.005, perOutputMinute: 0.018 };

const endpoint =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

function liveModel(
  id: string,
  name: string,
  toolCalls: RealtimeModel<'gemini-live'>['toolCalls'],
  video: boolean
): RealtimeModel<'gemini-live'> {
  return {
    id,
    name,
    api: 'gemini-live',
    provider: 'google',
    baseUrl: endpoint,
    type: 'realtime',
    transports: ['websocket'],
    toolCalls,
    inputFormat: pcmFormat(16000),
    outputFormat: pcmFormat(24000),
    video: video ? { maxFps: 1 } : undefined,
    maxSessionMs: 900_000,
    resumable: true,
    ephemeralAuth: true,
    voices,
    provisioning: 'none',
    delivery: { interrupt: 'native', when_idle: 'native', silent: 'native' },
    truncation: 'none',
    liveToolUpdate: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    audioCost,
  };
}

export const gemini38Live = liveModel('gemini-3.8-live', 'Gemini 3.8 Live', 'async', true);

export const gemini25NativeAudio = liveModel(
  'gemini-live-2.5-flash-native-audio',
  'Gemini 2.5 Flash Live',
  'async',
  true
);

export const gemini31FlashLive = liveModel(
  'gemini-3.1-flash-live-preview',
  'Gemini 3.1 Flash Live',
  'blocking',
  false
);

export function registerGeminiLive(options: GeminiOptions = {}): () => void {
  const unregisterModels = [gemini38Live, gemini25NativeAudio, gemini31FlashLive].map(
    registerVoiceModel
  );
  const unregisterApi = registerRealtimeApiProvider({
    api: 'gemini-live',
    connect: (model, context, connectOptions) =>
      connectGeminiSession(model, context, connectOptions, options),
  });
  return () => {
    for (const unregister of unregisterModels) unregister();
    unregisterApi();
  };
}

export type { GeminiOptions, VoiceWireFactory } from './session.ts';
