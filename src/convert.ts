import type { AudioChunk, AudioEncoding, AudioFormat, AudioSource } from './audio.ts';

const compressed = new Set<AudioEncoding>(['opus', 'mp3', 'flac']);
const LAW_BIAS = 0x84;

const base64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function byteAt(data: Uint8Array, index: number): number {
  const byte = data[index];
  return byte === undefined ? 0 : byte;
}

function symbolAt(index: number): string {
  return base64Alphabet.charAt(index);
}

export function encodeAudioBase64(data: Uint8Array): string {
  let encoded = '';
  for (let index = 0; index < data.length; index += 3) {
    const second = data[index + 1];
    const third = data[index + 2];
    const triple =
      (byteAt(data, index) << 16) | (byteAt(data, index + 1) << 8) | byteAt(data, index + 2);
    encoded += symbolAt((triple >> 18) & 63);
    encoded += symbolAt((triple >> 12) & 63);
    encoded += second === undefined ? '=' : symbolAt((triple >> 6) & 63);
    encoded += third === undefined ? '=' : symbolAt(triple & 63);
  }
  return encoded;
}

function codeAt(value: string, index: number): number {
  const character = value[index];
  if (character === undefined) return -1;
  const code = base64Alphabet.indexOf(character);
  if (code < 0) throw new Error('Invalid base64 audio');
  return code;
}

function sextet(code: number): number {
  return Math.max(code, 0);
}

export function decodeAudioBase64(value: string): Uint8Array {
  const cleaned = value.replaceAll('=', '');
  if (cleaned.length % 4 === 1) throw new Error('Invalid base64 audio');
  const bytes = [];
  for (let index = 0; index < cleaned.length; index += 4) {
    const first = codeAt(cleaned, index);
    const second = codeAt(cleaned, index + 1);
    const third = codeAt(cleaned, index + 2);
    const fourth = codeAt(cleaned, index + 3);
    const triple =
      (sextet(first) << 18) | (sextet(second) << 12) | (sextet(third) << 6) | sextet(fourth);
    bytes.push((triple >> 16) & 0xff);
    if (third >= 0) bytes.push((triple >> 8) & 0xff);
    if (fourth >= 0) bytes.push(triple & 0xff);
  }
  return Uint8Array.from(bytes);
}

export function convertAudio(chunk: AudioChunk, format: AudioFormat): AudioChunk {
  checkFormat(chunk.format);
  checkFormat(format);
  if (sameFormat(chunk.format, format)) {
    return { data: chunk.data.slice(), format, timestamp: chunk.timestamp };
  }
  if (compressed.has(chunk.format.encoding) || compressed.has(format.encoding)) {
    throw new Error(
      `Cannot convert ${chunk.format.encoding} to ${format.encoding} without a codec`
    );
  }
  const decoded = decode(chunk.data, chunk.format);
  const mixed = mix(decoded.channels, format.channels);
  const resampled = mixed.map((channel) =>
    resample(channel, decoded.sampleRate, format.sampleRate)
  );
  return {
    data: encode(resampled, format),
    format,
    timestamp: chunk.timestamp,
  };
}

export async function* convertAudioSource(source: AudioSource, format: AudioFormat): AudioSource {
  for await (const chunk of source) yield convertAudio(chunk, format);
}

function sameFormat(left: AudioFormat, right: AudioFormat): boolean {
  return (
    left.encoding === right.encoding &&
    left.sampleRate === right.sampleRate &&
    left.channels === right.channels
  );
}

function checkFormat(format: AudioFormat): void {
  if (format.channels !== 1 && format.channels !== 2) {
    throw new Error(`Unsupported channel count ${String(format.channels)}`);
  }
  if (!Number.isFinite(format.sampleRate) || format.sampleRate <= 0) {
    throw new Error(`Unsupported sample rate ${String(format.sampleRate)}`);
  }
}

interface Planar {
  channels: Float32Array[];
  sampleRate: number;
}

function decode(data: Uint8Array, format: AudioFormat): Planar {
  if (format.encoding === 'wav') return decodeWav(data);
  return { channels: decodePcm(data, format), sampleRate: format.sampleRate };
}

