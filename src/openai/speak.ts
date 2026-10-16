import type { ProviderRequestOptions } from '@earendil-works/pi-ai';
import type { AudioFormat } from '../audio.ts';
import { VoiceRequestError } from '../errors.ts';
import type { SpeechModel } from '../models.ts';
import { SpeechEventStream, type SpeechInput } from '../speech.ts';
import { type AudioCounters, priceAudio } from '../usage.ts';
import {
  applyPayload,
  asVoiceError,
  endpoint,
  isOpenRouter,
  isRecord,
  voiceFetch,
} from './wire.ts';

function sameFormat(left: AudioFormat, right: AudioFormat): boolean {
  return (
    left.encoding === right.encoding &&
    left.sampleRate === right.sampleRate &&
    left.channels === right.channels
  );
}

function resolveSpeechFormat(
  model: SpeechModel<string>,
  requested: AudioFormat | undefined
): AudioFormat {
  const fallback = model.outputFormats[0];
  if (!fallback) throw new Error('No output format');
  if (!requested) return fallback;
  const match = model.outputFormats.find((format) => sameFormat(format, requested));
  if (!match) throw new Error(`Unsupported speech format ${requested.encoding}`);
  return match;
}

function speechResponseFormat(encoding: AudioFormat['encoding'], openRouter: boolean): string {
  if (encoding === 'pcm16') return 'pcm';
  if (encoding === 'mp3') return 'mp3';
  if (openRouter) throw new Error(`OpenRouter speech cannot return ${encoding}`);
  if (encoding === 'wav' || encoding === 'opus' || encoding === 'flac') return encoding;
  throw new Error(`OpenAI speech cannot return ${encoding}`);
}

function outputSeconds(format: AudioFormat, byteLength: number): number | undefined {
  if (format.encoding !== 'pcm16') return undefined;
  const width = format.sampleRate * format.channels * 2;
  return width > 0 ? byteLength / width : 0;
}

async function readText(
  text: SpeechInput['text'],
  signal: AbortSignal | undefined
): Promise<string> {
  if (typeof text === 'string') return text;
  let combined = '';
  for await (const part of text) {
    if (signal?.aborted) throw new VoiceRequestError('aborted', 'aborted');
    combined += part;
  }
  return combined;
}

export function speakOpenAI(
  model: SpeechModel<string>,
  input: SpeechInput,
  options?: ProviderRequestOptions
): SpeechEventStream {
  const stream = new SpeechEventStream();
  void pumpSpeech(model, input, options, stream);
  return stream;
}

async function pumpSpeech(
  model: SpeechModel<string>,
  input: SpeechInput,
  options: ProviderRequestOptions | undefined,
  stream: SpeechEventStream
) {
  try {
    if (options?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const format = resolveSpeechFormat(model, input.format);
    const openRouter = isOpenRouter(model);
    const responseFormat = speechResponseFormat(format.encoding, openRouter);
    const text = await readText(input.text, options?.signal);
    const payload: Record<string, unknown> = {
      model: model.id,
      input: text,
      voice: input.voice,
      response_format: responseFormat,
    };
    if (input.instructions !== undefined) payload.instructions = input.instructions;
    const body = await applyPayload(payload, model, options);
    if (!isRecord(body)) throw new Error('Speech payload was not JSON');
    const response = await voiceFetch(
      model,
      options,
      endpoint(model.baseUrl, 'audio/speech'),
      JSON.stringify(body),
      'application/json'
    );
    const data = new Uint8Array(await response.arrayBuffer());
    const seconds = outputSeconds(format, data.length);
    const meters: AudioCounters = { characters: text.length };
    if (seconds !== undefined) meters.outputSeconds = seconds;
    stream.push({ type: 'start', format });
    stream.push({
      type: 'audio',
      chunk: { data, format, timestamp: 0 },
      span: { itemId: model.id, start: 0, end: text.length },
    });
    stream.push({ type: 'done', usage: priceAudio(model.audioCost, meters) });
  } catch (error) {
    const voice = asVoiceError(error);
    stream.push({ type: 'error', reason: voice.reason, error: voice.error });
  }
}
