import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listen, speak, voiceTurns } from '@ai-ecoverse/pi-audio';
import { registerFauxSpeech, registerFauxTranscription } from '@ai-ecoverse/pi-audio/faux';

const format = { encoding: 'pcm16', sampleRate: 16000, channels: 1 };

function chunk(text, timestamp) {
  return { data: new TextEncoder().encode(text), format, timestamp };
}

function speechSink() {
  const listeners = new Set();
  return {
    playedMs: 0,
    write(_audio, tag) {
      this.playedMs += 20;
      for (const listener of listeners) listener(tag, 0);
    },
    flush() {},
    onPlayback(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

test('faux phases skip a short bed, keep it across tools, and duck under speech', async () => {
  const ears = registerFauxTranscription({
    api: 'soundscape-ears',
    id: 'soundscape-ears',
    cues: [{ at: 1, events: [{ type: 'turn_end', text: 'hello', at: 5 }] }],
  });
  const mouth = registerFauxSpeech({
    api: 'soundscape-mouth',
    id: 'soundscape-mouth',
    textStreaming: true,
    chunkChars: 20,
  });
  const events = [];
  const bed = {
    play(cue) {
      events.push(['play', cue.kind, cue.source.url]);
    },
    duck(gain) {
      events.push(['duck', gain]);
    },
    stop() {
      events.push(['stop']);
    },
  };
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let releaseMic;
  const micGate = new Promise((resolve) => {
    releaseMic = resolve;
  });
  const session = voiceTurns(
    { listen, speak },
    {
      async *prompt() {
        yield { type: 'tool_execution_start', toolName: 'bash', toolCallId: 'a', args: {} };
        await gate;
        yield { type: 'tool_execution_start', toolName: 'read', toolCallId: 'b', args: {} };
        yield {
          type: 'message_end',
          entry: {
            id: 4,
            model: [{ role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }],
          },
        };
      },
      async truncate() {},
    },
    (async function* mic() {
      yield chunk('hello', 5);
      await micGate;
    })(),
    {
      context: {},
      speech: speechSink(),
      bed,
      reference: (async function* reference() {})(),
      playback: 'webaudio',
    },
    {
      ears: ears.model,
      mouth: mouth.model,
      voice: 'faux',
      soundscape: {
        graceMs: 40,
        fadeMs: 8,
        duckUnderSpeech: 0.15,
        duckUnderUser: 0,
        cue(next, previous) {
          if (next.phase === 'thinking') return { kind: 'loop', source: { url: 'pad' }, gain: 0.2 };
          if (next.phase === 'tool' && next.toolName === 'bash') {
            return { kind: 'loop', source: { url: 'tick' }, gain: 0.3 };
          }
          if (next.phase === 'tool') return { kind: 'keep' };
          if (next.phase === 'speaking' && previous.phase === 'tool') {
            return [{ kind: 'oneShot', source: { url: 'done' }, gain: 0.4 }, { kind: 'keep' }];
          }
          return { kind: 'silence' };
        },
      },
    },
    new AbortController().signal
  );
  const phases = [];
  const reading = (async () => {
    for await (const phase of session.phases) phases.push(phase);
  })();
  await new Promise((resolve) => {
    setTimeout(resolve, 70);
  });
  release();
  await new Promise((resolve) => {
    setTimeout(resolve, 20);
  });
  releaseMic();
  await session.done;
  await reading;
  ears.unregister();
  mouth.unregister();
  assert.deepEqual(
    events.filter((event) => event[0] === 'play' && event[1] === 'loop').map((event) => event[2]),
    ['tick']
  );
  assert.equal(
    events.some((event) => event[0] === 'play' && event[2] === 'done'),
    true
  );
  assert.equal(
    events.some((event) => event[0] === 'duck' && event[1] === 0.15),
    true
  );
  assert.equal(
    phases.some((phase) => phase.phase === 'speaking'),
    true
  );
});
