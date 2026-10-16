import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectRealtime, realtimeSocket, VoiceRequestError } from '@ai-ecoverse/pi-audio';
import { registerFauxRealtime } from '@ai-ecoverse/pi-audio/faux';

const format = { encoding: 'pcm16', sampleRate: 24000, channels: 1 };
const context = { instructions: 'be brief', tools: [], voice: 'faux' };

test('a realtime session meters audio, gates delivery, and can ride a gateway', async () => {
  const talker = registerFauxRealtime({
    api: 'integration-rt-contract',
    id: 'talker',
    delivery: { interrupt: 'native', when_idle: 'approximate', silent: 'unsupported' },
    truncation: 'client',
    audioCost: { perInputMinute: 60, perOutputMinute: 120, perTextMessage: 0.5 },
  });
  try {
    await assert.rejects(
      () => connectRealtime(talker.model, context, { transport: 'webrtc' }),
      (error) => error instanceof VoiceRequestError && /webrtc/.test(error.message)
    );
    await assert.rejects(
      () => connectRealtime(talker.model, context, { resumeHandle: 'handle' }),
      (error) => error instanceof VoiceRequestError && /resumable/.test(error.message)
    );
    const gateway = { url: 'wss://gateway.example/v1/acct/gw/openai', token: 'cf-token' };
    const session = await connectRealtime(talker.model, context, { gateway });
    assert.deepEqual(
      talker.socket,
      realtimeSocket(talker.model.baseUrl, { gateway }, ['realtime'])
    );
    session.appendAudio({ data: new Uint8Array(48000), format, timestamp: 0 });
    session.sendText('hello');
    session.inject('status', 'interrupt');
    assert.throws(
      () => session.inject('quiet', 'silent'),
      (error) => error instanceof VoiceRequestError && error.reason === 'error'
    );
    talker.emit({
      type: 'output_audio',
      itemId: 'u',
      chunk: { data: new Uint8Array(24000), format, timestamp: 1 },
    });
    session.inject('tests passed', 'when_idle');
    assert.deepEqual(
      talker.calls.map((call) => call.method),
      ['appendAudio', 'sendText', 'inject']
    );
    talker.emit({
      type: 'response_done',
      itemId: 'u',
      interrupted: false,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    assert.equal(talker.calls.at(-1).delivery, 'when_idle');
    assert.equal(talker.calls.at(-1).support, 'approximate');
    session.interrupt({ itemId: 'u', heardMs: 100 });
    assert.deepEqual(talker.calls.at(-1).plan, {
      item: { itemId: 'u', audioEndMs: 100 },
    });
    const { usage } = await session.close();
    assert.equal(usage.input, 0);
    assert.equal(usage.output, 0);
    assert.equal(usage.audio.inputSeconds, 1);
    assert.equal(usage.audio.outputSeconds, 0.5);
    assert.equal(usage.audio.textMessages, 3);
    assert.equal(usage.cost.input, 2.5);
    assert.equal(usage.cost.output, 1);
    assert.equal(usage.cost.total, 3.5);
  } finally {
    talker.unregister();
  }
});
