import type { AudioFormat } from '../audio.ts';
import {
  registerVoiceModel,
  type SpeechModel,
  type TranscriptionModel,
  type VoiceInfo,
} from '../models.ts';
import { registerSpeechApiProvider, registerTranscriptionApiProvider } from '../registry.ts';
import { listenCloudflare } from './listen.ts';
import { speakCloudflare } from './speak.ts';
import { transcribeCloudflare } from './transcribe.ts';

const tokenCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const cloudflare = 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run';

const format = (encoding: AudioFormat['encoding'], sampleRate: number): AudioFormat => ({
  encoding,
  sampleRate,
  channels: 1,
});

const pcm = [format('pcm16', 16000), format('mulaw', 8000)];
const auraOut = [
  format('mp3', 24000),
  format('pcm16', 24000),
  format('mulaw', 8000),
  format('alaw', 8000),
];

function named(ids: string[]): VoiceInfo[] {
  return ids.map((id) => ({ id, name: id }));
}

const aura1Voices = named([
  'angus',
  'asteria',
  'arcas',
  'orion',
  'orpheus',
  'athena',
  'luna',
  'zeus',
  'perseus',
  'helios',
  'hera',
  'stella',
]);

const aura2EnVoices = named([
  'amalthea',
  'andromeda',
  'apollo',
  'arcas',
  'aries',
  'asteria',
  'athena',
  'atlas',
  'aurora',
  'callista',
  'cora',
  'cordelia',
  'delia',
  'draco',
  'electra',
  'harmonia',
  'helena',
  'hera',
  'hermes',
  'hyperion',
  'iris',
  'janus',
  'juno',
  'jupiter',
  'luna',
  'mars',
  'minerva',
  'neptune',
  'odysseus',
  'ophelia',
  'orion',
  'orpheus',
  'pandora',
  'phoebe',
  'pluto',
  'saturn',
  'thalia',
  'theia',
  'vesta',
  'zeus',
]);

const aura2EsVoices = named([
  'sirio',
  'nestor',
  'carina',
  'celeste',
  'alvaro',
  'diana',
  'aquila',
  'selena',
  'estrella',
  'javier',
]);

function transcription(
  id: string,
  streaming: boolean,
  turnDetection: 'none' | 'vad' | 'semantic',
  inputFormats: AudioFormat[],
  perInputMinute: number,
  diarization: boolean
): TranscriptionModel<string> {
  return {
    id,
    name: id,
    api: 'cloudflare-ai-run',
    provider: 'cloudflare',
    baseUrl: cloudflare,
    type: 'transcription',
    streaming,
    turnDetection,
    inputFormats,
    diarization,
    cost: tokenCost,
    audioCost: { perInputMinute },
  };
}

function speech(
  id: string,
  textStreaming: boolean,
  outputFormats: AudioFormat[],
  voices: VoiceInfo[] | undefined,
  audioCost: SpeechModel<string>['audioCost']
): SpeechModel<string> {
  return {
    id,
    name: id,
    api: 'cloudflare-ai-run',
    provider: 'cloudflare',
    baseUrl: cloudflare,
    type: 'speech',
    textStreaming,
    outputFormats,
    voices,
    cost: tokenCost,
    audioCost,
  };
}

export function registerCloudflare(): () => void {
  const models = [
    transcription('@cf/deepgram/nova-3', true, 'vad', pcm, 0.0092, true),
    transcription('@cf/deepgram/flux', true, 'semantic', [format('pcm16', 16000)], 0.0077, false),
    transcription(
      '@cf/openai/whisper-large-v3-turbo',
      false,
      'none',
      [format('pcm16', 16000), format('wav', 16000), format('mp3', 16000)],
      0.000513,
      false
    ),
    speech('@cf/deepgram/aura-1', true, auraOut, aura1Voices, { perThousandChars: 0.015 }),
    speech('@cf/deepgram/aura-2-en', true, auraOut, aura2EnVoices, { perThousandChars: 0.03 }),
    speech('@cf/deepgram/aura-2-es', true, auraOut, aura2EsVoices, { perThousandChars: 0.03 }),
    speech('@cf/myshell-ai/melotts', false, [format('mp3', 24000)], undefined, {
      perOutputMinute: 0.000205,
    }),
  ];
  const unregisterModels = models.map((model) => registerVoiceModel(model));
  const unregisterTranscription = registerTranscriptionApiProvider({
    api: 'cloudflare-ai-run',
    transcribe: transcribeCloudflare,
    listen: listenCloudflare,
  });
  const unregisterSpeech = registerSpeechApiProvider({
    api: 'cloudflare-ai-run',
    speak: speakCloudflare,
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