function decodePcm(data: Uint8Array, format: AudioFormat): Float32Array[] {
  const width = sampleWidth(format.encoding);
  const frames = Math.floor(data.byteLength / (width * format.channels));
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const channels = Array.from({ length: format.channels }, () => new Float32Array(frames));
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < format.channels; channel++) {
      const offset = (frame * format.channels + channel) * width;
      channels[channel][frame] = readSample(view, offset, format.encoding);
    }
  }
  return channels;
}

function sampleWidth(encoding: AudioEncoding): number {
  if (encoding === 'pcm16') return 2;
  if (encoding === 'pcmf32') return 4;
  if (encoding === 'mulaw' || encoding === 'alaw') return 1;
  throw new Error(`Unsupported audio encoding ${encoding}`);
}

function readSample(view: DataView, offset: number, encoding: AudioEncoding): number {
  if (encoding === 'pcm16') return int16ToFloat(view.getInt16(offset, true));
  if (encoding === 'pcmf32') return finite(view.getFloat32(offset, true));
  if (encoding === 'mulaw') return int16ToFloat(mulawToLinear(view.getUint8(offset)));
  return int16ToFloat(alawToLinear(view.getUint8(offset)));
}

function encode(channels: Float32Array[], format: AudioFormat): Uint8Array {
  if (format.encoding === 'wav') {
    const pcm = encode(channels, { ...format, encoding: 'pcm16' });
    return wavBytes(pcm, format.sampleRate, format.channels);
  }
  const width = sampleWidth(format.encoding);
  const frames = channels[0]?.length ?? 0;
  const bytes = new Uint8Array(frames * format.channels * width);
  const view = new DataView(bytes.buffer);
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < format.channels; channel++) {
      const offset = (frame * format.channels + channel) * width;
      writeSample(view, offset, format.encoding, channels[channel]?.[frame] ?? 0);
    }
  }
  return bytes;
}

function writeSample(
  view: DataView,
  offset: number,
  encoding: AudioEncoding,
  sample: number
): void {
  const unit = finite(sample);
  if (encoding === 'pcm16') view.setInt16(offset, floatToInt16(unit), true);
  else if (encoding === 'pcmf32') view.setFloat32(offset, unit, true);
  else if (encoding === 'mulaw') view.setUint8(offset, linearToMulaw(floatToInt16(unit)));
  else view.setUint8(offset, linearToAlaw(floatToInt16(unit)));
}

function mix(channels: Float32Array[], target: 1 | 2): Float32Array[] {
  const length = channels[0]?.length ?? 0;
  if (channels.length === target) return channels;
  if (target === 1) {
    const mixed = new Float32Array(length);
    if (channels.length === 0) return [mixed];
    for (let index = 0; index < length; index++) {
      let sum = 0;
      for (const channel of channels) sum += channel[index] ?? 0;
      mixed[index] = sum / channels.length;
    }
    return [mixed];
  }
  const left = channels[0] ?? new Float32Array(length);
  return [left, channels[1] ?? left];
}

function resample(input: Float32Array, inRate: number, outRate: number): Float32Array {
  if (inRate === outRate || input.length === 0) return input;
  const outLength = Math.max(1, Math.round((input.length * outRate) / inRate));
  const output = new Float32Array(outLength);
  const scale = inRate / outRate;
  const last = input.length - 1;
  for (let index = 0; index < outLength; index++) {
    const position = index * scale;
    const cursor = Math.min(Math.floor(position), last);
    const next = Math.min(cursor + 1, last);
    const fraction = position - cursor;
    const left = input[cursor] ?? 0;
    const right = input[next] ?? 0;
    output[index] = left + (right - left) * fraction;
  }
  return output;
}

function finite(sample: number): number {
  return Number.isFinite(sample) ? sample : 0;
}

function floatToInt16(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample));
  const scaled = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  return Math.max(-0x8000, Math.min(0x7fff, Math.round(scaled)));
}

function int16ToFloat(sample: number): number {
  return sample < 0 ? sample / 0x8000 : sample / 0x7fff;
}

function mulawToLinear(mulaw: number): number {
  const value = ~mulaw;
  const exponent = (value & 0x70) >> 4;
  let sample = ((value & 0x0f) << 3) + LAW_BIAS;
  sample <<= exponent;
  return (value & 0x80) !== 0 ? LAW_BIAS - sample : sample - LAW_BIAS;
}

