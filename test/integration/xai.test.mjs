import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getVoiceModel, listen, speak, transcribe } from '@ai-ecoverse/pi-audio';
import { registerXAI } from '@ai-ecoverse/pi-audio/xai';

const pcm = { encoding: 'pcm16', sampleRate: 16000, channels: 1 };

class FakeSocket {
  static latest;
  constructor(url, protocols) {
    this.url = String(url);
    this.protocols = protocols;
    this.sent = [];
    this.listeners = new Map();
    FakeSocket.latest = this;
  }
  addEventListener(type, fn) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  send(data) {
    this.sent.push(data);
  }
  close() {
    this.emit('close', {});
  }
  emit(type, event) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
  }
}

test('xai speech adapters run on recorded fixtures', async () => {
  assert.equal(getVoiceModel('transcription', 'xai', 'grok-voice-transcribe-2.0'), undefined);
  const release = registerXAI();
  const previous = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket;
  try {
    const heard = await transcribe(
      getVoiceModel('transcription', 'xai', 'grok-voice-transcribe-2.0'),
      { data: Uint8Array.from([0]), mimeType: 'audio/wav' },
      {
        apiKey: 'sk',
        fetch: async (_url, init) => {
          const body = Buffer.from(init.body).toString('utf8');
          assert.ok(body.indexOf('name="model"') < body.indexOf('name="file"'));
          return Response.json({
            text: 'hello',
            duration: 1,
            words: [{ text: 'hello', start: 0, end: 1 }],
          });
        },
      }
    );
    assert.equal(heard.text, 'hello');
    assert.equal(heard.segments[0].text, 'hello');

    const spoken = [];
    for await (const event of speak(
      getVoiceModel('speech', 'xai', 'grok-voice-tts-1.0'),
      { text: 'hi', voice: 'eve' },
      {
        apiKey: 'sk',
        fetch: async (_url, init) => {
          assert.equal(JSON.parse(init.body).voice_id, 'eve');
          return new Response(Uint8Array.from([1, 2]));
        },
      }
    ))
      spoken.push(event.type);
    assert.deepEqual(spoken, ['start', 'audio', 'done']);

    const model = getVoiceModel('transcription', 'xai', 'grok-voice-transcribe-2.0');
    const pending = (async () => {
      const events = [];
      for await (const event of listen(model, audio(), { apiKey: 'sk' })) events.push(event);
      return events;
    })();
    const socket = await waitFor(() => FakeSocket.latest);
    socket.emit('open', {});
    socket.emit('message', { data: JSON.stringify({ type: 'transcript.created' }) });
    await waitFor(() =>
      socket.sent.some((item) => typeof item === 'string' && item.includes('audio.done'))
    );
    socket.emit('message', {
      data: JSON.stringify({
        type: 'transcript.partial',
        text: 'live',
        is_final: true,
        speech_final: true,
      }),
    });
    socket.emit('message', {
      data: JSON.stringify({ type: 'transcript.done', text: 'live', duration: 0.4 }),
    });
    const events = await pending;
    assert.equal(events.at(-1).transcript.text, 'live');

    const streamed = (async () => {
      const events = [];
      for await (const event of speak(
        getVoiceModel('speech', 'xai', 'grok-voice-tts-1.0'),
        { text: words(), voice: 'eve' },
        { apiKey: 'sk' }
      ))
        events.push(event);
      return events;
    })();
    const speechSocket = await waitFor(() =>
      FakeSocket.latest === socket ? undefined : FakeSocket.latest
    );
    speechSocket.emit('open', {});
    await waitFor(() =>
      speechSocket.sent.some((item) => typeof item === 'string' && item.includes('text.done'))
    );
    speechSocket.emit('message', { data: JSON.stringify({ type: 'audio.delta', delta: 'AA==' }) });
    speechSocket.emit('message', { data: JSON.stringify({ type: 'audio.done' }) });
    const speechEvents = await streamed;
    assert.equal(speechEvents.at(-1).type, 'done');
    assert.equal(speechEvents.at(-1).usage.audio.characters, 5);
  } finally {
    globalThis.WebSocket = previous;
    release();
  }
});

async function* audio() {
  yield { data: Uint8Array.from([1, 0]), format: pcm, timestamp: 0 };
}

async function* words() {
  yield 'he';
  yield 'llo';
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('timed out');
}
