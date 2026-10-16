import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getVoiceModel, listen, speak, transcribe } from '@ai-ecoverse/pi-audio';
import { registerMistral } from '@ai-ecoverse/pi-audio/mistral';

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

async function* audio() {
  yield { data: Uint8Array.from([1, 0]), format: pcm, timestamp: 0 };
}

function waitFor(predicate) {
  return new Promise((resolve, reject) => {
    let left = 40;
    const tick = () => {
      const value = predicate();
      if (value) {
        resolve(value);
        return;
      }
      left -= 1;
      if (left === 0) reject(new Error('timed out'));
      else setTimeout(tick, 0);
    };
    tick();
  });
}

test('mistral speech adapters run on recorded fixtures', async () => {
  assert.equal(getVoiceModel('transcription', 'mistral', 'voxtral-mini-latest'), undefined);
  const release = registerMistral();
  const previous = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket;
  try {
    const heard = await transcribe(
      getVoiceModel('transcription', 'mistral', 'voxtral-mini-latest'),
      { data: Uint8Array.from([0]), mimeType: 'audio/wav' },
      {
        apiKey: 'mistral',
        fetch: async (_url, init) => {
          assert.equal(init.headers.Authorization, 'Bearer mistral');
          const body = Buffer.from(init.body).toString('utf8');
          assert.ok(body.includes('name="model"'));
          assert.ok(body.includes('name="diarize"'));
          return Response.json({
            text: 'hello',
            language: 'en',
            duration: 1,
            segments: [{ text: 'hello', start: 0, end: 1, speaker_id: 'speaker_1' }],
          });
        },
      }
    );
    assert.equal(heard.text, 'hello');
    assert.equal(heard.segments[0].speaker, 'speaker_1');

    const spoken = [];
    for await (const event of speak(
      getVoiceModel('speech', 'mistral', 'voxtral-mini-tts-2603'),
      { text: 'hi', voice: 'en_paul_neutral' },
      {
        apiKey: 'mistral',
        fetch: async (url, init) => {
          assert.match(String(url), /\/audio\/speech$/);
          const payload = JSON.parse(init.body);
          assert.equal(payload.model, 'voxtral-mini-tts-2603');
          assert.equal(payload.voice_id, 'en_paul_neutral');
          assert.equal(payload.response_format, 'pcm');
          assert.equal(payload.stream, true);
          return new Response('event: speech.audio.delta\ndata: {"audio_data":"AAAAAA=="}\n\n', {
            headers: { 'content-type': 'text/event-stream' },
          });
        },
      }
    ))
      spoken.push(event.type);
    assert.deepEqual(spoken, ['start', 'audio', 'done']);

    const heardLive = [];
    const pending = (async () => {
      for await (const event of listen(
        getVoiceModel('transcription', 'mistral', 'voxtral-mini-transcribe-realtime-2602'),
        audio(),
        {
          apiKey: 'mistral',
          vad: {
            push() {
              return { speechStart: 0 };
            },
          },
        }
      ))
        heardLive.push(event);
    })();
    const socket = await waitFor(() => FakeSocket.latest);
    assert.match(socket.url, /model=voxtral-mini-transcribe-realtime-2602/);
    socket.emit('open', {});
    socket.emit('message', { data: JSON.stringify({ type: 'session.created' }) });
    await waitFor(() =>
      socket.sent.some((item) => typeof item === 'string' && item.includes('"input_audio.end"'))
    );
    socket.emit('message', {
      data: JSON.stringify({ type: 'transcription.text.delta', text: 'hello' }),
    });
    socket.emit('message', {
      data: JSON.stringify({ type: 'transcription.done', text: 'hello', language: 'en' }),
    });
    await pending;
    assert.ok(heardLive.some((event) => event.type === 'final' && event.text === 'hello'));
    assert.ok(heardLive.some((event) => event.type === 'done'));
  } finally {
    globalThis.WebSocket = previous;
    release();
  }
});