function alawToLinear(alaw: number): number {
  const value = alaw ^ 0x55;
  const exponent = (value & 0x70) >> 4;
  const mantissa = value & 0x0f;
  const sample =
    exponent === 0
      ? (mantissa + mantissa + 1) << 3
      : (mantissa + mantissa + 1 + 32) << (exponent + 2);
  return (value & 0x80) !== 0 ? sample : -sample;
}

function buildLawTable(expand: (code: number) => number, mask: number): Uint8Array {
  const table = new Uint8Array(16384);
  table[8192] = mask;
  let cursor = 1;
  for (let code = 0; code < 127; code++) {
    const left = expand(code ^ mask);
    const right = expand((code + 1) ^ mask);
    const limit = (left + right + 4) >> 3;
    for (; cursor < limit; cursor += 1) {
      table[8192 - cursor] = (code ^ (mask ^ 0x80)) & 0xff;
      table[8192 + cursor] = (code ^ mask) & 0xff;
    }
  }
  for (; cursor < 8192; cursor++) {
    table[8192 - cursor] = (127 ^ (mask ^ 0x80)) & 0xff;
    table[8192 + cursor] = (127 ^ mask) & 0xff;
  }
  table[0] = table[1] ?? mask;
  return table;
}

const mulawTable = buildLawTable(mulawToLinear, 0xff);
const alawTable = buildLawTable(alawToLinear, 0xd5);

function lawCode(table: Uint8Array, pcm: number, fallback: number): number {
  return table[(pcm + 32768) >> 2] ?? fallback;
}

function linearToMulaw(pcm: number): number {
  return lawCode(mulawTable, pcm, 0xff);
}

function linearToAlaw(pcm: number): number {
  return lawCode(alawTable, pcm, 0xd5);
}

function decodeWav(data: Uint8Array): Planar {
  if (data.byteLength < 44) throw new Error('Invalid WAV audio');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (text(data, 0, 4) !== 'RIFF' || text(data, 8, 4) !== 'WAVE')
    throw new Error('Invalid WAV audio');
  let cursor = 12;
  let format:
    | { audioFormat: number; channels: number; sampleRate: number; width: number }
    | undefined;
  let payload: Uint8Array | undefined;
  while (cursor + 8 <= data.byteLength) {
    const id = text(data, cursor, 4);
    const size = view.getUint32(cursor + 4, true);
    const start = cursor + 8;
    const end = Math.min(start + size, data.byteLength);
    if (id === 'fmt ' && end - start >= 16) {
      format = {
        audioFormat: view.getUint16(start, true),
        channels: view.getUint16(start + 2, true),
        sampleRate: view.getUint32(start + 4, true),
        width: view.getUint16(start + 14, true) / 8,
      };
    } else if (id === 'data') payload = data.subarray(start, end);
    cursor = start + size + (size % 2);
  }
  if (!format || !payload) throw new Error('Invalid WAV audio');
  if (format.audioFormat !== 1 || format.width !== 2) throw new Error('WAV audio must be PCM16');
  if (format.channels !== 1 && format.channels !== 2) throw new Error('Invalid WAV audio');
  return {
    channels: decodePcm(payload, {
      encoding: 'pcm16',
      sampleRate: format.sampleRate,
      channels: format.channels,
    }),
    sampleRate: format.sampleRate,
  };
}

function wavBytes(pcm: Uint8Array, sampleRate: number, channels: number): Uint8Array {
  const bytes = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(bytes.buffer);
  bytes.set(ascii('RIFF'), 0);
  view.setUint32(4, 36 + pcm.byteLength, true);
  bytes.set(ascii('WAVE'), 8);
  bytes.set(ascii('fmt '), 12);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  bytes.set(ascii('data'), 36);
  view.setUint32(40, pcm.byteLength, true);
  bytes.set(pcm, 44);
  return bytes;
}

function text(data: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...data.subarray(offset, offset + length));
}

function ascii(value: string): Uint8Array {
  return Uint8Array.from(value, (character) => character.charCodeAt(0));
}
