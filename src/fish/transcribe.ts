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
import { audioFilename, encodeForm, type FishFile, fishHeaders, formType } from './wire.ts';

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
  const duration = numberField(body, 'duration');
  if (duration === undefined) return 0;
  return duration;
}

function languageOf(body: Record<string, unknown>): string | undefined {
  const code = stringField(body, 'language_code');
  if (code !== undefined) return code;
  return stringField(body, 'language');
}

function segmentFrom(
  word: Record<string, unknown>,
  withSpeaker: boolean
): TranscriptSegment | undefined {
  const text = textOf(word, 'text');
  if (text === '') return undefined;
  const segment: TranscriptSegment = {
    text,
    start: secondsOf(word, 'start'),
    end: secondsOf(word, 'end'),
  };
  if (!withSpeaker) return segment;
  const speaker = stringField(word, 'speaker');
  if (speaker !== undefined) segment.speaker = speaker;
  return segment;
}

function segmentsFrom(value: unknown, withSpeaker: boolean): TranscriptSegment[] {
  if (!Array.isArray(value)) return [];
  const segments: TranscriptSegment[] = [];
  for (const word of value) {
    if (!isRecord(word) || Array.isArray(word)) continue;
    const segment = segmentFrom(word, withSpeaker);
    if (segment) segments.push(segment);
  }
  return segments;
}

function timedFrom(body: Record<string, unknown>): TranscriptSegment[] {
  const turns = segmentsFrom(body.speaker_turns, true);
  if (turns.length > 0) return turns;
  return segmentsFrom(body.segments, false);
}

function transcriptFrom(body: unknown, model: TranscriptionModel<string>): Transcript {
  if (!isRecord(body) || Array.isArray(body)) throw new Error('Transcription response had no text');
  const direct = stringField(body, 'text');
  if (direct === undefined) throw new Error('Transcription response had no text');
  const timed = timedFrom(body);
  const language = languageOf(body);
  return {
    text: direct,
    ...(language !== undefined ? { language } : {}),
    ...(timed.length > 0 ? { segments: timed } : {}),
    usage: priceAudio(model.audioCost, { inputSeconds: durationOf(body) }),
  };
}

function fileOf(body: Record<string, unknown>): FishFile {
  const file = body.audio;
  if (
    !isRecord(file) ||
    Array.isArray(file) ||
    !(file.data instanceof Uint8Array) ||
    typeof file.mimeType !== 'string'
  ) {
    throw new Error('Transcription payload was not a file');
  }
  const named = typeof file.filename === 'string' ? file.filename : audioFilename(file.mimeType);
  return { data: file.data, mimeType: file.mimeType, filename: named };
}

function fieldStrings(body: Record<string, unknown>): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === 'audio') continue;
    if (typeof value !== 'string') continue;
    fields[key] = value;
  }
  return fields;
}

function errorText(text: string, status: number): string {
  if (text === '') return `HTTP ${status}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  if (!isRecord(parsed) || Array.isArray(parsed)) return text;
  const message = stringField(parsed, 'message');
  if (message === undefined) return text;
  return message;
}

async function fishFetch(
  model: TranscriptionModel<string>,
  options: ProviderRequestOptions | undefined,
  url: string,
  body: BodyInit,
  contentType: string
): Promise<Response> {
  const headers = fishHeaders(model, options);
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
    throw new Error(errorText(text, response.status));
  }
  return response;
}

export async function transcribeFish(
  model: TranscriptionModel<string>,
  input: AudioInput,
  options?: ProviderRequestOptions
): Promise<Transcript> {
  try {
    if (options?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const fetchImpl = options?.fetch ?? globalThis.fetch;
    const loaded = await readAudio(input, fetchImpl, requestSignal(options));
    const payload: Record<string, unknown> = {
      ignore_timestamps: 'false',
      diarize: model.diarization ? 'true' : 'false',
      audio: {
        data: loaded.data,
        mimeType: loaded.mimeType,
        filename: audioFilename(loaded.mimeType),
      },
    };
    const body = await applyPayload(payload, model, options);
    if (!isRecord(body) || Array.isArray(body))
      throw new Error('Transcription payload was not a file');
    const file = fileOf(body);
    const encoded = encodeForm(file, fieldStrings(body));
    const response = await fishFetch(
      model,
      options,
      endpoint(model.baseUrl, 'asr'),
      encoded,
      formType()
    );
    return transcriptFrom(await readJson(response), model);
  } catch (error) {
    const voice = asVoiceError(error);
    throw new VoiceRequestError(voice.reason, voice.error);
  }
}
