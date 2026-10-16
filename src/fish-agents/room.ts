import type { AudioChunk, AudioSource } from '../audio.ts';
import type { MicOpen } from '../echo.ts';

const loadSpecifier = new Function('specifier', 'return import(specifier)') as (
  specifier: string
) => Promise<FishSdk>;

export interface FishSdkRoom {
  connect(url: string, token: string): Promise<void>;
  disconnect(): void;
  localParticipant: {
    identity?: string;
    publishTrack(track: unknown, options?: unknown): Promise<unknown>;
    publishData(data: Uint8Array, options: { reliable: boolean; topic: string }): Promise<void>;
  };
  on(event: string, listener: (...args: unknown[]) => void): void;
  registerTextStreamHandler(
    topic: string,
    handler: (
      reader: { readAll(): Promise<string>; info: { attributes?: Record<string, string> } },
      participant: { identity: string }
    ) => void
  ): void;
}

export interface FishSdk {
  Room: new () => FishSdkRoom;
}

export interface FishHandlers {
  data(topic: string, json: unknown, identity: string | undefined): void;
  text(identity: string, value: string, attributes: Record<string, string>): void;
  attribute(key: string, value: string): void;
  speakers(identities: string[]): void;
  audio(chunk: AudioChunk): void;
  fail(error: unknown): void;
}

export interface FishRoom {
  url?: string;
  token?: string;
  identity: string;
  connect(url: string, token: string): Promise<void>;
  publishMic(source: AudioSource, open: MicOpen): Promise<void>;
  publishData(payload: string): Promise<void>;
  close(): void;
}

export type FishRoomFactory = (handlers: FishHandlers) => FishRoom;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function importFishSdk(
  load: (specifier: string) => Promise<FishSdk> = loadSpecifier
): Promise<FishSdk> {
  try {
    return await load('livekit-client');
  } catch (browserError) {
    try {
      return await load('@livekit/rtc-node');
    } catch {
      if (browserError instanceof Error) throw browserError;
      throw new Error(String(browserError));
    }
  }
}

function decodePacket(payload: unknown): unknown {
  const raw =
    typeof payload === 'string' ? payload : new TextDecoder().decode(payload as Uint8Array);
  return JSON.parse(raw);
}

export function openFishRoom(sdk: FishSdk, handlers: FishHandlers): FishRoom {
  const room = new sdk.Room();
  room.on('dataReceived', (payload, participant, _kind, topic) => {
    if (topic !== 'agent-event') return;
    const identity = isRecord(participant) ? text(participant.identity) : undefined;
    try {
      handlers.data(String(topic), decodePacket(payload), identity);
    } catch (error) {
      handlers.fail(error);
    }
  });
  room.registerTextStreamHandler('lk.transcription', (reader, participant) => {
    void reader.readAll().then(
      (value) => {
        handlers.text(participant.identity, value, reader.info.attributes ?? {});
      },
      (error: unknown) => handlers.fail(error)
    );
  });
  room.on('participantAttributesChanged', (changed, _participant) => {
    if (!isRecord(changed)) return;
    const value = changed['lk.agent.state'];
    if (typeof value === 'string') handlers.attribute('lk.agent.state', value);
  });
  room.on('activeSpeakersChanged', (speakers) => {
    const identities = Array.isArray(speakers)
      ? speakers.filter(isRecord).map((speaker) => text(speaker.identity))
      : [];
    handlers.speakers(identities);
  });
  room.on('trackSubscribed', (track) => {
    if (!isRecord(track) || typeof track.on !== 'function') return;
    track.on('audio', (chunk: AudioChunk) => handlers.audio(chunk));
  });
  return {
    identity: '',
    async connect(url, token) {
      await room.connect(url, token);
      this.identity = room.localParticipant.identity ?? '';
    },
    async publishMic(source, open) {
      await room.localParticipant.publishTrack(source, { echoCancellation: open.echoCancellation });
    },
    async publishData(payload) {
      await room.localParticipant.publishData(new TextEncoder().encode(payload), {
        reliable: true,
        topic: 'client-event',
      });
    },
    close() {
      room.disconnect();
    },
  };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
