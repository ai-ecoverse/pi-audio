import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  convertAudio,
  convertAudioSource,
  decodeAudioBase64,
  encodeAudioBase64,
} from '@ai-ecoverse/pi-audio';
import { AUDIO_CONVERT_PROCESSOR, audioConvertWorkletUrl } from '@ai-ecoverse/pi-audio/worklet';

test('the package converts pcm and exposes the audio worklet', async () => {
  const format = { encoding: 'pcm16', sampleRate: 8000, channels: 1 };
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setInt16(0, 16384, true);
  new DataView(bytes.buffer).setInt16(2, -16384, true);
  const floats = convertAudio(
    { data: bytes, format, timestamp: 5 },
    { encoding: 'pcmf32', sampleRate: 8000, channels: 1 }
  );
  assert.equal(floats.timestamp, 5);
  const sample = new DataView(
    floats.data.buffer,
    floats.data.byteOffset,
    floats.data.byteLength
  ).getFloat32(0, true);
  assert.ok(Math.abs(sample - 0.5) < 0.001);
  const back = convertAudio(floats, format);
  assert.deepEqual([...back.data], [...bytes]);
  const encoded = encodeAudioBase64(bytes);
  assert.deepEqual([...decodeAudioBase64(encoded)], [...bytes]);
  const streamed = [];
  for await (const chunk of convertAudioSource(
    (async function* source() {
      yield { data: bytes, format, timestamp: 1 };
    })(),
    { encoding: 'pcmf32', sampleRate: 8000, channels: 1 }
  ))
    streamed.push(chunk.timestamp);
  assert.deepEqual(streamed, [1]);
  assert.equal(AUDIO_CONVERT_PROCESSOR, 'pi-audio-convert');
  assert.match(audioConvertWorkletUrl(), /worklet\/convert\.js$/);
});
