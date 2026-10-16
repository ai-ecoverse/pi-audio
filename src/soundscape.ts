import type { AudioSink, AudioSource } from './audio.ts';
import type { VoicePhase } from './turns.ts';

export type CueSource =
  | { url: string }
  | { buffer: AudioBuffer }
  | { synth: (ctx: BaseAudioContext) => AudioNode };

export type Cue =
  | { kind: 'loop'; source: CueSource; gain: number }
  | { kind: 'oneShot'; source: CueSource; gain: number }
  | { kind: 'keep' }
  | { kind: 'silence' };

export interface Soundscape {
  cue(next: VoicePhase, previous: VoicePhase): Cue | readonly Cue[];
  graceMs?: number;
  fadeMs?: number;
  duckUnderSpeech?: number;
  duckUnderUser?: number;
}

export interface BedChannel {
  play(cue: Cue, fadeMs: number): void;
  duck(gain: number, rampMs: number): void;
  stop(fadeMs: number): void;
}

export interface AudioOut {
  readonly context: BaseAudioContext;
  speech: AudioSink;
  bed: BedChannel;
  readonly reference: AudioSource;
  readonly playback: 'webaudio' | 'rtc-loopback';
}

export interface BedFollower {
  observe(phase: VoicePhase): void;
  stop(): void;
}

export function isAudioOut(out: AudioSink | AudioOut): out is AudioOut {
  return 'speech' in out && 'bed' in out;
}

export function followBed(
  bed: BedChannel,
  soundscape: Soundscape,
  wait?: (run: () => void, delayMs: number) => ReturnType<typeof setTimeout>
): BedFollower {
  const schedule =
    wait === undefined ? (run: () => void, delayMs: number) => setTimeout(run, delayMs) : wait;
  let previous: VoicePhase = { phase: 'idle' };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let playing: string | undefined;

  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const stop = () => {
    generation += 1;
    clearTimer();
    if (playing === undefined) return;
    playing = undefined;
    bed.stop(fadeOf(soundscape));
  };

  const observe = (phase: VoicePhase) => {
    const cues = listCues(soundscape.cue(phase, previous));
    previous = phase;
    const fade = fadeOf(soundscape);
    bed.duck(duckFor(phase, soundscape), fade);
    for (const cue of cues) {
      if (cue.kind === 'oneShot') bed.play(cue, fade);
    }
    if (cues.some((cue) => cue.kind === 'silence')) {
      generation += 1;
      clearTimer();
      playing = undefined;
      bed.stop(fade);
      return;
    }
    const loop = firstLoop(cues);
    if (!loop) {
      generation += 1;
      clearTimer();
      return;
    }
    const key = sourceKey(loop.source);
    if (playing === key) {
      generation += 1;
      clearTimer();
      return;
    }
    generation += 1;
    const token = generation;
    clearTimer();
    const start = () => {
      if (token !== generation) return;
      playing = key;
      bed.play(loop, fade);
    };
    const grace = graceOf(soundscape);
    if (grace <= 0) {
      start();
      return;
    }
    timer = schedule(start, grace);
  };

  return { observe, stop };
}

function listCues(cue: Cue | readonly Cue[]): readonly Cue[] {
  if ('kind' in cue) return [cue];
  return cue;
}

function firstLoop(cues: readonly Cue[]): Extract<Cue, { kind: 'loop' }> | undefined {
  for (const cue of cues) {
    if (cue.kind === 'loop') return cue;
  }
  return undefined;
}

const sourceIds = new WeakMap<object, number>();
let sourceSerial = 0;

function sourceIdentity(value: object): number {
  const existing = sourceIds.get(value);
  if (existing !== undefined) return existing;
  sourceSerial += 1;
  sourceIds.set(value, sourceSerial);
  return sourceSerial;
}

function sourceKey(source: CueSource): string {
  if ('url' in source) return `url:${source.url}`;
  if ('buffer' in source) return `buffer:${sourceIdentity(source.buffer)}`;
  return `synth:${sourceIdentity(source.synth)}`;
}

function fadeOf(soundscape: Soundscape): number {
  const fade = soundscape.fadeMs;
  if (fade === undefined) return 0;
  return fade;
}

function graceOf(soundscape: Soundscape): number {
  const grace = soundscape.graceMs;
  if (grace === undefined) return 0;
  return grace;
}

function duckFor(phase: VoicePhase, soundscape: Soundscape): number {
  if (phase.phase === 'speaking') {
    const gain = soundscape.duckUnderSpeech;
    if (gain === undefined) return 1;
    return gain;
  }
  if (phase.phase === 'listening') {
    const gain = soundscape.duckUnderUser;
    if (gain === undefined) return 1;
    return gain;
  }
  return 1;
}
