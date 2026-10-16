import type { ProviderRequestOptions } from '@earendil-works/pi-ai';
import type { AudioFormat } from '../audio.ts';
import { chunkSeconds } from '../audio.ts';
import { decodeAudioBase64 } from '../convert.ts';
import type { SpeechModel } from '../models.ts';
import {
  applyPayload,
  asVoiceError,
  endpoint,
  isRecord,
  requestSignal,
  stringField,
} from '../openai/wire.ts';
import { SpeechEventStream, type SpeechInput } from '../speech.ts';
import { type AudioCounters, priceAudio } from '../usage.ts';
import { bearerHeaders, sameFormat, speechFormatName } from './wire.ts';

interface SpeechPiece {
  name: string | undefined;
  body: Record<string, unknown> | undefined;
}

function languageCode(language: string | undefined): string | undefined {
  if (language === undefined) return undefined;
  if (language.trim() === '') return undefined;
  return language;
}

function resolveFormat(
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

function speechBody(
  model: SpeechModel<string>,
  text: string,
  voice: string,
  language: string | undefined,
  format: AudioFormat
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: model.id,
    input: text,
    voice_id: voice,
    response_format: speechFormatName(format),
    stream: true,
  };
  const code = languageCode(language);
  if (code !== undefined) body.language = code;
  return body;
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

function pieceName(piece: SpeechPiece): string {
  if (piece.name !== undefined && piece.name !== '') return piece.name;
  if (!piece.body) return '';
  const typed = stringField(piece.body, 'type');
  if (typed !== undefined) return typed;
  return '';
}

function audioOf(piece: SpeechPiece): string | undefined {
  const body = piece.body;
  if (!body) return undefined;
  const direct = stringField(body, 'audio_data');
  if (direct !== undefined) return direct;
  const nested = body.data;
  if (!isRecord(nested)) return undefined;
  return stringField(nested, 'audio_data');
}

function speechError(body: Record<string, unknown> | undefined): string {
  if (!body) return 'Mistral speech failed';
  const message = stringField(body, 'message');
  if (message !== undefined) return message;
  const error = body.error;
  if (typeof error === 'string') return error;
  if (isRecord(error)) {
    const nested = stringField(error, 'message');
    if (nested !== undefined) return nested;
  }
  return 'Mistral speech failed';
}

function piecesFrom(raw: string): SpeechPiece[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isRecord(parsed) && !Array.isArray(parsed)) {
      return [{ name: stringField(parsed, 'type'), body: parsed }];
    }
    return [];
  }
  const pieces: SpeechPiece[] = [];
  for (const block of raw.split('\n\n')) {
    let name: string | undefined;
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) name = line.slice(6).trim();
      if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    if (data.length === 0 && name === undefined) continue;
    const joined = data.join('\n');
    if (joined === '') {
      pieces.push({ name, body: undefined });
      continue;
    }
    const parsed = JSON.parse(joined) as unknown;
    pieces.push({ name, body: isRecord(parsed) ? parsed : undefined });
  }
  return pieces;
}

async function mistralFetch(
  model: SpeechModel<string>,
  options: ProviderRequestOptions | undefined,
  url: string,
  body: string
): Promise<Response> {
  const headers = bearerHeaders(model, options);
  headers['Content-Type'] = 'application/json';
  headers.Accept = 'text/event-stream';
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

export function speakMistral(
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
    await postSpeech(model, text, input.voice, input.language, format, options, stream);
  } catch (error) {
    const voice = asVoiceError(error);
    stream.push({ type: 'error', reason: voice.reason, error: voice.error });
  }
}

async function postSpeech(
  model: SpeechModel<string>,
  text: string,
  voice: string,
  language: string | undefined,
  format: AudioFormat,
  options: ProviderRequestOptions | undefined,
  stream: SpeechEventStream
) {
  const payload = speechBody(model, text, voice, language, format);
  const body = await applyPayload(payload, model, options);
  if (!isRecord(body)) throw new Error('Speech payload was not JSON');
  const response = await mistralFetch(
    model,
    options,
    endpoint(model.baseUrl, 'audio/speech'),
    JSON.stringify(body)
  );
  const raw = await response.text();
  const pieces = piecesFrom(raw);
  let started = false;
  let seconds = 0;
  let heard = false;
  for (const piece of pieces) {
    const name = pieceName(piece);
    if (name === 'error' || name === 'speech.error') {
      throw new Error(speechError(piece.body));
    }
    if (name === 'speech.audio.done') continue;
    const audio = audioOf(piece);
    if (audio === undefined || audio === '') continue;
    const data = decodeAudioBase64(audio);
    heard = true;
    const chunkSecondsValue = chunkSeconds({ data, format, timestamp: 0 });
    seconds += chunkSecondsValue;
    if (!started) {
      started = true;
      stream.push({ type: 'start', format });
    }
    stream.push({
      type: 'audio',
      chunk: { data, format, timestamp: 0 },
      span: { itemId: model.id, start: 0, end: text.length },
    });
  }
  if (!heard) throw new Error('Speech response had no audio');
  const meters: AudioCounters = { characters: text.length };
  if (seconds > 0) meters.outputSeconds = seconds;
  stream.push({ type: 'done', usage: priceAudio(model.audioCost, meters) });
}
