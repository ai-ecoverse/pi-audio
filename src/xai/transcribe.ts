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
  voiceFetch,
} from '../openai/wire.ts';
import type { AudioInput, Transcript, TranscriptSegment } from '../transcription.ts';
import { priceAudio } from '../usage.ts';
import { audioFilename, encodeForm, formType, rawFields, type XaiFile } from './wire.ts';

function durationOf(record: Record<string, unknown>): number {
  const duration = numberField(record, 'duration');
  if (duration === undefined) return 0;
  return duration;
}

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

function speakerOf(record: Record<string, unknown>): string | undefined {
  const value = record.speaker;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  return undefined;
}

function wordFrom(word: Record<string, unknown>): TranscriptSegment {
  const speaker = speakerOf(word);
  const segment: TranscriptSegment = {
    text: textOf(word, 'text'),
    start: secondsOf(word, 'start'),
    end: secondsOf(word, 'end'),
  };
  if (speaker !== undefined) segment.speaker = speaker;
  return segment;
}

function transcriptFrom(body: unknown, model: TranscriptionModel<string>): Transcript {
  if (!isRecord(body)) throw new Error('Transcription response had no text');
  const text = stringField(body, 'text');
  if (text === undefined) throw new Error('Transcription response had no text');
  const language = stringField(body, 'language');
  const words = Array.isArray(body.words) ? body.words.filter(isRecord).map(wordFrom) : undefined;
  return {
    text,
    ...(language !== undefined ? { language } : {}),
    ...(words !== undefined ? { segments: words } : {}),
    usage: priceAudio(model.audioCost, { inputSeconds: durationOf(body) }),
  };
}

function fileOf(body: Record<string, unknown>): XaiFile {
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

export async function transcribeXAI(
  model: TranscriptionModel<string>,
  input: AudioInput,
  options?: ProviderRequestOptions
): Promise<Transcript> {
  try {
    if (options?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const fetchImpl = options?.fetch ?? globalThis.fetch;
    const loaded = await readAudio(input, fetchImpl, requestSignal(options));
    const filename = audioFilename(loaded.mimeType);
    const payload: Record<string, unknown> = {
      model: model.id,
      file: { data: loaded.data, mimeType: loaded.mimeType, filename },
    };
    if (model.diarization) payload.diarize = 'true';
    const raw = rawFields(loaded.mimeType, model);
    if (raw) {
      payload.audio_format = raw.audio_format;
      payload.sample_rate = raw.sample_rate;
    }
    const body = await applyPayload(payload, model, options);
    if (!isRecord(body)) throw new Error('Transcription payload was not a file');
    const file = fileOf(body);
    const encoded = encodeForm(file, fieldStrings(body));
    const response = await voiceFetch(
      model,
      options,
      endpoint(model.baseUrl, 'stt'),
      encoded,
      formType()
    );
    return transcriptFrom(await readJson(response), model);
  } catch (error) {
    const voice = asVoiceError(error);
    throw new VoiceRequestError(voice.reason, voice.error);
  }
}
