import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getVoiceModel, speak, transcribe } from '@ai-ecoverse/pi-audio';
import { registerFish } from '@ai-ecoverse/pi-audio/fish';

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

function nextSocket() {
  const seen = FakeSocket.latest;
  return waitFor(() => {
    if (FakeSocket.latest && FakeSocket.latest !== seen) return FakeSocket.latest;
    return undefined;
  });
}

function packMap(entries) {
  const bytes = [0x80 | entries.length];
  const encoder = new TextEncoder();
  for (const [key, value] of entries) {
    const keyBytes = encoder.encode(key);
    bytes.push(0xa0 | keyBytes.length, ...keyBytes);
    if (typeof value === 'string') {
      const text = encoder.encode(value);
      bytes.push(0xa0 | text.length, ...text);
    } else {
      bytes.push(0xc4, value.length, ...value);
    }
  }
  return Uint8Array.from(bytes);
}

async function* text() {
  yield 'hi';
}

test('fish speech adapters run on recorded fixtures', async () => {
  assert.equal(getVoiceModel('transcription', 'fish', 'transcribe-1-pro'), undefined);
  const release = registerFish();
  const previous = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket;
  try {
    const heard = await transcribe(
      getVoiceModel('transcription', 'fish', 'transcribe-1-pro'),
      { data: Uint8Array.from([0]), mimeType: 'audio/wav' },
      {
        apiKey: 'fish',
        fetch: async (url, init) => {
          assert.equal(String(url), 'https://api.fish.audio/v1/asr');
          assert.equal(init.headers.Authorization, 'Bearer fish');
          assert.equal(init.headers.model, 'transcribe-1-pro');
          const body = Buffer.from(init.body).toString('utf8');
          assert.ok(body.includes('name="audio"'));
          assert.ok(body.includes('name="diarize"'));
          return Response.json({
            text: 'hello',
            language_code: 'en',
            duration: 1,
            speaker_turns: [{ speaker: 'speaker:0', text: 'hello', start: 0, end: 1 }],
          });
        },
      }
    );
    assert.equal(heard.text, 'hello');
    assert.equal(heard.segments[0].speaker, 'speaker:0');

    const spoken = [];
    for await (const event of speak(
      getVoiceModel('speech', 'fish', 's2.1-pro'),
      { text: 'hi', voice: 'ref' },
      {
        apiKey: 'fish',
        fetch: async (url, init) => {
          assert.match(String(url), /\/tts$/);
          assert.equal(init.headers.model, 's2.1-pro');
          const payload = JSON.parse(init.body);
          assert.equal(payload.reference_id, 'ref');
          assert.equal(payload.format, 'pcm');
          return new Response(Uint8Array.from([1, 0]));
        },
      }
    ))
      spoken.push(event.type);
    assert.deepEqual(spoken, ['start', 'audio', 'done']);

    const waiting = nextSocket();
    const heardLive = [];
    const pending = (async () => {
      for await (const event of speak(
        getVoiceModel('speech', 'fish', 's2.1-pro'),
        { text: text(), voice: 'ref' },
        { apiKey: 'fish' }
      ))
        heardLive.push(event);
    })();
    const socket = await waiting;
    assert.match(socket.url, /\/tts\/live$/);
    socket.emit('open', {});
    await waitFor(() => socket.sent.length >= 3);
    const sent = Buffer.concat(socket.sent.map((item) => Buffer.from(item))).toString('utf8');
    assert.ok(sent.includes('start'));
    assert.ok(sent.includes('ref'));
    socket.emit('message', {
      data: packMap([
        ['event', 'audio'],
        ['audio', Uint8Array.from([1, 0])],
      ]),
    });
    socket.emit('message', {
      data: packMap([
        ['event', 'finish'],
        ['reason', 'stop'],
      ]),
    });
    await pending;
    assert.deepEqual(
      heardLive.map((event) => event.type),
      ['start', 'audio', 'done']
    );
  } finally {
    globalThis.WebSocket = previous;
    release();
  }
});
