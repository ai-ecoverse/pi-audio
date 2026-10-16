import type { AudioFormat } from '../audio.ts';
import { registerVoiceModel, type SpeechModel, type VoiceInfo } from '../models.ts';
import { registerSpeechApiProvider } from '../registry.ts';
import { speakGoogle } from './speak.ts';

const tokenCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const google = 'https://generativelanguage.googleapis.com/v1beta';

const format = (encoding: 'wav' | 'pcm16' | 'mulaw' | 'alaw', sampleRate: number): AudioFormat => ({
  encoding,
  sampleRate,
  channels: 1,
});

const outputFormats = [
  format('wav', 24000),
  format('pcm16', 24000),
  format('mulaw', 8000),
  format('alaw', 8000),
];

const voices: VoiceInfo[] = [
  { id: 'Kore', name: 'Kore' },
  { id: 'Puck', name: 'Puck' },
  { id: 'Charon', name: 'Charon' },
  { id: 'Fenrir', name: 'Fenrir' },
  { id: 'Aoede', name: 'Aoede' },
];

function speechModel(id: string, perOutputMinute: number): SpeechModel<string> {
  return {
    id,
    name: id,
    api: 'google-tts',
    provider: 'google',
    baseUrl: google,
    type: 'speech',
    textStreaming: false,
    outputFormats,
    voices,
    cloning: true,
    cost: tokenCost,
    audioCost: { perOutputMinute },
  };
}

export function registerGoogle(): () => void {
  const models = [
    speechModel('gemini-3.8-flash-tts', (25 * 9 * 60) / 1_000_000),
    speechModel('gemini-3.8-flash-lite-tts', (25 * 6 * 60) / 1_000_000),
  ];
  const unregisterModels = models.map((model) => registerVoiceModel(model));
  const unregisterSpeech = registerSpeechApiProvider({
    api: 'google-tts',
    speak: speakGoogle,
  });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const unregister of unregisterModels) unregister();
    unregisterSpeech();
  };
}
