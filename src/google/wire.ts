import type { ProviderRequestOptions } from '@earendil-works/pi-ai';
import type { AudioFormat } from '../audio.ts';

const mimes: Record<string, string> = {
  wav: 'AUDIO_WAV',
  pcm16: 'AUDIO_L16',
  mulaw: 'AUDIO_MULAW',
  alaw: 'AUDIO_ALAW',
};

export function speechMime(format: AudioFormat): string {
  const name = mimes[format.encoding];
  if (!name) throw new Error(`Unsupported speech format ${format.encoding}`);
  return name;
}

export function sameFormat(left: AudioFormat, right: AudioFormat): boolean {
  return (
    left.encoding === right.encoding &&
    left.sampleRate === right.sampleRate &&
    left.channels === right.channels
  );
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === expected && value.trim() !== '') return value;
  }
  return undefined;
}

export function googleHeaders(
  model: { provider: string; headers?: Record<string, string> },
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
  if (headerValue(headers, 'x-goog-api-key') === undefined) {
    const apiKey = options?.apiKey;
    if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);
    headers['x-goog-api-key'] = apiKey;
  }
  return headers;
}
