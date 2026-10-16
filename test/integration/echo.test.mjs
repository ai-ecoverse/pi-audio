import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calibrateEcho } from '@ai-ecoverse/pi-audio';

function pcm16(samples, sampleRate) {
  const data = new Uint8Array(samples.length * 2);
  const view = new DataView(data.buffer);
  samples.forEach((sample, index) => {
    view.setInt16(index * 2, Math.round(sample * 32767), true);
  });
  return {
    data,
    format: { encoding: 'pcm16', sampleRate, channels: 1 },
    timestamp: 0,
  };
}

test('calibration measures a synthetic delay and attenuation', async () => {
  const calls = [];
  const report = await calibrateEcho(
    {
      context: {},
      speech: {
        playedMs: 0,
        write() {},
        flush() {},
        onPlayback() {
          return () => {};
        },
      },
      bed: {
        play() {
          calls.push('play');
        },
        duck() {},
        stop() {
          calls.push('stop');
        },
      },
      reference: (async function* reference() {
        yield pcm16([1, 0, 0, 0, 0], 1000);
      })(),
      playback: 'webaudio',
    },
    (async function* mic() {
      yield pcm16([0, 0, 0.1, 0, 0], 1000);
    })(),
    { kind: 'loop', source: { url: 'probe' }, gain: 0.2 },
    1000,
    new AbortController().signal
  );
  assert.equal(report.delayMs, 2);
  assert.ok(Math.abs(report.cancellationDb - 20) < 0.5);
  assert.equal(report.recommendation, 'onWords');
  assert.deepEqual(calls, ['play', 'stop']);
});
