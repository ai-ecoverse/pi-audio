import type { RealtimeModel } from '../models.ts';
import { registerVoiceModel } from '../models.ts';
import { registerRealtimeApiProvider } from '../registry.ts';
import type { FishOptions } from './session.ts';
import { connectFish } from './session.ts';

const voices = [{ id: '802e3bc2b27e49c2995d23ef70e6ac89', name: 'Example' }];

function pcm16(sampleRate: number) {
  return { encoding: 'pcm16' as const, sampleRate, channels: 1 as const };
}

export const fishAgent: RealtimeModel<'fish-agents'> = {
  id: 'fish-agent',
  name: 'Fish Agent',
  api: 'fish-agents',
  provider: 'fish',
  baseUrl: 'https://api.fish.audio',
  type: 'realtime',
  transports: ['webrtc'],
  toolCalls: 'blocking',
  inputFormat: pcm16(24000),
  outputFormat: pcm16(24000),
  maxSessionMs: 1_800_000,
  resumable: false,
  ephemeralAuth: true,
  voices,
  cascade: { stt: 'deepgram:nova-3', llm: 'fish', tts: 's2.1-pro' },
  provisioning: 'agent',
  delivery: { interrupt: 'native', when_idle: 'approximate', silent: 'approximate' },
  truncation: 'server',
  liveToolUpdate: false,
  toolTimeoutMs: { min: 1000, max: 120_000 },
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  audioCost: { perInputMinute: 0 },
};

export function registerFishAgents(options: FishOptions = {}): () => void {
  const unregisterModel = registerVoiceModel(fishAgent);
  const unregisterApi = registerRealtimeApiProvider({
    api: 'fish-agents',
    connect: (model, context, connectOptions) =>
      connectFish(model, context, connectOptions, options),
  });
  return () => {
    unregisterModel();
    unregisterApi();
  };
}

export type { CustomLlm, HostedAgent, HostedAgentSpec, HostedCache } from '../hosted-agent.ts';
export { hashHostedSpec, memoryHostedCache } from '../hosted-agent.ts';
export type { ProvisionOptions } from './provision.ts';
export { agentConfig, httpsOrigin, provisionAgent } from './provision.ts';
export type { FishRoom, FishRoomFactory, FishSdk } from './room.ts';
export { importFishSdk, openFishRoom } from './room.ts';
export type { FishOptions } from './session.ts';
