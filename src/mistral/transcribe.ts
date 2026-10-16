import type { ProviderRequestOptions } from '@earendil-works/pi-ai';
import { VoiceRequestError } from '../errors.ts';
import type { TranscriptionModel } from '../models.ts';
import {
  applyPayload,
  asVoiceError,
  endpoint,
  isRecord,
  numberField,
  readAudio,
  readJson,
  requestSignal,
  stringField,
} from '../openai/wire.ts';
import type { AudioInput, Transcript, TranscriptSegment } from '../transcription.ts';
import { priceAudio } from '../usage.ts';
import { audioFilename, bearerHeaders, encodeForm, formType, type MistralFile } from './wire.ts';

function textOf(record: Record<string, unknown>, key: string): string {
  const text = stringField(record, key);
  if (text === undefined) return '';
  return text;
}

function secondsOf(record: Record<string, unknown>, key: string): number {
  const value = numberField(record, key);
  if (value === undefined) return 0;
  return value;
}

function durationOf(body: Record<string, unknown>): number {
  const direct = numberField(body, 'duration');
  if (direct !== undefined) return direct;
  const alt = numberField(body, 'audio_duration_secs');
  if (alt !== undefined) return alt;
  return 0;
}

function segmentFrom(word: Record<string, unknown>): TranscriptSegment | undefined {
  const text = textOf(word, 'text');
  if (text === '') return undefined;
  const speaker = stringField(word, 'speaker_id');
  const segment: TranscriptSegment = {
    text,
    start: secondsOf(word, 'start'),
    end: secondsOf(word, 'end'),
  };
  if (speaker !== undefined) segment.speaker = speaker;
  return segment;
}

function segmentsFrom(value: unknown): TranscriptSegment[] {
  if (!Array.isArray(value)) return [];
  const segments: TranscriptSegment[] = [];
  for (const word of value) {
    if (!isRecord(word)) continue;
    const segment = segmentFrom(word);
    if (segment) segments.push(segment);
  }
  return segments;
}

function transcriptFrom(body: unknown, model: TranscriptionModel<string>): Transcript {
  if (!isRecord(body)) throw new Error('Transcription response had no text');
  const direct = stringField(body, 'text');
  const words = segmentsFrom(body.segments);
  const timed = words.length > 0 ? words : segmentsFrom(body.words);
  const joined = timed.map((segment) => segment.text).join(' ');
  const text = direct === undefined ? joined : direct;
  if (direct === undefined && timed.length === 0) {
    throw new Error('Transcription response had no text');
  }
  const language = stringField(body, 'language');
  return {
    text,
    ...(language !== undefined ? { language } : {}),
    ...(timed.length > 0 ? { segments: timed } : {}),
    usage: priceAudio(model.audioCost, { inputSeconds: durationOf(body) }),
  };
}

function fileOf(body: Record<string, unknown>): MistralFile {
  const file = body.file;
  if (!isRecord(file) || !(file.data instanceof Uint8Array) || typeof file.mimeType !== 'string') {
    throw new Error('Transcription payload was not a file');
  }
  const named = typeof file.filename === 'string' ? file.filename : audioFilename(file.mimeType);
  return { data: file.data, mimeType: file.mimeType, filename: named };
}

function fieldStrings(body: Record<string, unknown>): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === 'file') continue;
    if (typeof value !== 'string') continue;
    fields[key] = value;
  }
  return fields;
}

async function mistralFetch(
  model: TranscriptionModel<string>,
  options: ProviderRequestOptions | undefined,
  url: string,
  body: BodyInit,
  contentType: string
): Promise<Response> {
  const headers = bearerHeaders(model, options);
  headers['Content-Type'] = contentType;
  const fetchImpl = options?.fetch ?? globalThis.fetch;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers,
    body,
    signal: requestSignal(options),
  });
  await options?.onResponse?.({ status: response.status, headers: {} }, model as never);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text === '' ? `HTTP ${response.status}` : text);
  }
  return response;
}

export async function transcribeMistral(
  model: TranscriptionModel<string>,
  input: AudioInput,
  options?: ProviderRequestOptions
): Promise<Transcript> {
  try {
    if (options?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const fetchImpl = options?.fetch ?? globalThis.fetch;
    const loaded = await readAudio(input, fetchImpl, requestSignal(options));
    const payload: Record<string, unknown> = {
      model: model.id,
      timestamp_granularities: 'word',
      file: {
        data: loaded.data,
        mimeType: loaded.mimeType,
        filename: audioFilename(loaded.mimeType),
      },
    };
    if (model.diarization) payload.diarize = 'true';
    const body = await applyPayload(payload, model, options);
    if (!isRecord(body)) throw new Error('Transcription payload was not a file');
    const file = fileOf(body);
    const encoded = encodeForm(file, fieldStrings(body));
    const response = await mistralFetch(
      model,
      options,
      endpoint(model.baseUrl, 'audio/transcriptions'),
      encoded,
      formType()
    );
    return transcriptFrom(await readJson(response), model);
  } catch (error) {
    const voice = asVoiceError(error);
    throw new VoiceRequestError(voice.reason, voice.error);
  }
}
