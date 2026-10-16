import type { AudioFormat } from '../audio.ts';
import type { TranscriptionModel } from '../models.ts';

const boundary = 'pi-audio-xai-boundary';

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

export interface XaiFile {
  data: Uint8Array;
  mimeType: string;
  filename: string;
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

function declaredRate(
  model: TranscriptionModel<string>,
  encoding: AudioFormat['encoding']
): string {
  const match = model.inputFormats.find((format) => format.encoding === encoding);
  if (!match) return '16000';
  return String(match.sampleRate);
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

export function rawFields(
  mimeType: string,
  model: TranscriptionModel<string>
): Record<string, string> | undefined {
  const type = mediaType(mimeType);
  const rate = parameter(mimeType, 'rate');
  if (type === 'audio/pcm' || type === 'audio/l16') {
    const sampleRate = rate === undefined ? declaredRate(model, 'pcm16') : rate;
    return { audio_format: 'pcm', sample_rate: sampleRate };
  }
  if (type === 'audio/mulaw' || type === 'audio/basic') {
    const sampleRate = rate === undefined ? declaredRate(model, 'mulaw') : rate;
    return { audio_format: 'mulaw', sample_rate: sampleRate };
  }
  if (type === 'audio/alaw') {
    const sampleRate = rate === undefined ? declaredRate(model, 'alaw') : rate;
    return { audio_format: 'alaw', sample_rate: sampleRate };
  }
  return undefined;
}

export function encodeForm(file: XaiFile, fields: Record<string, string>): ArrayBuffer {
  const chunks: Uint8Array[] = [];
  const encoder = new TextEncoder();
  const write = (value: string) => {
    chunks.push(encoder.encode(value));
  };
  for (const [name, value] of Object.entries(fields)) {
    write(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  }
  write(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.mimeType}\r\n\r\n`
  );
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

export function socketUrl(baseUrl: string, path: string): URL {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/${path}`;
  url.search = '';
  return url;
}

export function codecName(encoding: AudioFormat['encoding']): string {
  if (encoding === 'pcm16') return 'pcm';
  if (encoding === 'mp3') return 'mp3';
  if (encoding === 'wav') return 'wav';
  if (encoding === 'mulaw') return 'mulaw';
  if (encoding === 'alaw') return 'alaw';
  throw new Error(`xAI speech cannot return ${encoding}`);
}

export function encodingName(encoding: AudioFormat['encoding']): string {
  if (encoding === 'pcm16') return 'pcm';
  if (encoding === 'mulaw') return 'mulaw';
  if (encoding === 'alaw') return 'alaw';
  throw new Error(`Unsupported audio format ${encoding}`);
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

export function copiedBytes(data: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(data.byteLength);
  new Uint8Array(copy).set(data);
  return copy;
}
