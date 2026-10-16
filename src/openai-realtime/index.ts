import type { RealtimeModel } from '../models.ts';
import { registerVoiceModel } from '../models.ts';
import { registerRealtimeApiProvider } from '../registry.ts';
import { type AdapterOptions, connectVendorSession, pcmFormat } from './session.ts';

const voices = [
  { id: 'marin', name: 'Marin' },
  { id: 'cedar', name: 'Cedar' },
  { id: 'alloy', name: 'Alloy' },
  { id: 'ash', name: 'Ash' },
  { id: 'ballad', name: 'Ballad' },
  { id: 'coral', name: 'Coral' },
  { id: 'echo', name: 'Echo' },
  { id: 'sage', name: 'Sage' },
  { id: 'shimmer', name: 'Shimmer' },
  { id: 'verse', name: 'Verse' },
];

const audioCost = { perInputMinute: 0.0192, perOutputMinute: 0.0384 };

function realtimeModel(id: string, name: string): RealtimeModel<'openai-realtime'> {
  return {
    id,
    name,
    api: 'openai-realtime',
    provider: 'openai',
    baseUrl: 'wss://api.openai.com/v1/realtime',
    type: 'realtime',
    transports: ['websocket', 'webrtc'],
    toolCalls: 'blocking',
    inputFormat: pcmFormat(24000),
    outputFormat: pcmFormat(24000),
    resumable: false,
    ephemeralAuth: true,
    voices,
    provisioning: 'none',
    delivery: { interrupt: 'native', when_idle: 'approximate', silent: 'native' },
    truncation: 'client',
    liveToolUpdate: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    audioCost,
  };
}

export const gptRealtime2 = realtimeModel('gpt-realtime-2', 'GPT Realtime 2');

export const gptRealtime21 = realtimeModel('gpt-realtime-2.1', 'GPT Realtime 2.1');

export function registerOpenAIRealtime(options: AdapterOptions = {}): () => void {
  const unregisterModels = [gptRealtime2, gptRealtime21].map(registerVoiceModel);
  const unregisterApi = registerRealtimeApiProvider({
    api: 'openai-realtime',
    connect: (model, context, connectOptions) =>
      connectVendorSession(model, context, connectOptions, { ...options, dialect: 'openai' }),
  });
  return () => {
    for (const unregister of unregisterModels) unregister();
    unregisterApi();
  };
}

export type { AdapterOptions, VoiceWireFactory } from './session.ts';
export type { VoiceSocketConstructor, VoiceWire, VoiceWireTarget } from './socket.ts';
