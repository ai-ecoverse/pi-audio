import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectRealtime } from '@ai-ecoverse/pi-audio';
import { gemini38Live, registerGeminiLive } from '@ai-ecoverse/pi-audio/gemini-live';
import { gptRealtime2, registerOpenAIRealtime } from '@ai-ecoverse/pi-audio/openai-realtime';

function fakeSocket() {
  const listeners = { open: [], message: [], close: [], error: [] };
  const api = {
    binaryType: 'blob',
    send() {},
    close() {},
    addEventListener(type, listener) {
      listeners[type].push(listener);
    },
    emit(type, event) {
      for (const listener of listeners[type]) listener(event ?? {});
    },
  };
  function Socket() {
    return api;
  }
  return { Socket, api };
}

test('openai realtime sets arraybuffer binaryType and decodes binary frames', async () => {
  const { Socket, api } = fakeSocket();
  const unregister = registerOpenAIRealtime({ socket: Socket });
  try {
    const session = await connectRealtime(
      gptRealtime2,
      { instructions: 'Be brief.', voice: 'marin', tools: [] },
      { apiKey: 'sk-test' }
    );
    assert.equal(api.binaryType, 'arraybuffer');
    const events = session[Symbol.asyncIterator]();
    api.emit('open');
    const payload = new TextEncoder().encode(
      JSON.stringify({ type: 'session.created', session: { id: 'sess-bin' } })
    );
    api.emit('message', { data: payload.buffer });
    assert.equal((await events.next()).value.sessionId, 'sess-bin');
    await session.close();
  } finally {
    unregister();
  }
});

test('openai realtime surfaces close code and reason before setup', async () => {
  const { Socket, api } = fakeSocket();
  const unregister = registerOpenAIRealtime({ socket: Socket });
  try {
    const session = await connectRealtime(
      gptRealtime2,
      { instructions: 'Be brief.', voice: 'marin', tools: [] },
      { apiKey: 'sk-test' }
    );
    const events = session[Symbol.asyncIterator]();
    api.emit('open');
    api.emit('close', {
      code: 1007,
      reason: 'Invalid JSON payload received. Unknown name "speechConfig"',
    });
    const event = (await events.next()).value;
    assert.equal(event.type, 'error');
    assert.equal(event.fatal, true);
    assert.match(event.error, /1007/);
    assert.match(event.error, /speechConfig/);
    await session.close();
  } finally {
    unregister();
  }
});

test('openai realtime uses only the Authorization header on Node', async () => {
  const captured = [];
  const unregister = registerOpenAIRealtime({
    wire(target) {
      captured.push(target);
      return {
        send() {},
        close() {},
        incoming: {
          async *[Symbol.asyncIterator]() {},
        },
      };
    },
  });
  try {
    const session = await connectRealtime(
      gptRealtime2,
      { instructions: 'Be brief.', voice: 'marin', tools: [] },
      { apiKey: 'sk-live' }
    );
    assert.equal(captured.length, 1);
    assert.deepEqual(captured[0].protocols, ['realtime']);
    assert.equal(captured[0].headers.Authorization, 'Bearer sk-live');
    assert.equal(
      captured[0].protocols.some((value) => value.startsWith('openai-insecure-api-key.')),
      false
    );
    await session.close();
  } finally {
    unregister();
  }
});

test('gemini live nests speechConfig under generationConfig', async () => {
  const sent = [];
  const unregister = registerGeminiLive({
    wire() {
      return {
        send(data) {
          sent.push(JSON.parse(data));
        },
        close() {},
        incoming: {
          async *[Symbol.asyncIterator]() {},
        },
      };
    },
  });
  try {
    const session = await connectRealtime(
      gemini38Live,
      { instructions: 'Be brief.', voice: 'Aoede', tools: [] },
      { apiKey: 'gemini-key' }
    );
    const setup = sent[0].setup;
    assert.equal(setup.speechConfig, undefined);
    assert.equal(
      setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName,
      'Aoede'
    );
    await session.close();
  } finally {
    unregister();
  }
});
