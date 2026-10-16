import type { AuthResult, Models } from '@earendil-works/pi-ai';
import type { VoiceModel } from './models.ts';

export function resolveVoiceAuth(
  models: Models,
  model: VoiceModel,
  overrides?: Parameters<Models['getAuth']>[1]
): Promise<AuthResult | undefined> {
  return models.getAuth(model, overrides);
}
