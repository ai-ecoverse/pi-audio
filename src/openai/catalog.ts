import type { AudioFormat } from '../audio.ts';
import {
  registerVoiceModel,
  type SpeechModel,
  type TranscriptionModel,
  type VoiceInfo,
} from '../models.ts';
import { registerSpeechApiProvider, registerTranscriptionApiProvider } from '../registry.ts';
import { listenOpenAI } from './listen.ts';
import { speakOpenAI } from './speak.ts';
import { transcribeOpenAI } from './transcribe.ts';

const tokenCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const openai = 'https://api.openai.com/v1';
const openrouter = 'https://openrouter.ai/api/v1';

const pcm24: AudioFormat = { encoding: 'pcm16', sampleRate: 24000, channels: 1 };
const fileFormats: AudioFormat[] = [
  { encoding: 'wav', sampleRate: 16000, channels: 1 },
  { encoding: 'mp3', sampleRate: 16000, channels: 1 },
  { encoding: 'flac', sampleRate: 16000, channels: 1 },
];
const openAISpeechFormats: AudioFormat[] = [
  pcm24,
  { encoding: 'mp3', sampleRate: 24000, channels: 1 },
  { encoding: 'wav', sampleRate: 24000, channels: 1 },
  { encoding: 'opus', sampleRate: 24000, channels: 1 },
  { encoding: 'flac', sampleRate: 24000, channels: 1 },
];
const openRouterSpeechFormats: AudioFormat[] = [
  pcm24,
  { encoding: 'mp3', sampleRate: 24000, channels: 1 },
];

const classicVoices = ['alloy', 'ash', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer'];
const miniVoices = [...classicVoices, 'ballad', 'verse', 'marin', 'cedar'];

function voices(ids: string[]): VoiceInfo[] {
  return ids.map((id) => ({ id, name: id }));
}

function transcription(
  id: string,
  provider: string,
  baseUrl: string,
  perInputMinute: number,
  streaming: boolean,
  turnDetection: TranscriptionModel<string>['turnDetection'],
  inputFormats: AudioFormat[]
): TranscriptionModel<string> {
  return {
    id,
    name: id,
    api: streaming ? 'openai-realtime-transcription' : 'openai-transcriptions',
    provider,
    baseUrl,
    type: 'transcription',
    streaming,
    turnDetection,
    inputFormats,
    cost: tokenCost,
    audioCost: { perInputMinute },
  };
}

function speech(
  id: string,
  provider: string,
  baseUrl: string,
  outputFormats: AudioFormat[],
  voiceIds: string[],
  audioCost: SpeechModel<string>['audioCost']
): SpeechModel<string> {
  return {
    id,
    name: id,
    api: 'openai-speech',
    provider,
    baseUrl,
    type: 'speech',
    textStreaming: false,
    outputFormats,
    voices: voices(voiceIds),
    cloning: false,
    cost: tokenCost,
    audioCost,
  };
}

function openAICatalog(): Array<TranscriptionModel<string> | SpeechModel<string>> {
  return [
    transcription('whisper-1', 'openai', openai, 0.006, false, 'none', fileFormats),
    transcription('gpt-4o-transcribe', 'openai', openai, 0.006, false, 'none', fileFormats),
    transcription('gpt-4o-mini-transcribe', 'openai', openai, 0.003, false, 'none', fileFormats),
    transcription('gpt-realtime-whisper', 'openai', openai, 0.017, true, 'vad', [pcm24]),
    transcription('gpt-live-transcribe', 'openai', openai, 0.017, true, 'none', [pcm24]),
    transcription('openai/whisper-1', 'openrouter', openrouter, 0.006, false, 'none', fileFormats),
    transcription(
      'openai/whisper-large-v3',
      'openrouter',
      openrouter,
      0.006,
      false,
      'none',
      fileFormats
    ),
    speech('tts-1', 'openai', openai, openAISpeechFormats, classicVoices, {
      perThousandChars: 0.015,
    }),
    speech('tts-1-hd', 'openai', openai, openAISpeechFormats, classicVoices, {
      perThousandChars: 0.03,
    }),
    speech('gpt-4o-mini-tts', 'openai', openai, openAISpeechFormats, miniVoices, {
      perThousandChars: 0.00015,
      perOutputMinute: 0.015,
    }),
    speech(
      'openai/gpt-4o-mini-tts-2025-12-15',
      'openrouter',
      openrouter,
      openRouterSpeechFormats,
      miniVoices,
      { perThousandChars: 0.00015, perOutputMinute: 0.015 }
    ),
  ];
}

export function registerOpenAI(): () => void {
  const models = openAICatalog();
  const unregisterModels = models.map((model) => registerVoiceModel(model));
  const unregisterBatch = registerTranscriptionApiProvider({
    api: 'openai-transcriptions',
    transcribe: transcribeOpenAI,
  });
  const unregisterRealtime = registerTranscriptionApiProvider({
    api: 'openai-realtime-transcription',
    listen: listenOpenAI,
  });
  const unregisterSpeech = registerSpeechApiProvider({ api: 'openai-speech', speak: speakOpenAI });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const unregister of unregisterModels) unregister();
    unregisterBatch();
    unregisterRealtime();
    unregisterSpeech();
  };
}
