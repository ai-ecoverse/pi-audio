import type { UserMessage } from '@earendil-works/pi-ai';
import type { VoiceConversation } from '../turns.ts';

export interface BrainBudget {
  firstTokenMs: number;
  hardDeadlineMs: number;
}

export interface BrainOptions {
  conversation(sessionKey: string, signal: AbortSignal): Promise<VoiceConversation>;
  vendorTools: 'terminal' | 'drop';
  budget: BrainBudget;
  filler(user: UserMessage): string;
}
