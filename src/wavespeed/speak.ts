import type { ProviderRequestOptions } from '@earendil-works/pi-ai';
import type { AudioFormat } from '../audio.ts';
import type { SpeechModel } from '../models.ts';
import { asVoiceError } from '../openai/wire.ts';
import { SpeechEventStream, type SpeechInput } from '../speech.ts';
import { priceAudio } from '../usage.ts';
import { finishTask, outputUrl, readHttp } from './wire.ts';

function resolveFormat(
  model: SpeechModel<string>,
  requested: AudioFormat | undefined
): AudioFormat {
  const fallback = model.outputFormats[0];
  if (!fallback) throw new Error('No output format');
  if (!requested) return fallback;
  const match = model.outputFormats.find(
    (format) =>
      format.encoding === requested.encoding &&
      format.sampleRate === requested.sampleRate &&
      format.channels === requested.channels
  );
  if (!match) throw new Error(`Unsupported speech format ${requested.encoding}`);
  return match;
}

async function readText(
  text: string | AsyncIterable<string>,
  signal: AbortSignal | undefined
): Promise<string> {
  if (typeof text === 'string') return text;
  let combined = '';
  for await (const part of text) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    combined += part;
  }
  return combined;
}

async function audioOf(
  model: SpeechModel<string>,
  options: ProviderRequestOptions | undefined,
  output: unknown
): Promise<Uint8Array> {
  const url = outputUrl(output);
  if (url === undefined) throw new Error('Speech response had no audio');
  const response = await readHttp(model, options, url);
  const data = new Uint8Array(await response.arrayBuffer());
  if (data.byteLength === 0) throw new Error('Speech response had no audio');
  return data;
}

export function speakWaveSpeed(
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
    const format = resolveFormat(model, input.format);
    const text = await readText(input.text, options?.signal);
    const payload: Record<string, unknown> = { text, voice_id: input.voice, format: 'mp3' };
    if (input.language !== undefined) payload.language_boost = input.language;
    const record = await finishTask(model, options, payload, 'Speech payload was not JSON');
    const outputs = record.outputs;
    const first = Array.isArray(outputs) ? outputs[0] : undefined;
    const data = await audioOf(model, options, first);
    stream.push({ type: 'start', format });
    stream.push({
      type: 'audio',
      chunk: { data, format, timestamp: 0 },
      span: { itemId: model.id, start: 0, end: text.length },
    });
    stream.push({
      type: 'done',
      usage: priceAudio(model.audioCost, { characters: text.length }),
    });
  } catch (error) {
    const voice = asVoiceError(error);
    stream.push({ type: 'error', reason: voice.reason, error: voice.error });
  }
}
