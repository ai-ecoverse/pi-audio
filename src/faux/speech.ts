import type { ProviderRequestOptions } from '@earendil-works/pi-ai';
import type { AudioFormat, CharAlignment } from '../audio.ts';
import { blankUsage } from '../blank-usage.ts';
import { VoiceRequestError } from '../errors.ts';
import { registerVoiceModel, type SpeechModel } from '../models.ts';
import { registerSpeechApiProvider } from '../registry.ts';
import { SpeechEventStream, type SpeechInput } from '../speech.ts';
import { encodeChars, errorMessage, modelKey, pcm, shareApi, zeroCost } from './shared.ts';

export interface FauxSpeechOptions {
  api?: string;
  provider?: string;
  id?: string;
  name?: string;
  alignment?: boolean;
  chunkChars?: number;
  textStreaming?: boolean;
}

export interface FauxSpeech {
  model: SpeechModel<string>;
  calls: SpeechInput[];
  setAlignment(alignment: boolean): void;
  unregister(): void;
}

interface SpeechState {
  model: SpeechModel<string>;
  alignment: boolean;
  chunkChars: number;
  calls: SpeechInput[];
}

const states = new Map<string, SpeechState>();
const apis = new Map<string, () => void>();

export function registerFauxSpeech(options: FauxSpeechOptions = {}): FauxSpeech {
  const model: SpeechModel<string> = {
    id: options.id ?? 'faux-speech',
    name: options.name ?? 'Faux speech',
    api: options.api ?? 'faux-speech',
    provider: options.provider ?? 'faux',
    baseUrl: 'http://localhost:0',
    type: 'speech',
    textStreaming: options.textStreaming ?? true,
    outputFormats: [pcm()],
    voices: [{ id: 'faux', name: 'Faux', languages: ['en'] }],
    cloning: false,
    cost: zeroCost,
  };
  const state: SpeechState = {
    model,
    alignment: options.alignment ?? false,
    chunkChars: Math.max(1, options.chunkChars ?? 4),
    calls: [],
  };
  states.set(modelKey(model), state);
  const unregisterModel = registerVoiceModel(model);
  const release = shareApi(
    apis,
    model.api,
    () => registerSpeechApiProvider({ api: model.api, speak: speakFaux }),
    () => [...states.values()].some((entry) => entry.model.api === model.api)
  );
  return {
    model,
    calls: state.calls,
    setAlignment(alignment) {
      state.alignment = alignment;
    },
    unregister() {
      if (states.get(modelKey(model)) === state) states.delete(modelKey(model));
      unregisterModel();
      release();
    },
  };
}

function speakFaux(
  model: SpeechModel<string>,
  input: SpeechInput,
  options?: ProviderRequestOptions
): SpeechEventStream {
  const stream = new SpeechEventStream();
  const state = states.get(modelKey(model));
  if (!state) {
    stream.push({
      type: 'error',
      reason: 'error',
      error: `Unknown faux speech model ${model.provider}/${model.id}`,
    });
    return stream;
  }
  state.calls.push(input);
  void pumpSpeech(state, input, options, stream);
  return stream;
}

async function readText(input: SpeechInput, signal: AbortSignal | undefined): Promise<string> {
  if (typeof input.text === 'string') return input.text;
  let text = '';
  for await (const part of input.text) {
    if (signal?.aborted) throw new VoiceRequestError('aborted', 'aborted');
    text += part;
  }
  return text;
}

function alignmentFor(start: number, length: number): CharAlignment {
  const startMs = [];
  const durationMs = [];
  for (let offset = 0; offset < length; offset++) {
    startMs.push((start + offset) * 20);
    durationMs.push(20);
  }
  return { startMs, durationMs };
}

async function pumpSpeech(
  state: SpeechState,
  input: SpeechInput,
  options: ProviderRequestOptions | undefined,
  stream: SpeechEventStream
) {
  try {
    if (options?.signal?.aborted) throw new VoiceRequestError('aborted', 'aborted');
    const text = await readText(input, options?.signal);
    const format: AudioFormat | undefined = input.format ?? state.model.outputFormats[0];
    if (!format) throw new Error('No output format');
    stream.push({ type: 'start', format });
    for (let start = 0; start < text.length; start += state.chunkChars) {
      const slice = text.slice(start, start + state.chunkChars);
      stream.push({
        type: 'audio',
        chunk: { data: encodeChars(slice), format, timestamp: start * 20 },
        span: { itemId: state.model.id, start, end: start + slice.length },
        ...(state.alignment ? { alignment: alignmentFor(start, slice.length) } : {}),
      });
    }
    stream.push({ type: 'done', usage: blankUsage() });
  } catch (error) {
    const reason = error instanceof VoiceRequestError ? error.reason : 'error';
    stream.push({ type: 'error', reason, error: errorMessage(error) });
  }
}
