import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getVoiceModel, listen, speak, transcribe } from '@ai-ecoverse/pi-audio';
import { registerOpenAI } from '@ai-ecoverse/pi-audio/openai';

const pcm = { encoding: 'pcm16', sampleRate: 24000, channels: 1 };

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
    this.sent.push(String(data));
  }
  close() {
    this.emit('close', {});
  }
  emit(type, event) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
  }
}

test('openai and openrouter speech adapters run on recorded fixtures', async () => {
  assert.equal(getVoiceModel('transcription', 'openai', 'whisper-1'), undefined);
  const release = registerOpenAI();
  const previous = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket;
  try {
    const heard = await transcribe(
      getVoiceModel('transcription', 'openai', 'whisper-1'),
      { data: Uint8Array.from([0]), mimeType: 'audio/wav' },
      {
        apiKey: 'sk',
        fetch: async (_url, init) => {
          assert.match(String(init.headers['Content-Type']), /multipart/);
          return Response.json({ text: 'hello', usage: { seconds: 1 } });
        },
      }
    );
    assert.equal(heard.text, 'hello');

    const routed = await transcribe(
      getVoiceModel('transcription', 'openrouter', 'openai/whisper-1'),
      { data: Uint8Array.from([0]), mimeType: 'audio/wav' },
      {
        apiKey: 'sk',
        fetch: async (_url, init) => {
          assert.equal(JSON.parse(init.body).input_audio.format, 'wav');
          return Response.json({ text: 'routed' });
        },
      }
    );
    assert.equal(routed.text, 'routed');

    const spoken = [];
    for await (const event of speak(
      getVoiceModel('speech', 'openai', 'tts-1'),
      { text: 'hi', voice: 'alloy' },
      {
        apiKey: 'sk',
        fetch: async (_url, init) => {
          assert.equal(JSON.parse(init.body).response_format, 'pcm');
          return new Response(Uint8Array.from([1, 0]));
        },
      }
    ))
      spoken.push(event.type);
    assert.deepEqual(spoken, ['start', 'audio', 'done']);

    const model = getVoiceModel('transcription', 'openai', 'gpt-live-transcribe');
    const pending = (async () => {
      const events = [];
      for await (const event of listen(model, emptyAudio(), { apiKey: 'sk' })) events.push(event);
      return events;
    })();
    const socket = await waitSocket();
    socket.emit('open', {});
    await waitFor(() => socket.sent.some((message) => message.includes('commit')));
    socket.emit('message', {
      data: JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: 'live',
      }),
    });
    const events = await pending;
    assert.equal(events.at(-1).transcript.text, 'live');
  } finally {
    globalThis.WebSocket = previous;
    release();
  }
});

async function* emptyAudio() {}

function waitSocket() {
  return waitFor(() => FakeSocket.latest);
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('timed out');
}
