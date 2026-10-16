import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { ConversationId, EntryId, EntryRecord, Tx } from '@earendil-works/pi-durable';
import type { VoiceCut } from '../turns.ts';

type Block = AssistantMessage['content'][number];

interface TruncateSession<C> {
  commit<T>(change: (tx: Tx) => T | Promise<T>, context: C): Promise<T>;
}

function entryIdOf(entryId: string): EntryId {
  if (!/^\d+$/.test(entryId)) {
    throw new Error(`Voice cut entry is not a durable id: ${entryId}`);
  }
  return Number(entryId) as EntryId;
}

function keptBlock(block: Block, index: number, cut: VoiceCut): Block | undefined {
  if (block.type === 'toolCall' || block.type === 'thinking') return block;
  if (index < cut.contentIndex) return block;
  if (index > cut.contentIndex) return undefined;
  const heard = block.text.slice(0, cut.heardUpTo);
  if (heard.length === 0) return undefined;
  if (heard === block.text) return block;
  return { ...block, text: heard };
}

function cutAssistantMessage(message: AssistantMessage, cut: VoiceCut): AssistantMessage {
  const content: Block[] = [];
  for (const [index, block] of message.content.entries()) {
    const kept = keptBlock(block, index, cut);
    if (kept === undefined) continue;
    content.push(kept);
  }
  return { ...message, content };
}

export async function appendVoiceTruncate<C>(
  session: TruncateSession<C>,
  conversationId: ConversationId,
  cut: VoiceCut,
  message: AssistantMessage,
  context: C
): Promise<EntryRecord> {
  const replacement = cutAssistantMessage(message, cut);
  const target = entryIdOf(cut.entryId);
  return session.commit(
    (tx) =>
      tx.appendEntry(conversationId, {
        kind: 'voice.truncate',
        data: {
          entryId: cut.entryId,
          contentIndex: cut.contentIndex,
          heardUpTo: cut.heardUpTo,
          heardMs: cut.heardMs,
        },
        edits: [{ target, action: 'replace', messages: [replacement] }],
      }),
    context
  );
}
