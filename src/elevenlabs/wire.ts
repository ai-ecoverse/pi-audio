import type { ProviderRequestOptions } from '@earendil-works/pi-ai';
import type { AudioFormat, CharAlignment } from '../audio.ts';
import { isRecord } from '../openai/wire.ts';

const boundary = 'pi-audio-elevenlabs-boundary';

const filenames: Record<string, string> = {
  'audio/wav': 'audio.wav',
  'audio/wave': 'audio.wav',
  'audio/x-wav': 'audio.wav',
  'audio/mpeg': 'audio.mp3',
  'audio/mp3': 'audio.mp3',
  'audio/flac': 'audio.flac',
  'audio/ogg': 'audio.ogg',
  'audio/opus': 'audio.opus',
  'audio/pcm': 'audio.pcm',
  'audio/l16': 'audio.pcm',
  'audio/mulaw': 'audio.mulaw',
  'audio/basic': 'audio.mulaw',
  'audio/alaw': 'audio.alaw',
  'audio/mp4': 'audio.mp4',
  'audio/m4a': 'audio.m4a',
  'audio/aac': 'audio.aac',
  'audio/webm': 'audio.webm',
};

const sttFormats = new Set([
  'pcm_8000',
  'pcm_16000',
  'pcm_22050',
  'pcm_24000',
  'pcm_44100',
  'pcm_48000',
  'ulaw_8000',
]);

export interface ElevenFile {
  data: Uint8Array;
  mimeType: string;
  filename: string;
}

interface HeaderModel {
  provider: string;
  headers?: Record<string, string>;
}

export function mediaType(mimeType: string): string {
  const type = mimeType.split(';')[0]?.trim().toLowerCase();
  if (!type) throw new Error(`Unsupported audio type ${mimeType}`);
  return type;
}

export function audioFilename(mimeType: string): string {
  const name = filenames[mediaType(mimeType)];
  if (!name) throw new Error(`Unsupported audio type ${mimeType}`);
  return name;
}

function parameter(mimeType: string, name: string): string | undefined {
  for (const part of mimeType.split(';').slice(1)) {
    const pieces = part.split('=');
    const key = pieces[0]?.trim().toLowerCase();
    const value = pieces[1]?.trim();
    if (key === name && value) return value;
  }
  return undefined;
}

export function pcmS16(mimeType: string): boolean {
  const type = mediaType(mimeType);
  if (type !== 'audio/pcm' && type !== 'audio/l16') return false;
  const rate = parameter(mimeType, 'rate');
  if (rate === undefined) return true;
  return rate === '16000';
}

export function encodeForm(file: ElevenFile, fields: Record<string, string>): ArrayBuffer {
  const chunks: Uint8Array[] = [];
  const encoder = new TextEncoder();
  const write = (value: string) => {
    chunks.push(encoder.encode(value));
  };
  for (const [name, value] of Object.entries(fields)) {
    write(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  }
  const header =
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\n` +
    `Content-Type: ${file.mimeType}\r\n\r\n`;
  write(header);
  chunks.push(file.data);
  write(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body.buffer;
}

export function formType(): string {
  return `multipart/form-data; boundary=${boundary}`;
}

function headerValue(
  headers: Record<string, string | null> | undefined,
  name: string
): string | undefined {
  if (!headers) return undefined;
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === expected && value !== null && value.trim() !== '') return value;
  }
  return undefined;
}

export function xiHeaders(
  model: HeaderModel,
  options: ProviderRequestOptions | undefined
): Record<string, string> {
  const headers: Record<string, string> = { ...model.headers };
  const extra = options?.headers;
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value === null) delete headers[key];
      else headers[key] = value;
    }
  }
  if (headerValue(headers, 'xi-api-key') === undefined) {
    const apiKey = options?.apiKey;
    if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);
    headers['xi-api-key'] = apiKey;
  }
  return headers;
}

export function socketUrl(baseUrl: string, path: string): URL {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/${path}`;
  url.search = '';
  return url;
}

export function outputFormatName(format: AudioFormat): string {
  if (format.encoding === 'mp3' && format.sampleRate === 44100) return 'mp3_44100_128';
  if (format.encoding === 'mp3' && format.sampleRate === 24000) return 'mp3_24000_48';
  if (format.encoding === 'mp3' && format.sampleRate === 22050) return 'mp3_22050_32';
  if (format.encoding === 'pcm16') return `pcm_${format.sampleRate}`;
  if (format.encoding === 'wav') return `wav_${format.sampleRate}`;
  if (format.encoding === 'mulaw') return 'ulaw_8000';
  if (format.encoding === 'alaw') return 'alaw_8000';
  if (format.encoding === 'opus') return 'opus_48000_128';
  throw new Error(`Unsupported speech format ${format.encoding}`);
}

export function sttAudioFormat(format: AudioFormat): string {
  const name = format.encoding === 'mulaw' ? 'ulaw_8000' : `pcm_${format.sampleRate}`;
  if (format.encoding !== 'mulaw' && format.encoding !== 'pcm16') {
    throw new Error(`Unsupported audio format ${format.encoding}`);
  }
  if (!sttFormats.has(name)) throw new Error(`Unsupported audio format ${format.encoding}`);
  return name;
}

export function connectSocket(url: string, headers: Record<string, string>): WebSocket {
  const Socket = WebSocket as unknown as new (
    address: string,
    init: { headers: Record<string, string> }
  ) => WebSocket;
  return new Socket(url, { headers });
}

export function awaitOpen(
  socket: WebSocket,
  label: string,
  fail: (message: string) => void
): Promise<void> {
  return new Promise((resolve) => {
    let opened = false;
    socket.addEventListener('open', () => {
      opened = true;
      resolve();
    });
    socket.addEventListener('error', () => {
      fail(`${label} socket failed`);
      if (!opened) resolve();
    });
    socket.addEventListener('close', () => {
      if (!opened) {
        fail(`${label} socket closed`);
        resolve();
      }
    });
  });
}

export async function messageText(data: unknown): Promise<string> {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (data instanceof Uint8Array) return new TextDecoder().decode(data);
  if (typeof Blob !== 'undefined' && data instanceof Blob) return data.text();
  throw new Error('Unsupported socket message');
}

export function sameFormat(left: AudioFormat, right: AudioFormat): boolean {
  return (
    left.encoding === right.encoding &&
    left.sampleRate === right.sampleRate &&
    left.channels === right.channels
  );
}

function numberList(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const numbers: number[] = [];
  for (const item of value) {
    if (typeof item === 'number') numbers.push(item);
  }
  return numbers;
}

function durationMs(start: number | undefined, end: number | undefined): number {
  if (start === undefined || end === undefined) return 0;
  return (end - start) * 1000;
}

export function alignmentFrom(value: unknown): CharAlignment | undefined {
  if (!isRecord(value)) return undefined;
  const startMs = numberList(value.charStartTimesMs);
  const durationMsList = numberList(value.charDurationsMs);
  if (startMs && durationMsList) return { startMs, durationMs: durationMsList };
  const starts = numberList(value.character_start_times_seconds);
  const ends = numberList(value.character_end_times_seconds);
  if (!starts || !ends) return undefined;
  return {
    startMs: starts.map((start) => start * 1000),
    durationMs: starts.map((start, index) => durationMs(start, ends[index])),
  };
}
