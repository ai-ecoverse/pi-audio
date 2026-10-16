export type AudioEncoding = 'pcm16' | 'pcmf32' | 'mulaw' | 'alaw' | 'opus' | 'mp3' | 'wav' | 'flac';

export interface AudioFormat {
  encoding: AudioEncoding;
  sampleRate: number;
  channels: 1 | 2;
}

export interface AudioChunk {
  data: Uint8Array;
  format: AudioFormat;
  timestamp: number;
}

export type AudioSource = AsyncIterable<AudioChunk>;

export type TextSpan =
  | { entryId: string; contentIndex: number; start: number; end: number }
  | { itemId: string; start: number; end: number };

export interface CharAlignment {
  startMs: number[];
  durationMs: number[];
}

export interface AudioTag {
  span: TextSpan;
  alignment?: CharAlignment;
}

export interface AudioSink {
  write(chunk: AudioChunk, tag?: AudioTag): void;
  flush(): void;
  readonly playedMs: number;
  onPlayback(listener: (tag: AudioTag, offsetMs: number) => void): () => void;
}

const sampleWidth: Record<AudioEncoding, number> = {
  pcm16: 2,
  pcmf32: 4,
  mulaw: 1,
  alaw: 1,
  opus: 0,
  mp3: 0,
  wav: 0,
  flac: 0,
};

export function chunkSeconds(chunk: AudioChunk): number {
  const width = sampleWidth[chunk.format.encoding];
  if (width === 0 || chunk.format.sampleRate === 0) return 0;
  return chunk.data.byteLength / (width * chunk.format.channels * chunk.format.sampleRate);
}

export function alignmentSeconds(alignment: CharAlignment | undefined): number {
  if (alignment === undefined) return 0;
  let ms = 0;
  for (const duration of alignment.durationMs) ms += duration;
  return ms / 1000;
}
