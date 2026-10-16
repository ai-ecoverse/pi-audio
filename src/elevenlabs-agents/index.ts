import type { RealtimeModel } from '../models.ts';
import { registerVoiceModel } from '../models.ts';
import { registerRealtimeApiProvider } from '../registry.ts';
import type { ElevenLabsOptions } from './session.ts';
import { connectElevenLabs } from './session.ts';

const voices = [
  { id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel' },
  { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah' },
  { id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam' },
];

function pcm16(sampleRate: number) {
  return { encoding: 'pcm16' as const, sampleRate, channels: 1 as const };
}

export const elevenLabsAgent: RealtimeModel<'elevenlabs-agents'> = {
  id: 'elevenlabs-agent',
  name: 'ElevenLabs Agent',
  api: 'elevenlabs-agents',
  provider: 'elevenlabs',
  baseUrl: 'wss://api.elevenlabs.io/v1/convai/conversation',
  type: 'realtime',
  transports: ['websocket'],
  toolCalls: 'blocking',
  inputFormat: pcm16(16000),
  outputFormat: pcm16(16000),
  maxSessionMs: 600_000,
  resumable: false,
  ephemeralAuth: true,
  voices,
  cascade: { stt: 'scribe_realtime', llm: 'gemini-2.5-flash', tts: 'eleven_flash_v2_5' },
  provisioning: 'agent',
  delivery: { interrupt: 'approximate', when_idle: 'approximate', silent: 'native' },
  truncation: 'server',
  liveToolUpdate: false,
  toolTimeoutMs: { min: 1000, max: 120_000 },
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  audioCost: { perInputMinute: 0.08 },
};

export function registerElevenLabsAgents(options: ElevenLabsOptions = {}): () => void {
  const unregisterModel = registerVoiceModel(elevenLabsAgent);
  const unregisterApi = registerRealtimeApiProvider({
    api: 'elevenlabs-agents',
    connect: (model, context, connectOptions) =>
      connectElevenLabs(model, context, connectOptions, options),
  });
  return () => {
    unregisterModel();
    unregisterApi();
  };
}

export type { CustomLlm, HostedAgent, HostedAgentSpec, HostedCache } from '../hosted-agent.ts';
export { hashHostedSpec, memoryHostedCache } from '../hosted-agent.ts';
export type { ProvisionOptions } from './provision.ts';
export { agentBody, httpsOrigin, provisionAgent } from './provision.ts';
export type { ElevenLabsOptions, VoiceWireFactory } from './session.ts';
