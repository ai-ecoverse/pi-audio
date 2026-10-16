import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatCompletionsBrain } from '@ai-ecoverse/pi-audio/brain';

test('the brain subpath turns one chat completion into a voice turn', async () => {
  assert.match(import.meta.resolve('@ai-ecoverse/pi-audio/brain'), /brain\/index\.js$/);
  const handler = chatCompletionsBrain({
    vendorTools: 'terminal',
    budget: { firstTokenMs: 60_000, hardDeadlineMs: 60_000 },
    filler: () => '',
    async conversation(sessionKey) {
      assert.equal(sessionKey, 'sess-recorded');
      return {
        async *prompt(message) {
          assert.equal(message.content, 'order');
          yield {
            type: 'message_end',
            entry: {
              id: 'e',
              model: [{ role: 'assistant', content: [{ type: 'text', text: 'Shipped' }] }],
            },
          };
        },
        async truncate() {},
      };
    },
  });
  const response = await handler(
    new Request('https://brain.example/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'pi-voice',
        stream: true,
        session_id: 'sess-recorded',
        messages: [
          { role: 'system', content: 'You are Aria.' },
          { role: 'user', content: 'order' },
        ],
      }),
    })
  );
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const body = await response.text();
  assert.match(body, /Shipped/);
  assert.match(body, /data: \[DONE\]/);
});
