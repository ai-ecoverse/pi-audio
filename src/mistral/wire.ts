import type { ProviderRequestOptions } from '@earendil-works/pi-ai';
import type { AudioFormat } from '../audio.ts';
import { requestHeaders } from '../openai/wire.ts';

const boundary = 'pi-audio-mistral-boundary';

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
  'audio/webm': 'audio.webm',
  'audio/mp4': 'audio.mp4',
  'audio/m4a': 'audio.m4a',
  'audio/aac': 'audio.aac',
};

const encodings: Record<string, string> = {
  pcm16: 'pcm_s16le',
  pcmf32: 'pcm_f32le',
  mulaw: 'pcm_mulaw',
  alaw: 'pcm_alaw',
};

const speechNames: Record<string, string> = {
  pcmf32: 'pcm',
  mp3: 'mp3',
  wav: 'wav',
  flac: 'flac',
  opus: 'opus',
};

export interface MistralFile {
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

export function encodeForm(file: MistralFile, fields: Record<string, string>): ArrayBuffer {
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

export function bearerHeaders(
  model: { provider: string; headers?: Record<string, string> },
  options: ProviderRequestOptions | undefined
): Record<string, string> {
  return requestHeaders(model, options);
}

export function socketUrl(baseUrl: string, path: string): URL {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/${path}`;
  url.search = '';
  return url;
}

export function realtimeEncoding(format: AudioFormat): string {
  const name = encodings[format.encoding];
  if (!name) throw new Error(`Unsupported audio format ${format.encoding}`);
  return name;
}

export function speechFormatName(format: AudioFormat): string {
  const name = speechNames[format.encoding];
  if (!name) throw new Error(`Unsupported speech format ${format.encoding}`);
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
