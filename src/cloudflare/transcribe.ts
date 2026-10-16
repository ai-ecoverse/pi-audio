import type { ProviderRequestOptions } from '@earendil-works/pi-ai';
import { encodeAudioBase64 } from '../convert.ts';
import { VoiceRequestError } from '../errors.ts';
import type { TranscriptionModel } from '../models.ts';
import {
  applyPayload,
  asVoiceError,
  isRecord,
  numberField,
  readAudio,
  requestSignal,
  stringField,
} from '../openai/wire.ts';
import type { AudioInput, Transcript, TranscriptSegment } from '../transcription.ts';
import { type AudioCounters, priceAudio } from '../usage.ts';
import { errorText, resultOf, runUrl, session } from './wire.ts';

function novaEncoding(mimeType: string): string | undefined {
  const mime = mimeType.toLowerCase();
  if (mime.includes('mulaw') || mime === 'audio/basic') return 'mulaw';
  if (mime.includes('flac')) return 'flac';
  if (mime.includes('opus')) return 'opus';
  if (mime.includes('pcm') || mime.includes('l16') || mime.includes('wav')) return 'linear16';
  return undefined;
}

function requestBody(
  modelId: string,
  audio: string,
  mimeType: string,
  language: string | undefined
): Record<string, unknown> {
  if (modelId.includes('whisper')) {
    const body: Record<string, unknown> = { audio };
    if (language !== undefined) body.language = language;
    return body;
  }
  const body: Record<string, unknown> = { audio: { body: audio, contentType: mimeType } };
  const encoding = novaEncoding(mimeType);
  if (encoding !== undefined) body.encoding = encoding;
  if (language !== undefined) body.language = language;
  return body;
}

function speakerOf(record: Record<string, unknown>): string | undefined {
  const value = record.speaker;
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

function segmentText(record: Record<string, unknown>): string {
  return stringField(record, 'text') ?? stringField(record, 'word') ?? '';
}

function segmentsFrom(value: unknown): TranscriptSegment[] {
  if (!Array.isArray(value)) return [];
  const segments: TranscriptSegment[] = [];
  for (const item of value) {
    if (!isRecord(item) || Array.isArray(item)) continue;
    const text = segmentText(item);
    if (text === '') continue;
    const segment: TranscriptSegment = {
      text,
      start: numberField(item, 'start') ?? 0,
      end: numberField(item, 'end') ?? 0,
    };
    const speaker = speakerOf(item);
    if (speaker !== undefined) segment.speaker = speaker;
    segments.push(segment);
  }
  return segments;
}

function alternative(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const results = body.results;
  if (!isRecord(results) || Array.isArray(results)) return undefined;
  const channels = results.channels;
  if (!Array.isArray(channels)) return undefined;
  const first = channels[0];
  if (!isRecord(first) || Array.isArray(first)) return undefined;
  const alternatives = first.alternatives;
  if (!Array.isArray(alternatives)) return undefined;
  const alt = alternatives[0];
  if (!isRecord(alt) || Array.isArray(alt)) return undefined;
  return alt;
}

function durationSeconds(body: Record<string, unknown>): number {
  const direct = numberField(body, 'duration');
  if (direct !== undefined) return direct;
  const metadata = body.metadata;
  if (!isRecord(metadata) || Array.isArray(metadata)) return 0;
  const nested = numberField(metadata, 'duration');
  if (nested === undefined) return 0;
  return nested;
}

function optionLanguage(options: ProviderRequestOptions | undefined): string | undefined {
  const record = options as { language?: unknown } | undefined;
  if (record === undefined) return undefined;
  if (typeof record.language !== 'string') return undefined;
  return record.language;
}

function transcriptFrom(body: unknown, model: TranscriptionModel<string>): Transcript {
  const result = resultOf(body);
  if (!isRecord(result) || Array.isArray(result))
    throw new Error('Transcription response had no text');
  const alt = alternative(result);
  const nova = alt === undefined ? undefined : stringField(alt, 'transcript');
  const text = nova ?? stringField(result, 'text');
  if (text === undefined) throw new Error('Transcription response had no text');
  const words = alt === undefined ? undefined : alt.words;
  const segments = segmentsFrom(words ?? result.segments);
  const seconds = durationSeconds(result);
  const meters: AudioCounters = {};
  if (seconds > 0) meters.inputSeconds = seconds;
  const transcript: Transcript = { text, usage: priceAudio(model.audioCost, meters) };
  const language = stringField(result, 'language');
  if (language !== undefined) transcript.language = language;
  if (segments.length > 0) transcript.segments = segments;
  return transcript;
}

async function postTranscription(
  model: TranscriptionModel<string>,
  body: unknown,
  options: ProviderRequestOptions | undefined
): Promise<unknown> {
  const route = session(model, options);
  const headers = route.headers;
  headers['Content-Type'] = 'application/json';
  const fetchImpl = options?.fetch ?? globalThis.fetch;
  const response = await fetchImpl(runUrl(model.baseUrl, model.id, route.account), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: requestSignal(options),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(errorText(text, response.status));
  }
  const text = await response.text();
  if (text === '') throw new Error('Transcription response had no text');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function transcribeCloudflare(
  model: TranscriptionModel<string>,
  input: AudioInput,
  options?: ProviderRequestOptions
): Promise<Transcript> {
  try {
    if (model.id.includes('/flux')) throw new Error('Cloudflare flux is websocket only');
    if (options?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const file = await readAudio(input, options?.fetch ?? globalThis.fetch, requestSignal(options));
    const payload = requestBody(
      model.id,
      encodeAudioBase64(file.data),
      file.mimeType,
      optionLanguage(options)
    );
    const body = await applyPayload(payload, model, options);
    if (!isRecord(body) || Array.isArray(body))
      throw new Error('Transcription payload was not JSON');
    const parsed = await postTranscription(model, body, options);
    return transcriptFrom(parsed, model);
  } catch (error) {
    const voice = asVoiceError(error);
    throw new VoiceRequestError(voice.reason, voice.error);
  }
}
