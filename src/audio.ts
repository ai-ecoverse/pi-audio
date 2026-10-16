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
