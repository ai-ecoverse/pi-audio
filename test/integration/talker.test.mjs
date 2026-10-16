import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askAgent, bindThinker, connectRealtime, talkerTools } from '@ai-ecoverse/pi-audio';
import { registerFauxRealtime } from '@ai-ecoverse/pi-audio/faux';

const context = { instructions: '', tools: [askAgent], voice: 'faux' };
const delivery = { interrupt: 'native', when_idle: 'native', silent: 'native' };

function message(id, text) {
  return {
    role: 'toolResult',
    toolCallId: id,
    toolName: 'ask_agent',
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: 1,
  };
}

test('bindThinker treats blocking and async ask_agent calls the same for the thinker', async () => {
  assert.deepEqual(talkerTools, ['ask_agent', 'read']);
  const reports = [];
  for (const blocking of [true, false]) {
    const faux = registerFauxRealtime({
      api: `integration-talker-${blocking}`,
      id: blocking ? 'block' : 'async',
      toolCalls: blocking ? 'blocking' : 'async',
      delivery,
    });
    try {
      const session = await connectRealtime(faux.model, context);
      const asked = [];
      const bound = bindThinker(
        session,
        {
          async *ask(request, heard) {
            asked.push({ request, heard });
            yield { type: 'progress', text: 'running npm test' };
            yield { type: 'result', message: message('c1', 'fixed it') };
          },
        },
        async (call) => message(call.id, 'file contents'),
        {
          progress: 'silent',
          result: 'when_idle',
          ack: 'working on it',
          directTimeoutMs: 1000,
          directMaxChars: 100,
        }
      );
      const captions = [];
      const reading = (async () => {
        for await (const caption of bound.captions) captions.push(caption);
      })();
      faux.emit({ type: 'input_transcript', itemId: 'u', text: 'please fix', final: true });
      faux.emit({
        type: 'tool_call',
        blocking,
        call: {
          type: 'toolCall',
          id: 'c1',
          name: 'ask_agent',
          arguments: { request: 'fix it' },
        },
      });
      await new Promise((resolve) => setImmediate(resolve));
      await session.close();
      await bound.done;
      await reading;
      reports.push({
        asked,
        captions,
        calls: faux.calls.map((call) =>
          call.method === 'respond' ? `respond:${call.result.content[0].text}` : call.method
        ),
      });
    } finally {
      faux.unregister();
    }
  }
  assert.deepEqual(reports[0].asked, reports[1].asked);
  assert.deepEqual(reports[0].asked[0], { request: 'fix it', heard: ['user: please fix'] });
  assert.deepEqual(reports[0].captions, reports[1].captions);
  assert.deepEqual(reports[0].captions[0], {
    type: 'thinker_progress',
    callId: 'c1',
    text: 'running npm test',
  });
  assert.equal(reports[0].captions[1].summary, 'fixed it');
  assert.deepEqual(reports[0].calls, ['respond:working on it', 'inject', 'inject', 'close']);
  assert.deepEqual(reports[1].calls, ['inject', 'respond:fixed it', 'close']);
});
