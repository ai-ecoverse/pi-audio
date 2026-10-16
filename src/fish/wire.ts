import type { ProviderRequestOptions } from '@earendil-works/pi-ai';
import type { AudioFormat } from '../audio.ts';
import { requestHeaders } from '../openai/wire.ts';

const boundary = 'pi-audio-fish-boundary';

const filenames: Record<string, string> = {
  'audio/wav': 'audio.wav',
  'audio/wave': 'audio.wav',
  'audio/x-wav': 'audio.wav',
  'audio/mpeg': 'audio.mp3',
  'audio/mp3': 'audio.mp3',
  'audio/flac': 'audio.flac',
  'audio/ogg': 'audio.ogg',
  'audio/opus': 'audio.opus',
  'audio/webm': 'audio.webm',
  'audio/mp4': 'audio.m4a',
  'audio/m4a': 'audio.m4a',
  'audio/aac': 'audio.aac',
};

const speechNames: Record<string, string> = {
  pcm16: 'pcm',
  wav: 'wav',
  mp3: 'mp3',
  opus: 'opus',
};

export type PackValue =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | PackValue[]
  | { [key: string]: PackValue };

export interface FishFile {
  data: Uint8Array;
  mimeType: string;
  filename: string;
}

class ByteWriter {
  readonly #bytes: number[] = [];

  byte(value: number): void {
    this.#bytes.push(value & 0xff);
  }

  u16(value: number): void {
    this.byte(value >> 8);
    this.byte(value);
  }

  u32(value: number): void {
    this.byte(value >>> 24);
    this.byte(value >>> 16);
    this.byte(value >>> 8);
    this.byte(value);
  }

  f64(value: number): void {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value);
    for (let index = 0; index < 8; index += 1) this.byte(view.getUint8(index));
  }

  raw(bytes: Uint8Array): void {
    for (const byte of bytes) this.byte(byte);
  }

  toArray(): Uint8Array {
    return Uint8Array.from(this.#bytes);
  }
}

class ByteReader {
  #offset = 0;
  readonly #data: Uint8Array;

  constructor(data: Uint8Array) {
    this.#data = data;
  }

  byte(): number {
    const value = this.#data[this.#offset];
    if (value === undefined) throw new Error('Fish frame ended early');
    this.#offset += 1;
    return value;
  }

  u16(): number {
    return (this.byte() << 8) | this.byte();
  }

  u32(): number {
    return ((this.byte() << 24) | (this.byte() << 16) | (this.byte() << 8) | this.byte()) >>> 0;
  }

  i16(): number {
    const value = this.u16();
    return value > 0x7fff ? value - 0x10000 : value;
  }

  i32(): number {
    return this.u32() | 0;
  }

  u64(): number {
    const high = this.u32();
    const low = this.u32();
    return high * 0x100000000 + low;
  }

  i64(): number {
    const high = this.i32();
    const low = this.u32();
    return high * 0x100000000 + low;
  }

  f32(): number {
    const copy = new Uint8Array(4);
    copy.set(this.bytes(4));
    return new DataView(copy.buffer).getFloat32(0);
  }

  f64(): number {
    const copy = new Uint8Array(8);
    copy.set(this.bytes(8));
    return new DataView(copy.buffer).getFloat64(0);
  }

  bytes(length: number): Uint8Array {
    const start = this.#offset;
    if (start + length > this.#data.length) throw new Error('Fish frame ended early');
    this.#offset = start + length;
    return this.#data.subarray(start, this.#offset);
  }

  done(): boolean {
    return this.#offset === this.#data.length;
  }
}

function packString(value: string, out: ByteWriter): void {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length < 32) out.byte(0xa0 | bytes.length);
  else if (bytes.length < 256) {
    out.byte(0xd9);
    out.byte(bytes.length);
  } else if (bytes.length < 65536) {
    out.byte(0xda);
    out.u16(bytes.length);
  } else throw new Error('String too long');
  out.raw(bytes);
}

function packBin(value: Uint8Array, out: ByteWriter): void {
  if (value.byteLength < 256) {
    out.byte(0xc4);
    out.byte(value.byteLength);
  } else if (value.byteLength < 65536) {
    out.byte(0xc5);
    out.u16(value.byteLength);
  } else throw new Error('Binary too long');
  out.raw(value);
}

function packNumber(value: number, out: ByteWriter): void {
  if (!Number.isInteger(value)) {
    out.byte(0xcb);
    out.f64(value);
    return;
  }
  if (value >= 0 && value <= 0x7f) {
    out.byte(value);
    return;
  }
  if (value < 0 && value >= -32) {
    out.byte(value & 0xff);
    return;
  }
  if (value >= 0 && value <= 0xff) {
    out.byte(0xcc);
    out.byte(value);
    return;
  }
  if (value >= 0 && value <= 0xffff) {
    out.byte(0xcd);
    out.u16(value);
    return;
  }
  if (value >= 0 && value <= 0xffffffff) {
    out.byte(0xce);
    out.u32(value);
    return;
  }
  if (value < 0 && value >= -128) {
    out.byte(0xd0);
    out.byte(value & 0xff);
    return;
  }
  throw new Error('Integer out of range');
}

function packArray(values: PackValue[], out: ByteWriter): void {
  if (values.length < 16) out.byte(0x90 | values.length);
  else if (values.length < 65536) {
    out.byte(0xdc);
    out.u16(values.length);
  } else throw new Error('Array too long');
  for (const value of values) packInto(value, out);
}

