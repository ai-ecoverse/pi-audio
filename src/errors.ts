export class VoiceRequestError extends Error {
  readonly reason: 'aborted' | 'error';

  constructor(reason: 'aborted' | 'error', message: string) {
    super(message);
    this.name = 'VoiceRequestError';
    this.reason = reason;
  }
}
