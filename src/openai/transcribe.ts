import type { ProviderRequestOptions } from '@earendil-works/pi-ai';
import { VoiceRequestError } from '../errors.ts';
import type { TranscriptionModel } from '../models.ts';
import type { AudioInput, Transcript, TranscriptSegment } from '../transcription.ts';
import { priceAudio } from '../usage.ts';
import {
  type AudioFile,
  applyPayload,
  asVoiceError,
  audioFile,
  audioPayload,
  encodeMultipart,
  endpoint,
  isOpenRouter,
  isRecord,
  multipartType,
  numberField,
  readAudio,
  readJson,
  requestSignal,
  stringField,
  voiceFetch,
} from './wire.ts';

function durationSeconds(record: Record<string, unknown>): number {
  const usage = record.usage;
  if (isRecord(usage)) {
    const seconds = numberField(usage, 'seconds');
    if (seconds !== undefined) return seconds;
  }
  const duration = numberField(record, 'duration');
  return duration === undefined ? 0 : duration;
}

function fieldText(segment: Record<string, unknown>): string {
  const text = stringField(segment, 'text');
  return text === undefined ? '' : text;
}

function fieldNumber(segment: Record<string, unknown>, key: string): number {
  const value = numberField(segment, key);
  return value === undefined ? 0 : value;
}

function segmentFrom(segment: Record<string, unknown>): TranscriptSegment {
  const speaker = stringField(segment, 'speaker');
  const mapped: TranscriptSegment = {
    text: fieldText(segment),
    start: fieldNumber(segment, 'start'),
    end: fieldNumber(segment, 'end'),
  };
  if (speaker !== undefined) mapped.speaker = speaker;
  return mapped;
}

function transcriptFrom(
  body: unknown,
  model: TranscriptionModel<string>,
  seconds: number
): Transcript {
  if (!isRecord(body)) throw new Error('Transcription response had no text');
  const text = stringField(body, 'text');
  if (text === undefined) throw new Error('Transcription response had no text');
  const language = stringField(body, 'language');
  const segments = Array.isArray(body.segments)
    ? body.segments.filter(isRecord).map(segmentFrom)
    : undefined;
  return {
    text,
    ...(language !== undefined ? { language } : {}),
    ...(segments !== undefined ? { segments } : {}),
    usage: priceAudio(model.audioCost, { inputSeconds: seconds }),
  };
}

function fileFrom(loaded: { data: Uint8Array; mimeType: string }): AudioFile {
  const named = audioFile(loaded.mimeType);
  return { data: loaded.data, mimeType: loaded.mimeType, ...named };
}

export async function transcribeOpenAI(
  model: TranscriptionModel<string>,
  input: AudioInput,
  options?: ProviderRequestOptions
): Promise<Transcript> {
  try {
    if (options?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const fetchImpl = options?.fetch ?? globalThis.fetch;
    const loaded = await readAudio(input, fetchImpl, requestSignal(options));
    const file = fileFrom(loaded);
    const payload = audioPayload(file, isOpenRouter(model), model.id);
    const body = await applyPayload(payload, model, options);
    if (!isRecord(body)) throw new Error('Transcription payload was not JSON');
    const url = endpoint(model.baseUrl, 'audio/transcriptions');
    const response = await postTranscription(model, options, url, body);
    const json = await readJson(response);
    const seconds = isRecord(json) ? durationSeconds(json) : 0;
    return transcriptFrom(json, model, seconds);
  } catch (error) {
    const voice = asVoiceError(error);
    throw new VoiceRequestError(voice.reason, voice.error);
  }
}

async function postTranscription(
  model: TranscriptionModel<string>,
  options: ProviderRequestOptions | undefined,
  url: string,
  body: Record<string, unknown>
): Promise<Response> {
  const inline = body.input_audio;
  if (isRecord(inline)) {
    return voiceFetch(model, options, url, JSON.stringify(body), 'application/json');
  }
  const file = body.file;
  if (!isRecord(file) || !(file.data instanceof Uint8Array) || typeof file.mimeType !== 'string') {
    throw new Error('Transcription payload was not JSON');
  }
  const named = audioFile(file.mimeType);
  const fields: Record<string, string> = {};
  const modelId = stringField(body, 'model');
  fields.model = modelId === undefined ? model.id : modelId;
  const encoded = encodeMultipart(
    {
      data: file.data,
      mimeType: file.mimeType,
      filename: typeof file.filename === 'string' ? file.filename : named.filename,
      format: named.format,
    },
    fields
  );
  const copy = new ArrayBuffer(encoded.byteLength);
  new Uint8Array(copy).set(encoded);
  return voiceFetch(model, options, url, copy, multipartType());
}
