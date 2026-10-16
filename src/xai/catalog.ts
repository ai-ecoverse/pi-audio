import type { AudioFormat } from '../audio.ts';
import {
  registerVoiceModel,
  type SpeechModel,
  type TranscriptionModel,
  type VoiceInfo,
} from '../models.ts';
import { registerSpeechApiProvider, registerTranscriptionApiProvider } from '../registry.ts';
import { listenXAI } from './listen.ts';
import { speakXAI } from './speak.ts';
import { transcribeXAI } from './transcribe.ts';

const tokenCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const xai = 'https://api.x.ai/v1';

const languages = [
  'ar',
  'bs',
  'bg',
  'yue',
  'ca',
  'zh',
  'hr',
  'cs',
  'da',
  'nl',
  'en',
  'fil',
  'fi',
  'fr',
  'de',
  'el',
  'hi',
  'hu',
  'id',
  'it',
  'ja',
  'ko',
  'mk',
  'ms',
  'nb',
  'fa',
  'pl',
  'pt',
  'ro',
  'ru',
  'sk',
  'es',
  'sv',
  'th',
  'tr',
  'uk',
  'ur',
  'vi',
];

const pcm16 = (sampleRate: number): AudioFormat => ({
  encoding: 'pcm16',
  sampleRate,
  channels: 1,
});

const law = (encoding: 'mulaw' | 'alaw', sampleRate = 8000): AudioFormat => ({
  encoding,
  sampleRate,
  channels: 1,
});

const container = (encoding: 'wav' | 'mp3' | 'flac', sampleRate: number): AudioFormat => ({
  encoding,
  sampleRate,
  channels: 1,
});

const voices: VoiceInfo[] = ['eve', 'ara', 'rex', 'sal', 'leo'].map((id) => ({ id, name: id }));

function xaiCatalog(): Array<TranscriptionModel<string> | SpeechModel<string>> {
  const transcription: TranscriptionModel<string> = {
    id: 'grok-voice-transcribe-2.0',
    name: 'grok-voice-transcribe-2.0',
    api: 'xai-stt',
    provider: 'xai',
    baseUrl: xai,
    type: 'transcription',
    streaming: true,
    turnDetection: 'semantic',
    inputFormats: [
      pcm16(16000),
      pcm16(24000),
      law('mulaw'),
      law('alaw'),
      container('wav', 16000),
      container('mp3', 16000),
      container('flac', 16000),
    ],
    languages,
    diarization: true,
    cost: tokenCost,
    audioCost: { perInputMinute: 0.2 / 60 },
  };
  const speech: SpeechModel<string> = {
    id: 'grok-voice-tts-1.0',
    name: 'grok-voice-tts-1.0',
    api: 'xai-tts',
    provider: 'xai',
    baseUrl: xai,
    type: 'speech',
    textStreaming: true,
    outputFormats: [
      container('mp3', 24000),
      pcm16(24000),
      container('wav', 24000),
      law('mulaw'),
      law('alaw'),
    ],
    voices,
    cloning: false,
    cost: tokenCost,
    audioCost: { perThousandChars: 0.015 },
  };
  return [transcription, speech];
}

export function registerXAI(): () => void {
  const models = xaiCatalog();
  const unregisterModels = models.map((model) => registerVoiceModel(model));
  const unregisterStt = registerTranscriptionApiProvider({
    api: 'xai-stt',
    transcribe: transcribeXAI,
    listen: listenXAI,
  });
  const unregisterTts = registerSpeechApiProvider({ api: 'xai-tts', speak: speakXAI });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const unregister of unregisterModels) unregister();
    unregisterStt();
    unregisterTts();
  };
}
