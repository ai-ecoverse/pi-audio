import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendVoiceTruncate } from '@ai-ecoverse/pi-audio/durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { AssistantEntry, createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable';

const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function assistant(content) {
  return {
    role: 'assistant',
    content,
    api: 'pi-audio',
    provider: 'pi-audio',
    model: 'voice',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost },
    stopReason: 'toolUse',
    timestamp: 1,
  };
}

test('a voice.truncate edit cuts derived context and leaves the stored entry', async () => {
  const harness = await Harness.open(
    new MemoryStorage(),
    { models: createModels(), registry: createRegistry() },
    BACKGROUND_CONTEXT
  );
  try {
    const conversation = await harness.createConversation(
      { ownership: { kind: 'ownerless' } },
      BACKGROUND_CONTEXT
    );
    const message = assistant([
      { type: 'text', text: 'Hello there. friend' },
      { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { cmd: 'ls' } },
    ]);
    const stored = await conversation.commit(
      (tx) =>
        tx.appendEntry(AssistantEntry, conversation.id, {
          model: [message],
        }),
      BACKGROUND_CONTEXT
    );
    const voiceCut = {
      entryId: String(stored.id),
      contentIndex: 0,
      heardUpTo: 'Hello there.'.length,
      heardMs: 80,
    };
    const truncate = await appendVoiceTruncate(
      harness,
      conversation.id,
      voiceCut,
      message,
      BACKGROUND_CONTEXT
    );
    assert.equal(truncate.kind, 'voice.truncate');
    assert.equal(truncate.model, undefined);
    assert.deepEqual(truncate.data, voiceCut);
    const again = await conversation.commit((tx) => tx.entry(stored.id), BACKGROUND_CONTEXT);
    assert.equal(again.model[0].content[0].text, 'Hello there. friend');
    assert.equal(again.model[0].content[1].name, 'bash');
    const view = await conversation.context(BACKGROUND_CONTEXT);
    const derived = view.messages.find((item) => item.role === 'assistant');
    assert.equal(derived.content[0].text, 'Hello there.');
    assert.equal(derived.content[1].name, 'bash');
    assert.equal(derived.content.length, 2);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
});
