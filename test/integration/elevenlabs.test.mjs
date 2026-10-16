import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getVoiceModel, listen, speak, transcribe } from '@ai-ecoverse/pi-audio';
import { registerElevenLabs } from '@ai-ecoverse/pi-audio/elevenlabs';

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

async function* words() {
  yield 'hello ';
  yield 'there';
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

test('elevenlabs speech adapters run on recorded fixtures', async () => {
  assert.equal(getVoiceModel('transcription', 'elevenlabs', 'scribe_v2'), undefined);
  const release = registerElevenLabs();
  const previous = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket;
  try {
    const heard = await transcribe(
      getVoiceModel('transcription', 'elevenlabs', 'scribe_v2'),
      { data: Uint8Array.from([0]), mimeType: 'audio/wav' },
      {
        apiKey: 'xi',
        fetch: async (_url, init) => {
          assert.equal(init.headers['xi-api-key'], 'xi');
          const body = Buffer.from(init.body).toString('utf8');
          assert.ok(body.includes('name="model_id"'));
          return Response.json({
            text: 'hello',
            language_code: 'en',
            audio_duration_secs: 1,
            words: [{ text: 'hello', start: 0, end: 1, type: 'word', speaker_id: 'speaker_1' }],
          });
        },
      }
    );
    assert.equal(heard.text, 'hello');
    assert.equal(heard.segments[0].speaker, 'speaker_1');

    const spoken = [];
    for await (const event of speak(
      getVoiceModel('speech', 'elevenlabs', 'eleven_flash_v2_5'),
      { text: 'hi', voice: '21m00Tcm4TlvDq8ikWAM' },
      {
        apiKey: 'xi',
        fetch: async (url, init) => {
          assert.match(String(url), /with-timestamps/);
          assert.equal(JSON.parse(init.body).model_id, 'eleven_flash_v2_5');
          return Response.json({ audio_base64: 'AAE=' });
        },
      }
    ))
      spoken.push(event.type);
    assert.deepEqual(spoken, ['start', 'audio', 'done']);

    const streamed = [];
    const pendingSpeech = (async () => {
      for await (const event of speak(
        getVoiceModel('speech', 'elevenlabs', 'eleven_flash_v2_5'),
        { text: words(), voice: '21m00Tcm4TlvDq8ikWAM' },
        { apiKey: 'xi' }
      ))
        streamed.push(event);
    })();
    const speechSocket = await waitFor(() => FakeSocket.latest);
    speechSocket.emit('open', {});
    await waitFor(() =>
      speechSocket.sent.some((item) => typeof item === 'string' && item.includes('"flush":true'))
    );
    speechSocket.emit('message', {
      data: JSON.stringify({
        audio: 'AAE=',
        alignment: { charStartTimesMs: [0], charDurationsMs: [20], chars: ['h'] },
      }),
    });
    speechSocket.emit('message', { data: JSON.stringify({ isFinal: true }) });
    await pendingSpeech;
    assert.equal(
      streamed.some((event) => event.type === 'audio' && event.alignment),
      true
    );

    const model = getVoiceModel('transcription', 'elevenlabs', 'scribe_v2_realtime');
    const pending = (async () => {
      const events = [];
      for await (const event of listen(model, audio(), { apiKey: 'xi', language: 'en' }))
        events.push(event);
      return events;
    })();
    const socket = await waitFor(() => FakeSocket.latest !== speechSocket && FakeSocket.latest);
    assert.match(socket.url, /commit_strategy=turn_prediction/);
    socket.emit('open', {});
    socket.emit('message', {
      data: JSON.stringify({ message_type: 'session_started', session_id: 's' }),
    });
    await waitFor(() =>
      socket.sent.some((item) => typeof item === 'string' && item.includes('"commit":true'))
    );
    socket.emit('message', {
      data: JSON.stringify({ message_type: 'partial_transcript', text: 'hel' }),
    });
    socket.emit('message', {
      data: JSON.stringify({ message_type: 'committed_transcript', text: 'hello' }),
    });
    const events = await pending;
    assert.equal(events[0].type, 'speech_start');
    assert.equal(events.at(-1).transcript.text, 'hello');
  } finally {
    globalThis.WebSocket = previous;
    release();
  }
});
