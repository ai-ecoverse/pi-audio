import assert from 'node:assert/strict';
import { test } from 'node:test';
import { energyVad, listen, speak } from '@ai-ecoverse/pi-audio';
import { registerFauxSpeech, registerFauxTranscription } from '@ai-ecoverse/pi-audio/faux';

const format = { encoding: 'pcm16', sampleRate: 16000, channels: 1 };

function tone(amplitude, samples, timestamp) {
  const data = new Int16Array(samples);
  data.fill(amplitude);
  return { data: new Uint8Array(data.buffer), format, timestamp };
}

async function* source(chunks) {
  for (const chunk of chunks) yield chunk;
}

async function eventsOf(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

test('faux speech is requested once per sentence when the model cannot stream text', async () => {
  const mouth = registerFauxSpeech({
    api: 'integration-chunk-tts',
    id: 'mouth',
    textStreaming: false,
    chunkChars: 100,
    audioCost: { perThousandChars: 1000 },
  });
  const events = await eventsOf(
    speak(mouth.model, { text: 'Hello there. Next sentence!', voice: 'faux' })
  );
  assert.deepEqual(
    mouth.calls.map((call) => call.text),
    ['Hello there. ', 'Next sentence!']
  );
  const audio = events.filter((event) => event.type === 'audio');
  const first = mouth.calls[0].text.length;
  const total = first + mouth.calls[1].text.length;
  assert.deepEqual(audio[0].span, { itemId: 'mouth', start: 0, end: first });
  assert.deepEqual(audio[1].span, { itemId: 'mouth', start: first, end: total });
  assert.equal(events.at(-1).usage.audio.characters, total);
  assert.equal(events.at(-1).usage.cost.total, total);
  const signal = AbortSignal.abort();
  const aborted = await eventsOf(
    speak(mouth.model, { text: 'Hi. There.', voice: 'faux' }, { signal })
  );
  assert.equal(aborted[0].type, 'error');
  assert.equal(aborted[0].reason, 'aborted');
  await assert.rejects(
    speak(mouth.model, { text: 'Hi. There.', voice: 'faux' }, { signal }).result()
  );
  mouth.unregister();
});

test('faux listen uses a local vad hook when the model does not detect turns', async () => {
  const ears = registerFauxTranscription({
    api: 'integration-vad-stt',
    id: 'ears',
    turnDetection: 'none',
    cues: [
      { at: 1, events: [{ type: 'partial', segmentId: 'a', text: 'hello' }] },
      { at: 2, events: [{ type: 'final', segmentId: 'a', text: 'hello', confidence: 1 }] },
    ],
  });
  const heard = await eventsOf(
    listen(
      ears.model,
      source([
        { data: new TextEncoder().encode('hel'), format, timestamp: 0 },
        { data: new TextEncoder().encode('lo'), format, timestamp: 30 },
      ]),
      {
        vad: {
          push(chunk) {
            if (chunk.timestamp === 0) return { speechStart: 0 };
            if (chunk.timestamp === 30) return { turnEnd: 40 };
            return undefined;
          },
        },
      }
    )
  );
  assert.deepEqual(
    heard.map((event) => event.type),
    ['speech_start', 'partial', 'final', 'turn_end', 'done']
  );
  assert.equal(heard[0].at, 0);
  assert.equal(heard.find((event) => event.type === 'turn_end').text, 'hello');
  assert.equal(heard.find((event) => event.type === 'turn_end').at, 40);
  const signal = AbortSignal.abort();
  const aborted = await eventsOf(listen(ears.model, source([tone(0, 1, 0)]), { signal }));
  assert.equal(aborted[0].reason, 'aborted');
  const loud = tone(8000, 1600, 0);
  const quiet = tone(0, 8000, 100);
  const energy = await eventsOf(
    listen(ears.model, source([loud, quiet]), { vad: energyVad({ silenceMs: 500 }) })
  );
  assert.equal(energy.filter((event) => event.type === 'turn_end').length, 1);
  ears.unregister();
});
