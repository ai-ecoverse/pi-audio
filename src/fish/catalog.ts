import type { AudioFormat } from '../audio.ts';
import { registerVoiceModel, type SpeechModel, type TranscriptionModel } from '../models.ts';
import { registerSpeechApiProvider, registerTranscriptionApiProvider } from '../registry.ts';
import { speakFish } from './speak.ts';
import { transcribeFish } from './transcribe.ts';

const tokenCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const fish = 'https://api.fish.audio/v1';

const container = (
  encoding: 'wav' | 'mp3' | 'flac' | 'opus' | 'pcm16',
  sampleRate: number
): AudioFormat => ({
  encoding,
  sampleRate,
  channels: 1,
});

const outputFormats = [
  container('pcm16', 44100),
  container('wav', 44100),
  container('mp3', 44100),
  container('opus', 48000),
];

function speechModel(id: string, perThousandChars: number): SpeechModel<string> {
  return {
    id,
    name: id,
    api: 'fish-tts',
    provider: 'fish',
    baseUrl: fish,
    type: 'speech',
    textStreaming: true,
    outputFormats,
    cloning: true,
    cost: tokenCost,
    audioCost: { perThousandChars },
  };
}

function fishCatalog(): Array<TranscriptionModel<string> | SpeechModel<string>> {
  const batch: TranscriptionModel<string> = {
    id: 'transcribe-1-pro',
    name: 'transcribe-1-pro',
    api: 'fish-asr',
    provider: 'fish',
    baseUrl: fish,
    type: 'transcription',
    streaming: false,
    turnDetection: 'none',
    inputFormats: [
      container('wav', 16000),
      container('mp3', 16000),
      container('flac', 16000),
      container('opus', 16000),
    ],
    diarization: true,
    cost: tokenCost,
    audioCost: { perInputMinute: 0.36 / 60 },
  };
  return [batch, speechModel('s2.1-pro', 0.015), speechModel('s2.1-pro-free', 0)];
}

export function registerFish(): () => void {
  const models = fishCatalog();
  const unregisterModels = models.map((model) => registerVoiceModel(model));
  const unregisterTranscription = registerTranscriptionApiProvider({
    api: 'fish-asr',
    transcribe: transcribeFish,
  });
  const unregisterSpeech = registerSpeechApiProvider({
    api: 'fish-tts',
    speak: speakFish,
  });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const unregister of unregisterModels) unregister();
    unregisterTranscription();
    unregisterSpeech();
  };
}
