import type { AudioFormat } from '../audio.ts';
import { registerVoiceModel, type SpeechModel, type TranscriptionModel } from '../models.ts';
import { registerSpeechApiProvider, registerTranscriptionApiProvider } from '../registry.ts';
import { speakWaveSpeed } from './speak.ts';
import { transcribeWaveSpeed } from './transcribe.ts';

const tokenCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const wavespeed = 'https://api.wavespeed.ai/api/v3';

const format = (encoding: 'wav' | 'mp3' | 'flac', sampleRate: number): AudioFormat => ({
  encoding,
  sampleRate,
  channels: 1,
});

export function registerWaveSpeed(): () => void {
  const whisper: TranscriptionModel<string> = {
    id: 'wavespeed-ai/openai-whisper',
    name: 'wavespeed-ai/openai-whisper',
    api: 'wavespeed',
    provider: 'wavespeed',
    baseUrl: wavespeed,
    type: 'transcription',
    streaming: false,
    turnDetection: 'none',
    inputFormats: [format('wav', 16000), format('mp3', 16000), format('flac', 16000)],
    cost: tokenCost,
    audioCost: { perInputMinute: 0.06 },
  };
  const speech: SpeechModel<string> = {
    id: 'minimax/speech-2.6-turbo',
    name: 'minimax/speech-2.6-turbo',
    api: 'wavespeed',
    provider: 'wavespeed',
    baseUrl: wavespeed,
    type: 'speech',
    textStreaming: false,
    outputFormats: [format('mp3', 24000)],
    cloning: true,
    cost: tokenCost,
    audioCost: { perThousandChars: 0.06 },
  };
  const unregisterModels = [registerVoiceModel(whisper), registerVoiceModel(speech)];
  const unregisterTranscription = registerTranscriptionApiProvider({
    api: 'wavespeed',
    transcribe: transcribeWaveSpeed,
  });
  const unregisterSpeech = registerSpeechApiProvider({
    api: 'wavespeed',
    speak: speakWaveSpeed,
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
