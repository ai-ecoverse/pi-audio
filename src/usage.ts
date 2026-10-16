import type { Usage } from '@earendil-works/pi-ai';

export interface AudioCounters {
  inputSeconds?: number;
  outputSeconds?: number;
  characters?: number;
  textMessages?: number;
}

export interface TranscriptionAudioCost {
  perInputMinute?: number;
}

export interface SpeechAudioCost {
  perThousandChars?: number;
  perOutputMinute?: number;
}

export interface RealtimeAudioCost {
  perInputMinute?: number;
  perOutputMinute?: number;
  perTextMessage?: number;
}

export type AudioCost = TranscriptionAudioCost & SpeechAudioCost & RealtimeAudioCost;

declare module '@earendil-works/pi-ai' {
  interface Usage {
    audio?: AudioCounters;
  }
}

export type AudioUsage = Usage;

const audioKeys = ['inputSeconds', 'outputSeconds', 'characters', 'textMessages'] as const;

export function priceAudio(rates: AudioCost, meters: AudioCounters): AudioUsage {
  const audio: AudioCounters = {};
  for (const key of audioKeys) {
    const value = meters[key];
    if (value !== undefined) audio[key] = value;
  }
  const input =
    ((meters.inputSeconds ?? 0) / 60) * (rates.perInputMinute ?? 0) +
    (meters.textMessages ?? 0) * (rates.perTextMessage ?? 0);
  const output =
    ((meters.outputSeconds ?? 0) / 60) * (rates.perOutputMinute ?? 0) +
    ((meters.characters ?? 0) / 1000) * (rates.perThousandChars ?? 0);
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    audio,
    cost: { input, output, cacheRead: 0, cacheWrite: 0, total: input + output },
  };
}

export function addAudioCounters(total: AudioUsage, usage: AudioUsage): void {
  if (usage.audio === undefined) return;
  const audio = total.audio ?? {};
  total.audio = audio;
  for (const key of audioKeys) {
    const value = usage.audio[key];
    if (value !== undefined) audio[key] = (audio[key] ?? 0) + value;
  }
}
