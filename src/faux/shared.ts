import type { AudioFormat } from '../audio.ts';

export const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function pcm(sampleRate = 24000): AudioFormat {
  return { encoding: 'pcm16', sampleRate, channels: 1 };
}

export function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}\0${model.id}`;
}

export function decodeBytes(data: Uint8Array): string {
  return new TextDecoder().decode(data);
}

export function encodeChars(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index) & 0xff;
  return bytes;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function shareApi(
  registrations: Map<string, () => void>,
  api: string,
  register: () => () => void,
  stillUsed: () => boolean
): () => void {
  if (!registrations.has(api)) registrations.set(api, register());
  return () => {
    if (stillUsed()) return;
    const unregister = registrations.get(api);
    registrations.delete(api);
    if (unregister) unregister();
  };
}
