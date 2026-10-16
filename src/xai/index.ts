import type { RealtimeModel } from '../models.ts';
import { registerVoiceModel } from '../models.ts';
import {
  type AdapterOptions,
  connectVendorSession,
  pcmFormat,
} from '../openai-realtime/session.ts';
import { registerRealtimeApiProvider } from '../registry.ts';

const voices = [
  { id: 'eve', name: 'Eve' },
  { id: 'ara', name: 'Ara' },
  { id: 'rex', name: 'Rex' },
  { id: 'sal', name: 'Sal' },
  { id: 'leo', name: 'Leo' },
];

export const grokVoiceLatest: RealtimeModel<'xai-realtime'> = {
  id: 'grok-voice-latest',
  name: 'Grok Voice',
  api: 'xai-realtime',
  provider: 'xai',
  baseUrl: 'wss://api.x.ai/v1/realtime',
  type: 'realtime',
  transports: ['websocket', 'webrtc'],
  toolCalls: 'blocking',
  inputFormat: pcmFormat(24000),
  outputFormat: pcmFormat(24000),
  maxSessionMs: 7_200_000,
  resumable: true,
  ephemeralAuth: true,
  voices,
  provisioning: 'none',
  delivery: { interrupt: 'native', when_idle: 'approximate', silent: 'native' },
  truncation: 'client',
  liveToolUpdate: true,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  audioCost: { perInputMinute: 0.08, perOutputMinute: 0.08, perTextMessage: 0.004 },
};

export function registerXaiRealtime(options: AdapterOptions = {}): () => void {
  const unregisterModel = registerVoiceModel(grokVoiceLatest);
  const unregisterApi = registerRealtimeApiProvider({
    api: 'xai-realtime',
    connect: (model, context, connectOptions) =>
      connectVendorSession(model, context, connectOptions, { ...options, dialect: 'xai' }),
  });
  return () => {
    unregisterModel();
    unregisterApi();
  };
}
