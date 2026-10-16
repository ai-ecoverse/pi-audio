import type { AudioFormat } from '../audio.ts';
import {
  registerVoiceModel,
  type SpeechModel,
  type TranscriptionModel,
  type VoiceInfo,
} from '../models.ts';
import { registerSpeechApiProvider, registerTranscriptionApiProvider } from '../registry.ts';
import { listenMistral } from './listen.ts';
import { speakMistral } from './speak.ts';
import { transcribeMistral } from './transcribe.ts';

const tokenCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const mistral = 'https://api.mistral.ai/v1';
const languages = ['en', 'zh', 'hi', 'es', 'ar', 'fr', 'pt', 'ru', 'de', 'ja', 'ko', 'it', 'nl'];

const pcm16 = (sampleRate: number): AudioFormat => ({
  encoding: 'pcm16',
  sampleRate,
  channels: 1,
});

const container = (
  encoding: 'wav' | 'mp3' | 'flac' | 'opus' | 'pcmf32',
  sampleRate: number
): AudioFormat => ({
  encoding,
  sampleRate,
  channels: 1,
});

const voices: VoiceInfo[] = [
  { id: 'en_paul_neutral', name: 'Paul', languages: ['en'] },
  { id: 'gb_jane_neutral', name: 'Jane', languages: ['en'] },
  { id: 'gb_oliver_neutral', name: 'Oliver', languages: ['en'] },
  { id: 'fr_marie_neutral', name: 'Marie', languages: ['fr'] },
];

function mistralCatalog(): Array<TranscriptionModel<string> | SpeechModel<string>> {
  const batch: TranscriptionModel<string> = {
    id: 'voxtral-mini-latest',
    name: 'voxtral-mini-latest',
    api: 'mistral-transcriptions',
    provider: 'mistral',
    baseUrl: mistral,
    type: 'transcription',
    streaming: false,
    turnDetection: 'none',
    inputFormats: [
      container('wav', 16000),
      container('mp3', 16000),
      container('flac', 16000),
      pcm16(16000),
    ],
    languages,
    diarization: true,
    cost: tokenCost,
    audioCost: { perInputMinute: 0.003 },
  };
  const realtime: TranscriptionModel<string> = {
    id: 'voxtral-mini-transcribe-realtime-2602',
    name: 'voxtral-mini-transcribe-realtime-2602',
    api: 'mistral-transcriptions',
    provider: 'mistral',
    baseUrl: mistral,
    type: 'transcription',
    streaming: true,
    turnDetection: 'none',
    inputFormats: [pcm16(16000)],
    languages,
    diarization: false,
    cost: tokenCost,
    audioCost: { perInputMinute: 0.006 },
  };
  const speech: SpeechModel<string> = {
    id: 'voxtral-mini-tts-2603',
    name: 'voxtral-mini-tts-2603',
    api: 'mistral-speech',
    provider: 'mistral',
    baseUrl: mistral,
    type: 'speech',
    textStreaming: false,
    outputFormats: [
      container('pcmf32', 24000),
      container('mp3', 24000),
      container('wav', 24000),
      container('flac', 24000),
      container('opus', 24000),
    ],
    voices,
    cloning: true,
    cost: tokenCost,
    audioCost: { perThousandChars: 0.016 },
  };
  return [batch, realtime, speech];
}

export function registerMistral(): () => void {
  const models = mistralCatalog();
  const unregisterModels = models.map((model) => registerVoiceModel(model));
  const unregisterTranscription = registerTranscriptionApiProvider({
    api: 'mistral-transcriptions',
    transcribe: transcribeMistral,
    listen: listenMistral,
  });
  const unregisterSpeech = registerSpeechApiProvider({
    api: 'mistral-speech',
    speak: speakMistral,
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
