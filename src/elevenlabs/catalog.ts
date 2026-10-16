import type { AudioFormat } from '../audio.ts';
import {
  registerVoiceModel,
  type SpeechModel,
  type TranscriptionModel,
  type VoiceInfo,
} from '../models.ts';
import { registerSpeechApiProvider, registerTranscriptionApiProvider } from '../registry.ts';
import { listenElevenLabs } from './listen.ts';
import { speakElevenLabs } from './speak.ts';
import { transcribeElevenLabs } from './transcribe.ts';

const tokenCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const eleven = 'https://api.elevenlabs.io/v1';

const pcm16 = (sampleRate: number): AudioFormat => ({
  encoding: 'pcm16',
  sampleRate,
  channels: 1,
});

const law = (encoding: 'mulaw' | 'alaw'): AudioFormat => ({
  encoding,
  sampleRate: 8000,
  channels: 1,
});

const container = (encoding: 'wav' | 'mp3' | 'flac' | 'opus', sampleRate: number): AudioFormat => ({
  encoding,
  sampleRate,
  channels: 1,
});

const voices: VoiceInfo[] = [
  { id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel' },
  { id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam' },
  { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Bella' },
  { id: 'ErXwobaYiN019PkySvjV', name: 'Antoni' },
  { id: 'TxGEqnHWrfWFTfGW9XjX', name: 'Josh' },
];

const speechFormats: AudioFormat[] = [
  container('mp3', 44100),
  container('mp3', 24000),
  container('mp3', 22050),
  pcm16(16000),
  pcm16(24000),
  pcm16(8000),
  container('wav', 16000),
  law('mulaw'),
  law('alaw'),
  container('opus', 48000),
];

function speech(id: string, textStreaming: boolean, perThousandChars: number): SpeechModel<string> {
  return {
    id,
    name: id,
    api: 'elevenlabs-tts',
    provider: 'elevenlabs',
    baseUrl: eleven,
    type: 'speech',
    textStreaming,
    outputFormats: speechFormats,
    voices,
    cloning: true,
    cost: tokenCost,
    audioCost: { perThousandChars },
  };
}

function elevenCatalog(): Array<TranscriptionModel<string> | SpeechModel<string>> {
  const batch: TranscriptionModel<string> = {
    id: 'scribe_v2',
    name: 'scribe_v2',
    api: 'elevenlabs-scribe',
    provider: 'elevenlabs',
    baseUrl: eleven,
    type: 'transcription',
    streaming: false,
    turnDetection: 'none',
    inputFormats: [
      container('wav', 16000),
      container('mp3', 16000),
      container('flac', 16000),
      pcm16(16000),
      law('mulaw'),
    ],
    diarization: true,
    cost: tokenCost,
    audioCost: { perInputMinute: 0.22 / 60 },
  };
  const realtime: TranscriptionModel<string> = {
    id: 'scribe_v2_realtime',
    name: 'scribe_v2_realtime',
    api: 'elevenlabs-scribe',
    provider: 'elevenlabs',
    baseUrl: eleven,
    type: 'transcription',
    streaming: true,
    turnDetection: 'semantic',
    inputFormats: [
      pcm16(8000),
      pcm16(16000),
      pcm16(22050),
      pcm16(24000),
      pcm16(44100),
      pcm16(48000),
      law('mulaw'),
    ],
    diarization: true,
    cost: tokenCost,
    audioCost: { perInputMinute: 0.39 / 60 },
  };
  return [
    batch,
    realtime,
    speech('eleven_flash_v2_5', true, 0.05),
    speech('eleven_multilingual_v2', true, 0.1),
    speech('eleven_v3', false, 0.1),
    speech('eleven_v4', false, 0.1),
  ];
}

export function registerElevenLabs(): () => void {
  const models = elevenCatalog();
  const unregisterModels = models.map((model) => registerVoiceModel(model));
  const unregisterScribe = registerTranscriptionApiProvider({
    api: 'elevenlabs-scribe',
    transcribe: transcribeElevenLabs,
    listen: listenElevenLabs,
  });
  const unregisterSpeech = registerSpeechApiProvider({
    api: 'elevenlabs-tts',
    speak: speakElevenLabs,
  });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const unregister of unregisterModels) unregister();
    unregisterScribe();
    unregisterSpeech();
  };
}
