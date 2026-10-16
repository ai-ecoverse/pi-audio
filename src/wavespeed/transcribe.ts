import type { ProviderRequestOptions } from '@earendil-works/pi-ai';
import { VoiceRequestError } from '../errors.ts';
import type { TranscriptionModel } from '../models.ts';
import {
  asVoiceError,
  audioFile,
  encodeMultipart,
  endpoint,
  multipartType,
} from '../openai/wire.ts';
import type { AudioInput, Transcript } from '../transcription.ts';
import { type AudioCounters, priceAudio } from '../usage.ts';
import {
  downloadUrl,
  durationSeconds,
  finishTask,
  isHttpUrl,
  outputText,
  readHttp,
  waveFetch,
} from './wire.ts';

async function sourceUrl(
  model: TranscriptionModel<string>,
  input: AudioInput,
  options: ProviderRequestOptions | undefined
): Promise<string> {
  if ('url' in input) return input.url;
  const named = audioFile(input.mimeType);
  const encoded = encodeMultipart(
    { data: input.data, mimeType: input.mimeType, filename: named.filename, format: named.format },
    {}
  );
  const copy = new Uint8Array(encoded.byteLength);
  copy.set(encoded);
  const parsed = await waveFetch(
    model,
    options,
    endpoint(model.baseUrl, 'media/upload/binary'),
    copy.buffer,
    multipartType()
  );
  return downloadUrl(parsed);
}

async function textOf(
  model: TranscriptionModel<string>,
  options: ProviderRequestOptions | undefined,
  output: unknown
): Promise<string> {
  if (typeof output === 'string' && isHttpUrl(output)) {
    const response = await readHttp(model, options, output);
    const text = await response.text();
    if (text === '') throw new Error('Transcription response had no text');
    return text;
  }
  const text = outputText(output);
  if (text === undefined || text === '' || isHttpUrl(text)) {
    throw new Error('Transcription response had no text');
  }
  return text;
}

function languageOf(options: ProviderRequestOptions | undefined): string | undefined {
  const record = options as { language?: unknown } | undefined;
  if (record === undefined) return undefined;
  if (typeof record.language !== 'string') return undefined;
  return record.language;
}

export async function transcribeWaveSpeed(
  model: TranscriptionModel<string>,
  input: AudioInput,
  options?: ProviderRequestOptions
): Promise<Transcript> {
  try {
    if (options?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const audio = await sourceUrl(model, input, options);
    const payload: Record<string, unknown> = {
      audio,
      task: 'transcribe',
      enable_timestamps: false,
    };
    const language = languageOf(options);
    if (language !== undefined) payload.language = language;
    const record = await finishTask(model, options, payload, 'Transcription payload was not JSON');
    const outputs = record.outputs;
    const first = Array.isArray(outputs) ? outputs[0] : undefined;
    const text = await textOf(model, options, first);
    const meters: AudioCounters = {};
    const seconds = durationSeconds(record);
    if (seconds > 0) meters.inputSeconds = seconds;
    const transcript: Transcript = { text, usage: priceAudio(model.audioCost, meters) };
    if (language !== undefined) transcript.language = language;
    return transcript;
  } catch (error) {
    const voice = asVoiceError(error);
    throw new VoiceRequestError(voice.reason, voice.error);
  }
}
