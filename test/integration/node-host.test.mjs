import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindWorkletNode, calibrateEcho, openNodeAudio } from '@ai-ecoverse/pi-audio';
import { AUDIO_CONVERT_PROCESSOR, audioConvertWorkletUrl } from '@ai-ecoverse/pi-audio/worklet';

function tone(sampleRate, seconds) {
  const frames = Math.floor(sampleRate * seconds);
  const data = new Uint8Array(frames * 4);
  const view = new DataView(data.buffer);
  for (let frame = 0; frame < frames; frame += 1) {
    const sample = Math.sin((2 * Math.PI * 440 * frame) / sampleRate) * 0.2;
    view.setFloat32(frame * 4, sample, true);
  }
  return {
    data,
    format: { encoding: 'pcmf32', sampleRate, channels: 1 },
    timestamp: 0,
  };
}

function energy(chunk) {
  const view = new DataView(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength);
  let total = 0;
  const count = Math.floor(chunk.data.byteLength / 4);
  for (let index = 0; index < count; index += 1)
    total += Math.abs(view.getFloat32(index * 4, true));
  return total;
}

async function chunkWithEnergy(source) {
  const iterator = source[Symbol.asyncIterator]();
  const deadline = Date.now() + 2000;
  let pending = iterator.next();
  while (Date.now() < deadline) {
    const result = await Promise.race([
      pending.then((value) => ({ value })),
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 50)),
    ]);
    if (result.timeout) continue;
    pending = iterator.next();
    if (result.value.done) return result.value;
    if (energy(result.value.value) > 0) return result.value;
  }
  return { done: true };
}

async function waitFor(read, timeoutMs) {
  const started = Date.now();
  while (!read() && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('node engines render a silent graph', { timeout: 20000 }, async () => {
  const engines = ['node-web-audio-api', 'web-audio-api'];
  for (const engine of engines) {
    const session = await openNodeAudio({ engine, sink: 'none', sampleRate: 16000 });
    try {
      assert.equal(session.engine, engine);
      assert.equal(session.sink, 'none');
      assert.equal(session.out.playback, 'webaudio');
      if (engine === 'node-web-audio-api') assert.equal(session.context.sinkId.type, 'none');
      const chunk = tone(session.context.sampleRate, 0.1);
      session.out.speech.write(chunk);
      const heard = await chunkWithEnergy(session.out.reference);
      assert.equal(heard.done, false);
      assert.equal(heard.value.format.encoding, 'pcmf32');
      assert.equal(energy(heard.value) > 0, true);
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(session.out.speech.playedMs > 0, true);
      const library = await import(engine);
      const node = new library.AudioWorkletNode(session.context, 'pi-audio-tap', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      node.connect(session.context.destination);
      let disconnected = 0;
      const disconnect = node.disconnect.bind(node);
      node.disconnect = () => {
        disconnected += 1;
        disconnect();
      };
      bindWorkletNode(node);
      node.port.postMessage({ type: 'pi-audio-release' });
      await waitFor(() => disconnected > 0, 1500);
      assert.equal(disconnected > 0, true);
      if (engine === 'node-web-audio-api') {
        await session.context.audioWorklet.addModule(audioConvertWorkletUrl());
        const convert = new library.AudioWorkletNode(session.context, AUDIO_CONVERT_PROCESSOR, {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          processorOptions: {
            sampleRate: 16000,
            format: { encoding: 'pcm16', sampleRate: 16000, channels: 1 },
          },
        });
        convert.connect(session.context.destination);
        let convertOff = 0;
        const convertDisconnect = convert.disconnect.bind(convert);
        convert.disconnect = () => {
          convertOff += 1;
          convertDisconnect();
        };
        bindWorkletNode(convert);
        convert.port.postMessage({ type: 'pi-audio-release' });
        await waitFor(() => convertOff > 0, 1500);
        assert.equal(convertOff > 0, true);
      }
      const report = await calibrateEcho(
        session.out,
        (async function* mic() {
          yield chunk;
        })(),
        { kind: 'silence' },
        20,
        new AbortController().signal
      );
      assert.equal(typeof report.delayMs, 'number');
      assert.equal(typeof report.recommendation, 'string');
    } finally {
      await session.close();
      assert.equal(session.context.state, 'closed');
    }
  }
});