function packMap(value: { [key: string]: PackValue }, out: ByteWriter): void {
  const entries = Object.entries(value);
  if (entries.length < 16) out.byte(0x80 | entries.length);
  else if (entries.length < 65536) {
    out.byte(0xde);
    out.u16(entries.length);
  } else throw new Error('Map too long');
  for (const [key, item] of entries) {
    packString(key, out);
    packInto(item, out);
  }
}

function packInto(value: PackValue, out: ByteWriter): void {
  if (value === null) {
    out.byte(0xc0);
    return;
  }
  if (typeof value === 'boolean') {
    out.byte(value ? 0xc3 : 0xc2);
    return;
  }
  if (typeof value === 'number') {
    packNumber(value, out);
    return;
  }
  if (typeof value === 'string') {
    packString(value, out);
    return;
  }
  if (value instanceof Uint8Array) {
    packBin(value, out);
    return;
  }
  if (Array.isArray(value)) {
    packArray(value, out);
    return;
  }
  packMap(value, out);
}

function unpackString(reader: ByteReader, length: number): string {
  return new TextDecoder().decode(reader.bytes(length));
}

function unpackArray(reader: ByteReader, length: number): PackValue[] {
  const values: PackValue[] = [];
  for (let index = 0; index < length; index += 1) values.push(unpackOne(reader));
  return values;
}

function unpackMap(reader: ByteReader, length: number): { [key: string]: PackValue } {
  const value: { [key: string]: PackValue } = {};
  for (let index = 0; index < length; index += 1) {
    const key = unpackOne(reader);
    if (typeof key !== 'string') throw new Error('Fish frame key was not a string');
    value[key] = unpackOne(reader);
  }
  return value;
}

function unpackSized(reader: ByteReader, marker: number): PackValue | undefined {
  if (marker === 0xc0) return null;
  if (marker === 0xc2) return false;
  if (marker === 0xc3) return true;
  if (marker === 0xc4) return reader.bytes(reader.byte());
  if (marker === 0xc5) return reader.bytes(reader.u16());
  if (marker === 0xc6) return reader.bytes(reader.u32());
  if (marker === 0xca) return reader.f32();
  if (marker === 0xcb) return reader.f64();
  if (marker === 0xcc) return reader.byte();
  if (marker === 0xcd) return reader.u16();
  if (marker === 0xce) return reader.u32();
  if (marker === 0xcf) return reader.u64();
  if (marker === 0xd0) return (reader.byte() << 24) >> 24;
  if (marker === 0xd1) return reader.i16();
  if (marker === 0xd2) return reader.i32();
  if (marker === 0xd3) return reader.i64();
  return undefined;
}

function unpackOne(reader: ByteReader): PackValue {
  const marker = reader.byte();
  if (marker <= 0x7f) return marker;
  if (marker >= 0xe0) return marker - 0x100;
  const sized = unpackSized(reader, marker);
  if (sized !== undefined) return sized;
  if ((marker & 0xe0) === 0xa0) return unpackString(reader, marker & 0x1f);
  if (marker === 0xd9) return unpackString(reader, reader.byte());
  if (marker === 0xda) return unpackString(reader, reader.u16());
  if (marker === 0xdb) return unpackString(reader, reader.u32());
  if ((marker & 0xf0) === 0x90) return unpackArray(reader, marker & 0x0f);
  if (marker === 0xdc) return unpackArray(reader, reader.u16());
  if (marker === 0xdd) return unpackArray(reader, reader.u32());
  if ((marker & 0xf0) === 0x80) return unpackMap(reader, marker & 0x0f);
  if (marker === 0xde) return unpackMap(reader, reader.u16());
  if (marker === 0xdf) return unpackMap(reader, reader.u32());
  throw new Error('Unsupported Fish frame');
}

export function pack(value: PackValue): Uint8Array {
  const out = new ByteWriter();
  packInto(value, out);
  return out.toArray();
}

export function unpack(data: Uint8Array): PackValue {
  const reader = new ByteReader(data);
  const value = unpackOne(reader);
  if (!reader.done()) throw new Error('Fish frame had trailing bytes');
  return value;
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

export function encodeForm(file: FishFile, fields: Record<string, string>): ArrayBuffer {
  const chunks: Uint8Array[] = [];
  const encoder = new TextEncoder();
  const write = (value: string) => {
    chunks.push(encoder.encode(value));
  };
  for (const [name, value] of Object.entries(fields)) {
    write(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  }
  const header =
    `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="${file.filename}"\r\n` +
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

export function fishHeaders(
  model: { id: string; provider: string; headers?: Record<string, string> },
  options: ProviderRequestOptions | undefined
): Record<string, string> {
  const headers = requestHeaders(model, options);
  headers.model = model.id;
  return headers;
}

export function socketUrl(baseUrl: string, path: string): URL {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/${path}`;
  url.search = '';
  return url;
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

export async function messageBytes(data: unknown): Promise<Uint8Array> {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Uint8Array) return data;
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }
  throw new Error('Unsupported socket message');
}

export function sameFormat(left: AudioFormat, right: AudioFormat): boolean {
  return (
    left.encoding === right.encoding &&
    left.sampleRate === right.sampleRate &&
    left.channels === right.channels
  );
}
