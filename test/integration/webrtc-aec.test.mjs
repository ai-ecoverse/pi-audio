import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calibrateEcho, openNodeAudio } from '@ai-ecoverse/pi-audio';
import { createNodeWebRtcEcho } from '@ai-ecoverse/pi-audio/webrtc-aec';

function noise(frames, seed) {
  const samples = new Float32Array(frames);
  let state = seed;
  for (let index = 0; index < frames; index += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    samples[index] = (state / 0x100000000) * 2 - 1;
  }
  return samples;
}

function chunk(samples, sampleRate) {
  const data = new Uint8Array(samples.length * 4);
  data.set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
  return {
    data,
    format: { encoding: 'pcmf32', sampleRate, channels: 1 },
    timestamp: 0,
  };
}

function floats(audio) {
  const view = new DataView(audio.data.buffer, audio.data.byteOffset, audio.data.byteLength);
  const count = Math.floor(audio.data.byteLength / 4);
  const samples = new Float32Array(count);
  for (let index = 0; index < count; index += 1) samples[index] = view.getFloat32(index * 4, true);
  return samples;
}

function finiteChunk(audio) {
  const samples = floats(audio);
  return samples.every((sample) => Number.isFinite(sample));
}

async function capture(source, sampleRate, seconds) {
  const target = Math.floor(sampleRate * seconds);
  const samples = [];
  const iterator = source[Symbol.asyncIterator]();
  const deadline = Date.now() + 12000;
  let pending = iterator.next();
  while (samples.length < target && Date.now() < deadline) {
    const result = await Promise.race([
      pending.then((value) => ({ value })),
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 50)),
    ]);
    if (result.timeout) continue;
    pending = iterator.next();
    if (result.value.done) break;
    samples.push(...floats(result.value.value));
  }
  return Float32Array.from(samples);
}

function delayed(reference, delay, gain) {
  const mic = new Float32Array(reference.length);
  for (let index = delay; index < reference.length; index += 1) {
    mic[index] = reference[index - delay] * gain;
  }
  return mic;
}

test('node playback of a delayed leak is cancelled and reported from AEC stats', {
  timeout: 30000,
}, async () => {
  const session = await openNodeAudio({ sink: 'none', sampleRate: 16000 });
  const echo = await createNodeWebRtcEcho({ sampleRate: 16000 });
  try {
    const rate = session.context.sampleRate;
    assert.equal(session.out.playback, 'webaudio');
    const rendered = capture(session.out.reference, rate, 3.4);
    session.out.speech.write(chunk(noise(Math.floor(rate * 3.6), 11), rate));
    const reference = await rendered;
    assert.equal(reference.length >= rate * 3, true);
    const delay = Math.round(rate * 0.032);
    const mic = delayed(reference, delay, 0.5);
    const report = await calibrateEcho(
      {
        context: session.context,
        speech: session.out.speech,
        bed: { play() {}, duck() {}, stop() {} },
        reference: (async function* replay() {
          yield chunk(reference, rate);
        })(),
        playback: 'webaudio',
      },
      (async function* heard() {
        yield chunk(mic, rate);
      })(),
      { kind: 'silence' },
      (reference.length / rate) * 1000,
      new AbortController().signal,
      echo
    );
    assert.ok(Math.abs(report.delayMs - 32) <= 8, `delay ${report.delayMs}`);
    assert.ok(report.cancellationDb > 10, `cancellation ${report.cancellationDb}`);
    assert.equal(report.residualDb < -20, true);
  } finally {
    echo.destroy();
    await session.close();
  }
});

test('one non-finite mic sample does not poison later cancelled audio', async () => {
  const entry = import.meta.resolve('@ai-ecoverse/pi-audio/webrtc-aec');
  assert.match(entry, /\/dist\/webrtc-aec\/index\.js$/);
  const echo = await createNodeWebRtcEcho({ sampleRate: 16000 });
  try {
    const tone = new Float32Array(160).fill(0.25);
    const poisoned = chunk(tone, 16000);
    const view = new DataView(poisoned.data.buffer);
    view.setFloat32(12, Number.NaN, true);
    view.setFloat32(16, Number.NEGATIVE_INFINITY, true);
    const reference = chunk(tone, 16000);
    const first = echo.cancel(poisoned, reference);
    const second = echo.cancel(chunk(tone, 16000), reference);
    const third = echo.cancel(chunk(tone, 16000), reference);
    assert.equal(finiteChunk(first), true);
    assert.equal(finiteChunk(second), true);
    assert.equal(finiteChunk(third), true);
  } finally {
    echo.destroy();
  }
});
